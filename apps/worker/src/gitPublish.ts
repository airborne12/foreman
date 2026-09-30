/**
 * 平台代做 git（job kind=git-publish，2026-09-30）。
 *
 * codex 的 workspace-write 沙箱把所有 .git 目录设为只读，agent 在沙箱里无法提交、推送、建 PR（T-77 实测）。
 * 改为：agent 只改代码并申请「创建 PR」，用户批准后由 worker 在任务工作区里执行——
 * 有未提交改动就提交 → 推到用户 fork（pushRemote）的任务分支 → 向上游仓库的基线分支建 PR（已有则取回链接）。
 * worker 不在沙箱里，推送走 gh 凭据（~/.gitconfig 的 credential helper）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

export interface GitPublishArgs { path: string; repo: string; base: string; branch: string; pushRemote: string; title: string; body: string }
export interface GitPublishResult { url: string; branch: string; commit: string; created: boolean; committed: boolean }
export type Runner = (bin: string, args: string[], cwd: string) => Promise<string>;

// 异步执行：推送 doris 要一两分钟，同步调用会卡住 worker 的事件循环（2026-09-30 A-96：推送期间 session.logs 超时）
const execFileP = promisify(execFile);
const realRun: Runner = async (bin, args, cwd) => (await execFileP(bin, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout;

export class GitPublishError extends Error { constructor(public code: string, message: string) { super(message); } }

/** 从 remote 地址取 GitHub owner（https://github.com/o/r.git 或 git@github.com:o/r.git） */
export function githubOwner(url: string): string | null {
  return /github\.com[:/]([^/]+)\/[^/]+?(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? null;
}

export async function gitPublish(a: GitPublishArgs, run: Runner = realRun): Promise<GitPublishResult> {
  const git = async (...args: string[]) => (await run('git', args, a.path)).trim();
  const errText = (e: unknown) => String((e as any)?.stderr ?? (e as Error)?.message ?? e).trim().slice(0, 400);
  if (!existsSync(a.path)) throw new GitPublishError('WORKTREE_MISSING', `工作区不存在：${a.path}`);
  if (!a.pushRemote) throw new GitPublishError('NO_PUSH_REMOTE', `仓库 ${a.repo} 没有配置 pushRemote（用户 fork）`);

  // 1. 提交未提交的改动。.foreman/ 在 info/exclude 里；子模块指针不提交——构建脚本初始化依赖时会把子模块
  //    切到别的提交（T-77 的 contrib/datasketches-cpp），那不是本任务的改动
  let committed = false;
  if (await git('status', '--porcelain', '--ignore-submodules=all')) {
    await git('add', '-A');
    const subs = await (async () => { try { return (await git('config', '--file', '.gitmodules', '--get-regexp', 'path')).split('\n').map((l) => l.split(' ')[1]).filter(Boolean) as string[]; } catch { return []; } })();
    if (subs.length) await git('reset', '-q', '--', ...subs);
    if (await git('diff', '--cached', '--name-only')) {
      try { await git('commit', '-q', '-m', a.title); committed = true; }
      catch (e) { throw new GitPublishError('COMMIT_FAILED', `提交失败：${errText(e)}`); }
    }
  }
  // 2. 相对基线必须有提交，否则没东西可建 PR
  const baseRef = await (async () => { for (const r of [`refs/remotes/origin/${a.base}`, `refs/heads/${a.base}`]) { try { await git('rev-parse', '--verify', '--quiet', r); return r; } catch { /* next */ } } return null; })();
  if (baseRef && Number(await git('rev-list', '--count', `${baseRef}..HEAD`)) === 0) throw new GitPublishError('NOTHING_TO_PUBLISH', `相对基线 ${a.base} 没有任何改动，无法建 PR`);
  const commit = await git('rev-parse', 'HEAD');

  // 3. 推到 fork 的任务分支（只推本任务自己的分支，带 lease 防止覆盖别人的改动）
  try { await git('push', '--force-with-lease', a.pushRemote, `HEAD:refs/heads/${a.branch}`); }
  catch (e) { throw new GitPublishError('PUSH_FAILED', `推送到 ${a.pushRemote} 失败：${errText(e)}`); }

  // 4. 建 PR（已存在则取回）
  const owner = githubOwner(await git('remote', 'get-url', a.pushRemote));
  if (!owner) throw new GitPublishError('NO_PUSH_REMOTE', `看不出 ${a.pushRemote} 的 GitHub owner`);
  const head = `${owner}:${a.branch}`;
  try {
    const out = await run('gh', ['pr', 'create', '--repo', a.repo, '--base', a.base, '--head', head, '--title', a.title, '--body', a.body], a.path);
    const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(out)?.[0];
    if (!url) throw new GitPublishError('PR_FAILED', `gh pr create 没有返回 PR 链接：${out.slice(0, 200)}`);
    return { url, branch: a.branch, commit, created: true, committed };
  } catch (e) {
    if (e instanceof GitPublishError) throw e;
    const msg = errText(e);
    const existing = /already exists/i.test(msg) ? /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(msg)?.[0] : null;
    if (existing) return { url: existing, branch: a.branch, commit, created: false, committed };
    throw new GitPublishError('PR_FAILED', `建 PR 失败：${msg}`);
  }
}
