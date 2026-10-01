/**
 * S06 单元测试：UT-S06-01 ~ UT-S06-36（来源：logos/resources/test/core-S06-test-cases.md）
 * 审批创建与信任快照、双通道决定、信任升降级、执行/作废/补偿。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { withReport } from '../helpers/reporter.js';
import { bootTestApp, http, TEST_TOKEN, type TestApp } from '../helpers/testApp.js';
import { FakeWorker } from '../helpers/fakeWorker.js';
import { seedTask, seedRuntime, seedSession } from '../helpers/seed.js';
import { sha256, REVOCABLE_ACTIONS } from '../../apps/center/src/domain/approvals.js';
import { Intake } from '../../apps/center/src/domain/intake.js';

let app: TestApp;
let taskId: string;
/** 需要真实在线 runtime 的用例才用（拉起调度员等）；每个用例结束后断开 */
const workers: FakeWorker[] = [];
const trust = (type: string, patch: Record<string, unknown>) => app.db.query(`UPDATE trust_counters SET ${Object.keys(patch).map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE action_type=$1`, [type, ...Object.values(patch)]);
const counter = async (type: string) => app.db.one<any>('SELECT * FROM trust_counters WHERE action_type=$1', [type]);
const request = (actionType: string, body = 'x', extra: Record<string, unknown> = {}) => app.approvals.request({ taskId, actionType: actionType as any, title: `t-${actionType}`, body, payload: { taskKey: 'T-231' }, executor: 'center', ...extra });
const decide = (key: string, body: Record<string, unknown>) => http(app, 'POST', `/api/approvals/${key}/decide`, body);
const emit = (message_id: string, emoji: string, operator = 'ou_owner') => http(app, 'POST', '/__test/lark/emit', { event: { type: 'im.message.reaction.created_v1', event_id: crypto.randomUUID(), message_id, operator_type: 'user', operator_open_id: operator, emoji } });
async function mcpToken(taskKey = 'T-231') {
  await seedRuntime(app.db, { name: 'dev' });
  const sid = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'codex' });
  const token = Intake.newToken();
  await app.db.query('UPDATE sessions SET mcp_token_hash=$2 WHERE id=$1', [sid, Intake.hash(token)]);
  return { token, sid, taskKey };
}
const mcp = (token: string, tool: string, args: Record<string, unknown>) => fetch(app.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) }).then((r) => r.json() as Promise<any>);

beforeAll(async () => { app = await bootTestApp(); });
afterAll(async () => { await new Promise((r) => setTimeout(r, 300)); await app.close(); });
beforeEach(async () => {
  for (const w of workers.splice(0)) w.close();
  await new Promise((r) => setTimeout(r, 50));
  await http(app, 'POST', '/__test/reset');
  taskId = await seedTask(app.db, { key: 'T-231', state: 'running', runtime: 'dev' });
});

