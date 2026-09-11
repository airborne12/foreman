import pg from 'pg';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Queryable = pg.Pool | pg.PoolClient;

export class Db {
  readonly pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 8 });
  }
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = [], client?: Queryable) {
    return (client ?? this.pool).query<T>(sql, params as any[]);
  }
  async one<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = [], client?: Queryable): Promise<T | null> {
    const r = await this.query<T>(sql, params, client);
    return r.rows[0] ?? null;
  }
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async close() { await this.pool.end(); }

  /**
   * 迁移：0001_init 直接使用 logos/resources/database/schema.sql（设计源），
   * 后续增量迁移放在 apps/center/migrations/NNNN_*.sql。
   */
  async migrate(repoRoot = findRepoRoot()) {
    await this.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const applied = new Set((await this.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files: Array<{ name: string; path: string }> = [
      { name: '0001_init', path: resolve(repoRoot, 'logos/resources/database/schema.sql') },
    ];
    const dir = resolve(repoRoot, 'apps/center/migrations');
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) files.push({ name: f.replace(/\.sql$/, ''), path: resolve(dir, f) });
    }
    for (const f of files) {
      if (applied.has(f.name)) continue;
      const sql = readFileSync(f.path, 'utf8');
      await this.tx(async (c) => {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f.name]);
      });
    }
  }

  /** 测试模式：清空业务表并重置序列与初始数据 */
  async resetForTest() {
    await this.query(`TRUNCATE runtimes, channels, tasks, source_items, context_packs, triage_cards, sessions, worktrees,
      approvals, actions, questions, task_drafts, messages, artifacts, candidates, jobs, notifications, feishu_events, events RESTART IDENTITY CASCADE`);
    await this.query(`ALTER SEQUENCE task_key_seq RESTART WITH 231`);
    await this.query(`ALTER SEQUENCE approval_key_seq RESTART WITH 87`);
    await this.query(`UPDATE trust_counters SET mode = CASE WHEN action_type IN ('merge_release','jira_done') THEN 'locked' ELSE 'manual' END, streak = 0, threshold = 5, total_confirmed = 0, total_rejected = 0, last_confirmed_at = NULL, last_rejected_at = NULL, promoted_at = NULL`);
    await this.query(`UPDATE source_health SET status='disabled', watermark=NULL, last_success_at=NULL, last_error=NULL, consecutive_failures=0, executed_on=NULL, last_alert_at=NULL`);
  }
}

export function findRepoRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  let d = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(d, 'pnpm-workspace.yaml'))) return d;
    d = dirname(d);
  }
  return process.cwd();
}
