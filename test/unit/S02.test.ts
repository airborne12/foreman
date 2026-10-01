/**
 * S02 单元测试：UT-S02-01 ~ UT-S02-17（来源：logos/resources/test/core-S02-test-cases.md）
 * 事件解析与过滤、入库与回帖、候选扫描。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { withReport } from '../helpers/reporter.js';
import { bootTestApp, http, TEST_TOKEN, type TestApp } from '../helpers/testApp.js';
import { FakeWorker } from '../helpers/fakeWorker.js';
import { seedRuntime } from '../helpers/seed.js';
import { parseFeishuEvent } from '../../apps/center/src/domain/feishuIntake.js';
import type { FeishuMessage } from '../../apps/center/src/adapters/feishu.js';

let app: TestApp;
const workers: FakeWorker[] = [];
const CENTER = { labels: ['agent:codex', 'text'], agents: { codex: { bin: 'fake-codex', maxConcurrent: 3 } }, transport: 'local' as const };

async function fw(name: string, reg: Record<string, unknown> = CENTER) {
  const w = new FakeWorker(app.ws, TEST_TOKEN); await w.connect(); workers.push(w);
  const ack = await w.register({ name, ...reg } as any);
  if (ack.type !== 'register.ack') throw new Error(JSON.stringify(ack.payload));
  await new Promise((r) => setTimeout(r, 80)); return w;
}
/** 在假 lark 消息库里放一个群 */
function seedChat(chatId: string, count: number, targetId?: string): FeishuMessage[] {
  const mid = Math.floor(count / 2);
  const base = app.clock.now().getTime() - count * 60_000;
  const messages: FeishuMessage[] = Array.from({ length: count }, (_, i) => ({
    messageId: targetId && i === mid ? targetId : `om_${chatId}_${i}`,
    chatId, senderOpenId: i % 3 === 0 ? 'ou_owner' : `ou_user${i % 5}`,
    text: targetId && i === mid ? 'ngram 索引 LIKE 偶发超时' : `${chatId} 第 ${i} 条`,
    createdAt: new Date(base + i * 60_000).toISOString(),
  }));
  app.fakeFeishu.chats[chatId] = { name: 'Doris 内核-索引', messages };
  return messages;
}
const reaction = (over: Record<string, unknown> = {}) => ({ type: 'im.message.reaction.created_v1', event_id: `evt-${Math.random().toString(36).slice(2)}`, message_id: 'om_target', chat_id: 'oc_index', operator_type: 'user', operator_open_id: 'ou_owner', emoji: 'PUSHPIN', ...over });

beforeAll(async () => { app = await bootTestApp(); });
afterAll(async () => { for (const w of workers) w.close(); await new Promise((r) => setTimeout(r, 200)); await app.close(); });
beforeEach(async () => { for (const w of workers.splice(0)) w.close(); await new Promise((r) => setTimeout(r, 60)); await http(app, 'POST', '/__test/reset'); });

