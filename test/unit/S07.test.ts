/**
 * S07 单元测试：UT-S07-01 ~ UT-S07-29（来源：logos/resources/test/core-S07-test-cases.md）
 * 进展回写与日志、需要输入与回答、完成/续接/停止/无进展。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { withReport } from '../helpers/reporter.js';
import { bootTestApp, http, TEST_TOKEN, type TestApp } from '../helpers/testApp.js';
import { FakeWorker } from '../helpers/fakeWorker.js';
import { seedTask, seedRuntime, seedSession, seedWorktree } from '../helpers/seed.js';
import { Intake } from '../../apps/center/src/domain/intake.js';
import { claudeAdapter } from '../../apps/worker/src/sessions.js';
import type { Envelope } from '@foreman/shared';

let app: TestApp;
const workers: FakeWorker[] = [];
const REG = { labels: ['agent:claude', 'agent:codex', 'build:doris'], agents: { claude: { bin: 'fake-claude', maxConcurrent: 3 }, codex: { bin: 'fake-codex', maxConcurrent: 3 } } };
async function fw(name = 'dev') {
  const w = new FakeWorker(app.ws, TEST_TOKEN); await w.connect(); workers.push(w);
  const ack = await w.register({ name, ...REG }); if (ack.type !== 'register.ack') throw new Error(JSON.stringify(ack.payload));
  await new Promise((r) => setTimeout(r, 100)); return w;
}
/** running 会话（含 worktree、token） */
async function running(opts: { key?: string; state?: string; sessionState?: string; agentSessionId?: string; online?: boolean } = {}) {
  const key = opts.key ?? 'T-231';
  if (!opts.online) await seedRuntime(app.db, { name: 'dev', labels: REG.labels, agents: REG.agents });
  const taskId = await seedTask(app.db, { key, state: opts.state ?? 'running', runtime: 'dev', agent: 'claude', authorAgent: 'claude' });
  const wt = await seedWorktree(app.db, { taskId, runtime: 'dev', path: `/tmp/fx/wt/${key}` });
  const sid = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'claude', kind: 'implement', state: opts.sessionState ?? 'running', agentSessionId: opts.agentSessionId ?? 'cl-231', cwd: `/tmp/fx/wt/${key}`, startedAt: app.clock.now() });
  const token = Intake.newToken();
  await app.db.query('UPDATE sessions SET worktree_id=$2, mcp_token_hash=$3 WHERE id=$1', [sid, wt, Intake.hash(token)]);
  return { taskId, sid, token, key };
}
const mcp = (token: string, tool: string, args: Record<string, unknown>) => fetch(app.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) }).then((r) => ({ status: r.status, json: r.json() as Promise<any> }));
const post = (key: string, body: Record<string, unknown>) => http(app, 'POST', `/api/tasks/${key}/messages`, body);
const emitReply = (parent_id: string, text: string, message_id = `om_r_${Date.now()}`) => http(app, 'POST', '/__test/lark/emit', { event: { type: 'im.message.receive_v1', event_id: crypto.randomUUID(), message_id, operator_type: 'user', sender_open_id: 'ou_owner', parent_id, text } });

beforeAll(async () => { app = await bootTestApp(); });
afterAll(async () => { for (const w of workers) w.close(); await new Promise((r) => setTimeout(r, 300)); await app.close(); });
beforeEach(async () => { for (const w of workers.splice(0)) w.close(); await new Promise((r) => setTimeout(r, 80)); await http(app, 'POST', '/__test/reset'); });