describe('S06 1.5 决定后的承接（等待者已不在）', () => {
  const channelMsgs = async () => (await app.db.query<any>(`SELECT text, payload FROM messages WHERE channel_id IS NOT NULL AND kind='system' AND payload->>'reason'='approval_decided_no_waiter' ORDER BY created_at`)).rows;

  it('UT-S06-33: 否决且没有等待者时，理由与上下文进入频道并由调度员接手', () => withReport('UT-S06-33', async () => {
    // 必须是真实连上的 runtime：只往表里 seed 一行的话 hub 认为它不在线，拉不起调度员
    const w = new FakeWorker(app.ws, TEST_TOKEN); await w.connect(); workers.push(w);
    await w.register({ name: 'center', labels: ['text'], agents: { codex: { bin: 'fake-codex', maxConcurrent: 3 } } });
    await new Promise((r) => setTimeout(r, 100));
    const sid = await seedSession(app.db, { taskId, runtime: 'center', agent: 'codex', kind: 'implement', state: 'done' });
    const a = await request('create_pr', '推送 foreman/T-231 并建 PR', { sessionId: sid, executor: 'agent' });
    const r = await decide(a.key, { decision: 'reject', bodyHash: a.body_hash, comment: '推送目标应该是我自己的 fork' });
    expect(r.status).toBe(200);
    for (let i = 0; i < 30 && !(await channelMsgs()).length; i++) await new Promise((x) => setTimeout(x, 100));
    const msgs = await channelMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toContain(a.key);
    expect(msgs[0].text).toContain('推送目标应该是我自己的 fork');
    expect(msgs[0].payload.approved).toBe(false);
    // 频道里没有调度员 → 拉起一个来接住讨论
    const d = await app.db.one<any>(`SELECT kind, state FROM sessions WHERE kind='dispatcher' ORDER BY created_at DESC LIMIT 1`);
    expect(d).not.toBeNull();
  }));

  it('UT-S06-34: 批准但等待者已不在且会话不可续接时，同样进入频道', () => withReport('UT-S06-34', async () => {
    // 只承接要 agent 接手的动作；会话已被判失联（不可续接）
    await seedRuntime(app.db, { name: 'dev' });
    const sid = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'codex', kind: 'implement', state: 'lost' });
    const a = await request('create_pr', '推送并建 PR', { sessionId: sid, executor: 'agent' });
    const r = await decide(a.key, { decision: 'approve', bodyHash: a.body_hash });
    expect(r.status).toBe(200);
    for (let i = 0; i < 30 && !(await channelMsgs()).length; i++) await new Promise((x) => setTimeout(x, 100));
    const msgs = await channelMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.approved).toBe(true);
  }));

  it('UT-S06-36: 中心执行器代跑的动作（如 jira_comment）批准后不进频道', () => withReport('UT-S06-36', async () => {
    const a = await request('jira_comment', '回写进展');
    await decide(a.key, { decision: 'approve', bodyHash: a.body_hash });
    await new Promise((r) => setTimeout(r, 300));
    expect(await channelMsgs()).toHaveLength(0);
  }));

  it('UT-S06-35: 有等待者时保持原行为，不重复送进频道', () => withReport('UT-S06-35', async () => {
    const { token } = await mcpToken();
    const p = mcp(token, 'request_approval', { taskKey: 'T-231', actionType: 'create_pr', title: 't', body: 'b' });
    await new Promise((r) => setTimeout(r, 300));
    const a = await app.db.one<any>(`SELECT key, body_hash FROM approvals WHERE action_type='create_pr' AND status='pending' ORDER BY created_at DESC LIMIT 1`);
    await decide(a.key, { decision: 'reject', bodyHash: a.body_hash, comment: '不用做了' });
    const out = await p;
    expect(out.result.structuredContent.approved).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(await channelMsgs()).toHaveLength(0);
  }));
});

describe('S06 1.1 审批创建与信任快照', () => {
  it('UT-S06-01: 创建审批记录 body_hash 与 trust 快照', () => withReport('UT-S06-01', async () => {
    await trust('reply_review', { streak: 2, mode: 'manual' });
    const a = await request('reply_review', '感谢指出…');
    expect(a.body_hash).toBe(sha256('感谢指出…')); expect(a.trust_mode_snapshot).toBe('manual'); expect(a.trust_streak_snapshot).toBe(2); expect(a.status).toBe('pending');
  }));
  it('UT-S06-02: 类型为 auto 时直接 auto_approved 并执行', () => withReport('UT-S06-02', async () => {
    await trust('rerun_ci', { mode: 'auto', streak: 5 });
    const a = await request('rerun_ci', 'doris_be_ut');
    expect(a.status).toBe('auto_approved');
    const act = await app.db.one<any>('SELECT * FROM actions WHERE approval_id=$1', [a.id]);
    expect(act.auto).toBe(true); expect(act.status).toBe('succeeded');
    expect(new Date(act.revocable_until).getTime()).toBe(app.clock.now().getTime() + 7 * 86400_000);
    expect(await app.db.one(`SELECT 1 FROM notifications WHERE ref_id=$1`, [a.id])).toBeNull();
  }));
  it('UT-S06-03: locked 类型即使 streak ≥ 5 仍 pending', () => withReport('UT-S06-03', async () => {
    await trust('merge_release', { streak: 10 });
    const a = await request('merge_release', 'b');
    expect(a.status).toBe('pending'); expect(a.trust_mode_snapshot).toBe('locked');
  }));
  it('UT-S06-04: 初始 trust_counters 13 行，merge_release 与 jira_done 为 locked', () => withReport('UT-S06-04', async () => {
    const rows = await app.db.query<any>('SELECT action_type, mode FROM trust_counters ORDER BY action_type');
    expect(rows.rows).toHaveLength(13);
    expect(rows.rows.filter((r) => r.mode === 'locked').map((r) => r.action_type).sort()).toEqual(['jira_done', 'merge_release']);
    expect(rows.rows.filter((r) => r.mode === 'manual')).toHaveLength(11);
  }));
  it('UT-S06-05: action_type 不在枚举被外键拒绝', () => withReport('UT-S06-05', async () => {
    await expect(app.db.query(`INSERT INTO approvals (key, task_id, action_type, title, body, body_hash, trust_mode_snapshot) VALUES ('A-1',$1,'deploy','t','b','h','manual')`, [taskId])).rejects.toThrow(/foreign key|check constraint|违反/i);
  }));
  it('UT-S06-06: expires_at = created + 30 分钟', () => withReport('UT-S06-06', async () => {
    const a = await request('reply_review');
    expect(new Date(a.expires_at!).getTime() - new Date(a.created_at).getTime()).toBe(30 * 60_000);
  }));
});

