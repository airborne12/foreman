/**
 * 进程内假 worker：直接说 worker 协议，用于 UT 与编排里的 runtime.* 控制动作。
 */
import WebSocket from 'ws';
import { makeEnvelope, type Envelope, type Register } from '@foreman/shared';

export class FakeWorker {
  ws!: WebSocket;
  received: Envelope[] = [];
  private waiters: Array<{ pred: (e: Envelope) => boolean; resolve: (e: Envelope) => void }> = [];
  ack: Envelope | null = null;
  closeInfo: { code: number; reason: string } | null = null;
  errors: Envelope[] = [];
  /** 旁路监听（不消费 received）：自动应答器、会话脚本引擎用 */
  private listeners: Array<(e: Envelope) => void> = [];
  onAny(fn: (e: Envelope) => void) { this.listeners.push(fn); }
  /** 指令是否仍未被 expect 消费 */
  stillPending(e: Envelope) { return this.received.includes(e); }
  consume(e: Envelope) { this.received = this.received.filter((x) => x !== e); }
  /** 把随 register.ack 补发的离线指令视作收到的独立消息 */
  injectReceived(envs: Envelope[]) { for (const e of envs) this.deliver(e); }

  constructor(private wsUrl: string, private token: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${this.wsUrl}/ws/worker`, { headers: { Authorization: `Bearer ${this.token}` } });
      this.ws.on('open', () => resolve());
      this.ws.on('error', (e) => reject(e));
      this.ws.on('close', (code, reason) => { this.closeInfo = { code, reason: String(reason) }; });
      this.ws.on('message', (d) => { this.deliver(JSON.parse(String(d)) as Envelope); });
    });
  }

  private deliver(env: Envelope) {
    this.received.push(env);
    if (env.type === 'register.ack') this.ack = env;
    if (env.type === 'error') this.errors.push(env);
    const i = this.waiters.findIndex((w) => w.pred(env));
    if (i >= 0) { const w = this.waiters[i]!; this.waiters.splice(i, 1); w.resolve(env); }
    for (const l of this.listeners) { try { l(env); } catch { /* ignore */ } }
  }

  send(type: string, payload: Record<string, unknown>, ref?: string | null, id?: string) {
    const env = makeEnvelope(type, payload, { ref: ref ?? null, id });
    this.ws.send(JSON.stringify(env));
    return env;
  }

  /** 注册并等待 ack 或 error */
  async register(reg: Partial<Register> & { name: string }): Promise<Envelope> {
    const full: Register = {
      instanceId: crypto.randomUUID(), version: '0.1.0', transport: 'direct', labels: [], agents: {}, repos: {}, capabilities: [], ...reg,
    } as Register;
    const p = this.expect((e) => e.type === 'register.ack' || e.type === 'error', 5000);
    this.send('register', full as unknown as Record<string, unknown>);
    return p;
  }

  expect(pred: (e: Envelope) => boolean, timeoutMs = 5000): Promise<Envelope> {
    const hit = this.received.find(pred);
    if (hit) { this.received = this.received.filter((e) => e !== hit); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w.resolve !== resolve); reject(new Error(`timeout waiting for ${pred.toString().slice(0, 80)}`)); }, timeoutMs);
      this.waiters.push({ pred, resolve: (e) => { clearTimeout(t); this.received = this.received.filter((x) => x !== e); resolve(e); } });
    });
  }

  waitClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting close')), timeoutMs);
      this.ws.once('close', (code, reason) => { clearTimeout(t); resolve({ code, reason: String(reason) }); });
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
