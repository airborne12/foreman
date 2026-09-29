/**
 * claude 工作区信任（2026-09-29，经用户同意）。
 *
 * claude 2.1.284 起 `--bg` 只在被信任的目录里启动，而且 git 仓库只认仓库根自己的信任，父目录的信任不继承
 * （实测：foreman-wt 已信任，其下普通目录能起，普通 git 仓库和 worktree 都报 Workspace not trusted）。
 * 平台每张单一个 worktree，都是新的 git 根，只能逐个标记。
 *
 * 边界：只对 worker 自己管理的目录写 hasTrustDialogAccepted——repos.*.worktreeRoot 之下的子目录、
 * 文本会话目录 ~/.foreman/workspace；其他路径一律不碰。worktree 回收时一并删掉对应条目。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, statSync, chmodSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep, basename } from 'node:path';

export interface TrustScope { childrenOf: string[]; exact: string[] }

export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
}

/** 路径是否归 worker 管：某个 worktreeRoot 的子目录（不含根本身），或精确列出的目录 */
export function isManagedPath(path: string, scope: TrustScope): boolean {
  const p = resolve(path);
  if (scope.exact.some((e) => resolve(e) === p)) return true;
  return scope.childrenOf.some((r) => p.startsWith(resolve(r) + sep));
}

/**
 * 标记 / 取消信任。返回是否真的改了文件。
 * 先读最新内容再写，写临时文件后 rename 替换，避免与正在运行的 claude 同时写出半截 JSON；
 * 文件解析失败时直接抛错，绝不覆盖。
 */
export function setClaudeTrust(path: string, trusted: boolean, file = claudeConfigPath()): boolean {
  const target = existsSync(file) ? realpathSync(file) : file;
  let d: Record<string, any> = {};
  if (existsSync(target)) {
    const raw = readFileSync(target, 'utf8');
    d = raw.trim() ? JSON.parse(raw) : {};
  }
  d.projects ??= {};
  const key = resolve(path);
  if (trusted) {
    const cur = d.projects[key];
    if (cur?.hasTrustDialogAccepted === true) return false;
    // 字段与 claude 自己在信任确认后写入的一致，已有条目只补信任这一项
    d.projects[key] = { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], ...(cur ?? {}), hasTrustDialogAccepted: true };
  } else {
    if (!(key in d.projects)) return false;
    delete d.projects[key];
  }
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const tmp = join(dirname(target), `.${basename(target)}.foreman-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(d, null, 2), { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
  return true;
}

export const isUntrustedError = (msg: string) => /Workspace not trusted/i.test(msg);
