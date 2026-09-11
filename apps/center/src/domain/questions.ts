/**
 * 需要输入（S07 Step 13–30；EX-13.1、19.1、22.1、25.1）：ask_user 问题、面板/飞书回答、钩子推断问题、30 分钟超时。
 * 来源：mcp.yaml AskUserInput/Output；tasks.yaml postTaskMessage/Question；schema questions
 */
import type { Db, Queryable } from '../db.js';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events.js';
import type { Notifications } from './notifications.js';
import type { WorkerHub } from '../hub/workerHub.js';
import { ApiError, type CenterConfig } from '@foreman/shared';

export const QUESTION_WAIT_MINUTES = 30;
export type AskResult = { answered: boolean; answer: string | null; answeredVia: 'panel' | 'feishu' | null; reason: 'timeout' | 'task_paused' | null; questionId: string };

export class Questions {
  private waiters = new Map<string, { resolve: (r: AskResult) => void; cancel: () => void }>();
  constructor(private db: Db, private clock: Clock, private events: EventBus, private cfg: CenterConfig, private notifications: Notifications, private hub: WorkerHub) {}

  /** Step 13–18：创建问题、ask 消息、任务 waiting_input、收件箱与飞书推送 */
  async ask(session: any, input: { question: string; options?: string[]; origin?: 'mcp' | 'hook' }) {
    const now = this.clock.now();
    const q = await this.db.tx(async (c) => {
      const q = await this.db.one<any>(`INSERT INTO questions (task_id, session_id, text, options, origin, status, expires_at, asked_at) VALUES ($1,$2,$3,$4,$5,'open',$6,$7) RETURNING *`,
        [session.task_id, session.id, input.question, input.options ?? [], input.origin ?? 'mcp', new Date(now.getTime() + QUESTION_WAIT_MINUTES * 60_000), now], c);
      await c.query(`INSERT INTO messages (channel_id, task_id, session_id, kind, author, text, ref_type, ref_id, payload, created_at) VALUES ($1,$2,$3,'ask',$4,$5,'question',$6,$7,$8)`,
        [session.channel_id, session.task_id, session.id, session.agent, input.question, q.id, JSON.stringify({ options: input.options ?? [], origin: input.origin ?? 'mcp' }), now]);
      await c.query(`UPDATE tasks SET state='waiting_input', last_activity_at=$2, updated_at=$2 WHERE id=$1 AND state IN ('running','queued','waiting_input')`, [session.task_id, now]);
      await c.query(`UPDATE sessions SET state='waiting_input', last_activity_at=$2, updated_at=$2 WHERE id=$1 AND state IN ('running','waiting_input')`, [session.id, now]);
      await this.events.record(c, { type: 'inbox.new', taskId: session.task_id, payload: { itemType: 'question', item: this.serialize(q, session.task_key) } });
      await this.events.record(c, { type: 'task.updated', taskId: session.task_id, payload: { taskKey: session.task_key, changed: ['state'], state: 'waiting_input' } });
      return q;
    });
    this.events.flush();
    const n = await this.notifications.send({ kind: 'question', target: this.cfg.feishu.owner_open_id ?? 'owner', text: `[需要你回答] ${session.task_key} · ${input.question.slice(0, 500)}${input.options?.length ? `\n选项：${input.options.join(' / ')}` : ''}\n直接回复本条消息即可送入会话；面板：/tasks/${session.task_key}`, refType: 'question', refId: q.id });
    if (n.externalMessageId) await this.db.query(`UPDATE questions SET feishu_message_id=$2 WHERE id=$1`, [q.id, n.externalMessageId]);
    return q;
  }

  /** MCP ask_user 阻塞等待；超时返回 timeout，问题保持 open（EX-13.1） */
  waitFor(questionId: string, timeoutMs: number): Promise<AskResult> {
    return new Promise((resolve) => {
      const cancel = this.clock.after(timeoutMs, () => { this.waiters.delete(questionId); resolve({ answered: false, answer: null, answeredVia: null, reason: 'timeout', questionId }); });
      this.waiters.set(questionId, { resolve, cancel });
    });
  }
  hasWaiter(questionId: string) { return this.waiters.has(questionId); }

  async openFor(taskId: string, questionId?: string | null) {
    if (questionId) return this.db.one<any>('SELECT * FROM questions WHERE id=$1 AND task_id=$2', [questionId, taskId]);
    return this.db.one<any>(`SELECT * FROM questions WHERE task_id=$1 AND status='open' ORDER BY asked_at DESC LIMIT 1`, [taskId]);
  }

  /** Step 21–29：回答（面板或飞书）。返回是否唤醒了挂起的 MCP 请求 */
  async answer(q: any, answer: string, via: 'panel' | 'feishu', client?: Queryable): Promise<{ woke: boolean }> {
    const now = this.clock.now();
    const t = await this.db.one<any>('SELECT key, channel_id FROM tasks WHERE id=$1', [q.task_id], client);
    const run = async (c: Queryable) => {
      await c.query(`UPDATE questions SET status='answered', answer=$2, answered_via=$3, answered_at=$4 WHERE id=$1 AND status='open'`, [q.id, answer, via, now]);
      await c.query(`UPDATE tasks SET state='running', last_activity_at=$2, updated_at=$2 WHERE id=$1 AND state='waiting_input' AND NOT EXISTS (SELECT 1 FROM questions WHERE task_id=$1 AND status='open')`, [q.task_id, now]);
      await c.query(`UPDATE sessions SET state='running', last_activity_at=$2, updated_at=$2 WHERE id=$1 AND state='waiting_input'`, [q.session_id, now]);
      await c.query(`INSERT INTO messages (channel_id, task_id, session_id, kind, author, text, created_at) VALUES ($1,$2,$3,'system','system',$4,$5)`, [t.channel_id, q.task_id, q.session_id, `已送入会话（${via === 'feishu' ? '飞书回复' : '面板'}）`, now]);
      await this.events.record(c, { type: 'inbox.removed', taskId: q.task_id, payload: { itemType: 'question', key: q.id, reason: 'answered' } });
      await this.events.record(c, { type: 'task.updated', taskId: q.task_id, payload: { taskKey: t.key, changed: ['state'] } });
    };
    if (client) await run(client); else { await this.db.tx(run); this.events.flush(); }
    const w = this.waiters.get(q.id);
    if (w) { this.waiters.delete(q.id); w.cancel(); w.resolve({ answered: true, answer, answeredVia: via, reason: null, questionId: q.id }); return { woke: true }; }
    return { woke: false };
  }

