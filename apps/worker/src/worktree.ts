/**
 * worktree.create 执行（S03 Step 11；worker-channel.yaml WorktreeCreate/WorktreeReady；EX-11.1）
 * - 路径 <worktreeRoot>/<taskKey>；已存在且 reuseIfExists → 直接复用
 * - 分支缺省 foreman/<taskKey>；已存在的分支直接挂载，否则从 baseBranch 新建
 * - 写入 .foreman/context.md、.foreman/task.json、.claude/settings.json（Notification 钩子）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  writeContextFiles(path, input);
  return { taskKey: input.taskKey, path, branchName, reused };
}

/** 上下文文件（每次都刷新，保证 context.md 为最新版本） */
export function writeContextFiles(path: string, input: Pick<WorktreeCreateInput, 'contextMarkdown' | 'taskJson' | 'hooks' | 'taskKey'>) {
  mkdirSync(resolve(path, '.foreman'), { recursive: true });
  writeFileSync(resolve(path, '.foreman/context.md'), input.contextMarkdown ?? `# ${input.taskKey}\n`);
  writeFileSync(resolve(path, '.foreman/task.json'), JSON.stringify(input.taskJson ?? { key: input.taskKey }, null, 2));
  mkdirSync(resolve(path, '.claude'), { recursive: true });
  const settingsPath = resolve(path, '.claude/settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) { try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { settings = {}; } }
  const hooks = input.hooks ?? { Notification: [{ matcher: 'agent_needs_input|agent_completed', hooks: [{ type: 'command', command: 'foreman-hook notify' }] }] };
  settings.hooks = { ...((settings.hooks as Record<string, unknown>) ?? {}), ...hooks };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
