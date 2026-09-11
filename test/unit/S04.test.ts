/**
 * S04 单元测试：UT-S04-01 ~ UT-S04-26（来源：logos/resources/test/core-S04-test-cases.md）
 * 频道与消息校验、斜杠命令、调度员会话生命周期、草案与确认。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { withReport } from '../helpers/reporter.js';
import { bootTestApp, http, TEST_TOKEN, type TestApp } from '../helpers/testApp.js';
import { FakeWorker } from '../helpers/fakeWorker.js';
import { seedTask, seedSession, seedRuntime, runtimeId } from '../helpers/seed.js';
import { Intake } from '../../apps/center/src/domain/intake.js';
import { parseCommand } from '../../apps/center/src/domain/channels.js';
import type { Envelope } from '@foreman/shared';

let app: TestApp;
const workers: FakeWorker[] = [];
const CENTER = { transport: 'local' as const, labels: ['agent:claude', 'agent:codex', 'text'], agents: { claude: { bin: 'fake-claude', maxConcurrent: 3 }, codex: { bin: 'fake-codex', maxConcurrent: 3 } } };
const DEV = { transport: 'direct' as const, labels: ['agent:claude', 'agent:codex', 'build:doris', 'repo:selectdb/selectdb-core', 'vpn:jira'], agents: { claude: { bin: 'fake-claude', maxConcurrent: 3 }, codex: { bin: 'fake-codex', maxConcurrent: 3 } }, repos: { 'selectdb/selectdb-core': { main: '/tmp/fx/core', worktreeRoot: '/tmp/fx/wt' } }, capabilities: ['jira-lookup'] as string[] };

async function fw(name: string, reg: Record<string, unknown>) {
  const w = new FakeWorker(app.ws, TEST_TOKEN); await w.connect(); workers.push(w);
  const ack = await w.register({ name, ...reg } as any);
  if (ack.type !== 'register.ack') throw new Error(JSON.stringify(ack.payload));
  await new Promise((r) => setTimeout(r, 80)); return w;
}
const channel = (slug = 'doris-index', title?: string) => http(app, 'POST', '/api/channels', { slug, ...(title ? { title } : {}) });
const post = (text: string, slug = 'doris-index', extra: Record<string, unknown> = {}) => http(app, 'POST', `/api/channels/${slug}/messages`, { text, ...extra });
/** 直接造一个带 MCP token 的调度员会话 */
async function dispatcherSession(slug = 'doris-index') {
  const c = await app.db.one<{ id: string }>('SELECT id FROM channels WHERE slug=$1', [slug]);
  const rid = await runtimeId(app.db, 'center');
  const s = await app.db.one<{ id: string }>(`INSERT INTO sessions (channel_id, runtime_id, agent, kind, state, prompt, started_at, last_activity_at, created_at, updated_at) VALUES ($1,$2,'claude','dispatcher','running','p',$3,$3,$3,$3) RETURNING id`, [c!.id, rid, app.clock.now()]);
  const token = Intake.newToken();
  await app.db.query('UPDATE sessions SET mcp_token_hash=$2 WHERE id=$1', [s!.id, Intake.hash(token)]);
  return { sessionId: s!.id, token, channelId: c!.id };
}
const mcp = (token: string, tool: string, args: Record<string, unknown>) => fetch(app.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) }).then((r) => r.json() as Promise<any>);
/** 造 N 条占满并发的会话 */
async function fillQuota(runtime: string) {
  for (const [a, agent] of ['claude', 'codex'].entries()) for (let i = 0; i < 3; i++) {
    const t = await seedTask(app.db, { key: `T-9${a}${i}`, state: 'running', runtime });
    await seedSession(app.db, { taskId: t, runtime, agent, kind: 'implement', state: 'running' });
  }
}

beforeAll(async () => { app = await bootTestApp(); });
afterAll(async () => { for (const w of workers) w.close(); await new Promise((r) => setTimeout(r, 200)); await app.close(); });
beforeEach(async () => { for (const w of workers.splice(0)) w.close(); await new Promise((r) => setTimeout(r, 60)); await http(app, 'POST', '/__test/reset'); });

