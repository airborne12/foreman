/** 单执行器 API 编排：真实中心与 WebSocket worker，沿用 OpenLogos reporter。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { bootTestApp, http, TEST_TOKEN, type TestApp } from '../helpers/testApp.js';
import { FakeWorker } from '../helpers/fakeWorker.js';
import { seedTask, seedSession, seedWorktree, seedChannel } from '../helpers/seed.js';
import { withReport } from '../helpers/reporter.js';
import { Intake } from '../../apps/center/src/domain/intake.js';

let app: TestApp;
const workers: FakeWorker[] = [];
async function worker(name = 'dev', agents: Record<string, { bin: string; maxConcurrent: number }> = { codex: { bin: 'fake-codex', maxConcurrent: 3 } }) {
  const w = new FakeWorker(app.ws, TEST_TOKEN); await w.connect(); workers.push(w);
  await w.register({ name, labels: ['build:doris', 'agent:codex'], agents, repos: { 'selectdb/selectdb-core': { main: '/tmp/core', worktreeRoot: '/tmp/wt' } } });
  await new Promise((r) => setTimeout(r, 80)); return w;
}
beforeAll(async () => { app = await bootTestApp(); });
beforeEach(async () => { for (const w of workers.splice(0)) w.close(); await new Promise((r) => setTimeout(r, 80)); await http(app, 'POST', '/__test/reset'); });
afterAll(async () => { for (const w of workers) w.close(); await new Promise((r) => setTimeout(r, 100)); await app.close(); });

describe('Codex 单执行器 API 编排', () => {
  it('ST-S03-20: 旧任务默认改派 Codex，review 与文本会话也是 Codex', () => withReport('ST-S03-20', async () => {
    const w = await worker();
    const task = await seedTask(app.db, { key: 'T-900', state: 'queued', runtime: 'dev', agent: 'claude' });
    await seedWorktree(app.db, { taskId: task, runtime: 'dev', path: '/tmp/wt/T-900' });
    await app.db.query("UPDATE worktrees SET base_branch='selectdb-cloud-4.0' WHERE task_id=$1", [task]);
    await app.dispatch.dispatchTask(task);
    const cmd = await w.expect((e) => e.type === 'session.start'); expect(cmd.payload.agent).toBe('codex');
    expect(await app.dispatch.reviewerFor({ author_agent: 'codex' })).toBe('codex');
    const result = await app.dispatch.startTextSession({ channelId: null, kind: 'candidate_scan', prompt: '扫描' });
    expect('agent' in result && result.agent).toBe('codex');
  }));
  it('ST-S03-21: HTTP 和 MCP 不接受停用执行器', () => withReport('ST-S03-21', async () => {
    await worker();
    for (const agent of ['claude', 'opencode']) {
      const r = await http(app, 'POST', '/api/tasks', { source: 'CIR-900', path: 'fix', agent });
      expect(r.status).toBe(422); expect(r.body.code).toBe('VALIDATION_FAILED');
    }
    await seedTask(app.db, { key: 'T-901', state: 'failed' });
    expect((await http(app, 'POST', '/api/tasks/T-901/restart', { agent: 'claude' })).status).toBe(422);
    const cid = await seedChannel(app.db, 'codex-mcp');
    const sid = await seedSession(app.db, { channelId: cid, runtime: 'dev', agent: 'codex', kind: 'dispatcher' });
    const token = Intake.newToken(); await app.db.query('UPDATE sessions SET mcp_token_hash=$2 WHERE id=$1', [sid, Intake.hash(token)]);
    const response = await fetch(app.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_task', arguments: { channel: 'codex-mcp', source: 'CIR-902', path: 'fix', agent: 'claude' } } }) });
    const body = await response.json() as any;
    expect(body.error).toBeTruthy(); expect(await app.db.one('SELECT 1 FROM task_drafts')).toBeNull();

  }));
  it('ST-S03-22: Codex 满额时分析任务排队，不能借用 Claude 名额', () => withReport('ST-S03-22', async () => {
    await worker('dev', { codex: { bin: 'fake-codex', maxConcurrent: 1 }, claude: { bin: 'fake-claude', maxConcurrent: 99 } });
    await seedSession(app.db, { runtime: 'dev', agent: 'codex' });
    const id = await seedTask(app.db, { key: 'T-902', state: 'queued', kind: 'analysis' });
    await app.dispatch.dispatchTask(id);
    const t = await app.tasks.byKey('T-902'); expect(t.state).toBe('queued'); expect(t.queue_reason).toContain('codex');
    expect(await app.db.one('SELECT 1 FROM sessions WHERE task_id=$1', [id])).toBeNull();
    expect(await app.dispatch.pickFreeAgent({ id: (await app.db.one<any>("SELECT id FROM runtimes WHERE name='dev'"))!.id, agents: { claude: { maxConcurrent: 99 } } })).toBeNull();
  }));
  it('ST-S03-25: 遗留 planned 会话转换遵守 Codex 名额，释放后补派', () => withReport('ST-S03-25', async () => {
    const w = await worker('dev', { codex: { bin: 'fake-codex', maxConcurrent: 1 } });
    const busy = await seedSession(app.db, { runtime: 'dev', agent: 'codex' });
    const id = await seedTask(app.db, { key: 'T-925', state: 'queued', runtime: 'dev', agent: 'claude' });
    const pending = await seedSession(app.db, { taskId: id, runtime: 'dev', agent: 'claude', state: 'planned', kind: 'plan' });
    const wt = await seedWorktree(app.db, { taskId: id, runtime: 'dev', path: '/tmp/wt/T-925' });
    await app.db.query('UPDATE sessions SET worktree_id=$2 WHERE id=$1', [pending, wt]);
    await app.dispatch.startSession(pending, '/tmp/wt/T-925');
    expect(app.workerHub.sentLog.some((x) => x.env.type === 'session.start' && x.env.payload.sessionId === pending)).toBe(false);
    expect((await app.tasks.byKey('T-925')).queue_reason).toContain('codex');
    await app.dispatch.onSessionState('dev', { sessionId: busy, state: 'done', source: 'exit', exitCode: 0 });
    const cmd = await w.expect((e) => e.type === 'session.start' && e.payload.sessionId === pending);
    expect(cmd.payload.agent).toBe('codex'); expect(cmd.payload.kind).toBe('plan');
    expect((await app.db.one<any>('SELECT count(*)::int AS n FROM sessions WHERE task_id=$1', [id])).n).toBe(1);
  }));
  it('ST-S03-26: 两个遗留会话并行转换只预约一个 Codex 名额', () => withReport('ST-S03-26', async () => {
    await worker('dev', { codex: { bin: 'fake-codex', maxConcurrent: 1 } });
    const ids = await Promise.all([926, 927].map(async (n) => {
      const taskId = await seedTask(app.db, { key: `T-${n}`, state: 'queued', runtime: 'dev', agent: 'claude' });
      return seedSession(app.db, { taskId, runtime: 'dev', agent: 'claude', state: 'planned' });
    }));
    await Promise.all(ids.map((id) => app.dispatch.startSession(id, '/tmp')));
    expect(app.workerHub.sentLog.filter((x) => x.env.type === 'session.start' && ids.includes(String(x.env.payload.sessionId)))).toHaveLength(1);
    expect((await app.db.one<any>("SELECT count(*)::int AS n FROM sessions WHERE agent='codex' AND state='planned'")).n).toBe(1);
  }));
  it('ST-S03-27: 遗留转换与新的文本会话共用 Codex 预约闸门', () => withReport('ST-S03-27', async () => {
    await worker('center', { codex: { bin: 'fake-codex', maxConcurrent: 1 } });
    const taskId = await seedTask(app.db, { key: 'T-928', state: 'queued', runtime: 'center', agent: 'claude' });
    const sid = await seedSession(app.db, { taskId, runtime: 'center', agent: 'claude', state: 'planned' });
    await Promise.all([app.dispatch.startSession(sid, '/tmp'), app.dispatch.startTextSession({ channelId: null, kind: 'candidate_scan', prompt: '扫描' })]);
    expect(app.workerHub.sentLog.filter((x) => x.env.type === 'session.start')).toHaveLength(1);
    expect((await app.db.one<any>("SELECT count(*)::int AS n FROM sessions WHERE agent='codex' AND state='planned'")).n).toBe(1);
  }));
  it('ST-S03-28: 完成后续接重新预约，Codex 满额时不启动进程', () => withReport('ST-S03-28', async () => {
    const w = await worker('dev', { codex: { bin: 'fake-codex', maxConcurrent: 1 } });
    const taskId = await seedTask(app.db, { key: 'T-929', state: 'delivered', runtime: 'dev', agent: 'codex' });
    const sid = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'codex', state: 'done', agentSessionId: 'thread-done' });
    const busy = await seedSession(app.db, { runtime: 'dev', agent: 'codex' });
    const blocked = await http(app, 'POST', '/api/tasks/T-929/messages', { text: '继续改进' });
    expect(blocked.status).toBe(409); expect(blocked.body.code).toBe('RESUME_FAILED');
    expect(app.workerHub.sentLog.some((x) => x.env.type === 'session.resume')).toBe(false);
    await app.dispatch.onSessionState('dev', { sessionId: busy, state: 'done', source: 'exit', exitCode: 0 });
    expect((await http(app, 'POST', '/api/tasks/T-929/messages', { text: '继续改进' })).status).toBe(202);
    expect((await w.expect((e) => e.type === 'session.resume')).payload.sessionId).toBe(sid);
  }));
  it('ST-S03-23: 旧会话不能续接，重试会开启附摘要的 Codex 会话', () => withReport('ST-S03-23', async () => {
    const w = await worker();
    const id = await seedTask(app.db, { key: 'T-903', state: 'failed', agent: 'claude', runtime: 'dev' });
    const old = await seedSession(app.db, { taskId: id, runtime: 'dev', agent: 'claude', state: 'failed', agentSessionId: 'legacy-thread' });
    const wt = await seedWorktree(app.db, { taskId: id, runtime: 'dev', path: '/tmp/wt/T-903' });
    await app.db.query('UPDATE sessions SET worktree_id=$2 WHERE id=$1', [old, wt]);
    const r = await http(app, 'POST', '/api/tasks/T-903/messages', { text: '继续' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('RESUME_FAILED');
    expect((await http(app, 'POST', '/api/tasks/T-903/retry', { mode: 'switch_agent' })).status).toBe(202);
    const start = await w.expect((e) => e.type === 'session.start');
    expect(start.payload.agent).toBe('codex'); expect(start.payload.sessionId).not.toBe(old); expect(String(start.payload.prompt)).toContain('线程摘要');
  }));
  it('ST-S03-24: 旧频道调度员由新的 Codex 会话接手，无 Codex 的 runtime 不被选中', () => withReport('ST-S03-24', async () => {
    const w = await worker('center');
    const cid = await seedChannel(app.db, 'legacy');
    const old = await seedSession(app.db, { channelId: cid, runtime: 'center', agent: 'claude', kind: 'dispatcher' });
    const r = await http(app, 'POST', '/api/channels/legacy/messages', { text: '帮我整理任务' });
    expect(r.status).toBe(202);
    const start = await w.expect((e) => e.type === 'session.start'); expect(start.payload.agent).toBe('codex'); expect(start.payload.sessionId).not.toBe(old);
    await worker('dev', { claude: { bin: 'fake-claude', maxConcurrent: 3 } });
    const route = await app.tasks.routeFor('code'); expect(route.runtime).toBe('center');
  }));
});
