/**
 * worktree.create 执行（S03 Step 11；worker-channel.yaml WorktreeCreate/WorktreeReady；EX-11.1）
 * - 路径 <worktreeRoot>/<taskKey>；已存在且 reuseIfExists → 直接复用
 * - 分支缺省 foreman/<taskKey>；已存在的分支直接挂载，否则从 baseBranch 新建
 * - 写入 .foreman/context.md、.foreman/task.json、.claude/settings.json（Notification 钩子）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface WorktreeCreateInput {
  taskKey: string; repo: string; baseBranch: string; branchName?: string; buildEnv?: Record<string, string>;
  contextMarkdown?: string; taskJson?: Record<string, unknown>; hooks?: Record<string, unknown>; reuseIfExists?: boolean; fetchFirst?: boolean;
  /** 已存在但基线不对时按新基线重建（见 dropForRebase 的安全检查） */
  resetToBase?: boolean;
}
export interface WorktreeReadyOutput { taskKey: string; path: string; branchName: string; reused: boolean }

export class WorktreeError extends Error {
  constructor(message: string, public retryable: boolean) { super(message); }
}

export type GitRunner = (args: string[], cwd: string) => string;
export const realGit: GitRunner = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function defaultBranchName(taskKey: string) { return `foreman/${taskKey}`; }

/**
 * 基线引用：本地分支优先；主仓库里只有远端跟踪分支时（开发机上的 origin/branch-selectdb-doris-4.1 就是这样）用远端的。
 * 直接拿分支名去 `git worktree add` 会报 invalid reference——T-6 的 agent 当时只能自己 fetch + checkout -B 绕过去。
 */
export function resolveBaseRef(base: string, main: string, git: GitRunner = realGit): string {
  const has = (ref: string) => { try { git(['rev-parse', '--verify', '--quiet', ref], main); return true; } catch { return false; } };
  if (has(`refs/heads/${base}`)) return base;
  if (has(`refs/remotes/origin/${base}`)) return `origin/${base}`;
  return base; // 可能是 tag 或提交号，交给 git 判断
}

/**
 * 按新基线重建前的安全检查：有未提交改动、或有不在任何其他分支 / 远端上的提交，就拒绝——绝不丢别人的改动。
 * 代码定位阶段不改代码，正常情况下两项都为空。
 */
function dropForRebase(path: string, branchName: string, main: string, git: GitRunner) {
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], path).trim();
  if (dirty) throw new WorktreeError(`worktree 有未提交的改动，不能切换基线：${dirty.split('\n').slice(0, 3).join('；')}`, false);
  const unique = Number(git(['rev-list', '--count', 'HEAD', '--not', `--exclude=${branchName}`, '--branches', '--remotes'], path).trim() || '0');
  if (unique > 0) throw new WorktreeError(`worktree 上有 ${unique} 个只在 ${branchName} 上的提交，不能切换基线（请先推送或手动处理）`, false);
  git(['worktree', 'remove', '--force', path], main);
  try { git(['branch', '-D', branchName], main); } catch { /* 分支可能不存在 */ }
}

/**
 * 按基线分支挑构建环境（thirdparty、jdk 等）。
 * `build_env.<repo>` 的键是分支族，挑选顺序：与分支同名 > 最长前缀匹配 > `default`。
 * 一个都没有时返回 env=null，由 worker 在 worktree.ready 里回报 buildEnvMissing——
 * 拿不匹配的依赖硬编译只会在链接阶段失败，不如明确降级（T-6 在 4.1 上就是这么撞的）。
 */
export function pickBuildEnv(byBranch: Record<string, Record<string, string>> | undefined, baseBranch?: string): { env: Record<string, string> | null; matched: string | null } {
  if (!byBranch) return { env: null, matched: null };
  if (baseBranch) {
    if (byBranch[baseBranch]) return { env: byBranch[baseBranch]!, matched: baseBranch };
    const prefix = Object.keys(byBranch)
      .filter((k) => k !== 'default' && baseBranch.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix) return { env: byBranch[prefix]!, matched: prefix };
  }
  return byBranch.default ? { env: byBranch.default, matched: 'default' } : { env: null, matched: null };
}

