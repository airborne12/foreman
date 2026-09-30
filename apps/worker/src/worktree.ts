/**
 * worktree.create 执行（S03 Step 11；worker-channel.yaml WorktreeCreate/WorktreeReady；EX-11.1）
 * - 路径 <worktreeRoot>/<taskKey>；已存在且 reuseIfExists → 直接复用
 * - 分支缺省 foreman/<taskKey>；已存在的分支直接挂载，否则从 baseBranch 新建
 * - 写入 .foreman/context.md、.foreman/task.json、.claude/settings.json（Notification 钩子）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

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

export type GitRunner = (args: string[], cwd: string) => Promise<string>;
// 异步执行：doris 这种大仓库 worktree add / fetch 要几十秒，同步调用会卡住 worker 的事件循环，
// 期间心跳、取日志全都不回（2026-09-30 T-77.2：session.logs 15 秒超时）
const execFileP = promisify(execFile);
export const realGit: GitRunner = async (args, cwd) => (await execFileP('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;

export function defaultBranchName(taskKey: string) { return `foreman/${taskKey}`; }

/**
 * 基线引用：本地分支优先；主仓库里只有远端跟踪分支时（开发机上的 origin/branch-selectdb-doris-4.1 就是这样）用远端的。
 * 直接拿分支名去 `git worktree add` 会报 invalid reference——T-6 的 agent 当时只能自己 fetch + checkout -B 绕过去。
 */
export async function resolveBaseRef(base: string, main: string, git: GitRunner = realGit): Promise<string> {
  const has = async (ref: string) => { try { await git(['rev-parse', '--verify', '--quiet', ref], main); return true; } catch { return false; } };
  if (await has(`refs/heads/${base}`)) return base;
  if (await has(`refs/remotes/origin/${base}`)) return `origin/${base}`;
  return base; // 可能是 tag 或提交号，交给 git 判断
}

/**
 * 按新基线重建前的安全检查：有未提交改动、或有不在任何其他分支 / 远端上的提交，就拒绝——绝不丢别人的改动。
 * 代码定位阶段不改代码，正常情况下两项都为空。
 */
async function dropForRebase(path: string, branchName: string, main: string, git: GitRunner) {
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'], path)).trim();
  if (dirty) throw new WorktreeError(`worktree 有未提交的改动，不能切换基线：${dirty.split('\n').slice(0, 3).join('；')}`, false);
  const unique = Number((await git(['rev-list', '--count', 'HEAD', '--not', `--exclude=${branchName}`, '--branches', '--remotes'], path)).trim() || '0');
  if (unique > 0) throw new WorktreeError(`worktree 上有 ${unique} 个只在 ${branchName} 上的提交，不能切换基线（请先推送或手动处理）`, false);
  await git(['worktree', 'remove', '--force', path], main);
  try { await git(['branch', '-D', branchName], main); } catch { /* 分支可能不存在 */ }
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

/** 工作区是否由该主仓库建出（比对 git common dir）；不是 git 目录也算不属于 */
export async function belongsTo(path: string, main: string, git: GitRunner = realGit): Promise<boolean> {
  try {
    const common = String(await git(['rev-parse', '--git-common-dir'], path)).trim();
    const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
    return real(resolve(path, common)) === real(resolve(main, '.git'));
  } catch { return false; }
}

export async function createWorktree(input: WorktreeCreateInput, repo: { main: string; worktreeRoot: string }, git: GitRunner = realGit): Promise<WorktreeReadyOutput> {
  const branchName = input.branchName ?? defaultBranchName(input.taskKey);
  // 同一任务换了仓库（代码定位时仓库未定、用了默认仓库；拍板后定成另一个）：原路径上的工作区属于别的主仓库，
  // 不能复用，否则 agent 会在错的仓库里改（2026-09-29 T-77：定位工作区来自 selectdb-core，任务要改 apache/doris）
  let path = resolve(repo.worktreeRoot, input.taskKey);
  if (existsSync(path) && !(await belongsTo(path, repo.main, git))) path = resolve(repo.worktreeRoot, `${input.taskKey}@${basename(repo.main)}`);
  let reused = false;
  const exists = existsSync(path);
  if (exists && (input.reuseIfExists ?? true) && !input.resetToBase) {
    reused = true;
  } else {
    try {
      if (!existsSync(repo.main)) throw new Error(`主仓库不存在：${repo.main}`);
      if (input.fetchFirst) await git(['fetch', '--all', '--prune'], repo.main);
      if (exists && input.resetToBase) await dropForRebase(path, branchName, repo.main, git);
      mkdirSync(repo.worktreeRoot, { recursive: true });
      let branchExists = false;
      try { await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], repo.main); branchExists = true; } catch { branchExists = false; }
      if (branchExists) await git(['worktree', 'add', path, branchName], repo.main);
      else await git(['worktree', 'add', '-b', branchName, path, await resolveBaseRef(input.baseBranch, repo.main, git)], repo.main);
    } catch (e) {
      if (e instanceof WorktreeError) throw e;
      const msg = String((e as any)?.stderr ?? (e as Error).message ?? e).trim();
      throw new WorktreeError(msg.slice(0, 500), !input.fetchFirst);
    }
  }
  await excludeForemanDir(path, git);
  writeContextFiles(path, input, repo.main);
  return { taskKey: input.taskKey, path, branchName, reused };
}