describe('S06 1.2 双通道决定', () => {
  it('UT-S06-07: ✅ 映射 approve，❌ 映射 reject，其他表情忽略', () => withReport('UT-S06-07', async () => {
    const a1 = await request('reply_review', 'a'); const a2 = await request('reply_review', 'b'); const a3 = await request('reply_review', 'c');
    const mid = async (id: string) => (await app.db.one<any>('SELECT feishu_message_id FROM approvals WHERE id=$1', [id])).feishu_message_id as string;
    await emit(await mid(a3.id), 'THUMBSUP'); expect((await app.approvals.byKey(a3.key))!.status).toBe('pending');
    await emit(await mid(a1.id), 'DONE'); expect((await app.approvals.byKey(a1.key))!.status).toBe('approved');
    await emit(await mid(a2.id), 'CrossMark'); expect((await app.approvals.byKey(a2.key))!.status).toBe('rejected');
  }));
  it('UT-S06-08: 非 owner reaction 忽略', () => withReport('UT-S06-08', async () => {
    const a = await request('reply_review');
    const mid = (await app.db.one<any>('SELECT feishu_message_id FROM approvals WHERE id=$1', [a.id])).feishu_message_id;
    const r = await emit(mid, 'DONE', 'ou_colleague');
    expect(r.body.handled).toBe('ignored');
    expect((await app.approvals.byKey(a.key))!.status).toBe('pending');
    expect(Number((await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM events WHERE type='approval.reaction_ignored'`))!.n)).toBe(1);
  }));
  it('UT-S06-09: 对 superseded 审批消息的 reaction 回帖"已作废"', () => withReport('UT-S06-09', async () => {
    const a = await request('reply_review', 'v1');
    const mid = (await app.db.one<any>('SELECT feishu_message_id FROM approvals WHERE id=$1', [a.id])).feishu_message_id;
    await app.approvals.supersede(a.key, 'v2');
    await emit(mid, 'DONE');
    expect((await app.approvals.byKey(a.key))!.status).toBe('superseded');
    expect(app.fakeFeishu.sent.some((m) => m.kind === 'messages-reply' && m.message_id === mid && m.text.includes('已作废'))).toBe(true);
  }));
  it('UT-S06-10: 对已 approved 审批再 ❌ 回帖"已于 hh:mm 确认"', () => withReport('UT-S06-10', async () => {
    const a = await request('reply_review');
    const mid = (await app.db.one<any>('SELECT feishu_message_id FROM approvals WHERE id=$1', [a.id])).feishu_message_id;
    await emit(mid, 'DONE');
    await emit(mid, 'CrossMark');
    expect((await app.approvals.byKey(a.key))!.status).toBe('approved');
    expect(app.fakeFeishu.sent.some((m) => m.kind === 'messages-reply' && m.message_id === mid && m.text.includes('已于'))).toBe(true);
  }));
  it('UT-S06-11: 面板 decide 在飞书先到后返回 409 含 decidedVia', () => withReport('UT-S06-11', async () => {
    const a = await request('reply_review');
    await app.approvals.decide(a.key, { decision: 'approve', via: 'feishu' });
    const r = await decide(a.key, { decision: 'approve', bodyHash: a.body_hash });
    expect(r.status).toBe(409); expect(r.body.code).toBe('APPROVAL_ALREADY_DECIDED'); expect(r.body.details.decidedVia).toBe('feishu');
  }));
  it('UT-S06-12: bodyHash 不匹配返回 409 APPROVAL_BODY_CHANGED', () => withReport('UT-S06-12', async () => {
    const a = await request('reply_review', 'v1');
    const r = await decide(a.key, { decision: 'approve', bodyHash: sha256('v0') });
    expect(r.status).toBe(409); expect(r.body.code).toBe('APPROVAL_BODY_CHANGED');
  }));
  it('UT-S06-13: 并发两通道同时决定只有一个成功', () => withReport('UT-S06-13', async () => {
    const a = await request('reply_review');
    const mid = (await app.db.one<any>('SELECT feishu_message_id FROM approvals WHERE id=$1', [a.id])).feishu_message_id;
    const [panel, feishu] = await Promise.all([decide(a.key, { decision: 'approve', bodyHash: a.body_hash }), emit(mid, 'DONE')]);
    const panelOk = panel.status === 200; const feishuOk = feishu.body.handled === 'decided';
    expect(Number(panelOk) + Number(feishuOk)).toBe(1);
    const row = await app.approvals.byKey(a.key);
    expect(row!.status).toBe('approved'); expect(['panel', 'feishu']).toContain(row!.decided_via);
    expect(Number((await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM events WHERE type='approval.decided'`))!.n)).toBe(1);
  }));
});