describe('S04 1.1 频道与消息校验', () => {
  it('UT-S04-01: slug 含大写或下划线被拒', () => withReport('UT-S04-01', async () => {
    expect((await channel('Doris_Index')).status).toBe(422);
    expect((await channel('doris_index')).status).toBe(422);
  }));
  it('UT-S04-02: slug 超过 40 字符被拒', () => withReport('UT-S04-02', async () => {
    expect((await channel('a123456789b123456789c123456789d123456789x')).status).toBe(422);
  }));
  it('UT-S04-03: 重名频道 409', () => withReport('UT-S04-03', async () => {
    expect((await channel()).status).toBe(201);
    const r = await channel();
    expect(r.status).toBe(409); expect(r.body.code).toBe('CHANNEL_EXISTS');
  }));
  it('UT-S04-04: 消息 text 为空被拒', () => withReport('UT-S04-04', async () => {
    await channel();
    expect((await post('')).status).toBe(422);
  }));
  it('UT-S04-05: 消息 text 超过 20000 被拒', () => withReport('UT-S04-05', async () => {
    await channel();
    expect((await post('x'.repeat(20001))).status).toBe(422);
  }));
  it('UT-S04-06: 用户消息先落库再处理', () => withReport('UT-S04-06', async () => {
    await channel(); await fw('center', CENTER); await fillQuota('center');
    const r = await post('把 CIR-19418 修了');
    expect(r.status).toBe(202); expect(r.body.handling).toBe('unavailable'); expect(r.body.hint).toContain('/task new');
    const msgs = await http(app, 'GET', '/api/channels/doris-index/messages');
    expect(msgs.body.items.filter((m: any) => m.kind === 'user')).toHaveLength(1);
  }));
});

describe('S04 1.2 斜杠命令解析', () => {
  it('UT-S04-07: /task new 完整参数直出草案', () => withReport('UT-S04-07', async () => {
    await channel();
    const r = await post('/task new --source CIR-19418 --repo selectdb/selectdb-core --path fix --pick branch-selectdb-doris-3.1');
    expect(r.status).toBe(202); expect(r.body.handling).toBe('command');
    expect(r.body.draft.fields).toMatchObject({ source: 'CIR-19418', repo: 'selectdb/selectdb-core', path: 'fix', pickTargets: ['branch-selectdb-doris-3.1'] });
    const d = await app.db.one<any>('SELECT * FROM task_drafts');
    expect(d.origin).toBe('command'); expect(d.status).toBe('open');
  }));
  it('UT-S04-08: /task new 缺 --path 时草案字段留空并高亮', () => withReport('UT-S04-08', async () => {
    await channel();
    const r = await post('/task new --source CIR-19420 --repo selectdb/selectdb-core');
    expect(r.body.draft.fields.path).toBeNull();
    expect(r.body.draft.payload.highlight).toContain('path');
  }));
  it('UT-S04-09: /task pause T-231 执行暂停并回系统消息', () => withReport('UT-S04-09', async () => {
    await channel();
    await seedTask(app.db, { key: 'T-231', state: 'running', channel: 'doris-index' });
    const r = await post('/task pause T-231');
    expect(r.status).toBe(202); expect(r.body.handling).toBe('command');
    expect((await app.tasks.byKey('T-231')).state).toBe('paused');
    const msgs = await http(app, 'GET', '/api/channels/doris-index/messages');
    expect(msgs.body.items.some((m: any) => m.kind === 'system' && m.text.includes('T-231 已暂停'))).toBe(true);
  }));
  it('UT-S04-10: 未知命令返回 422 并提示', () => withReport('UT-S04-10', async () => {
    await channel();
    const r = await post('/foo bar');
    expect(r.status).toBe(422); expect(r.body.details.command).toBe('foo'); expect(r.body.message).toContain('输入 / 查看列表');
    expect(parseCommand('/foo bar')).toMatchObject({ command: 'foo' });
  }));
  it('UT-S04-11: /approve 等价 decide approve（原样）', () => withReport('UT-S04-11', async () => {
    await channel();
    const t = await seedTask(app.db, { key: 'T-231', state: 'running', channel: 'doris-index' });
    const a = await app.approvals.request({ taskId: t, actionType: 'reply_review', title: '回复', body: 'v1', payload: { taskKey: 'T-231' } });
    const r = await post(`/approve ${a.key}`);
    expect(r.status).toBe(202);
    const fresh = await app.approvals.byKey(a.key);
    expect(fresh!.status).toBe('approved'); expect(fresh!.decided_via).toBe('panel'); expect(fresh!.modified).toBe(false);
  }));
});