/**
 * `.foreman/` 放的是上下文包与会话日志，不该被 agent 的 `git add -A` 带进 PR。
 * 写 worktree 自己的 info/exclude（`git rev-parse --git-path` 在 worktree 里指向 .git/worktrees/<name>/info/exclude），
 * 而不是改仓库的 .gitignore —— 后者本身就是一处要提交的改动。
 */
export async function excludeForemanDir(path: string, git: GitRunner = realGit) {
  try {
    const p = resolve(path, (await git(['rev-parse', '--git-path', 'info/exclude'], path)).trim());
    mkdirSync(dirname(p), { recursive: true });
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
    if (cur.split('\n').some((l) => l.trim() === '.foreman/')) return;
    writeFileSync(p, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}.foreman/\n`);
  } catch { /* 写不了不影响会话，最多是 PR 里多出 .foreman/ */ }
}

/** 上下文文件（每次都刷新，保证 context.md 为最新版本） */
export function writeContextFiles(path: string, input: Pick<WorktreeCreateInput, 'contextMarkdown' | 'taskJson' | 'hooks' | 'taskKey' | 'buildEnv'>, main?: string) {
  mkdirSync(resolve(path, '.foreman'), { recursive: true });
  writeFileSync(resolve(path, '.foreman/context.md'), input.contextMarkdown ?? `# ${input.taskKey}\n`);
  writeFileSync(resolve(path, '.foreman/task.json'), JSON.stringify(input.taskJson ?? { key: input.taskKey }, null, 2));
  // 编译环境：Doris 的 env.sh 会 source 仓库根的 custom_env.sh（已被 .gitignore 忽略）；thirdparty/installed 不随 worktree 带过去
  // 以主仓库的 custom_env.sh 为底（JAVA_HOME / Maven / 工具链 / BUILD_TYPE 等都在里面，worktree 里没有这个被忽略的文件；
  // 2026-09-30 之前工作区只写了 DORIS_THIRDPARTY 一行，agent 编译缺环境），再叠加 build_env 的覆盖项
  const envPath = resolve(path, 'custom_env.sh');
  const mainEnv = main ? resolve(main, 'custom_env.sh') : null;
  const base = mainEnv && existsSync(mainEnv) ? readFileSync(mainEnv, 'utf8') : existsSync(envPath) ? readFileSync(envPath, 'utf8') : null;
  if (base != null || (input.buildEnv && Object.keys(input.buildEnv).length)) {
    const keys = Object.keys(input.buildEnv ?? {});
    const keep = (base ?? '').split('\n').filter((l) => l && !keys.some((k) => new RegExp(`^\\s*export\\s+${k}=`).test(l)));
    writeFileSync(envPath, [...keep, ...Object.entries(input.buildEnv ?? {}).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)].join('\n') + '\n');
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