describe('S06 1.3 信任升降级', () => {
  it('UT-S06-14: 原样确认 streak +1', () => withReport('UT-S06-14', async () => {
    await trust('reply_review', { streak: 3 });
    const a = await request('reply_review');
    await decide(a.key, { decision: 'approve', bodyHash: a.body_hash });
    const c = await counter('reply_review');
    expect(Number(c.streak)).toBe(4); expect(c.last_confirmed_at).not.toBeNull(); expect(Number(c.total_confirmed)).toBe(1);
  }));
  it('UT-S06-15: 第 5 次原样确认升级为 auto', () => withReport('UT-S06-15', async () => {
    await trust('reply_review', { streak: 4 });
    const a = await request('reply_review');
    const r = await decide(a.key, { decision: 'approve', bodyHash: a.body_hash });
    expect(r.body.trust.mode).toBe('auto'); expect(r.body.trust.streak).toBe(5);
    const c = await counter('reply_review'); expect(c.mode).toBe('auto'); expect(c.promoted_at).not.toBeNull();
    expect(await app.db.one(`SELECT 1 FROM events WHERE type='trust.updated' AND payload->>'change'='promoted'`)).not.toBeNull();
  }));
  it('UT-S06-16: 否决清零并回 manual', () => withReport('UT-S06-16', async () => {
    await trust('reply_review', { streak: 4, mode: 'auto' });
    await trust('rerun_ci', { streak: 4 });
    const a = await request('rerun_ci');
    await decide(a.key, { decision: 'reject', bodyHash: a.body_hash, comment: '不该重跑' });
    const c = await counter('rerun_ci'); expect(Number(c.streak)).toBe(0); expect(c.mode).toBe('manual'); expect(c.last_rejected_at).not.toBeNull();
  }));
  it('UT-S06-17: 修改后确认不改 streak', () => withReport('UT-S06-17', async () => {
    await trust('reply_review', { streak: 2 });
    const a = await request('reply_review', 'v1');
    const r = await decide(a.key, { decision: 'approve', bodyHash: a.body_hash, editedBody: 'v1 加一句' });
    expect(r.body.trust.streak).toBe(2); expect(r.body.approval.modified).toBe(true); expect(r.body.approval.finalBody).toBe('v1 加一句');
    expect(Number((await counter('reply_review')).streak)).toBe(2);
  }));
  it('UT-S06-18: 阈值可配（threshold 3）', () => withReport('UT-S06-18', async () => {
    await trust('reply_review', { threshold: 3, streak: 2 });
    const a = await request('reply_review');
    const r = await decide(a.key, { decision: 'approve', bodyHash: a.body_hash });
    expect(r.body.trust.mode).toBe('auto'); expect(r.body.trust.threshold).toBe(3);
  }));
  it('UT-S06-19: resetTrust 把 auto 重置为 manual 并清零', () => withReport('UT-S06-19', async () => {
    await trust('rerun_ci', { mode: 'auto', streak: 5 });
    const r = await http(app, 'POST', '/api/trust/rerun_ci/reset');
    expect(r.status).toBe(200); expect(r.body.mode).toBe('manual'); expect(r.body.streak).toBe(0);
    const c = await counter('rerun_ci'); expect(c.mode).toBe('manual'); expect(Number(c.streak)).toBe(0);
  }));
  it('UT-S06-20: resetTrust 对 locked 类型 409', () => withReport('UT-S06-20', async () => {
    const r = await http(app, 'POST', '/api/trust/merge_release/reset');
    expect(r.status).toBe(409); expect(r.body.code).toBe('TRUST_LOCKED');
  }));
  it('UT-S06-21: revoke 在 7 天内降级并清零', () => withReport('UT-S06-21', async () => {
    await trust('rerun_ci', { mode: 'auto', streak: 5 });
    const a = await request('rerun_ci');
    await app.db.query(`UPDATE actions SET created_at=$2, revocable_until=$3 WHERE approval_id=$1`, [a.id, new Date(app.clock.now().getTime() - 3 * 86400_000), new Date(app.clock.now().getTime() + 4 * 86400_000)]);
    const r = await http(app, 'POST', `/api/actions/${a.action_id}/revoke`, { reason: '不该重跑' });
    expect(r.status).toBe(200); expect(r.body.trust.mode).toBe('manual'); expect(r.body.trust.streak).toBe(0);
    const act = await app.db.one<any>('SELECT * FROM actions WHERE id=$1', [a.action_id]); expect(act.revoked_at).not.toBeNull();
    expect(await app.db.one(`SELECT 1 FROM events WHERE type='trust.downgraded'`)).not.toBeNull();
    expect(await app.db.one(`SELECT 1 FROM events WHERE type='trust.updated' AND payload->>'change'='downgraded'`)).not.toBeNull();
  }));
  it('UT-S06-22: revoke 超过 7 天 409', () => withReport('UT-S06-22', async () => {
    await trust('rerun_ci', { mode: 'auto', streak: 5 });
    const a = await request('rerun_ci');
    await app.db.query(`UPDATE actions SET revocable_until=$2 WHERE approval_id=$1`, [a.id, new Date(app.clock.now().getTime() - 86400_000)]);
    const r = await http(app, 'POST', `/api/actions/${a.action_id}/revoke`, {});
    expect(r.status).toBe(409); expect(r.body.code).toBe('ACTION_NOT_REVOCABLE');
  }));
  it('UT-S06-23: listTrust 返回 13 个 counter、threshold 与 4 周趋势', () => withReport('UT-S06-23', async () => {
    await trust('rerun_ci', { mode: 'auto', streak: 5 });
    await request('rerun_ci');
    const a = await request('reply_review'); await decide(a.key, { decision: 'approve', bodyHash: a.body_hash });
    const r = await http(app, 'GET', '/api/trust');
    expect(r.status).toBe(200); expect(r.body.threshold).toBe(5); expect(r.body.counters).toHaveLength(13); expect(r.body.weeklyConfirmations).toHaveLength(4);
    expect(r.body.counters.find((c: any) => c.actionType === 'rerun_ci').autoExecutions7d).toBe(1);
    expect(r.body.weeklyConfirmations[3].count).toBe(1);
  }));
});

