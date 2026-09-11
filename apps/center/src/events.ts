/**
 * 领域事件：先写 events 表（同一事务），事务提交后广播到面板。
 * 用法：await events.emit(client, { type, taskId?, channelId?, payload }) 在事务内；
 * 事务提交后由 Db.tx 的调用方调用 events.flush()。为简化，这里采用"记录后延迟广播"：
 * emit 在事务内落库并把事件放入待广播队列，flushAfterCommit 在提交后统一广播。
 */
import type { Queryable } from './db.js';
import type { Db } from './db.js';
import type { Clock } from './clock.js';

export interface DomainEvent {
  id: string;
  seq: number;
  type: string;
  taskId?: string | null;
  channelId?: string | null;
  sessionId?: string | null;
  actor?: string;
  payload: Record<string, unknown>;
  ts: string;
  broadcast?: boolean;
}

type Listener = (e: DomainEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private pending: DomainEvent[] = [];
  constructor(private db: Db, private clock: Clock) {}

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** 在事务内落库；返回事件（尚未广播） */
  async record(client: Queryable, e: { type: string; taskId?: string | null; channelId?: string | null; sessionId?: string | null; actor?: string; payload?: Record<string, unknown>; broadcast?: boolean }): Promise<DomainEvent> {
    const row = await this.db.one<{ id: string; seq: string; created_at: Date }>(
      `INSERT INTO events (type, task_id, channel_id, session_id, actor, payload, broadcast, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, seq, created_at`,
      [e.type, e.taskId ?? null, e.channelId ?? null, e.sessionId ?? null, e.actor ?? 'system', JSON.stringify(e.payload ?? {}), e.broadcast ?? true, this.clock.now()],
      client,
    );
    const ev: DomainEvent = { id: row!.id, seq: Number(row!.seq), type: e.type, taskId: e.taskId, channelId: e.channelId, sessionId: e.sessionId, actor: e.actor ?? 'system', payload: e.payload ?? {}, ts: row!.created_at.toISOString(), broadcast: e.broadcast ?? true };
    this.pending.push(ev);
    return ev;
  }

  /** 事务提交后调用：广播所有待发事件 */
  flush() {
    const batch = this.pending; this.pending = [];
    for (const ev of batch) if (ev.broadcast !== false) for (const l of this.listeners) { try { l(ev); } catch { /* listener 错误不影响主流程 */ } }
  }
  /** 事务失败时丢弃 */
  discard() { this.pending = []; }

  /** 断线补发：seq 之后的事件（最多 500） */
  async since(seq: number): Promise<DomainEvent[]> {
    const r = await this.db.query<any>(`SELECT id, seq, type, task_id, channel_id, session_id, actor, payload, created_at FROM events WHERE seq > $1 AND broadcast ORDER BY seq LIMIT 501`, [seq]);
    return r.rows.map((x) => ({ id: x.id, seq: Number(x.seq), type: x.type, taskId: x.task_id, channelId: x.channel_id, sessionId: x.session_id, actor: x.actor, payload: x.payload, ts: new Date(x.created_at).toISOString() }));
  }
}
