/**
 * 进程内调度器：周期作业用注入时钟；每次运行写 jobs 表。
 * 来源：architecture 2.3；S05 Step 21；S01 Step 1（后续批次注册更多作业）
 */
import type { Clock } from './clock.js';
import type { Db } from './db.js';
import type { Logger } from 'pino';

export type JobFn = () => Promise<unknown>;

export class Scheduler {
  private jobs = new Map<string, { fn: JobFn; intervalMs: number; detached: boolean; stop?: () => void }>();
  constructor(private db: Db, private clock: Clock, private log: Logger) {}

  /** detached：作业会等待 worker 回包（如 worktree-gc），不能阻塞时钟推进 */
  register(kind: string, intervalMs: number, fn: JobFn, opts?: { detached?: boolean }) {
    this.jobs.set(kind, { fn, intervalMs, detached: !!opts?.detached });
  }

  start() {
    for (const [kind, j] of this.jobs) {
      // 非 detached 作业把 Promise 交给时钟：FakeClock.advance 会等它跑完，保证"推进 5 分钟后重试已执行"是确定的
      j.stop = this.clock.every(j.intervalMs, () => (j.detached ? void this.tick(kind) : this.tick(kind)));
    }
  }

  /** 立即执行某类作业一次（测试与手动触发） */
  async tick(kind: string): Promise<{ status: string; error?: string }> {
    const j = this.jobs.get(kind);
    if (!j) throw new Error(`unknown job ${kind}`);
    const now = this.clock.now();
    let row: { id: string } | null = null;
    try { row = await this.db.one<{ id: string }>(`INSERT INTO jobs (kind, status, scheduled_at, dispatched_at, created_at) VALUES ($1,'running',$2,$2,$2) RETURNING id`, [kind, now]); }
    catch (e) { return { status: 'failed', error: String(e) }; }
    try {
      const result = await j.fn();
      const skipped = typeof result === 'object' && result !== null && (result as any).skipped;
      await this.db.query(`UPDATE jobs SET status=$2, result=$3, error_code=$4, finished_at=$5 WHERE id=$1`, [row!.id, skipped ? 'skipped' : 'succeeded', JSON.stringify(result ?? {}), skipped ? (result as any).reason ?? null : null, this.clock.now()]);
      return { status: skipped ? 'skipped' : 'succeeded' };
    } catch (e) {
      this.log.error({ err: String(e), kind }, 'job failed');
      await this.db.query(`UPDATE jobs SET status='failed', error_code='INTERNAL', error_message=$2, finished_at=$3 WHERE id=$1`, [row!.id, String(e), this.clock.now()]);
      return { status: 'failed', error: String(e) };
    }
  }

  stop() { for (const j of this.jobs.values()) j.stop?.(); }
}
