/**
 * worktree 生命周期（来源：core-03 §5.2；S05 EX-19.1；worker-channel WorktreeGc/GcResult）
 * 中心只决定"删哪些"，删除由 worker 执行并回报。
 */
import type { Db } from '../db.js';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events.js';
import type { GcResult } from '@foreman/shared';

export interface GcPlan {
  policy: 'retain_days' | 'high_watermark';
  dryRun: boolean;
  retainDays: number;
  highWatermark: number;
  protectedTaskKeys: string[];
  candidates: Array<{ taskKey: string; path: string; terminalAt: string | null }>;
}

export class Worktrees {
  constructor(private db: Db, private clock: Clock, private events: EventBus, private cfg: { retain_days: number; disk_high_watermark: number }) {}

  /** 生成回收计划：retain_days 只选终态超过 N 天；high_watermark 选所有终态（从最老起） */
  async plan(runtimeId: string, policy: GcPlan['policy'], dryRun: boolean): Promise<GcPlan> {
    const now = this.clock.now();
    const protectedRows = await this.db.query<{ key: string }>(
      `SELECT DISTINCT t.key FROM worktrees w JOIN tasks t ON t.id=w.task_id WHERE w.runtime_id=$1 AND w.state='ready' AND t.terminal_at IS NULL`, [runtimeId]);
    const cutoff = new Date(now.getTime() - this.cfg.retain_days * 86400_000);
    const cand = await this.db.query<{ key: string; path: string; terminal_at: Date | null }>(
      policy === 'retain_days'
        ? `SELECT t.key, w.path, t.terminal_at FROM worktrees w JOIN tasks t ON t.id=w.task_id WHERE w.runtime_id=$1 AND w.state='ready' AND t.terminal_at IS NOT NULL AND t.terminal_at <= $2 ORDER BY t.terminal_at ASC`
        : `SELECT t.key, w.path, t.terminal_at FROM worktrees w JOIN tasks t ON t.id=w.task_id WHERE w.runtime_id=$1 AND w.state='ready' AND t.terminal_at IS NOT NULL ORDER BY t.terminal_at ASC`,
      policy === 'retain_days' ? [runtimeId, cutoff] : [runtimeId]);
    return {
      policy, dryRun,
      retainDays: this.cfg.retain_days,
      highWatermark: this.cfg.disk_high_watermark,
      protectedTaskKeys: protectedRows.rows.map((r) => r.key),
      candidates: cand.rows.map((r) => ({ taskKey: r.key, path: r.path, terminalAt: r.terminal_at ? new Date(r.terminal_at).toISOString() : null })),
    };
  }

  /** worker 回报后落库：标 removed，写任务线程事件 */
  async applyResult(runtimeId: string, result: GcResult) {
    if (result.dryRun) return;
    const now = this.clock.now();
    await this.db.tx(async (c) => {
      for (const r of result.removed) {
        const t = await this.db.one<{ id: string; channel_id: string }>('SELECT id, channel_id FROM tasks WHERE key=$1', [r.taskKey], c);
        const upd = await c.query(`UPDATE worktrees SET state='removed', removed_at=$3 WHERE runtime_id=$1 AND path=$2 AND state<>'removed'`, [runtimeId, r.path, now]);
        // 已回收过的路径（worker 重复上报）不再重复写事件
        if (t && upd.rowCount) {
          await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [t.channel_id, t.id, `worktree 已回收（${result.dryRun ? '演练' : ''}${r.path}）`, now]);
          await this.events.record(c, { type: 'thread.event', taskId: t.id, payload: { taskKey: r.taskKey, text: `worktree 已回收：${r.path}` } });
        }
      }
      if (result.diskUsedRatioAfter != null) await c.query(`UPDATE runtimes SET disk_used_ratio=$2, updated_at=$3 WHERE id=$1`, [runtimeId, result.diskUsedRatioAfter, now]);
    });
    this.events.flush();
  }
}