describe('S07 1.1 进展回写与日志', () => {
  it('UT-S07-01: report_progress 写 progress 消息并刷新 last_progress_at', () => withReport('UT-S07-01', async () => {
    const { token, sid, taskId } = await running();
    const r = await (await mcp(token, 'report_progress', { taskKey: 'T-231', text: '复'.repeat(120) })).json;
    expect(r.result.structuredContent.ok).toBe(true);
    const m = await app.db.one<any>(`SELECT * FROM messages WHERE task_id=$1 AND kind='progress'`, [taskId]);
    expect(m.text).toHaveLength(120);
    expect(new Date((await app.db.one<any>('SELECT last_progress_at FROM sessions WHERE id=$1', [sid])).last_progress_at).getTime()).toBe(app.clock.now().getTime());
  }));
  it('UT-S07-02: 超过 200 字被截断并标记', () => withReport('UT-S07-02', async () => {
    const { token, taskId } = await running();
    const r = await (await mcp(token, 'report_progress', { taskKey: 'T-231', text: 'x'.repeat(260) })).json;
    expect(r.result.structuredContent.truncated).toBe(true);
    const m = await app.db.one<any>(`SELECT * FROM messages WHERE task_id=$1 AND kind='progress'`, [taskId]);
    expect(m.text).toHaveLength(200); expect(m.payload.truncated).toBe(true);
  }));
  it('UT-S07-03: progress 消息带 log_from/log_to 时间窗', () => withReport('UT-S07-03', async () => {
    const { token, taskId } = await running();
    const t1 = app.clock.now();
    await (await mcp(token, 'report_progress', { taskKey: 'T-231', text: 'a' })).json;
    await app.fakeClock.advance(8 * 60_000);
    const t2 = app.clock.now();
    await (await mcp(token, 'report_progress', { taskKey: 'T-231', text: 'b' })).json;
    const m = await app.db.one<any>(`SELECT * FROM messages WHERE task_id=$1 AND kind='progress' AND text='b'`, [taskId]);
    expect(new Date(m.log_from).getTime()).toBe(t1.getTime()); expect(new Date(m.log_to).getTime()).toBe(t2.getTime());
    expect(m.payload.logFrom).toBe(t1.toISOString());
  }));
  it('UT-S07-04: getSessionLogs limit 超过 2000 被拒', () => withReport('UT-S07-04', async () => {
    const { sid } = await running();
    const r = await http(app, 'GET', `/api/sessions/${sid}/logs?limit=5000`);
    expect(r.status).toBe(422);
  }));
  it('UT-S07-05: getSessionLogs 经 worker 通道取片段并返回 truncated', () => withReport('UT-S07-05', async () => {
    const w = await fw();
    const { sid } = await running({ online: true });
    void w.expect((e: Envelope) => e.type === 'session.logs').then((env) => w.send('session.logs.result', { sessionId: sid, lines: Array.from({ length: 600 }, (_, i) => `line ${i}`), truncated: false }, env.id));
    const r = await http(app, 'GET', `/api/sessions/${sid}/logs?limit=400`);
    expect(r.status).toBe(200); expect(r.body.lines).toHaveLength(400); expect(r.body.truncated).toBe(true);
  }));
  it('UT-S07-06: runtime 离线时 getSessionLogs 503', () => withReport('UT-S07-06', async () => {
    const { sid } = await running();
    await app.db.query(`UPDATE runtimes SET online=false WHERE name='dev'`);
    const r = await http(app, 'GET', `/api/sessions/${sid}/logs`);
    expect(r.status).toBe(503); expect(r.body.code).toBe('RUNTIME_OFFLINE'); expect(r.body.message).toContain('dev');
  }));
  it('UT-S07-07: task token 与 taskKey 不符的 MCP 调用返回 -32001', () => withReport('UT-S07-07', async () => {
    const { token } = await running();
    await seedTask(app.db, { key: 'T-232', state: 'running', runtime: 'dev' });
    const r = await (await mcp(token, 'report_progress', { taskKey: 'T-232', text: 'x' })).json;
    expect(r.error.code).toBe(-32001);
  }));
  it('UT-S07-08: 任务终态后 MCP token 失效 401', () => withReport('UT-S07-08', async () => {
    const { token, taskId } = await running();
    await app.db.query(`UPDATE tasks SET state='done', terminal_at=$2 WHERE id=$1`, [taskId, app.clock.now()]);
    const r = await mcp(token, 'report_progress', { taskKey: 'T-231', text: 'x' });
    expect(r.status).toBe(401);
  }));
});

