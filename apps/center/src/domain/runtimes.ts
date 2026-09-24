/**
 * runtime 领域：注册、心跳、离线判定、对账、序列化（来源：core-S05、api/runtimes.yaml、schema runtimes/sessions）
 */
import type { Db } from '../db.js';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events.js';
import type { Register, Heartbeat } from '@foreman/shared';
import { OFFLINE_AFTER_SECONDS, OFFLINE_ALERT_AFTER_SECONDS, ApiError } from '@foreman/shared';
import type { Notifications } from './notifications.js';

export interface RuntimeRow {
  id: string; name: string; instance_id: string | null; online: boolean; transport: string; labels: string[];
  agents: Record<string, { bin: string; version?: string | null; maxConcurrent: number }>;
  repos: Record<string, { main: string; worktreeRoot: string; pushRemote?: string }>;
  capabilities: string[]; worker_version: string | null; disk_used_ratio: string | null; disk_free_bytes: string | null;
  load: string | null; tunnel_state: string | null; tunnel_reconnects: number; tunnel_last_error: string | null;
  last_seen_at: Date | null; registered_at: Date | null; offline_since?: Date | null;
}

export class Runtimes {
  constructor(private db: Db, private clock: Clock, private events: EventBus, private notifications: Notifications) {}

  async byName(name: string): Promise<RuntimeRow | null> {
    return this.db.one<RuntimeRow>('SELECT * FROM runtimes WHERE name=$1', [name]);
  }

  /** S05 Step 11–12：注册（upsert）。同名冲突由 hub 在调用前判断（需要连接表）。 */
  async register(reg: Register): Promise<RuntimeRow> {
    const now = this.clock.now();
    const row = await this.db.tx(async (c) => {
      const r = await this.db.one<RuntimeRow>(
        `INSERT INTO runtimes (name, instance_id, online, transport, labels, agents, repos, capabilities, worker_version, disk_used_ratio, disk_free_bytes, last_seen_at, registered_at, updated_at)
         VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11)
         ON CONFLICT (name) DO UPDATE SET instance_id=EXCLUDED.instance_id, online=true, transport=EXCLUDED.transport, labels=EXCLUDED.labels,
           agents=EXCLUDED.agents, repos=EXCLUDED.repos, capabilities=EXCLUDED.capabilities, worker_version=EXCLUDED.worker_version,
           disk_used_ratio=COALESCE(EXCLUDED.disk_used_ratio, runtimes.disk_used_ratio), disk_free_bytes=COALESCE(EXCLUDED.disk_free_bytes, runtimes.disk_free_bytes),
           last_seen_at=EXCLUDED.last_seen_at, registered_at=EXCLUDED.registered_at, updated_at=EXCLUDED.updated_at
         RETURNING *`,
        [reg.name, reg.instanceId, reg.transport, reg.labels, JSON.stringify(reg.agents), JSON.stringify(reg.repos), reg.capabilities, reg.version,
          reg.disk?.usedRatio ?? null, reg.disk?.freeBytes ?? null, now], c);
      await this.events.record(c, { type: 'runtime.updated', payload: { runtime: await this.serialize(r!), change: 'registered' } });
      return r!;
    });
    this.events.flush();
    return row;
  }

  /** S05 Step 18–19：心跳刷新 */
  async heartbeat(name: string, hb: Heartbeat): Promise<RuntimeRow | null> {
    const now = this.clock.now();
    const r = await this.db.one<RuntimeRow>(
      `UPDATE runtimes SET last_seen_at=$2, disk_used_ratio=COALESCE($3, disk_used_ratio), disk_free_bytes=COALESCE($4, disk_free_bytes), load=COALESCE($5, load), online=true, updated_at=$2 WHERE name=$1 RETURNING *`,
      [name, now, hb.disk?.usedRatio ?? null, hb.disk?.freeBytes ?? null, hb.load ?? null]);
    return r;
  }

