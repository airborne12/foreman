/**
 * 测试专用端点（仅 FOREMAN_TEST_MODE=1）。来源：scenario/core-00-format.schema.json x-test-endpoints
 * 本批：reset、clock（freeze/advance）、scheduler tick、lark 假适配器观测。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { FakeClock } from '../clock.js';
import { FakeFeishu } from '../adapters/feishu.js';
import { parseBody } from './common.js';
import { ACTION_TYPES } from '@foreman/shared';

function normalizeMsg(m: Record<string, unknown>, chatId: string) {
  const x = m as any;
  return {
    messageId: String(x.messageId ?? x.message_id ?? ''), chatId: String(x.chatId ?? x.chat_id ?? chatId), chatName: x.chatName ?? x.chat_name ?? null,
    senderOpenId: String(x.senderOpenId ?? x.sender_open_id ?? 'ou_someone'), senderName: x.senderName ?? null,
    text: String(x.text ?? ''), createdAt: String(x.createdAt ?? x.created_at ?? new Date().toISOString()),
  };
}

export function testRoutes(app: AppContext) {
  const r = new Hono();

  /** 假 Jira（中心侧执行器目标；没有 vpn:jira runtime 在线时使用） */
  const fakeJira = { commentFailWith: 0 as number | null, commentFailTimes: 0 };
  r.post('/__test/mock/jira', async (c) => {
    const b = await parseBody(c, z.object({ commentFailWith: z.number().nullable().optional(), commentFailTimes: z.number().optional() }));
    if (b.commentFailWith !== undefined) fakeJira.commentFailWith = b.commentFailWith;
    if (b.commentFailTimes !== undefined) fakeJira.commentFailTimes = b.commentFailTimes;
    return c.json({ ok: true });
  });
  // 测试模式执行器：无在线 vpn:jira runtime 时用假 Jira；reply_review / rerun_ci 为假执行器（回帖正文 / 空操作）
  const realJira = app.approvals.hasExecutor('jira_comment') ? (app.dispatch.mirrorToJira.bind(app.dispatch)) : null;
  app.approvals.registerExecutor('jira_comment', async (x) => {
    const online = await app.db.one(`SELECT 1 FROM runtimes WHERE online AND $1 = ANY(labels)`, [app.config.sources.jira.run_on_label]);
    if (online && app.workerHub.isOnline((await app.db.one<any>(`SELECT name FROM runtimes WHERE online AND $1 = ANY(labels) LIMIT 1`, [app.config.sources.jira.run_on_label]))!.name) && realJira) return realJira(x);
    if (fakeJira.commentFailTimes > 0) { fakeJira.commentFailTimes -= 1; throw new Error('fake Jira comment 500'); }
    if (fakeJira.commentFailWith) throw new Error(`fake Jira comment ${fakeJira.commentFailWith}`);
    return { commentId: `fake-${Date.now()}`, fake: true };
  });
  app.approvals.registerExecutor('reply_review', async (x) => {
    const n = await app.notifications.send({ kind: 'reply', target: app.config.feishu.owner_open_id ?? 'owner', text: `[reply_review 已执行] ${x.finalBody}`, replyTo: x.approval.feishu_message_id, refType: 'approval', refId: x.approval.id });
    return { fake: true, notificationId: n.id };
  });
  app.approvals.registerExecutor('rerun_ci', async () => ({ fake: true, rerun: 'doris_be_ut' }));
  app.approvals.registerCompensator('rerun_ci', async () => true);
  app.approvals.registerCompensator('reply_review', async () => true);
  app.approvals.registerCompensator('jira_comment', async () => true);
  app.approvals.registerCompensator('feishu_reply', async () => true);

  r.post('/__test/reset', async (c) => {
    fakeJira.commentFailWith = null; fakeJira.commentFailTimes = 0;
    app.workerHub.sentLog.length = 0;
    app.config.sources.feishu.scan_enabled = false;
    await app.db.resetForTest();
    if (app.feishu instanceof FakeFeishu) app.feishu.reset();
    if (app.clock instanceof FakeClock) app.clock.freeze(new Date('2026-09-10T08:00:00Z'));
    return c.json({ ok: true });
  });

  r.post('/__test/clock/freeze', async (c) => {
    const b = await parseBody(c, z.object({ at: z.string().optional() }));
    if (app.clock instanceof FakeClock) app.clock.freeze(b.at ? new Date(b.at) : undefined);
    return c.json({ now: app.clock.now().toISOString() });
  });
  r.post('/__test/clock/advance', async (c) => {
    const b = await parseBody(c, z.object({ seconds: z.number().optional(), minutes: z.number().optional(), toNextHour: z.boolean().optional() }));
    if (!(app.clock instanceof FakeClock)) return c.json({ error: 'not fake clock' }, 400);
    let ms = (b.seconds ?? 0) * 1000 + (b.minutes ?? 0) * 60_000;
    if (b.toNextHour) { const n = app.clock.now(); ms = 3600_000 - (n.getTime() % 3600_000); }
    await app.clock.advance(ms);
    return c.json({ now: app.clock.now().toISOString() });
  });
  r.get('/__test/clock', (c) => c.json({ now: app.clock.now().toISOString() }));

  r.post('/__test/scheduler/tick', async (c) => {
    const b = await parseBody(c, z.object({ job: z.string() }));
    return c.json(await app.scheduler.tick(b.job));
  });

  r.get('/__test/lark/sent', (c) => c.json({ items: app.feishu instanceof FakeFeishu ? app.feishu.sent : [] }));
  r.post('/__test/lark/set', async (c) => {
    const b = await parseBody(c, z.object({
      failSend: z.boolean().optional(), failReply: z.boolean().optional(), failGetOnce: z.boolean().optional(), failGet: z.boolean().optional(),
      owner: z.string().optional(), botOpenId: z.string().optional(), scanEnabled: z.boolean().optional(),
      chats: z.record(z.object({ name: z.string().optional(), messages: z.array(z.record(z.unknown())).default([]) })).optional(),
      recent: z.array(z.record(z.unknown())).optional(),
    }));
    const f = app.feishu;
    if (f instanceof FakeFeishu) {
      if (b.failSend !== undefined) f.failSend = b.failSend;
      if (b.failReply !== undefined) f.failReply = b.failReply;
      if (b.failGetOnce !== undefined) f.failGetOnce = b.failGetOnce;
      if (b.failGet !== undefined) f.failGet = b.failGet;
      if (b.botOpenId) f.botOpenId = b.botOpenId;
      if (b.chats) for (const [chatId, chat] of Object.entries(b.chats)) f.chats[chatId] = { name: chat.name ?? chatId, messages: (chat.messages as any[]).map((m) => normalizeMsg(m, chatId)) };
      if (b.recent) f.recent = (b.recent as any[]).map((m) => normalizeMsg(m, String(m.chatId ?? m.chat_id ?? 'oc_dm')));
    }
    if (b.owner) app.config.feishu.owner_open_id = b.owner;
    if (b.botOpenId) app.config.feishu.bot_open_id = b.botOpenId;
    if (b.scanEnabled !== undefined) app.config.sources.feishu.scan_enabled = b.scanEnabled;
    return c.json({ ok: true });
  });

  /** 假 lark-cli 推送事件：reaction → 审批决定（S06 Step 11–13） */
  r.post('/__test/lark/emit', async (c) => {
    const b = await parseBody(c, z.object({ event: z.record(z.unknown()) }));
    const ev = b.event as Record<string, any>;
    const type = String(ev.type ?? ev.event_type ?? '');
    if (type.startsWith('im.message.receive')) {
      // @机器人 → S02 入库；普通回复 → S07 回答问题
      if (Array.isArray(ev.mentions) && ev.mentions.length) return c.json(await app.feishuIntake.onEvent(ev));
      const r = await app.questions.onFeishuReply({ messageId: String(ev.message_id), parentId: (ev.parent_id as string) ?? null, senderOpenId: String(ev.sender_open_id ?? ev.operator_open_id ?? ''), text: String(ev.text ?? '') }, (taskId, text) => app.dispatch.resumeSession(taskId, text));
      return c.json(r);
    }
    if (type.startsWith('im.message.reaction')) {
      // 审批消息上的表情 → S06 决定；其他消息 → S02 入库表情
      const isApproval = await app.db.one('SELECT 1 FROM approvals WHERE feishu_message_id=$1', [String(ev.message_id)]);
      if (!isApproval) return c.json(await app.feishuIntake.onEvent(ev));
      const eventId = String(ev.event_id ?? crypto.randomUUID());
      await app.db.query(`INSERT INTO feishu_events (event_id, event_type, message_id, operator_open_id, raw, received_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (event_id) DO NOTHING`, [eventId, type, String(ev.message_id), String(ev.operator_open_id ?? ''), JSON.stringify(ev), app.clock.now()]);
      const r = await app.approvals.decideByFeishu({ messageId: String(ev.message_id), operatorOpenId: String(ev.operator_open_id ?? ''), operatorType: String(ev.operator_type ?? 'user'), emoji: String(ev.emoji ?? '') });
      await app.db.query(`UPDATE feishu_events SET handled=$2, ignore_reason=$3, processed_at=$4 WHERE event_id=$1`, [eventId, r.handled === 'decided' ? 'processed' : 'ignored', r.reason ?? null, app.clock.now()]);
      return c.json(r);
    }
    return c.json({ handled: 'ignored', reason: 'unsupported' });
  });

  // 直接触达领域核心（scenario x-test-endpoints）
  r.post('/__test/approvals/request', async (c) => {
    const b = await parseBody(c, z.object({ taskKey: z.string(), actionType: z.enum(ACTION_TYPES), title: z.string(), body: z.string(), executor: z.enum(['center', 'agent']).optional(), payload: z.record(z.unknown()).optional() }));
    const t = await app.tasks.byKey(b.taskKey);
    const a = await app.approvals.request({ taskId: t.id, actionType: b.actionType, title: b.title, body: b.body, payload: { ...(b.payload ?? {}), taskKey: t.key }, executor: b.executor ?? 'center' });
    return c.json(app.approvals.serialize(a), 201);
  });
  r.post('/__test/approvals/:key/supersede', async (c) => {
    const b = await parseBody(c, z.object({ body: z.string() }));
    return c.json(await app.approvals.supersede(c.req.param('key'), b.body));
  });
  r.post('/__test/actions/retry', async (c) => {
    const b = await parseBody(c, z.object({ approvalKey: z.string() }));
    return c.json(await app.approvals.retryAction(b.approvalKey));
  });

  r.get('/__test/hub/sent', (c) => c.json({ items: app.workerHub.sentLog }));
  r.post('/__test/db/query', async (c) => {
    const b = await parseBody(c, z.object({ sql: z.string(), params: z.array(z.unknown()).optional() }));
    if (!/^\s*(select|with)/i.test(b.sql)) return c.json({ error: 'read-only' }, 400);
    const rows = await app.db.query(b.sql, b.params ?? []);
    return c.json({ rows: rows.rows });
  });
  r.post('/__test/db/exec', async (c) => {
    const b = await parseBody(c, z.object({ sql: z.string(), params: z.array(z.unknown()).optional() }));
    const rows = await app.db.query(b.sql, b.params ?? []);
    return c.json({ rows: rows.rows, rowCount: rows.rowCount });
  });

  return r;
}
