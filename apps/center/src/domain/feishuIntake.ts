/**
 * 飞书显式入库与候选扫描（S02）
 * 来源：core-S02-feishu-intake.md（Step 1–17 入库、Step 18–30 候选；EX-4.1/5.1/8.1/13.1/23.1/26.1）
 * 事件来自 lark-cli 长连接（测试用 /__test/lark/emit 回放）。
 */
import type { Db, Queryable } from '../db.js';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events.js';
import type { FeishuAdapter, FeishuMessage } from '../adapters/feishu.js';
import type { Notifications } from './notifications.js';
import type { Tasks } from './tasks.js';
import type { Intake } from './intake.js';
import type { Dispatch } from './dispatch.js';
import { ApiError, type CenterConfig } from '@foreman/shared';

/** 归一化后的入库事件（S02 Step 3） */
export interface IntakeEvent {
  type: 'reaction' | 'mention' | 'message';
  eventId: string;
  messageId: string;
  chatId: string | null;
  operatorType: string;
  operatorOpenId: string;
  emoji?: string | null;
  text?: string | null;
  mentions?: string[];
  quotedMessageId?: string | null;
}

/** lark-cli 事件（原始 header/event 结构或编排里的扁平结构）→ IntakeEvent */
export function parseFeishuEvent(raw: string | Record<string, any>): IntakeEvent | null {
  let j: Record<string, any>;
  if (typeof raw === 'string') { try { j = JSON.parse(raw); } catch { return null; } } else j = raw;
  const type = String(j.header?.event_type ?? j.type ?? j.event_type ?? '');
  const eventId = String(j.header?.event_id ?? j.event_id ?? '');
  const e = j.event ?? j;
  if (type.startsWith('im.message.reaction')) {
    return {
      type: 'reaction', eventId,
      messageId: String(e.message_id ?? ''),
      chatId: e.chat_id ?? null,
      operatorType: String(e.operator_type ?? 'user'),
      operatorOpenId: String(e.user_id?.open_id ?? e.operator_open_id ?? e.operator?.open_id ?? ''),
      emoji: e.reaction_type?.emoji_type ?? e.emoji ?? null,
    };
  }
  if (type.startsWith('im.message.receive')) {
    const m = e.message ?? e;
    const mentions = (m.mentions ?? []).map((x: any) => (typeof x === 'string' ? x : x.id?.open_id ?? x.open_id ?? ''));
    return {
      type: mentions.length ? 'mention' : 'message', eventId,
      messageId: String(m.message_id ?? ''),
      chatId: m.chat_id ?? null,
      operatorType: String(e.sender?.sender_type ?? e.operator_type ?? 'user'),
      operatorOpenId: String(e.sender?.sender_id?.open_id ?? e.sender_open_id ?? e.operator_open_id ?? ''),
      text: typeof m.content === 'string' ? safeText(m.content) : (m.text ?? e.text ?? null),
      mentions,
      quotedMessageId: m.parent_id ?? m.root_id ?? e.parent_id ?? null,
    };
  }
  return null;
}
function safeText(content: string) { try { const c = JSON.parse(content); return c.text ?? content; } catch { return content; } }

export type IgnoreReason = 'not_user' | 'not_owner' | 'emoji_mismatch' | 'not_bot' | 'duplicate' | 'unsupported';

export class FeishuIntake {
  constructor(
    private db: Db, private clock: Clock, private events: EventBus, private cfg: CenterConfig,
    private feishu: FeishuAdapter | null, private tasks: Tasks, private intake: Intake,
    private notifications: Notifications, private dispatch: Dispatch,
  ) {}

  private owner() { return this.cfg.feishu.owner_open_id ?? 'owner'; }
  private bot() { return this.cfg.feishu.bot_open_id ?? 'ou_bot'; }