  /** S05 Step 21–24：心跳超时判离线；其上会话标失联；不改派。连续离线 5 分钟推一次告警。 */
  async checkHeartbeats(): Promise<string[]> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - OFFLINE_AFTER_SECONDS * 1000);
    const stale = await this.db.query<RuntimeRow>(`SELECT * FROM runtimes WHERE online AND (last_seen_at IS NULL OR last_seen_at < $1)`, [cutoff]);
    const went: string[] = [];
    for (const rt of stale.rows) {
      await this.db.tx(async (c) => {
        await c.query(`UPDATE runtimes SET online=false, updated_at=$2 WHERE id=$1`, [rt.id, now]);
        await c.query(`UPDATE sessions SET reachable=false, updated_at=$2 WHERE runtime_id=$1 AND state IN ('planned','running','waiting_input')`, [rt.id, now]);
        const affected = await c.query<{ key: string; id: string }>(`SELECT t.key, t.id FROM tasks t JOIN sessions s ON s.task_id=t.id WHERE s.runtime_id=$1 AND s.state IN ('planned','running','waiting_input')`, [rt.id]);
        await this.events.record(c, { type: 'runtime.updated', payload: { runtime: await this.serialize({ ...rt, online: false }), change: 'offline' } });
        for (const t of affected.rows) await this.events.record(c, { type: 'task.updated', taskId: t.id, payload: { taskKey: t.key, changed: ['reachable'], reachable: false } });
      });
      this.events.flush();
      went.push(rt.name);
    }
    // 连续离线告警（5 分钟）
    const alertCutoff = new Date(now.getTime() - OFFLINE_ALERT_AFTER_SECONDS * 1000);
    const longOffline = await this.db.query<RuntimeRow>(`SELECT * FROM runtimes WHERE NOT online AND last_seen_at IS NOT NULL AND last_seen_at <= $1`, [alertCutoff]);
    for (const rt of longOffline.rows) {
      const queued = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE state='queued' AND runtime_name=$1`, [rt.name]);
      await this.notifications.alertOnce(`${rt.name} 离线`, `${rt.name} 离线 5 分钟 · ${queued?.n ?? 0} 个任务等待中`);
    }
    return went;
  }

  /** S05 Step 16–17：对账 worker 上报的会话 */
  async reconcileSessions(name: string, sessions: Array<{ sessionId: string; state: string; agentSessionId?: string | null }>) {
    const rt = await this.byName(name);
    if (!rt) return;
    const now = this.clock.now();
    const lost: Array<{ id: string; task_id: string | null; kind: string }> = [];
    await this.db.tx(async (c) => {
      const reported = new Map(sessions.map((s) => [s.sessionId, s]));
      const active = await c.query<{ id: string; state: string; task_id: string | null; kind: string }>(`SELECT id, state, task_id, kind FROM sessions WHERE runtime_id=$1 AND state IN ('planned','running','waiting_input')`, [rt.id]);
      for (const s of active.rows) {
        const rep = reported.get(s.id);
        if (!rep) {
          await c.query(`UPDATE sessions SET state='lost', reachable=true, ended_at=$2, updated_at=$2 WHERE id=$1`, [s.id, now]);
          // 会话已经不在了，它推断出来的问题没人能回答，留在收件箱只是噪音（EX-19.1 的问题才是 origin=hook）
          await c.query(`UPDATE questions SET status='timeout' WHERE session_id=$1 AND status='open' AND origin='hook'`, [s.id]);
          if (s.task_id) lost.push({ id: s.id, task_id: s.task_id, kind: s.kind });
        } else {
          await c.query(`UPDATE sessions SET state=$2, reachable=true, agent_session_id=COALESCE($3, agent_session_id), updated_at=$4 WHERE id=$1`, [s.id, rep.state, rep.agentSessionId ?? null, now]);
        }
      }
    });
    // 善后要调 dispatch / intake，这里够不到；把失联清单交给调用方处理，否则任务会无声僵死
    return lost;
  }

  async list() {
    const r = await this.db.query<RuntimeRow>('SELECT * FROM runtimes ORDER BY name');
    return Promise.all(r.rows.map((x) => this.serialize(x)));
  }

  async runningByAgent(runtimeId: string): Promise<Record<string, number>> {
    const r = await this.db.query<{ agent: string; n: string }>(`SELECT agent, count(*) AS n FROM sessions WHERE runtime_id=$1 AND state IN ('planned','running','waiting_input') GROUP BY agent`, [runtimeId]);
    return Object.fromEntries(r.rows.map((x) => [x.agent, Number(x.n)]));
  }

  async serialize(rt: RuntimeRow) {
    const running = await this.runningByAgent(rt.id);
    const agents: Record<string, { running: number; max: number }> = {};
    for (const [k, v] of Object.entries(rt.agents ?? {})) agents[k] = { running: running[k] ?? 0, max: v.maxConcurrent };
    const sessions = Object.values(running).reduce((a, b) => a + b, 0);
    const maxSessions = Object.values(rt.agents ?? {}).reduce((a, b) => a + b.maxConcurrent, 0);
    return {
      name: rt.name,
      online: rt.online,
      transport: rt.transport,
      labels: rt.labels,
      repos: Object.keys(rt.repos ?? {}),
      agents,
      sessions,
      maxSessions,
      diskUsedRatio: rt.disk_used_ratio == null ? null : Number(rt.disk_used_ratio),
      load: rt.load == null ? null : Number(rt.load),
      workerVersion: rt.worker_version,
      tunnel: rt.transport === 'reverse-tunnel' ? { state: rt.tunnel_state ?? 'down', reconnects: rt.tunnel_reconnects, lastError: rt.tunnel_last_error } : null,
      lastSeenAt: rt.last_seen_at ? new Date(rt.last_seen_at).toISOString() : null,
    };
  }

  async detail(name: string) {
    const rt = await this.byName(name);
    if (!rt) throw new ApiError(404, 'NOT_FOUND', `runtime ${name} 不存在`);
    const base = await this.serialize(rt);
    const repos = Object.entries(rt.repos ?? {}).map(([n, v]) => ({ name: n, main: v.main, worktreeRoot: v.worktreeRoot }));
    const sess = await this.db.query<any>(`SELECT s.*, t.key AS task_key FROM sessions s LEFT JOIN tasks t ON t.id=s.task_id WHERE s.runtime_id=$1 AND s.state IN ('planned','running','waiting_input') ORDER BY s.created_at DESC`, [rt.id]);
    const rec = await this.db.one<{ n: string; bytes: string }>(`SELECT count(*) AS n, coalesce(sum(size_bytes),0) AS bytes FROM worktrees w JOIN tasks t ON t.id=w.task_id WHERE w.runtime_id=$1 AND w.state='ready' AND t.terminal_at IS NOT NULL`, [rt.id]);
    const warn = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM sessions WHERE runtime_id=$1 AND kind='candidate_scan' AND state IN ('stopped','failed') AND created_at > $2`, [rt.id, new Date(this.clock.now().getTime() - 4 * 3600_000)]);
    const warnings: Array<{ code: string; count: number }> = [];
    const cs = Number(warn.rows[0]?.n ?? 0);
    if (cs >= 3) warnings.push({ code: 'candidate_scan_failing', count: cs });
    return {
      ...base,
      repos,
      activeSessions: sess.rows.map(serializeSession),
      reclaimableWorktrees: { count: Number(rec?.n ?? 0), bytes: Number(rec?.bytes ?? 0) },
      warnings,
    };
  }
}

export function serializeSession(s: any) {
  return {
    id: s.id,
    taskKey: s.task_key ?? null,
    runtime: s.runtime_name ?? undefined,
    agent: s.agent,
    model: s.model ?? null,
    kind: s.kind,
    state: s.state,
    reachable: s.reachable,
    agentSessionId: s.agent_session_id ?? null,
    worktreePath: s.cwd ?? null,
    startedAt: s.started_at ? new Date(s.started_at).toISOString() : null,
    endedAt: s.ended_at ? new Date(s.ended_at).toISOString() : null,
    lastProgressAt: s.last_progress_at ? new Date(s.last_progress_at).toISOString() : null,
    failureReason: s.failure_reason ?? null,
    createdAt: new Date(s.created_at).toISOString(),
  };
}
