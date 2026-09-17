/**
 * worker 通道（/ws/worker）。来源：worker-channel.yaml；S05 Step 10–17。
 * - 连接需 Bearer workerToken，错误关闭码 4001
 * - 5 秒内必须 register
 * - 同名不同 instanceId 且旧连接活跃 → RUNTIME_NAME_CONFLICT
 * - 指令带 commandId；等待回复用 ref 关联
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { Envelope, WORKER_TO_CENTER, CENTER_TO_WORKER, makeEnvelope, semverGte, MIN_WORKER_VERSION, HEARTBEAT_SECONDS, REGISTER_TIMEOUT_MS, type Register } from '@foreman/shared';
import type { Runtimes } from '../domain/runtimes.js';
import type { Worktrees } from '../domain/worktrees.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db.js';
import type { Logger } from 'pino';

interface Conn { ws: WebSocket; name: string; instanceId: string; runtimeId: string; executed: Map<string, Envelope> }

type CommandHandler = (conn: Conn, env: Envelope) => Promise<void> | void;

export class WorkerHub {
  readonly wss = new WebSocketServer({ noServer: true });
  private conns = new Map<string, Conn>();
  private waiters = new Map<string, { resolve: (e: Envelope) => void; reject: (e: Error) => void; cancel: () => void }>();
  /** 离线期间排队的指令（S05 Step 13 pendingCommands） */
  private pending = new Map<string, Envelope[]>();
  /** 外部（后续批次）注册的 worker→center 消息处理器 */
  private handlers = new Map<string, CommandHandler>();
  /** 测试/观测：每条下发的指令 */
  readonly sentLog: Array<{ name: string; env: Envelope }> = [];
  /** runtime 注册完成后的钩子（补派排队作业等）；replayed 为随 ack 补发的离线指令 */
  private registeredHooks: Array<(name: string, replayed: Envelope[]) => Promise<void> | void> = [];
  /** 对账发现会话失联后的钩子：本类够不到 dispatch / intake，善后交给接线层，否则任务会无声僵死 */
  private sessionsLostHooks: Array<(name: string, lost: Array<{ id: string; task_id: string | null; kind: string }>) => Promise<void> | void> = [];

  constructor(
    private deps: { db: Db; clock: Clock; runtimes: Runtimes; worktrees: Worktrees; workerToken: string; log: Logger; highWatermark: number },
  ) {}

  on(type: string, h: CommandHandler) { this.handlers.set(type, h); }
  onRegistered(h: (name: string, replayed: Envelope[]) => Promise<void> | void) { this.registeredHooks.push(h); }
  onSessionsLost(h: (name: string, lost: Array<{ id: string; task_id: string | null; kind: string }>) => Promise<void> | void) { this.sessionsLostHooks.push(h); }

  isOnline(name: string) { return this.conns.has(name); }

  handleUpgrade(req: IncomingMessage, socket: any, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const auth = req.headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== this.deps.workerToken) {
      this.rawSend(ws, makeEnvelope('error', { code: 'AUTH_INVALID', message: 'token 无效', retryable: false }));
      ws.close(4001, 'AUTH_INVALID');
      // S05 EX-10.1：记录来源与失败次数（不广播）
      void this.deps.db.query(`INSERT INTO events (type, actor, payload, broadcast, created_at) VALUES ('worker.auth_failed','worker',$1,false,$2)`, [JSON.stringify({ remote: req.socket.remoteAddress ?? null }), this.deps.clock.now()]).catch(() => undefined);
      return;
    }
    let conn: Conn | null = null;
    const regTimer = this.deps.clock.after(REGISTER_TIMEOUT_MS, () => { if (!conn) ws.close(4002, 'REGISTER_TIMEOUT'); });
    ws.on('message', async (data) => {
      let env: Envelope;
      try { env = Envelope.parse(JSON.parse(String(data))); } catch (e) { this.rawSend(ws, makeEnvelope('error', { code: 'VALIDATION', message: String(e) })); return; }
      try {
        if (!conn) {
          if (env.type !== 'register') { this.rawSend(ws, makeEnvelope('error', { code: 'UNKNOWN_COMMAND', message: '需先 register' }, { ref: env.id })); return; }
          regTimer();
          conn = await this.register(ws, env);
          return;
        }
        await this.dispatch(conn, env);
      } catch (e) {
        this.deps.log.error({ err: String(e), type: env.type }, 'worker message failed');
        this.rawSend(ws, makeEnvelope('error', { code: 'INTERNAL', message: String(e) }, { ref: env.id }));
      }
    });
    ws.on('close', () => { if (conn && this.conns.get(conn.name)?.ws === ws) this.conns.delete(conn.name); });
  }

  private async register(ws: WebSocket, env: Envelope): Promise<Conn | null> {
    const parsed = WORKER_TO_CENTER.register.safeParse(env.payload);
    if (!parsed.success) { this.rawSend(ws, makeEnvelope('error', { code: 'VALIDATION', message: parsed.error.message }, { ref: env.id })); ws.close(4003, 'VALIDATION'); return null; }
    const reg: Register = parsed.data;
    if (!semverGte(reg.version, MIN_WORKER_VERSION)) {
      this.rawSend(ws, makeEnvelope('error', { code: 'VERSION_UNSUPPORTED', message: `worker ${reg.version} < ${MIN_WORKER_VERSION}`, retryable: false }, { ref: env.id }));
      ws.close(4004, 'VERSION_UNSUPPORTED');
      return null;
    }
    const existing = this.conns.get(reg.name);
    if (existing && existing.ws.readyState === WebSocket.OPEN && existing.instanceId !== reg.instanceId) {
      this.rawSend(ws, makeEnvelope('error', { code: 'RUNTIME_NAME_CONFLICT', message: `runtime ${reg.name} 已由另一实例连接`, retryable: false }, { ref: env.id }));
      ws.close(4005, 'RUNTIME_NAME_CONFLICT');
      return null;
    }
    if (existing) { try { existing.ws.close(4006, 'REPLACED'); } catch { /* ignore */ } }
    const row = await this.deps.runtimes.register(reg);
    const conn: Conn = { ws, name: reg.name, instanceId: reg.instanceId, runtimeId: row.id, executed: existing?.executed ?? new Map() };
    this.conns.set(reg.name, conn);
    const pendingCommands = this.pending.get(reg.name) ?? [];
    this.pending.delete(reg.name);
    this.rawSend(ws, makeEnvelope('register.ack', { runtimeId: row.id, heartbeatSeconds: HEARTBEAT_SECONDS, pendingCommands }, { ref: env.id }));
    for (const p of pendingCommands) this.sentLog.push({ name: reg.name, env: p });
    this.deps.log.info({ runtime: reg.name, transport: reg.transport }, 'runtime registered');
    // 钩子（补派排队作业等）异步执行：先让 onConnection 记下 conn，否则 ack 后立刻到达的心跳会被当作"未注册"丢弃
    setImmediate(() => { void (async () => { for (const h of this.registeredHooks) { try { await h(reg.name, pendingCommands); } catch (e) { this.deps.log.error({ err: String(e) }, 'onRegistered hook failed'); } } })(); });
    return conn;
  }

  private async dispatch(conn: Conn, env: Envelope) {
    try {
      await this.handle(conn, env);
    } finally {
      // 回复类消息：处理并落库之后再唤醒等待者，避免调用方读到未提交状态
      if (env.ref && this.waiters.has(env.ref)) {
        const w = this.waiters.get(env.ref)!; this.waiters.delete(env.ref); w.cancel(); w.resolve(env);
      }
    }
  }

  private async handle(conn: Conn, env: Envelope) {
    switch (env.type) {
      case 'heartbeat': {
        const hb = WORKER_TO_CENTER.heartbeat.parse(env.payload);
        const rt = await this.deps.runtimes.heartbeat(conn.name, hb);
        if (rt && hb.disk?.usedRatio != null && hb.disk.usedRatio >= this.deps.highWatermark) await this.triggerGc(conn, 'high_watermark', false);
        return;
      }
      case 'session.list': {
        const l = WORKER_TO_CENTER['session.list'].parse(env.payload);
        const lost = await this.deps.runtimes.reconcileSessions(conn.name, l.sessions);
        if (lost?.length) for (const h of this.sessionsLostHooks) await h(conn.name, lost);
        return;
      }
      case 'worktree.gc.result': {
        const r = WORKER_TO_CENTER['worktree.gc.result'].parse(env.payload);
        await this.deps.worktrees.applyResult(conn.runtimeId, r);
        return;
      }
      case 'error': {
        this.deps.log.warn({ runtime: conn.name, payload: env.payload }, 'worker error');
        const h = this.handlers.get('error'); if (h) await h(conn, env);
        return;
      }
      default: {
        const h = this.handlers.get(env.type);
        if (h) { await h(conn, env); return; }
        if (!(env.type in WORKER_TO_CENTER)) this.rawSend(conn.ws, makeEnvelope('error', { code: 'UNKNOWN_COMMAND', message: env.type }, { ref: env.id }));
      }
    }
  }

  async triggerGc(conn: Conn, policy: 'retain_days' | 'high_watermark', dryRun: boolean, timeoutMs = 30_000) {
    const plan = await this.deps.worktrees.plan(conn.runtimeId, policy, dryRun);
    const reply = await this.request(conn.name, 'worktree.gc', plan as unknown as Record<string, unknown>, timeoutMs);
    return WORKER_TO_CENTER['worktree.gc.result'].parse(reply.payload);
  }

  /** 下发指令；离线则入 pending 队列 */
  send(name: string, type: keyof typeof CENTER_TO_WORKER | string, payload: Record<string, unknown>, opts?: { id?: string }): Envelope {
    const env = makeEnvelope(type, payload, { id: opts?.id, ts: this.deps.clock.now().toISOString() });
    const conn = this.conns.get(name);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      this.rawSend(conn.ws, env);
      this.sentLog.push({ name, env });
    } else {
      const q = this.pending.get(name) ?? []; q.push(env); this.pending.set(name, q);
    }
    return env;
  }

  /** 下发并等待 ref 回复 */
  request(name: string, type: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<Envelope> {
    const env = this.send(name, type, payload);
    return new Promise((resolve, reject) => {
      const cancel = this.deps.clock.after(timeoutMs, () => { this.waiters.delete(env.id); reject(new Error(`timeout waiting reply for ${type}`)); });
      this.waiters.set(env.id, { resolve, reject, cancel });
    });
  }

  queuedFor(name: string) { return this.pending.get(name) ?? []; }

  private rawSend(ws: WebSocket, env: Envelope) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env)); }

  closeAll() { for (const c of this.conns.values()) c.ws.close(1001, 'shutdown'); this.conns.clear(); this.wss.close(); }
}