export function createWorktree(input: WorktreeCreateInput, repo: { main: string; worktreeRoot: string }, git: GitRunner = realGit): WorktreeReadyOutput {
  const branchName = input.branchName ?? defaultBranchName(input.taskKey);
  const path = resolve(repo.worktreeRoot, input.taskKey);
  let reused = false;
  const exists = existsSync(path);
  if (exists && (input.reuseIfExists ?? true) && !input.resetToBase) {
    reused = true;
  } else {
    try {
      if (!existsSync(repo.main)) throw new Error(`主仓库不存在：${repo.main}`);
      if (input.fetchFirst) git(['fetch', '--all', '--prune'], repo.main);
      if (exists && input.resetToBase) dropForRebase(path, branchName, repo.main, git);
      mkdirSync(repo.worktreeRoot, { recursive: true });
      let branchExists = false;
      try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], repo.main); branchExists = true; } catch { branchExists = false; }
      if (branchExists) git(['worktree', 'add', path, branchName], repo.main);
      else git(['worktree', 'add', '-b', branchName, path, resolveBaseRef(input.baseBranch, repo.main, git)], repo.main);
    } catch (e) {
      if (e instanceof WorktreeError) throw e;
      const msg = String((e as any)?.stderr ?? (e as Error).message ?? e).trim();
      throw new WorktreeError(msg.slice(0, 500), !input.fetchFirst);
    }
  }
  excludeForemanDir(path, git);
  writeContextFiles(path, input);
  return { taskKey: input.taskKey, path, branchName, reused };
}

/**
 * `.foreman/` 放的是上下文包与会话日志，不该被 agent 的 `git add -A` 带进 PR。
 * 写 worktree 自己的 info/exclude（`git rev-parse --git-path` 在 worktree 里指向 .git/worktrees/<name>/info/exclude），
 * 而不是改仓库的 .gitignore —— 后者本身就是一处要提交的改动。
 */
export function excludeForemanDir(path: string, git: GitRunner = realGit) {
  try {
    const p = resolve(path, git(['rev-parse', '--git-path', 'info/exclude'], path).trim());
    mkdirSync(dirname(p), { recursive: true });
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
    if (cur.split('\n').some((l) => l.trim() === '.foreman/')) return;
    writeFileSync(p, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}.foreman/\n`);
  } catch { /* 写不了不影响会话，最多是 PR 里多出 .foreman/ */ }
}

/** 上下文文件（每次都刷新，保证 context.md 为最新版本） */
export function writeContextFiles(path: string, input: Pick<WorktreeCreateInput, 'contextMarkdown' | 'taskJson' | 'hooks' | 'taskKey' | 'buildEnv'>) {
  mkdirSync(resolve(path, '.foreman'), { recursive: true });
  writeFileSync(resolve(path, '.foreman/context.md'), input.contextMarkdown ?? `# ${input.taskKey}\n`);
  writeFileSync(resolve(path, '.foreman/task.json'), JSON.stringify(input.taskJson ?? { key: input.taskKey }, null, 2));
  // 编译环境：Doris 的 env.sh 会 source 仓库根的 custom_env.sh（已被 .gitignore 忽略）；thirdparty/installed 不随 worktree 带过去
  if (input.buildEnv && Object.keys(input.buildEnv).length) {
    const envPath = resolve(path, 'custom_env.sh');
    const keys = Object.keys(input.buildEnv);
    const keep = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n').filter((l) => l && !keys.some((k) => l.startsWith(`export ${k}=`))) : [];
    writeFileSync(envPath, [...keep, ...Object.entries(input.buildEnv).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)].join('\n') + '\n');
  }
  // 需要输入改由 worker 轮询 claude state=blocked 发现；只有显式传入 hooks 才写 .claude/settings.json
  if (!input.hooks) return;
  mkdirSync(resolve(path, '.claude'), { recursive: true });
  const settingsPath = resolve(path, '.claude/settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) { try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { settings = {}; } }
  settings.hooks = { ...((settings.hooks as Record<string, unknown>) ?? {}), ...input.hooks };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
