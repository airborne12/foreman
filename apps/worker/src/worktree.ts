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
}
export interface WorktreeReadyOutput { taskKey: string; path: string; branchName: string; reused: boolean }

export class WorktreeError extends Error {
  constructor(message: string, public retryable: boolean) { super(message); }
}

export type GitRunner = (args: string[], cwd: string) => string;
export const realGit: GitRunner = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function defaultBranchName(taskKey: string) { return `foreman/${taskKey}`; }

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
  if (existsSync(path) && (input.reuseIfExists ?? true)) {
    reused = true;
  } else {
    try {
      if (!existsSync(repo.main)) throw new Error(`主仓库不存在：${repo.main}`);
      if (input.fetchFirst) git(['fetch', '--all', '--prune'], repo.main);
      mkdirSync(repo.worktreeRoot, { recursive: true });
      let branchExists = false;
      try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], repo.main); branchExists = true; } catch { branchExists = false; }
      if (branchExists) git(['worktree', 'add', path, branchName], repo.main);
      else git(['worktree', 'add', '-b', branchName, path, input.baseBranch], repo.main);
    } catch (e) {
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