describe('S07 1.2 需要输入与回答', () => {
  it('UT-S07-09: ask_user 创建 open 问题、ask 消息，任务 waiting_input', () => withReport('UT-S07-09', async () => {
    const { token, taskId } = await running();
    const p = mcp(token, 'ask_user', { taskKey: 'T-231', question: '方案一还是二？', options: ['一', '二'] }).then((r) => r.json);
    await new Promise((r) => setTimeout(r, 300));
    const q = await app.db.one<any>('SELECT * FROM questions WHERE task_id=$1', [taskId]);
    expect(q.status).toBe('open'); expect(new Date(q.expires_at).getTime() - new Date(q.asked_at).getTime()).toBe(30 * 60_000);
    expect(await app.db.one(`SELECT 1 FROM messages WHERE task_id=$1 AND kind='ask'`, [taskId])).not.toBeNull();
    expect((await app.tasks.byKey('T-231')).state).toBe('waiting_input');
    expect(await app.db.one(`SELECT 1 FROM notifications WHERE kind='question' AND ref_id=$1`, [q.id])).not.toBeNull();
    await app.fakeClock.advance(30 * 60_000); await p;
  }));
  it('UT-S07-10: ask_user timeoutMinutes 超过 30 被拒', () => withReport('UT-S07-10', async () => {
    const { token } = await running();
    const r = await (await mcp(token, 'ask_user', { taskKey: 'T-231', question: 'q', timeoutMinutes: 45 })).json;
    expect(r.error.code).toBe(-32602);
  }));
  it('UT-S07-11: postTaskMessage 有 open 问题时 delivery=answered 并唤醒 MCP', () => withReport('UT-S07-11', async () => {
    const { token, taskId } = await running();
    const p = mcp(token, 'ask_user', { taskKey: 'T-231', question: '选哪个？' }).then((r) => r.json);
    await new Promise((r) => setTimeout(r, 300));
    const r = await post('T-231', { text: '方案二' });
    expect(r.status).toBe(202); expect(r.body.delivery).toBe('answered');
    const out = await p;
    expect(out.result.structuredContent).toMatchObject({ answered: true, answer: '方案二', answeredVia: 'panel' });
    expect((await app.db.one<any>('SELECT status FROM questions WHERE task_id=$1', [taskId])).status).toBe('answered');
    expect((await app.tasks.byKey('T-231')).state).toBe('running');
  }));
  it('UT-S07-12: postTaskMessage 无 open 问题时 delivery=resumed 下发 session.resume', () => withReport('UT-S07-12', async () => {
    const w = await fw();
    const { sid } = await running({ online: true, sessionState: 'done', state: 'delivered' });
    const r = await post('T-231', { text: '顺便改一下' });
    expect(r.status).toBe(202); expect(r.body.delivery).toBe('resumed');
    const env = await w.expect((e: Envelope) => e.type === 'session.resume');
    expect(env.payload.sessionId).toBe(sid); expect(env.payload.text).toBe('顺便改一下');
  }));
  it('UT-S07-13: runtime 离线时 delivery=queued 且消息标 queued', () => withReport('UT-S07-13', async () => {
    const { taskId } = await running();
    const r = await post('T-231', { text: '再检查一遍' });
    expect(r.status).toBe(202); expect(r.body.delivery).toBe('queued');
    expect((await app.db.one<any>(`SELECT delivery FROM messages WHERE task_id=$1 AND kind='user'`, [taskId])).delivery).toBe('queued');
  }));
  it('UT-S07-14: 指定 questionId 回答特定问题', () => withReport('UT-S07-14', async () => {
    const { token, sid, taskId } = await running();
    const p1 = mcp(token, 'ask_user', { taskKey: 'T-231', question: 'q1' }).then((r) => r.json);
    await new Promise((r) => setTimeout(r, 200));
    const q1 = await app.db.one<any>(`SELECT id FROM questions WHERE text='q1'`);
    await app.db.query(`INSERT INTO questions (task_id, session_id, text, status, expires_at, asked_at) VALUES ($1,$2,'q2','open',$3,$3)`, [taskId, sid, new Date(app.clock.now().getTime() + 1000)]);
    const r = await post('T-231', { text: '答一', questionId: q1.id });
    expect(r.status).toBe(202);
    expect((await app.db.one<any>(`SELECT status FROM questions WHERE text='q1'`)).status).toBe('answered');
    expect((await app.db.one<any>(`SELECT status FROM questions WHERE text='q2'`)).status).toBe('open');
    await p1;
  }));
  it('UT-S07-15: 问题已答再答返回 409 但消息仍追加并 resume', () => withReport('UT-S07-15', async () => {
    const w = await fw();
    const { token, taskId } = await running({ online: true });
    const p = mcp(token, 'ask_user', { taskKey: 'T-231', question: 'q1' }).then((r) => r.json);
    await new Promise((r) => setTimeout(r, 200));
    const q = await app.db.one<any>(`SELECT id FROM questions WHERE text='q1'`);
    await post('T-231', { text: '答一', questionId: q.id }); await p;
    const r = await post('T-231', { text: '补充', questionId: q.id });
    expect(r.status).toBe(409); expect(r.body.code).toBe('QUESTION_ALREADY_ANSWERED');
    expect(Number((await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM messages WHERE task_id=$1 AND kind='user_reply'`, [taskId]))!.n)).toBe(2);
    const env = await w.expect((e: Envelope) => e.type === 'session.resume' && e.payload.text === '补充');
    expect(env.payload.text).toBe('补充');
  }));
  it('UT-S07-16: 飞书回复按 parent_id 匹配问题', () => withReport('UT-S07-16', async () => {
    const { token, taskId } = await running();
    const p = mcp(token, 'ask_user', { taskKey: 'T-231', question: 'q1' }).then((r) => r.json);
    await new Promise((r) => setTimeout(r, 300));
    const q = await app.db.one<any>('SELECT * FROM questions WHERE task_id=$1', [taskId]);
    expect(q.feishu_message_id).toBeTruthy();
    const r = await emitReply(q.feishu_message_id, '方案二', 'om_reply');
    expect(r.body.handled).toBe('answered');
    const out = await p; expect(out.result.structuredContent.answeredVia).toBe('feishu');
    expect((await app.db.one<any>('SELECT answered_via FROM questions WHERE id=$1', [q.id])).answered_via).toBe('feishu');
    expect(app.fakeFeishu.sent.some((m) => m.kind === 'messages-reply' && m.message_id === 'om_reply' && m.text.includes('已送入'))).toBe(true);
  }));
  it('UT-S07-17: 飞书回复非问题消息回帖引导', () => withReport('UT-S07-17', async () => {
    const { taskId } = await running();
    const a = await app.approvals.request({ taskId, actionType: 'create_pr', title: 't', body: 'b', payload: { taskKey: 'T-231' } });
    const r = await emitReply(a.feishu_message_id!, '改成出方案', 'om_reply2');
    expect(r.body.handled).toBe('ignored');
    expect(app.fakeFeishu.sent.some((m) => m.kind === 'messages-reply' && m.message_id === 'om_reply2' && m.text.includes('用 ✅/❌ 操作'))).toBe(true);
    expect((await app.approvals.byKey(a.key))!.status).toBe('pending');
  }));
  it('UT-S07-18: 问题 30 分钟超时 MCP 返回 timeout，状态保持 open', () => withReport('UT-S07-18', async () => {
    const { token, taskId } = await running();
    const p = mcp(token, 'ask_user', { taskKey: 'T-231', question: 'q1' }).then((r) => r.json);
    await new Promise((r) => setTimeout(r, 300));
    await app.fakeClock.advance(30 * 60_000);
    const out = await p;
    expect(out.result.structuredContent).toMatchObject({ answered: false, reason: 'timeout' });
    expect((await app.db.one<any>('SELECT status FROM questions WHERE task_id=$1', [taskId])).status).toBe('open');
    expect((await app.tasks.byKey('T-231')).state).toBe('waiting_input');
  }));
  it('UT-S07-19: 钩子 agent_needs_input 无对应问题时生成 origin=hook 问题', () => withReport('UT-S07-19', async () => {
    const w = await fw();
    const { sid, taskId } = await running({ online: true });
    void w.expect((e: Envelope) => e.type === 'session.logs').then((env) => w.send('session.logs.result', { sessionId: sid, lines: ['…', '要保留旧接口吗？(y/n)'], truncated: false }, env.id));
    w.send('session.state', { sessionId: sid, state: 'waiting_input', waitingFor: 'input', source: 'hook', observedAt: app.clock.now().toISOString() });
    for (let i = 0; i < 30; i++) { if (await app.db.one('SELECT 1 FROM questions WHERE task_id=$1', [taskId])) break; await new Promise((r) => setTimeout(r, 100)); }
    const q = await app.db.one<any>('SELECT * FROM questions WHERE task_id=$1', [taskId]);
    expect(q.origin).toBe('hook'); expect(q.text).toContain('旧接口');
  }));
  it('UT-S07-20: text 超过 20000 被拒', () => withReport('UT-S07-20', async () => {
    await running();
    const r = await post('T-231', { text: 'x'.repeat(20001) });
    expect(r.status).toBe(422);
  }));
});

describe('S07 1.3 完成、续接、停止、无进展', () => {
  it('UT-S07-21: session.state done 更新 sessions 与 tasks，写事件', () => withReport('UT-S07-21', async () => {
    const { sid, taskId } = await running();
    await app.db.query(`INSERT INTO artifacts (task_id, session_id, kind, branch) VALUES ($1,$2,'branch','foreman/T-231')`, [taskId, sid]);
    await app.dispatch.onSessionState('dev', { sessionId: sid, state: 'done', source: 'hook' });
    const s = await app.db.one<any>('SELECT * FROM sessions WHERE id=$1', [sid]); expect(s.state).toBe('done'); expect(s.ended_at).not.toBeNull();
    expect((await app.tasks.byKey('T-231')).state).toBe('delivered');
    expect(await app.db.one(`SELECT 1 FROM events WHERE type='task.updated' AND task_id=$1`, [taskId])).not.toBeNull();
  }));
  it('UT-S07-22: 续接先 stop <短 id> 再 --bg --resume <完整 UUID>', () => withReport('UT-S07-22', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'fclaude-'));
    const bin = resolve(dir, 'claude'); const log = resolve(dir, 'args.log');
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = "agents" ]; then echo '[]'; fi\nif [ "$1" = "--bg" ]; then echo "backgrounded · 3f171235"; fi\n`); chmodSync(bin, 0o755);
    const uuid = '3f171235-0ea7-40ae-b928-49c2b4445518';
    const s = { sessionId: crypto.randomUUID(), agent: 'claude', agentSessionId: uuid, shortId: '3f171235', pid: null, cwd: dir, logFile: resolve(dir, 'session.log'), state: 'done' as 'done' | 'running' | 'failed' | 'stopped' };
    await claudeAdapter.resume(s, '顺便改一下', bin, () => undefined, { pollMs: 3_600_000 });
    const calls = readFileSync(log, 'utf8').split('\n');
    expect(calls.indexOf('stop 3f171235')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`--bg --resume ${uuid} 顺便改一下`)).toBeGreaterThan(calls.indexOf('stop 3f171235'));
    expect(s.state).toBe('running');
    s.state = 'stopped';
    // 空闲进程没停掉时 claude 会开副本 → 视为续接失败
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--bg" ]; then echo "note: session 3f171235 is already running in the background, so this started a copy as 73969ae8."; fi\n`);
    await expect(claudeAdapter.resume({ ...s, state: 'done' }, '再改', bin, () => undefined, { pollMs: 3_600_000 })).rejects.toThrow(/副本/);
  }));
  it('UT-S07-29: 轮询 blocked 上报一次需要输入，done 时先 stop 再报完成；中心对 source=poll 同样推断问题', () => withReport('UT-S07-29', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'fclaude-'));
    const bin = resolve(dir, 'claude'); const log = resolve(dir, 'args.log'); const n = resolve(dir, 'n');
    const uuid = '3f171235-0ea7-40ae-b928-49c2b4445518';
    writeFileSync(bin, [
      '#!/bin/sh', `echo "$@" >> "${log}"`,
      'case "$1" in',
      '  --bg) echo "backgrounded · 3f171235 · T-231-implement";;',
      `  agents) c=$(cat "${n}" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "${n}"; if [ $c -le 3 ]; then echo '[{"id":"3f171235","sessionId":"${uuid}","state":"blocked","status":"waiting"}]'; elif [ $c -le 4 ]; then echo '[{"id":"3f171235","sessionId":"${uuid}","state":"working","status":"busy"}]'; else echo '[{"id":"3f171235","sessionId":"${uuid}","state":"blocked","status":"idle"}]'; fi;;`,
      'esac', '',
    ].join('\n')); chmodSync(bin, 0o755);
    let waits = 0;
    const exited = new Promise<number | null>((res) => {
      void claudeAdapter.start({ sessionId: crypto.randomUUID(), taskKey: 'T-231', kind: 'implement', agent: 'claude', prompt: 'p', cwd: dir, name: 'T-231-implement', mcp: { url: 'http://127.0.0.1:7801/mcp', token: 't' } }, bin, (code) => res(code), { pollMs: 50, onWaiting: () => { waits += 1; } });
    });
    expect(await exited).toBe(0);
    expect(waits).toBe(1);
    expect(readFileSync(log, 'utf8').split('\n')).toContain('stop 3f171235');
    // 中心：source=poll 的 waiting_input 也按 EX-19.1 从日志推断问题
    const w = await fw();
    const { sid, taskId } = await running({ online: true });
    void w.expect((e: Envelope) => e.type === 'session.logs').then((env) => w.send('session.logs.result', { sessionId: sid, lines: ['要保留旧接口吗？(y/n)'], truncated: false }, env.id));
    w.send('session.state', { sessionId: sid, state: 'waiting_input', waitingFor: 'input', source: 'poll', observedAt: app.clock.now().toISOString() });
    for (let i = 0; i < 30; i++) { if (await app.db.one('SELECT 1 FROM questions WHERE task_id=$1', [taskId])) break; await new Promise((r) => setTimeout(r, 100)); }
    expect((await app.db.one<any>('SELECT * FROM questions WHERE task_id=$1', [taskId]))?.text).toContain('旧接口');
  }));
  it('UT-S07-23: 续接失败 RESUME_FAILED → 收件箱三选一（fresh_session）', () => withReport('UT-S07-23', async () => {
    const w = await fw();
    const { sid, taskId } = await running({ online: true, sessionState: 'done', state: 'delivered', agentSessionId: 'cl-gone' });
    await post('T-231', { text: '继续' });
    const env = await w.expect((e: Envelope) => e.type === 'session.resume');
    w.send('error', { code: 'RESUME_FAILED', message: 'session not found', retryable: false }, env.id);
    for (let i = 0; i < 30; i++) { if ((await app.tasks.byKey('T-231')).state === 'failed') break; await new Promise((r) => setTimeout(r, 100)); }
    expect((await app.tasks.byKey('T-231')).state).toBe('failed');
    expect((await http(app, 'GET', '/api/inbox')).body.failures.some((f: any) => f.key === 'T-231')).toBe(true);
    const r = await http(app, 'POST', '/api/tasks/T-231/retry', { mode: 'fresh_session' });
    expect(r.status).toBe(202);
    const start = await w.expect((e: Envelope) => e.type === 'session.start');
    expect(start.payload.sessionId).not.toBe(sid); expect(String(start.payload.prompt)).toContain('线程摘要');
    const rows = await app.db.query<any>('SELECT attempt, worktree_id FROM sessions WHERE task_id=$1 ORDER BY attempt', [taskId]);
    expect(rows.rows[1].attempt).toBe(2); expect(rows.rows[1].worktree_id).toBe(rows.rows[0].worktree_id);
  }));
  it('UT-S07-24: stopSession 幂等', () => withReport('UT-S07-24', async () => {
    const { sid } = await running({ sessionState: 'stopped' });
    expect((await http(app, 'POST', `/api/sessions/${sid}/stop`)).status).toBe(200);
    expect((await http(app, 'POST', `/api/sessions/${sid}/stop`)).status).toBe(200);
  }));
  it('UT-S07-25: stopSession 使任务 paused 并保留 worktree', () => withReport('UT-S07-25', async () => {
    const w = await fw();
    const { sid, taskId } = await running({ online: true });
    const r = await http(app, 'POST', `/api/sessions/${sid}/stop`);
    expect(r.status).toBe(200);
    const env = await w.expect((e: Envelope) => e.type === 'session.stop'); expect(env.payload.reason).toBe('user');
    w.send('session.state', { sessionId: sid, state: 'stopped', source: 'exit', observedAt: app.clock.now().toISOString() });
    for (let i = 0; i < 30; i++) { if ((await app.tasks.byKey('T-231')).state === 'paused') break; await new Promise((r) => setTimeout(r, 100)); }
    expect((await app.tasks.byKey('T-231')).state).toBe('paused');
    expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [sid])).state).toBe('stopped');
    expect((await app.db.one<any>('SELECT state FROM worktrees WHERE task_id=$1', [taskId])).state).toBe('ready');
  }));
  it('UT-S07-26: 10 分钟无进展广播 session.stale', () => withReport('UT-S07-26', async () => {
    const { sid } = await running();
    await app.db.query('UPDATE sessions SET last_progress_at=$2 WHERE id=$1', [sid, new Date(app.clock.now().getTime() - 11 * 60_000)]);
    await app.scheduler.tick('progress-watch');
    const ev = await app.db.one<any>(`SELECT payload FROM events WHERE type='session.stale' AND session_id=$1`, [sid]);
    expect(ev.payload.minutes).toBe(10);
  }));
  it('UT-S07-27: 30 分钟无进展推飞书一次且不自动停止', () => withReport('UT-S07-27', async () => {
    const { sid } = await running();
    await app.db.query('UPDATE sessions SET last_progress_at=$2 WHERE id=$1', [sid, new Date(app.clock.now().getTime() - 31 * 60_000)]);
    await app.scheduler.tick('progress-watch'); await app.scheduler.tick('progress-watch');
    expect(Number((await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE kind='alert' AND text LIKE '%无进展%'`))!.n)).toBe(1);
    expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [sid])).state).toBe('running');
    expect(app.workerHub.sentLog.some((x) => x.env.type === 'session.stop')).toBe(false);
  }));
  it('UT-S07-28: listTaskMessages 游标分页正序', () => withReport('UT-S07-28', async () => {
    const { taskId } = await running();
    const ch = await app.db.one<any>('SELECT channel_id FROM tasks WHERE id=$1', [taskId]);
    const base = app.clock.now().getTime();
    for (let i = 0; i < 250; i++) await app.db.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [ch.channel_id, taskId, `m${i}`, new Date(base + i * 1000)]);
    const seen: string[] = []; let after: string | null = null; let pages = 0;
    for (;;) {
      const r = await http(app, 'GET', `/api/tasks/T-231/messages?limit=100${after ? `&after=${after}` : ''}`);
      pages += 1; expect(r.body.items.length).toBeLessThanOrEqual(100);
      for (const m of r.body.items) seen.push(m.text);
      if (!r.body.nextCursor) break; after = r.body.nextCursor;
    }
    expect(pages).toBe(3); expect(seen).toHaveLength(250); expect(seen[0]).toBe('m0'); expect(seen[249]).toBe('m249');
  }));
});