  /** S02 Step 3–4：落事件、过滤、去重、入库 */
  async onEvent(raw: string | Record<string, any>): Promise<{ handled: 'intaken' | 'existing' | 'ignored'; reason?: IgnoreReason; taskKey?: string }> {
    const ev = parseFeishuEvent(raw);
    if (!ev) return { handled: 'ignored', reason: 'unsupported' };
    const now = this.clock.now();
    const ins = await this.db.query(`INSERT INTO feishu_events (event_id, event_type, message_id, operator_open_id, raw, received_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (event_id) DO NOTHING`,
      [ev.eventId || `auto-${now.getTime()}`, ev.type, ev.messageId, ev.operatorOpenId, JSON.stringify(raw), now]);
    if (ins.rowCount === 0) return { handled: 'ignored', reason: 'duplicate' };

    const reason = this.filter(ev);
    if (reason) { await this.markEvent(ev.eventId, 'ignored', reason); return { handled: 'ignored', reason }; }

    const targetId = ev.type === 'mention' ? (ev.quotedMessageId ?? ev.messageId) : ev.messageId;
    const supplement = ev.type === 'mention' ? (ev.text ?? '').replace(/@\S+\s*/g, '').trim() : '';
    const r = await this.intakeMessage({ messageId: targetId, chatId: ev.chatId, supplement });
    await this.markEvent(ev.eventId, 'processed', null);
    return { handled: r.created ? 'intaken' : 'existing', taskKey: r.taskKey };
  }

  /** S02 Step 4 / EX-4.1：只认 owner 本人用配置表情或 @ 机器人 */
  filter(ev: IntakeEvent): IgnoreReason | null {
    if (ev.operatorType !== 'user') return 'not_user';
    if (ev.operatorOpenId !== this.owner()) return 'not_owner';
    if (ev.type === 'reaction') return ev.emoji === this.cfg.feishu.intake_emoji ? null : 'emoji_mismatch';
    if (ev.type === 'mention') return (ev.mentions ?? []).includes(this.bot()) ? null : 'not_bot';
    return 'unsupported';
  }

  private async markEvent(eventId: string, handled: 'processed' | 'ignored' | 'failed', reason: string | null) {
    await this.db.query(`UPDATE feishu_events SET handled=$2, ignore_reason=$3, processed_at=$4 WHERE event_id=$1`, [eventId, handled, reason, this.clock.now()]);
  }