describe('S06 1.4 执行、作废与补偿', () => {
  it('UT-S06-24: 通过后唤醒等待中的 MCP request_approval', () => withReport('UT-S06-24', async () => {
    const { token } = await mcpToken();
    const p = mcp(token, 'request_approval', { taskKey: 'T-231', actionType: 'create_pr', title: '创建 PR', body: 'v1' });
    await new Promise((r) => setTimeout(r, 300));
    const a = await app.db.one<any>(`SELECT * FROM approvals WHERE action_type='create_pr'`);
    await decide(a.key, { decision: 'approve', bodyHash: a.body_hash, editedBody: 'v1 最终' });
    const r = await p;
    expect(r.result.structuredContent.approved).toBe(true); expect(r.result.structuredContent.finalBody).toBe('v1 最终');
  }));
  it('UT-S06-25: 通过后内部执行器失败 → approvals failed 且信任不回退', () => withReport('UT-S06-25', async () => {
    await http(app, 'POST', '/__test/mock/jira', { commentFailWith: 500 });
    const a = await request('jira_comment', '已修复', { payload: { taskKey: 'T-231', issueKey: 'CIR-1', artifactId: null } });
    const r = await decide(a.key, { decision: 'approve', bodyHash: a.body_hash });
    expect(r.status).toBe(200); expect(r.body.trust.streak).toBe(1);
    expect((await app.approvals.byKey(a.key))!.status).toBe('failed');
    expect((await app.db.one<any>('SELECT status FROM actions WHERE approval_id=$1', [a.id])).status).toBe('failed');
    expect(Number((await counter('jira_comment')).streak)).toBe(1);
    const inbox = await http(app, 'GET', '/api/inbox');
    expect(inbox.body.approvals.some((x: any) => x.key === a.key && x.payload.retryable === true)).toBe(true);
  }));
  it('UT-S06-26: 正文变更作废旧审批并建新审批', () => withReport('UT-S06-26', async () => {
    const a = await request('reply_review', 'v1');
    const before = app.fakeFeishu.sent.length;
    const r = await app.approvals.supersede(a.key, 'v2');
    expect(r.old.status).toBe('superseded'); expect(r.old.supersededBy).toBe(r.new.key); expect(r.new.status).toBe('pending'); expect(r.new.body).toBe('v2');
    const sent = app.fakeFeishu.sent.slice(before);
    expect(sent.some((m) => m.kind === 'messages-reply' && m.text.includes('已作废'))).toBe(true);
    expect(sent.some((m) => m.kind === 'messages-send' && m.text.includes(r.new.key))).toBe(true);
  }));
  it('UT-S06-27: 补偿可撤回动作成功 → actions reverted', () => withReport('UT-S06-27', async () => {
    await trust('reply_review', { mode: 'auto', streak: 5 });
    const a = await request('reply_review', '回帖内容');
    expect(REVOCABLE_ACTIONS).toContain('reply_review');
    const r = await http(app, 'POST', `/api/actions/${a.action_id}/revoke`, { reason: 'x' });
    expect(r.body.compensation.status).toBe('reverted');
    expect((await app.db.one<any>('SELECT status FROM actions WHERE id=$1', [a.action_id])).status).toBe('reverted');
  }));
  it('UT-S06-28: 不可撤回动作 → not_revocable 且降级仍生效', () => withReport('UT-S06-28', async () => {
    await trust('create_pr', { mode: 'auto', streak: 5 });
    const a = await request('create_pr', 'PR', { executor: 'agent' });
    const r = await http(app, 'POST', `/api/actions/${a.action_id}/revoke`, {});
    expect(r.body.compensation.status).toBe('not_revocable'); expect(r.body.trust.mode).toBe('manual'); expect(r.body.trust.streak).toBe(0);
    const inbox = await http(app, 'GET', '/api/inbox');
    expect(inbox.body.failures.some((f: any) => f.key === 'T-231')).toBe(true);
  }));
  it('UT-S06-29: 审批 30 分钟过期 → MCP 返回 timeout，状态保持 pending', () => withReport('UT-S06-29', async () => {
    const { token } = await mcpToken();
    const p = mcp(token, 'request_approval', { taskKey: 'T-231', actionType: 'create_pr', title: '创建 PR', body: 'v1' });
    await new Promise((r) => setTimeout(r, 300));
    await app.fakeClock.advance(30 * 60_000);
    const r = await p;
    expect(r.result.structuredContent.approved).toBe(false); expect(r.result.structuredContent.reason).toBe('timeout');
    const a = await app.db.one<any>(`SELECT status FROM approvals WHERE action_type='create_pr'`); expect(a.status).toBe('pending');
  }));
});
