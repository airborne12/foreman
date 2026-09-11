/**
 * worktree 回收执行（S05 EX-19.1；core-03 §5.2）。中心给候选清单，worker 负责 git worktree remove + 删目录。
 */
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import type { GcResult } from '@foreman/shared';

export interface GcInput {
  policy: 'retain_days' | 'high_watermark';
  dryRun: boolean;
  highWatermark: number;
  protectedTaskKeys: string[];
  candidates: Array<{ taskKey: string; path: string; terminalAt: string | null }>;
}

export function dirSize(path: string): number {
  const r = spawnSync('du', ['-sk', path], { encoding: 'utf8' });
  const kb = parseInt((r.stdout || '0').split(/\s/)[0] ?? '0', 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

export function diskUsedRatio(path: string): number | null {
  try { const s = statfsSync(path); const total = Number(s.blocks) * Number(s.bsize); const free = Number(s.bavail) * Number(s.bsize); return total > 0 ? (total - free) / total : null; } catch { return null; }
}

export function runGc(input: GcInput, opts?: { diskPath?: string; remove?: (p: string) => void }): GcResult {
  const removed: GcResult['removed'] = [];
  let freed = 0;
  const protectedSet = new Set(input.protectedTaskKeys);
  const remove = opts?.remove ?? ((p: string) => {
    const wt = spawnSync('git', ['-C', p, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
    if (wt.status === 0) spawnSync('git', ['-C', wt.stdout.trim().replace(/\/\.git.*$/, ''), 'worktree', 'remove', '--force', p], { encoding: 'utf8' });
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  });
  for (const c of input.candidates) {
    if (protectedSet.has(c.taskKey)) continue;
    if (!existsSync(c.path)) { removed.push({ taskKey: c.taskKey, path: c.path, terminalAt: c.terminalAt ?? null, bytes: 0 }); continue; }
    const bytes = dirSize(c.path);
    if (!input.dryRun) remove(c.path);
    removed.push({ taskKey: c.taskKey, path: c.path, terminalAt: c.terminalAt ?? null, bytes });
    freed += bytes;
    if (input.policy === 'high_watermark' && !input.dryRun && opts?.diskPath) {
      const ratio = diskUsedRatio(opts.diskPath);
      if (ratio != null && ratio < input.highWatermark) break;
    }
  }
  return { dryRun: input.dryRun, removed, skippedRunning: input.protectedTaskKeys.length, freedBytes: freed, diskUsedRatioAfter: opts?.diskPath ? diskUsedRatio(opts.diskPath) : null };
}