  /** S02 Step 5–17：去重 → 拉上下文 → 建任务 → 回帖 → 代码定位 */
  async intakeMessage(input: { messageId: string; chatId?: string | null; supplement?: string; candidateText?: string | null }): Promise<{ taskKey: string; created: boolean }> {
    const now = this.clock.now();
    const existing = await this.db.one<{ task_id: string | null }>(`SELECT task_id FROM source_items WHERE source_type='feishu' AND external_id=$1`, [input.messageId]);
    if (existing?.task_id) return this.onDuplicate(existing.task_id, input.messageId);

    // Step 7–10：读原消息与前后各 20 条；失败则降级（EX-8.1）
    let ctx: { message: FeishuMessage; context: FeishuMessage[]; chatName: string; sender: string } | null = null;
    let partial = false;
    try {
      if (!this.feishu) throw new Error('飞书未启用');
      ctx = await this.feishu.fetchContext({ chatId: input.chatId ?? null, messageId: input.messageId, before: 20, after: 20 });
    } catch { partial = true; }

    const sourceText = ctx?.message.text ?? input.candidateText ?? `（飞书消息 ${input.messageId}，上下文读取失败）`;
    const summary = [ctx ? `${ctx.chatName} · ${ctx.message.senderOpenId}` : `飞书消息 ${input.messageId}`, input.supplement].filter(Boolean).join(' · ');
    const conversation = (ctx?.context ?? []).map((m) => ({ messageId: m.messageId, sender: m.senderOpenId, text: m.text, at: m.createdAt }));

    const created = await this.db.tx(async (c) => {
      const ch = await this.tasks.ensureChannel(this.cfg.source_channels.feishu ?? 'feishu', { kind: 'source_default', sourceType: 'feishu', title: '飞书' }, c);
      const key = (await this.db.one<{ k: string }>(`SELECT 'T-' || nextval('task_key_seq') AS k`, [], c))!.k;
      const t = await this.db.one<any>(
        `INSERT INTO tasks (key, channel_id, title, state, kind, source_type, source_ref, repo_name, repo_source, last_activity_at, created_at, updated_at)
         VALUES ($1,$2,$3,'triaging','code','feishu',$4,NULL,'llm',$5,$5,$5) RETURNING *`,
        [key, ch.id, (input.supplement || sourceText).slice(0, 200), input.messageId, now], c);
      await c.query(`INSERT INTO source_items (source_type, external_id, task_id, raw, seen_at) VALUES ('feishu',$1,$2,$3,$4)
        ON CONFLICT (source_type, external_id) DO UPDATE SET task_id=EXCLUDED.task_id, seen_at=EXCLUDED.seen_at`,
        [input.messageId, t.id, JSON.stringify({ chatId: input.chatId ?? ctx?.message.chatId ?? null, supplement: input.supplement ?? '' }), now]);
      await c.query(`INSERT INTO context_packs (task_id, summary, source_text, conversation, partial, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [t.id, summary, sourceText, JSON.stringify(conversation), partial, now]);
      const m = await this.db.one<any>(`INSERT INTO messages (channel_id, task_id, kind, author, text, payload, created_at) VALUES ($1,$2,'system','system',$3,'{}',$4) RETURNING id`,
        [ch.id, t.id, `来自飞书 · ${ctx?.chatName ?? input.chatId ?? '私聊'} · ${input.messageId}${partial ? '（上下文读取失败，稍后重试）' : ''}`, now], c);
      await this.events.record(c, { type: 'thread.created', taskId: t.id, channelId: ch.id, payload: { task: await this.tasks.serializeSummary(t, ch.slug), channel: ch.slug } });
      return { task: t, firstMessageId: m!.id };
    });
    this.events.flush();

    // Step 12–14：原消息下回帖（失败不影响任务，EX-13.1）
    const key = created.task.key;
    const text = `已收录为 ${key}${partial ? '（上下文读取失败，稍后重试）' : ''} · 面板 /c/${this.cfg.source_channels.feishu ?? 'feishu'}/t/${key}`;
    const n = await this.notifications.send({ kind: 'intake_ack', target: this.owner(), text, replyTo: input.messageId, refType: 'task', refId: created.task.id });
    if (n.status !== 'sent') await this.db.query(`UPDATE messages SET payload = payload || '{"feishu_ack_failed":true}'::jsonb WHERE id=$1`, [created.firstMessageId]);

    if (partial) {
      await this.db.query(`INSERT INTO jobs (kind, status, args, dedupe_key, scheduled_at, created_at) VALUES ('context-retry','queued',$1,$2,$3,$4)`,
        [JSON.stringify({ taskId: created.task.id, messageId: input.messageId, chatId: input.chatId ?? null }), `context-retry:${created.task.id}`, new Date(now.getTime() + 5 * 60_000), now]);
    }

    // Step 17：进入 S01 Step 12 起的代码定位与分流卡
    await this.intake.scheduleCodeLocate(created.task.id);
    return { taskKey: key, created: true };
  }

  /** EX-5.1：同一消息重复标记 */
  private async onDuplicate(taskId: string, messageId: string): Promise<{ taskKey: string; created: boolean }> {
    const now = this.clock.now();
    const t = await this.db.one<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1`, [taskId]);
    await this.notifications.send({ kind: 'intake_ack', target: this.owner(), text: `已存在 ${t.key} · 面板 /c/${t.channel_slug}/t/${t.key}`, replyTo: messageId, refType: 'task', refId: taskId });
    if (t.state === 'paused' || t.state === 'done') {
      await this.db.tx(async (c) => {
        await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','user',$3,$4)`, [t.channel_id, taskId, '用户再次标记该消息，是否恢复这个任务？', now]);
        await this.events.record(c, { type: 'thread.event', taskId, payload: { taskKey: t.key, text: '用户再次标记' } });
        await this.events.record(c, { type: 'inbox.new', taskId, payload: { itemType: 'failure', item: { key: t.key, title: t.title, question: '是否恢复', queueReason: '用户再次标记，是否恢复' } } });
      });
      this.events.flush();
    }
    return { taskKey: t.key, created: false };
  }

  /** 调度器 context-retry：EX-8.1 5 分钟后补齐，最多 3 次 */
  async retryContext() {
    const now = this.clock.now();
    const due = await this.db.query<any>(`SELECT * FROM jobs WHERE kind='context-retry' AND status='queued' AND scheduled_at <= $1 ORDER BY created_at`, [now]);
    let fixed = 0;
    for (const job of due.rows) {
      const args = job.args as { taskId: string; messageId: string; chatId: string | null };
      try {
        if (!this.feishu) throw new Error('飞书未启用');
        const ctx = await this.feishu.fetchContext({ chatId: args.chatId, messageId: args.messageId, before: 20, after: 20 });
        const conversation = ctx.context.map((m) => ({ messageId: m.messageId, sender: m.senderOpenId, text: m.text, at: m.createdAt }));
        await this.db.query(`UPDATE context_packs SET source_text=$2, summary=$3, conversation=$4, partial=false, version=version+1, updated_at=$5 WHERE task_id=$1`,
          [args.taskId, ctx.message.text, `${ctx.chatName} · ${ctx.message.senderOpenId}`, JSON.stringify(conversation), now]);
        await this.db.query(`UPDATE jobs SET status='succeeded', attempts=attempts+1, finished_at=$2 WHERE id=$1`, [job.id, now]);
        await this.dispatch.threadEvent(args.taskId, '上下文已补齐');
        fixed += 1;
      } catch (e) {
        const attempts = Number(job.attempts) + 1;
        await this.db.query(`UPDATE jobs SET status=$2, attempts=$3, error_message=$4, scheduled_at=$5, finished_at=$6 WHERE id=$1`,
          [job.id, attempts >= 3 ? 'failed' : 'queued', attempts, String((e as Error).message), new Date(now.getTime() + 5 * 60_000), attempts >= 3 ? now : null]);
      }
    }
    return { fixed, due: due.rows.length };
  }

  // ---------------- 候选扫描（Step 18–30） ----------------
  async scanCandidates(): Promise<Record<string, unknown>> {
    // 上一轮还在跑就跳过，避免重复扫描同一批消息
    const active = await this.db.one<{ id: string }>(`SELECT id FROM sessions WHERE kind='candidate_scan' AND state IN ('planned','running','waiting_input') LIMIT 1`);
    if (active) return { skipped: true, reason: 'IN_PROGRESS', sessionId: active.id };
    const health = await this.db.one<any>(`SELECT * FROM source_health WHERE source='feishu'`);
    const since = health?.watermark ? new Date(health.watermark).toISOString() : null;
    let messages: FeishuMessage[] = [];
    try { messages = this.feishu ? await this.feishu.fetchRecent({ since, limit: 50 }) : []; } catch { messages = []; }
    // Step 22：过滤已入库的消息（机器人自己的消息由适配器过滤）
    if (messages.length) {
      const known = await this.db.query<{ external_id: string }>(`SELECT external_id FROM source_items WHERE source_type='feishu' AND external_id = ANY($1::text[])`, [messages.map((m) => m.messageId)]);
      const skip = new Set(known.rows.map((r) => r.external_id));
      messages = messages.filter((m) => !skip.has(m.messageId));
    }
    const prompt = `你在扫描飞书最近的消息，判断哪些是"疑似指派给我的需求或问题"。只回写候选，不要建任务。\n对每条候选调用一次 deliver({artifacts:[{kind:"candidates", candidates:[{messageId, reason, confidence}]}]})，confidence 取 0–1。\n\n消息列表（${messages.length} 条）：\n${messages.map((m) => `- ${m.messageId} | ${m.chatName ?? m.chatId} | ${m.senderOpenId}: ${m.text.slice(0, 200)}`).join('\n') || '（无新消息）'}`;
    const r = await this.dispatch.startTextSession({ channelId: null, kind: 'candidate_scan', prompt, timeoutMinutes: 10 });
    if ('error' in r) return { skipped: true, reason: r.error === 'QUOTA' ? 'QUOTA' : 'NO_RUNTIME', detail: r.detail };
    return { started: true, sessionId: r.sessionId, runtime: r.runtime, messages: messages.length };
  }

  /** MCP deliver(candidates)（Step 26–29）：只入候选表，不推飞书 */
  async onCandidates(session: any, list: Array<{ messageId: string; reason: string; confidence: number }>) {
    const now = this.clock.now();
    let inserted = 0;
    for (const cand of list) {
      const hit = (this.feishu as any)?.find?.(cand.messageId) ?? null;
      const msg: FeishuMessage | null = hit ? hit.chat.messages[hit.index] : null;
      const r = await this.db.query(`INSERT INTO candidates (source_type, message_id, chat_id, chat_name, sender, text, reason, confidence, status, created_at)
        VALUES ('feishu',$1,$2,$3,$4,$5,$6,$7,'open',$8) ON CONFLICT DO NOTHING`,
        [cand.messageId, msg?.chatId ?? hit?.chatId ?? null, hit?.chat.name ?? null, msg?.senderOpenId ?? null, msg?.text ?? cand.reason, cand.reason, cand.confidence, now]);
      inserted += r.rowCount ?? 0;
    }
    await this.db.query(`UPDATE sessions SET last_progress_at=$2, last_activity_at=$2 WHERE id=$1`, [session.id, now]);
    await this.db.query(`INSERT INTO source_health (source, status, watermark, last_success_at, updated_at) VALUES ('feishu','ok',$1,$1,$1)
      ON CONFLICT (source) DO UPDATE SET status='ok', watermark=$1, last_success_at=$1, consecutive_failures=0, updated_at=$1`, [now]);
    await this.events.record(this.db.pool, { type: 'candidates.updated', payload: { items: await this.listCandidates(), inserted } });
    this.events.flush();
    return { ok: true, inserted };
  }

  async listCandidates() {
    const rows = await this.db.query<any>(`SELECT c.*, t.key AS task_key FROM candidates c LEFT JOIN tasks t ON t.id=c.task_id WHERE c.status='open' ORDER BY c.created_at`);
    return rows.rows.map((c) => this.serializeCandidate(c));
  }

  serializeCandidate(c: any) {
    return {
      id: c.id, status: c.status,
      source: { type: c.source_type, messageId: c.message_id, chatName: c.chat_name, sender: c.sender },
      text: c.text, reason: c.reason, confidence: Number(c.confidence),
      taskKey: c.task_key ?? null, createdAt: new Date(c.created_at).toISOString(),
    };
  }

  /** Step 30：候选一键入库，走 Step 5 起的主路径 */
  async intakeCandidate(id: string) {
    const c = await this.db.one<any>('SELECT * FROM candidates WHERE id=$1', [id]);
    if (!c) throw new ApiError(404, 'NOT_FOUND', '候选不存在');
    if (c.status !== 'open') throw new ApiError(409, 'CANDIDATE_NOT_OPEN');
    const r = await this.intakeMessage({ messageId: c.message_id, chatId: c.chat_id, candidateText: c.text });
    const t = await this.tasks.byKey(r.taskKey);
    await this.db.query(`UPDATE candidates SET status='intaken', task_id=$2, decided_at=$3 WHERE id=$1`, [id, t.id, this.clock.now()]);
    await this.events.record(this.db.pool, { type: 'candidates.updated', payload: { items: await this.listCandidates(), intaken: c.message_id } });
    this.events.flush();
    return this.tasks.serialize(t, t.channel_slug);
  }

  /** Step 30：忽略候选（幂等） */
  async dismissCandidate(id: string) {
    const c = await this.db.one<any>('SELECT * FROM candidates WHERE id=$1', [id]);
    if (!c) throw new ApiError(404, 'NOT_FOUND', '候选不存在');
    if (c.status === 'open') {
      await this.db.query(`UPDATE candidates SET status='dismissed', decided_at=$2 WHERE id=$1`, [id, this.clock.now()]);
      await this.events.record(this.db.pool, { type: 'candidates.updated', payload: { items: await this.listCandidates(), dismissed: c.message_id } });
      this.events.flush();
    }
    return this.serializeCandidate((await this.db.one<any>('SELECT * FROM candidates WHERE id=$1', [id]))!);
  }

  /** EX-26.1：候选扫描会话 10 分钟未回写视为失败 */
  async watchCandidateScanTimeouts() {
    const cutoff = new Date(this.clock.now().getTime() - 10 * 60_000);
    const stale = await this.db.query<any>(`SELECT s.id, r.name AS runtime FROM sessions s JOIN runtimes r ON r.id=s.runtime_id
      WHERE s.kind='candidate_scan' AND s.state IN ('planned','running') AND COALESCE(s.last_progress_at, s.started_at, s.created_at) <= $1`, [cutoff]);
    for (const s of stale.rows) {
      this.hubStop(s.runtime, s.id);
      await this.db.query(`UPDATE sessions SET state='stopped', failure_reason='candidate-scan timeout', ended_at=$2, updated_at=$2 WHERE id=$1`, [s.id, this.clock.now()]);
    }
    return { candidateScanStopped: stale.rows.length };
  }
  private hubStop(runtime: string, sessionId: string) { (this.dispatch as any).hub.send(runtime, 'session.stop', { sessionId, reason: 'timeout' }); }
}