describe('S02 1.1 事件解析与过滤', () => {
  it('UT-S02-01: reaction 事件解析出 messageId / operator / emoji', () => withReport('UT-S02-01', () => {
    const line = JSON.stringify({ schema: '2.0', header: { event_id: 'evt-1', event_type: 'im.message.reaction.created_v1' }, event: { message_id: 'om_1', operator_type: 'user', user_id: { open_id: 'ou_owner' }, reaction_type: { emoji_type: 'PUSHPIN' } } });
    const ev = parseFeishuEvent(line)!;
    expect(ev).toMatchObject({ type: 'reaction', eventId: 'evt-1', messageId: 'om_1', operatorType: 'user', operatorOpenId: 'ou_owner', emoji: 'PUSHPIN' });
  }));
  it('UT-S02-02: 非 owner open_id 的表情被忽略并记 ignore_reason', () => withReport('UT-S02-02', async () => {
    seedChat('oc_index', 5, 'om_target');
    const r = await app.feishuIntake.onEvent(reaction({ event_id: 'evt-2', operator_open_id: 'ou_colleague' }));
    expect(r).toMatchObject({ handled: 'ignored', reason: 'not_owner' });
    const row = await app.db.one<any>(`SELECT handled, ignore_reason FROM feishu_events WHERE event_id='evt-2'`);
    expect(row.handled).toBe('ignored'); expect(row.ignore_reason).toBe('not_owner');
    expect(Number((await app.db.one<{ n: string }>('SELECT count(*) AS n FROM tasks'))!.n)).toBe(0);
  }));
  it('UT-S02-03: 非入库表情被忽略', () => withReport('UT-S02-03', async () => {
    const r = await app.feishuIntake.onEvent(reaction({ event_id: 'evt-3', emoji: 'THUMBSUP' }));
    expect(r).toMatchObject({ handled: 'ignored', reason: 'emoji_mismatch' });
  }));
  it('UT-S02-04: operator_type 非 user 被忽略', () => withReport('UT-S02-04', async () => {
    const r = await app.feishuIntake.onEvent(reaction({ event_id: 'evt-4', operator_type: 'app' }));
    expect(r).toMatchObject({ handled: 'ignored', reason: 'not_user' });
  }));
  it('UT-S02-05: 同 event_id 重放只处理一次', () => withReport('UT-S02-05', async () => {
    seedChat('oc_index', 5, 'om_target');
    const first = await app.feishuIntake.onEvent(reaction({ event_id: 'evt-5' }));
    expect(first.handled).toBe('intaken');
    const second = await app.feishuIntake.onEvent(reaction({ event_id: 'evt-5' }));
    expect(second).toMatchObject({ handled: 'ignored', reason: 'duplicate' });
    expect(Number((await app.db.one<{ n: string }>('SELECT count(*) AS n FROM tasks'))!.n)).toBe(1);
    expect(Number((await app.db.one<{ n: string }>('SELECT count(*) AS n FROM feishu_events'))!.n)).toBe(1);
  }));
  it('UT-S02-06: @机器人带引用时以被引用消息为原文', () => withReport('UT-S02-06', async () => {
    const msgs = seedChat('oc_index', 5, 'om_target');
    const r = await app.feishuIntake.onEvent({ type: 'im.message.receive_v1', event_id: 'evt-6', message_id: 'om_mention', chat_id: 'oc_index', operator_type: 'user', sender_open_id: 'ou_owner', mentions: ['ou_bot'], text: '@foreman 看一下这个超时', parent_id: 'om_target' });
    expect(r.handled).toBe('intaken');
    const t = await app.tasks.byKey(r.taskKey!);
    expect(t.source_ref).toBe('om_target');
    const cp = await app.db.one<any>('SELECT * FROM context_packs WHERE task_id=$1', [t.id]);
    expect(cp.source_text).toBe(msgs.find((m) => m.messageId === 'om_target')!.text);
    expect(cp.summary).toContain('看一下这个超时');
  }));
  it('UT-S02-07: @ 的不是机器人自身 open_id 被忽略', () => withReport('UT-S02-07', async () => {
    const r = await app.feishuIntake.onEvent({ type: 'im.message.receive_v1', event_id: 'evt-7', message_id: 'om_m2', chat_id: 'oc_index', operator_type: 'user', sender_open_id: 'ou_owner', mentions: ['ou_other'], text: '@someone 看下' });
    expect(r).toMatchObject({ handled: 'ignored', reason: 'not_bot' });
  }));
});

describe('S02 1.2 入库与回帖', () => {
  it('UT-S02-08: 飞书入库任务 source_type = feishu 且落 feishu 默认频道', () => withReport('UT-S02-08', async () => {
    seedChat('oc_index', 5, 'om_target');
    const r = await app.feishuIntake.onEvent(reaction({ event_id: 'evt-8' }));
    const t = await app.tasks.byKey(r.taskKey!);
    expect(t.source_type).toBe('feishu'); expect(t.channel_slug).toBe('feishu');
    expect(t.repo_source).toBe('llm'); expect(t.repo_name).toBeNull();
  }));
  it('UT-S02-09: 上下文包 conversation 含前后各 20 条', () => withReport('UT-S02-09', async () => {
    seedChat('oc_index', 45, 'om_target');
    const r = await app.feishuIntake.onEvent(reaction({ event_id: 'evt-9' }));
    const t = await app.tasks.byKey(r.taskKey!);
    const cp = await app.db.one<any>('SELECT * FROM context_packs WHERE task_id=$1', [t.id]);
    expect(cp.conversation).toHaveLength(41);
  }));
  it('UT-S02-10: 上下文读取失败时 partial = true 且任务照建', () => withReport('UT-S02-10', async () => {
    seedChat('oc_index', 5, 'om_target');
    app.fakeFeishu.failGetOnce = true;
    const r = await app.feishuIntake.onEvent(reaction({ event_id: 'evt-10' }));
    const t = await app.tasks.byKey(r.taskKey!);
    const cp = await app.db.one<any>('SELECT * FROM context_packs WHERE task_id=$1', [t.id]);
    expect(cp.partial).toBe(true);
    const job = await app.db.one<any>(`SELECT * FROM jobs WHERE kind='context-retry'`);
    expect(job).not.toBeNull(); expect(job.args.taskId).toBe(t.id);
  }));
  it('UT-S02-11: 回帖文本含任务 key 与面板链接', () => withReport('UT-S02-11', async () => {
    seedChat('oc_index', 5, 'om_target');
    const r = await app.feishuIntake.onEvent(reaction({ event_id: 'evt-11' }));
    const n = await app.db.one<any>(`SELECT * FROM notifications WHERE kind='intake_ack' ORDER BY created_at DESC LIMIT 1`);
    expect(n.text).toContain(r.taskKey!);
    expect(n.text).toContain(`/c/feishu/t/${r.taskKey}`);
    expect(n.reply_to_message_id).toBe('om_target');
  }));
});