  /** EX-19.1：钩子报告 agent_needs_input 但没有 ask_user 问题 → 取日志尾部推断问题 */
  async inferFromHook(session: any, runtimeName: string) {
    const open = await this.db.one('SELECT 1 FROM questions WHERE task_id=$1 AND status=\'open\'', [session.task_id]);
    if (open) return null;
    let text = 'agent 正在等待输入（未通过 ask_user 提问）';
    try {
      const reply = await this.hub.request(runtimeName, 'session.logs', { sessionId: session.id, limit: 20 }, 5000);
      const lines = ((reply.payload as any).lines as string[] | undefined) ?? [];
      const last = [...lines].reverse().find((l) => l && l.trim() && l.trim() !== '…');
      if (last) text = last.trim().slice(0, 500);
    } catch { /* 取不到日志用默认文案 */ }
    const t = await this.db.one<any>('SELECT key, channel_id FROM tasks WHERE id=$1', [session.task_id]);
    return this.ask({ ...session, task_key: t.key, channel_id: t.channel_id }, { question: text, origin: 'hook' });
  }

  /** 飞书回复事件（Step 22–30；EX-22.1、EX-25.1）：按 parent_id 匹配问题或审批消息 */
  async onFeishuReply(ev: { messageId: string; parentId: string | null; senderOpenId: string; text: string }, resume: (taskId: string, text: string) => Promise<unknown>) {
    const owner = this.cfg.feishu.owner_open_id ?? 'owner';
    const reply = (text: string, refType: 'question' | 'approval' | null = null, refId: string | null = null) => this.notifications.send({ kind: 'reply', target: owner, text, replyTo: ev.messageId, refType, refId });
    if (ev.senderOpenId !== owner || !ev.parentId) return { handled: 'ignored', reason: 'not_owner_or_no_parent' };
    const q = await this.db.one<any>('SELECT q.*, t.key AS task_key FROM questions q JOIN tasks t ON t.id=q.task_id WHERE q.feishu_message_id=$1', [ev.parentId]);
    if (q) {
      if (q.status === 'open') {
        const r = await this.answer(q, ev.text, 'feishu');
        await this.appendUserReply(q.task_id, q.session_id, ev.text, 'feishu');
        if (!r.woke) await resume(q.task_id, ev.text);
        await reply(`已送入 ${q.task_key} 的会话`, 'question', q.id);
        return { handled: 'answered', woke: r.woke };
      }
      // EX-25.1：已被另一通道回答 → 作为补充送入会话
      const at = q.answered_at ? new Date(q.answered_at).toISOString().slice(11, 16) : '';
      await this.appendUserReply(q.task_id, q.session_id, ev.text, 'feishu');
      await resume(q.task_id, ev.text);
      await reply(`该问题已于 ${at} 在面板回复，本条已作为补充送入 ${q.task_key} 的会话`, 'question', q.id);
      return { handled: 'supplement' };
    }
    const a = await this.db.one<any>('SELECT * FROM approvals WHERE feishu_message_id=$1', [ev.parentId]);
    if (a) { await reply(`${a.key} 是待拍板/审批消息，请用 ✅/❌ 操作；修改请到面板`, 'approval', a.id); return { handled: 'ignored', reason: 'approval_message' }; }
    return { handled: 'ignored', reason: 'no_match' };
  }

  async appendUserReply(taskId: string, sessionId: string | null, text: string, via: 'panel' | 'feishu', client?: Queryable) {
    const t = await this.db.one<any>('SELECT key, channel_id FROM tasks WHERE id=$1', [taskId], client);
    const m = await this.db.one<any>(`INSERT INTO messages (channel_id, task_id, session_id, kind, author, text, payload, delivery, delivered_at, created_at) VALUES ($1,$2,$3,'user_reply','user',$4,$5,'delivered',$6,$6) RETURNING *`, [t.channel_id, taskId, sessionId, text, JSON.stringify({ via }), this.clock.now()], client);
    return m;
  }

  serialize(q: any, taskKey: string) {
    return { id: q.id, taskKey, sessionId: q.session_id, text: q.text, options: q.options ?? [], origin: q.origin, status: q.status, answer: q.answer ?? null, answeredVia: q.answered_via ?? null, askedAt: new Date(q.asked_at).toISOString(), answeredAt: q.answered_at ? new Date(q.answered_at).toISOString() : null, expiresAt: q.expires_at ? new Date(q.expires_at).toISOString() : null };
  }

  async listOpen() {
    const rows = await this.db.query<any>(`SELECT q.*, t.key AS task_key FROM questions q JOIN tasks t ON t.id=q.task_id WHERE q.status='open' ORDER BY q.asked_at`);
    return rows.rows.map((q) => this.serialize(q, q.task_key));
  }

  static apiError(code: 'QUESTION_ALREADY_ANSWERED') { return new ApiError(409, code); }
}
