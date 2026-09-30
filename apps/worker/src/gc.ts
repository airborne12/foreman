/**
 * worktree 回收执行（S05 EX-19.1；core-03 §5.2）。中心给候选清单，worker 负责 git worktree remove + 删目录。
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statfsSync } from 'node:fs';
import type { GcResult } from '@foreman/shared';

export interface GcInput {
  policy: 'retain_days' | 'high_watermark';
  dryRun: boolean;
  highWatermark: number;
  protectedTaskKeys: string[];
  candidates: Array<{ taskKey: string; path: string; terminalAt: string | null }>;
}

// 全部异步：doris worktree 几十 GB、几十万文件，du / worktree remove / 删目录同步做会卡住 worker 的事件循环
const execFileP = promisify(execFile);
const run = async (bin: string, args: string[]) => { try { return (await execFileP(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout; } catch { return null; } };

export async function dirSize(path: string): Promise<number> {
  const out = await run('du', ['-sk', path]);
  const kb = parseInt((out || '0').split(/\s/)[0] ?? '0', 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

export function diskUsedRatio(path: string): number | null {
  try { const s = statfsSync(path); const total = Number(s.blocks) * Number(s.bsize); const free = Number(s.bavail) * Number(s.bsize); return total > 0 ? (total - free) / total : null; } catch { return null; }
}

export async function runGc(input: GcInput, opts?: { diskPath?: string; remove?: (p: string) => void | Promise<void>; onRemoved?: (p: string) => void }): Promise<GcResult> {
  const removed: GcResult['removed'] = [];
  let freed = 0;
  const protectedSet = new Set(input.protectedTaskKeys);
  const remove = opts?.remove ?? (async (p: string) => {
    const common = await run('git', ['-C', p, 'rev-parse', '--git-common-dir']);
    if (common != null) await run('git', ['-C', common.trim().replace(/\/\.git.*$/, ''), 'worktree', 'remove', '--force', p]);
    if (existsSync(p)) await rm(p, { recursive: true, force: true });
  });
  for (const c of input.candidates) {
    if (protectedSet.has(c.taskKey)) continue;
    if (!existsSync(c.path)) { removed.push({ taskKey: c.taskKey, path: c.path, terminalAt: c.terminalAt ?? null, bytes: 0 }); continue; }
    const bytes = await dirSize(c.path);
    if (!input.dryRun) { await remove(c.path); opts?.onRemoved?.(c.path); }
    removed.push({ taskKey: c.taskKey, path: c.path, terminalAt: c.terminalAt ?? null, bytes });
    freed += bytes;
    if (input.policy === 'high_watermark' && !input.dryRun && opts?.diskPath) {
      const ratio = diskUsedRatio(opts.diskPath);
      if (ratio != null && ratio < input.highWatermark) break;
    }
  }
  return { dryRun: input.dryRun, removed, skippedRunning: input.protectedTaskKeys.length, freedBytes: freed, diskUsedRatioAfter: opts?.diskPath ? diskUsedRatio(opts.diskPath) : null };
}