describe('S02 1.3 候选扫描', () => {
  it('UT-S02-12: 同 message_id 候选二次写入被忽略', () => withReport('UT-S02-12', async () => {
    const session = { id: null as any };
    await app.db.query(`INSERT INTO candidates (source_type, message_id, text, reason, confidence, status) VALUES ('feishu','om_c1','x','疑似需求',0.7,'open')`);
    await app.feishuIntake.onCandidates(session, [{ messageId: 'om_c1', reason: '疑似需求', confidence: 0.7 }]);
    expect(Number((await app.db.one<{ n: string }>('SELECT count(*) AS n FROM candidates'))!.n)).toBe(1);
  }));
  it('UT-S02-13: confidence 非法（>1）被拒', () => withReport('UT-S02-13', async () => {
    await fw('center');
    app.config.sources.feishu.scan_enabled = true;
    const r = await app.feishuIntake.scanCandidates() as any;
    const s = await app.db.one<any>('SELECT * FROM sessions WHERE id=$1', [r.sessionId]);
    const token = 'tok-' + Math.random().toString(36).slice(2);
    const { Intake } = await import('../../apps/center/src/domain/intake.js');
    await app.db.query('UPDATE sessions SET mcp_token_hash=$2 WHERE id=$1', [s.id, Intake.hash(token)]);
    const res = await fetch(app.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deliver', arguments: { artifacts: [{ kind: 'candidates', candidates: [{ messageId: 'om_c9', reason: 'x', confidence: 1.2 }] }] } } }) }).then((x) => x.json() as Promise<any>);
    expect(res.error.code).toBe(-32602);
    expect(Number((await app.db.one<{ n: string }>('SELECT count(*) AS n FROM candidates'))!.n)).toBe(0);
  }));
  it('UT-S02-14: 候选 dismiss 幂等且状态为 dismissed', () => withReport('UT-S02-14', async () => {
    const c = await app.db.one<{ id: string }>(`INSERT INTO candidates (source_type, message_id, text, reason, confidence, status) VALUES ('feishu','om_c2','x','疑似需求',0.7,'open') RETURNING id`);
    const r1 = await http(app, 'POST', `/api/candidates/${c!.id}/dismiss`);
    const r2 = await http(app, 'POST', `/api/candidates/${c!.id}/dismiss`);
    expect(r1.status).toBe(200); expect(r2.status).toBe(200); expect(r2.body.status).toBe('dismissed');
    expect((await app.db.one<any>('SELECT decided_at FROM candidates WHERE id=$1', [c!.id])).decided_at).not.toBeNull();
  }));
  it('UT-S02-15: 已处理候选再 intake 返回 CANDIDATE_NOT_OPEN', () => withReport('UT-S02-15', async () => {
    const c = await app.db.one<{ id: string }>(`INSERT INTO candidates (source_type, message_id, text, reason, confidence, status) VALUES ('feishu','om_c3','x','疑似需求',0.7,'dismissed') RETURNING id`);
    const r = await http(app, 'POST', `/api/candidates/${c!.id}/intake`);
    expect(r.status).toBe(409); expect(r.body.code).toBe('CANDIDATE_NOT_OPEN');
  }));
  it('UT-S02-16: 候选扫描过滤机器人自己的消息与已入库消息', () => withReport('UT-S02-16', async () => {
    await fw('center');
    seedChat('oc_dm', 3, 'om_known');
    app.fakeFeishu.recent = [
      { messageId: 'om_new', chatId: 'oc_dm', senderOpenId: 'ou_user1', text: '新需求：导出慢', createdAt: app.clock.now().toISOString() },
      { messageId: 'om_bot', chatId: 'oc_dm', senderOpenId: 'ou_bot', text: '机器人自己发的', createdAt: app.clock.now().toISOString() },
      { messageId: 'om_known', chatId: 'oc_dm', senderOpenId: 'ou_user2', text: '已经入库过的消息', createdAt: app.clock.now().toISOString() },
    ];
    await app.feishuIntake.intakeMessage({ messageId: 'om_known', chatId: 'oc_dm' });
    const r = await app.feishuIntake.scanCandidates() as any;
    const s = await app.db.one<any>('SELECT prompt FROM sessions WHERE id=$1', [r.sessionId]);
    expect(s.prompt).toContain('om_new');
    expect(s.prompt).not.toContain('om_bot');
    expect(s.prompt).not.toContain('om_known');
  }));
  it('UT-S02-17: 候选扫描路由到 text 类型 → center', () => withReport('UT-S02-17', async () => {
    await fw('center');
    await seedRuntime(app.db, { name: 'dev', labels: ['build:doris'] });
    const r = await app.feishuIntake.scanCandidates() as any;
    expect(r.started).toBe(true); expect(r.runtime).toBe('center');
    const s = await app.db.one<any>(`SELECT s.kind, r.name FROM sessions s JOIN runtimes r ON r.id=s.runtime_id WHERE s.id=$1`, [r.sessionId]);
    expect(s.kind).toBe('candidate_scan'); expect(s.name).toBe('center');
  }));
});