describe('S04 1.3 调度员会话生命周期', () => {
  it('UT-S04-12: 无活跃调度员时拉起，路由到 center', () => withReport('UT-S04-12', async () => {
    await channel(); const w = await fw('center', CENTER); await seedRuntime(app.db, { name: 'dev', labels: DEV.labels });
    const r = await post('把 CIR-19418 修了');
    expect(r.body.handling).toBe('dispatcher');
    const env = await w.expect((e: Envelope) => e.type === 'session.start');
    expect(env.payload.kind).toBe('dispatcher');
    const s = await app.db.one<any>(`SELECT s.kind, s.channel_id, r.name FROM sessions s JOIN runtimes r ON r.id=s.runtime_id WHERE s.kind='dispatcher'`);
    expect(s.name).toBe('center');
    expect(s.channel_id).toBe((await app.db.one<any>(`SELECT id FROM channels WHERE slug='doris-index'`)).id);
  }));
  it('UT-S04-13: 有活跃调度员时改为 session.resume', () => withReport('UT-S04-13', async () => {
    await channel(); const w = await fw('center', CENTER);
    await post('第一句');
    await w.expect((e: Envelope) => e.type === 'session.start');
    const r = await post('第二句');
    expect(r.body.handling).toBe('dispatcher');
    const env = await w.expect((e: Envelope) => e.type === 'session.resume');
    expect(env.payload.text).toBe('第二句');
    expect(Number((await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM sessions WHERE kind='dispatcher'`))!.n)).toBe(1);
  }));
  it('UT-S04-14: 调度员提示词含最近 50 条频道消息与 runtime/仓库清单', () => withReport('UT-S04-14', async () => {
    await channel(); await fw('center', CENTER); await fw('dev', DEV);
    const c = await app.db.one<any>(`SELECT id FROM channels WHERE slug='doris-index'`);
    for (let i = 0; i < 60; i++) await app.db.query(`INSERT INTO messages (channel_id, kind, author, text, created_at) VALUES ($1,'user','user',$2,$3)`, [c.id, `msg-${i}`, new Date(app.clock.now().getTime() - (60 - i) * 1000)]);
    await post('最后一句');
    const s = await app.db.one<any>(`SELECT prompt FROM sessions WHERE kind='dispatcher'`);
    expect(s.prompt).toContain('doris-index');
    expect(s.prompt).toContain('msg-59'); expect(s.prompt).not.toContain('msg-0 ');
    expect(s.prompt).toContain('build:doris');
    expect(s.prompt).toContain('selectdb/selectdb-core');
  }));
  it('UT-S04-15: 空闲超过 30 分钟被回收', () => withReport('UT-S04-15', async () => {
    await channel(); const w = await fw('center', CENTER);
    await post('一句话');
    const start = await w.expect((e: Envelope) => e.type === 'session.start');
    await app.db.query(`UPDATE sessions SET last_activity_at=$1 WHERE kind='dispatcher'`, [new Date(app.clock.now().getTime() - 31 * 60_000)]);
    await app.scheduler.tick('dispatcher-idle');
    const stop = await w.expect((e: Envelope) => e.type === 'session.stop');
    expect(stop.payload.reason).toBe('idle');
    expect(stop.payload.sessionId).toBe(start.payload.sessionId);
    expect((await app.db.one<any>(`SELECT state FROM sessions WHERE kind='dispatcher'`)).state).toBe('stopped');
  }));
  it('UT-S04-16: 空闲 29 分钟不回收', () => withReport('UT-S04-16', async () => {
    await channel(); const w = await fw('center', CENTER);
    await post('一句话');
    await w.expect((e: Envelope) => e.type === 'session.start');
    await app.db.query(`UPDATE sessions SET last_activity_at=$1 WHERE kind='dispatcher'`, [new Date(app.clock.now().getTime() - 29 * 60_000)]);
    await app.scheduler.tick('dispatcher-idle');
    await expect(w.expect((e: Envelope) => e.type === 'session.stop', 800)).rejects.toThrow();
    expect((await app.db.one<any>(`SELECT state FROM sessions WHERE kind='dispatcher'`)).state).toBe('planned');
  }));
});

describe('S04 1.4 草案与确认', () => {
  it('UT-S04-17: propose_task 缺 path 被拒', () => withReport('UT-S04-17', async () => {
    await channel(); await seedRuntime(app.db, { name: 'center', labels: CENTER.labels });
    const { token } = await dispatcherSession();
    const r = await mcp(token, 'propose_task', { channel: 'doris-index', source: 'CIR-19418' });
    expect(r.error.code).toBe(-32602);
  }));
  it('UT-S04-18: propose_task 写草案与 draft_card 消息', () => withReport('UT-S04-18', async () => {
    await channel(); await seedRuntime(app.db, { name: 'center', labels: CENTER.labels });
    const { token } = await dispatcherSession();
    const r = await mcp(token, 'propose_task', { channel: 'doris-index', source: 'CIR-19418', sourceTitle: 'show index 报错', repo: 'selectdb/selectdb-core', path: 'fix' });
    expect(r.result.structuredContent.draftId).toBeTruthy();
    const d = await app.db.one<any>('SELECT * FROM task_drafts');
    expect(d.status).toBe('open'); expect(d.origin).toBe('dispatcher');
    const m = await app.db.one<any>(`SELECT * FROM messages WHERE kind='draft_card'`);
    expect(m.ref_type).toBe('draft'); expect(m.ref_id).toBe(d.id);
  }));
  it('UT-S04-19: confirmDraft 创建任务并挂到该频道，pick_targets 只记录', () => withReport('UT-S04-19', async () => {
    await channel(); await seedRuntime(app.db, { name: 'center', labels: CENTER.labels }); await fw('dev', DEV);
    const { token } = await dispatcherSession();
    const p = await mcp(token, 'propose_task', { channel: 'doris-index', source: 'CIR-19418', repo: 'selectdb/selectdb-core', path: 'fix', pickTargets: ['branch-selectdb-doris-3.1'] });
    const draftId = p.result.structuredContent.draftId;
    const r = await http(app, 'POST', `/api/drafts/${draftId}/confirm`);
    expect(r.status).toBe(201); expect(r.body.channel).toBe('doris-index'); expect(r.body.state).toBe('triaging');
    expect(r.body.pickTargets).toEqual(['branch-selectdb-doris-3.1']);
    const d = await app.db.one<any>('SELECT * FROM task_drafts WHERE id=$1', [draftId]);
    expect(d.status).toBe('confirmed'); expect(d.task_id).toBeTruthy();
  }));
  it('UT-S04-20: confirmDraft 的 edits 覆盖草案字段', () => withReport('UT-S04-20', async () => {
    await channel();
    const r0 = await post('/task new --source CIR-19418 --repo apache/doris --path fix');
    const r = await http(app, 'POST', `/api/drafts/${r0.body.draft.id}/confirm`, { edits: { repo: 'selectdb/selectdb-core' } });
    expect(r.status).toBe(201); expect(r.body.repo.name).toBe('selectdb/selectdb-core'); expect(r.body.repo.source).toBe('manual');
  }));
  it('UT-S04-21: 已取消草案 confirm 返回 409', () => withReport('UT-S04-21', async () => {
    await channel();
    const r0 = await post('/task new --source CIR-19418 --repo selectdb/selectdb-core --path fix');
    await http(app, 'POST', `/api/drafts/${r0.body.draft.id}/cancel`);
    const r = await http(app, 'POST', `/api/drafts/${r0.body.draft.id}/confirm`);
    expect(r.status).toBe(409); expect(r.body.code).toBe('DRAFT_NOT_OPEN');
  }));
  it('UT-S04-22: 草案 24 小时过期', () => withReport('UT-S04-22', async () => {
    await channel();
    const r0 = await post('/task new --source CIR-19418 --repo selectdb/selectdb-core --path fix');
    await app.fakeClock.advance(25 * 3600_000);
    const r = await http(app, 'POST', `/api/drafts/${r0.body.draft.id}/confirm`);
    expect(r.status).toBe(409); expect(r.body.code).toBe('DRAFT_NOT_OPEN');
    expect((await app.db.one<any>('SELECT status FROM task_drafts WHERE id=$1', [r0.body.draft.id])).status).toBe('expired');
  }));
  it('UT-S04-23: cancelDraft 幂等', () => withReport('UT-S04-23', async () => {
    await channel();
    const r0 = await post('/task new --source CIR-19418 --repo selectdb/selectdb-core --path fix');
    const a = await http(app, 'POST', `/api/drafts/${r0.body.draft.id}/cancel`);
    const b = await http(app, 'POST', `/api/drafts/${r0.body.draft.id}/cancel`);
    expect(a.status).toBe(200); expect(b.status).toBe(200); expect(b.body.status).toBe('cancelled');
  }));
  it('UT-S04-24: ask_clarification candidates 超过 5 个被拒', () => withReport('UT-S04-24', async () => {
    await channel(); await seedRuntime(app.db, { name: 'center', labels: CENTER.labels });
    const { token } = await dispatcherSession();
    const r = await mcp(token, 'ask_clarification', { channel: 'doris-index', text: '哪个？', candidates: Array.from({ length: 6 }, (_, i) => ({ label: `t${i}`, value: `T-${i}` })) });
    expect(r.error.code).toBe(-32602);
  }));
  it('UT-S04-25: lookup_jira 转系统作业并等待结果', () => withReport('UT-S04-25', async () => {
    await channel(); await seedRuntime(app.db, { name: 'center', labels: CENTER.labels });
    const w = await fw('dev', DEV);
    const { token } = await dispatcherSession();
    const p = mcp(token, 'lookup_jira', { key: 'CIR-19418' });
    const env = await w.expect((e: Envelope) => e.type === 'job.run' && e.payload.kind === 'jira-lookup');
    w.send('job.result', { ok: true, result: { found: true, issue: { key: 'CIR-19418', summary: 'show index 报错' } } }, env.id);
    const r = await p;
    expect(r.result.structuredContent).toMatchObject({ found: true });
    expect(r.result.structuredContent.issue.summary).toBe('show index 报错');
    const job = await app.db.one<any>(`SELECT status FROM jobs WHERE kind='jira-lookup'`);
    expect(job.status).toBe('succeeded');
  }));
  it('UT-S04-26: lookup_jira 无 vpn:jira runtime 返回 SOURCE_UNAVAILABLE', () => withReport('UT-S04-26', async () => {
    await channel(); await seedRuntime(app.db, { name: 'center', labels: CENTER.labels });
    const { token } = await dispatcherSession();
    const r = await mcp(token, 'lookup_jira', { key: 'CIR-19418' });
    expect(r.error.code).toBe(-32003); expect(r.error.message).toContain('SOURCE_UNAVAILABLE');
    expect(Number((await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM jobs WHERE kind='jira-lookup'`))!.n)).toBe(0);
  }));
});
