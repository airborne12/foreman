/**
 * S01 单元测试：UT-S01-01 ~ UT-S01-22（来源：logos/resources/test/core-S01-test-cases.md）
 * 直接驱动进程内 center 的领域对象（Intake / Approvals / Notifications / Tasks），Jira 与 agent 不参与。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { withReport } from '../helpers/reporter.js';
import { bootTestApp, http, TEST_TOKEN, type TestApp } from '../helpers/testApp.js';
import { FakeWorker } from '../helpers/fakeWorker.js';
import { seedTask, seedRuntime, seedSession } from '../helpers/seed.js';
import { WORKER_TO_CENTER } from '@foreman/shared';
import { Intake, jqlDate, type JiraIssue } from '../../apps/center/src/domain/intake.js';

let app: TestApp;
const workers: FakeWorker[] = [];
async function fw(name: string, reg?: Record<string, unknown>) {
  const w = new FakeWorker(app.ws, TEST_TOKEN);
  await w.connect(); workers.push(w);
  const ack = await w.register({ name, labels: ['vpn:jira', 'build:doris', 'agent:claude', 'agent:codex'], agents: { claude: { bin: 'fake-claude', maxConcurrent: 3 }, codex: { bin: 'fake-codex', maxConcurrent: 3 } }, capabilities: ['jira-poll', 'jira-lookup'], ...reg });
  if (ack.type !== 'register.ack') throw new Error(`注册失败 ${JSON.stringify(ack.payload)}`);
  return w;
}
const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({ key: 'CIR-20001', summary: 'ngram 索引 LIKE 偶发超时', project: 'CIR', assignee: 'jiangkai', updated: '2026-09-10T07:00:00Z', ...over });

/** 以任务级 token 调 MCP */
async function mcpSession(taskKey: string) {
  await seedRuntime(app.db, { name: 'dev', labels: ['build:doris', 'agent:claude'] });
  const taskId = await seedTask(app.db, { key: taskKey, state: 'triaging', runtime: 'dev' });
  const sessionId = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'claude', kind: 'code_locate' });
  const token = Intake.newToken();
  await app.db.query('UPDATE sessions SET mcp_token_hash=$2 WHERE id=$1', [sessionId, Intake.hash(token)]);
  return { taskId, sessionId, token };
}
async function mcpCall(token: string, tool: string, args: Record<string, unknown>) {
  const r = await fetch(app.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) });
  return r.json() as Promise<any>;
}

beforeAll(async () => { app = await bootTestApp(); });
afterAll(async () => { for (const w of workers) w.close(); await new Promise((r) => setTimeout(r, 300)); await app.close(); });
beforeEach(async () => { for (const w of workers.splice(0)) w.close(); await new Promise((r) => setTimeout(r, 50)); await http(app, 'POST', '/__test/reset'); });

describe('S01 1.1 Jira 轮询作业参数与去重', () => {
  it('UT-S01-01: 生成 jira-poll 作业时 JQL 含 since 水位线', () => withReport('UT-S01-01', async () => {
    await app.db.query(`UPDATE source_health SET watermark='2026-09-01T00:00:00Z' WHERE source='jira'`);
    const r = await app.intake.pollJira();
    expect(r.queued).toBe(true);
    const job = await app.db.one<any>(`SELECT * FROM jobs WHERE kind='jira-poll'`);
    // Jira 只认 'yyyy-MM-dd HH:mm'，ISO 8601 会被拒（真实环境验证过）
    expect(job.args.jql).toMatch(/updated >= "\d{4}-\d{2}-\d{2} \d{2}:\d{2}"$/);
    expect(job.args.jql).toContain(`updated >= "${jqlDate(new Date('2026-09-01T00:00:00Z'))}"`);
    expect(job.args.jql).toContain('assignee = currentUser()');
    expect(job.required_label).toBe('vpn:jira');
  }));

  it('UT-S01-02: 同 dedupe_key 的 queued 作业不重复入队', () => withReport('UT-S01-02', async () => {
    const a = await app.intake.pollJira();
    const b = await app.intake.pollJira();
    expect(b.skipped).toBe(true); expect(b.jobId).toBe(a.jobId);
    const n = await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM jobs WHERE kind='jira-poll'`);
    expect(Number(n!.n)).toBe(1);
  }));

  it('UT-S01-03: job.result 缺少 ok 字段被拒', () => withReport('UT-S01-03', () => {
    const r = WORKER_TO_CENTER['job.result'].safeParse({ result: {} });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]!.path.join('.')).toBe('ok');
  }));

  it('UT-S01-04: source_items 同 (source_type, external_id) 二次插入被忽略', () => withReport('UT-S01-04', async () => {
    const a = await app.intake.intakeJiraIssue(issue());
    const b = await app.intake.intakeJiraIssue(issue());
    expect(a.created).toBe(true); expect(b.created).toBe(false); expect(b.taskKey).toBe(a.taskKey);
    const n = await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM source_items WHERE source_type='jira' AND external_id='CIR-20001'`);
    expect(Number(n!.n)).toBe(1);
    const tasks = await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM tasks`);
    expect(Number(tasks!.n)).toBe(1);
  }));

  it('UT-S01-05: 水位线取 external_updated_at 最大值', () => withReport('UT-S01-05', async () => {
    const w = await fw('dev', { labels: ['vpn:jira'], agents: {}, capabilities: ['jira-poll'] });
    const r = await app.intake.pollJira();
    expect(r.dispatched).toBe(true);
    const cmd = await w.expect((e) => e.type === 'job.run');
    await app.intake.onJobResult(cmd.id, 'dev', { ok: true, result: { issues: [issue({ key: 'CIR-1', updated: '2026-09-10T01:00:00Z' }), issue({ key: 'CIR-2', updated: '2026-09-10T05:00:00Z' }), issue({ key: 'CIR-3', updated: '2026-09-10T03:00:00Z' })] } });
    const h = await app.db.one<any>(`SELECT watermark, status FROM source_health WHERE source='jira'`);
    expect(new Date(h.watermark).toISOString()).toBe('2026-09-10T05:00:00.000Z');
    expect(h.status).toBe('ok');
    const items = await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM source_items`);
    expect(Number(items!.n)).toBe(3);
  }));
});

describe('S01 1.2 任务与上下文包创建', () => {
  it('UT-S01-06: 任务 key 按序列生成且匹配 ^T-\\d+$', () => withReport('UT-S01-06', async () => {
    const t = await app.tasks.create({ source: 'CIR-9', path: 'fix', repo: 'selectdb/selectdb-core' });
    expect(t.key).toBe('T-231');
    expect(t.key).toMatch(/^T-\d+$/);
  }));

  it('UT-S01-07: 非法 kind 被 CHECK 拒绝', () => withReport('UT-S01-07', async () => {
    const ch = await app.tasks.ensureChannel('jira');
    await expect(app.db.query(`INSERT INTO tasks (key, channel_id, title, kind, source_type, source_ref) VALUES ('T-1',$1,'x','misc','jira','CIR-1')`, [ch.id])).rejects.toThrow(/check constraint|违反/i);
  }));

  it('UT-S01-08: Jira 项目映射命中时 repo_source = mapping', () => withReport('UT-S01-08', async () => {
    const r = await app.intake.intakeJiraIssue(issue({ project: 'CIR' }));
    const t = await app.tasks.byKey(r.taskKey);
    expect(t.repo_name).toBe('selectdb/selectdb-core'); expect(t.repo_source).toBe('mapping');
  }));

  it('UT-S01-09: 映射缺失且无线索时 repo_source = unresolved', () => withReport('UT-S01-09', async () => {
    const r = await app.intake.intakeJiraIssue(issue({ key: 'DORIS-300', project: 'DORIS' }));
    const t = await app.tasks.byKey(r.taskKey);
    expect(t.repo_name).toBeNull(); expect(t.repo_source).toBe('unresolved');
  }));

  it('UT-S01-10: 上下文包 code_locations 超过 8 条被截断', () => withReport('UT-S01-10', async () => {
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'triaging' });
    const locs = Array.from({ length: 10 }, (_, i) => ({ file: `be/src/f${i}.cpp`, line: i + 1, why: 'x' }));
    await app.intake.emitTriage(taskId, null, { tier: 'fix', effort: 'small', codeLocations: locs });
    const cp = await app.db.one<any>('SELECT code_locations FROM context_packs WHERE task_id=$1', [taskId]);
    expect(cp.code_locations).toHaveLength(8);
    const ev = await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM events WHERE type='context_pack.truncated' AND task_id=$1`, [taskId]);
    expect(Number(ev!.n)).toBe(1);
  }));

  it('UT-S01-11: 来源默认频道不存在时自动创建 kind=source_default', () => withReport('UT-S01-11', async () => {
    expect(await app.db.one(`SELECT 1 FROM channels WHERE slug='jira'`)).toBeNull();
    await app.intake.intakeJiraIssue(issue());
    const ch = await app.db.one<any>(`SELECT * FROM channels WHERE slug='jira'`);
    expect(ch.kind).toBe('source_default'); expect(ch.source_type).toBe('jira');
  }));
});

describe('S01 1.3 分流卡与审批生成', () => {
  it('UT-S01-12: deliver triage 缺 tier 被拒', () => withReport('UT-S01-12', async () => {
    const { token } = await mcpSession('T-231');
    const r = await mcpCall(token, 'deliver', { taskKey: 'T-231', artifacts: [{ kind: 'triage', effort: 'small' }] });
    expect(r.error).toBeTruthy();
    expect(r.error.code).toBe(-32602);
    expect(String(r.error.message)).toMatch(/tier/);
    expect(await app.db.one(`SELECT 1 FROM triage_cards`)).toBeNull();
  }));

  it('UT-S01-13: repo.confidence < 0.6 时分流卡 repo 标待确认', () => withReport('UT-S01-13', async () => {
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'triaging', repo: null });
    await app.intake.emitTriage(taskId, null, { tier: 'plan', effort: 'medium', repo: { name: 'apache/doris', confidence: 0.55, candidates: ['apache/doris', 'selectdb/selectdb-core'] } });
    const card = await app.db.one<any>('SELECT * FROM triage_cards WHERE task_id=$1', [taskId]);
    expect(card.repo_name).toBeNull();
    expect(card.repo_candidates).toEqual(['apache/doris', 'selectdb/selectdb-core']);
    const t = await app.tasks.byKey('T-231');
    expect(t.repo_source).toBe('unresolved');
  }));

  it('UT-S01-14: 分流卡就绪创建 triage_confirm 审批并置 pending_decision', () => withReport('UT-S01-14', async () => {
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'triaging' });
    await app.intake.emitTriage(taskId, null, { tier: 'fix', effort: 'small', codeLocations: [{ file: 'a.cpp', line: 1 }] });
    const ap = await app.db.query<any>(`SELECT * FROM approvals WHERE task_id=$1`, [taskId]);
    expect(ap.rows).toHaveLength(1); expect(ap.rows[0].status).toBe('pending'); expect(ap.rows[0].action_type).toBe('triage_confirm');
    expect((await app.tasks.byKey('T-231')).state).toBe('pending_decision');
  }));

  it('UT-S01-15: triage_confirm 已升级 auto 时不生成 pending 审批', () => withReport('UT-S01-15', async () => {
    await app.db.query(`UPDATE trust_counters SET mode='auto', streak=5 WHERE action_type='triage_confirm'`);
    await fw('dev');
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'triaging' });
    await app.intake.emitTriage(taskId, null, { tier: 'fix', effort: 'small' });
    const ap = await app.db.one<any>(`SELECT * FROM approvals WHERE task_id=$1`, [taskId]);
    expect(ap.status).toBe('auto_approved');
    expect(await app.db.one(`SELECT 1 FROM approvals WHERE status='pending'`)).toBeNull();
    expect((await app.tasks.byKey('T-231')).state).toBe('queued');
  }));

  it('UT-S01-16: 审批 key 匹配 ^A-\\d+$', () => withReport('UT-S01-16', async () => {
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'running' });
    const a = await app.approvals.request({ taskId, actionType: 'create_pr', title: 't', body: 'b', payload: { taskKey: 'T-231' } });
    expect(a.key).toBe('A-87'); expect(a.key).toMatch(/^A-\d+$/);
  }));
});

describe('S01 1.4 降级与通知', () => {
  it('UT-S01-17: 无在线 build:doris runtime 时生成降级卡', () => withReport('UT-S01-17', async () => {
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'triaging' });
    await app.intake.scheduleCodeLocate(taskId);
    const card = await app.db.one<any>('SELECT * FROM triage_cards WHERE task_id=$1', [taskId]);
    expect(card.degraded).toBe(true); expect(card.degraded_reason).toContain('离线');
    expect(await app.db.one(`SELECT 1 FROM jobs WHERE kind='code-locate' AND status='queued'`)).not.toBeNull();
  }));

  it('UT-S01-18: 降级卡补齐时原位更新不新建审批', () => withReport('UT-S01-18', async () => {
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'triaging' });
    await app.intake.scheduleCodeLocate(taskId);
    const before = await app.db.one<any>('SELECT * FROM triage_cards WHERE task_id=$1', [taskId]);
    await app.intake.emitTriage(taskId, null, { tier: 'fix', effort: 'small', codeLocations: [{ file: 'a.cpp', line: 3 }] });
    const after = await app.db.one<any>('SELECT * FROM triage_cards WHERE task_id=$1', [taskId]);
    expect(after.task_id).toBe(before.task_id); expect(after.degraded).toBe(false); expect(after.code_locations).toHaveLength(1);
    const n = await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM approvals WHERE task_id=$1`, [taskId]);
    expect(Number(n!.n)).toBe(1);
    const ap = await app.db.one<any>(`SELECT payload FROM approvals WHERE task_id=$1`, [taskId]);
    expect(ap.payload.degraded).toBe(false);
  }));

  it('UT-S01-19: 当日 approval 推送达 30 条后新通知标 deferred', () => withReport('UT-S01-19', async () => {
    const now = app.clock.now();
    for (let i = 0; i < 30; i++) await app.db.query(`INSERT INTO notifications (channel, kind, target, text, status, attempts, sent_at, created_at) VALUES ('feishu','approval','ou_owner',$1,'sent',1,$2,$2)`, [`hist ${i}`, now]);
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'running' });
    const a = await app.approvals.request({ taskId, actionType: 'create_pr', title: 't', body: 'b', payload: { taskKey: 'T-231' } });
    expect(a.feishu_deferred).toBe(true); expect(a.feishu_message_id).toBeNull();
    const n = await app.db.one<any>(`SELECT status FROM notifications WHERE ref_id=$1`, [a.id]);
    expect(n.status).toBe('deferred');
    expect(app.fakeFeishu.sent.filter((m) => m.text.includes('[审批]'))).toHaveLength(0);
  }));

  it('UT-S01-20: 发送失败重试最多 3 次且退避 5 分钟', () => withReport('UT-S01-20', async () => {
    app.fakeFeishu.failSend = true;
    const r = await app.notifications.send({ kind: 'approval', target: 'ou_owner', text: '[待拍板] x' });
    expect(r.status).toBe('failed');
    const t0 = app.clock.now().getTime();
    const n1 = await app.db.one<any>('SELECT * FROM notifications WHERE id=$1', [r.id]);
    expect(Number(n1.attempts)).toBe(1); expect(new Date(n1.next_attempt_at).getTime()).toBe(t0 + 5 * 60_000);
    await app.fakeClock.advance(5 * 60_000);
    const n2 = await app.db.one<any>('SELECT * FROM notifications WHERE id=$1', [r.id]);
    expect(Number(n2.attempts)).toBe(2); expect(new Date(n2.next_attempt_at).getTime()).toBe(t0 + 10 * 60_000);
    await app.fakeClock.advance(5 * 60_000);
    const n3 = await app.db.one<any>('SELECT * FROM notifications WHERE id=$1', [r.id]);
    expect(Number(n3.attempts)).toBe(3); expect(n3.status).toBe('failed'); expect(n3.next_attempt_at).toBeNull();
    await app.fakeClock.advance(10 * 60_000);
    const n4 = await app.db.one<any>('SELECT attempts FROM notifications WHERE id=$1', [r.id]);
    expect(Number(n4.attempts)).toBe(3);
  }));

  it('UT-S01-23: 分流结论给出的目标分支落进分流卡与任务，并出现在拍板卡上', () => withReport('UT-S01-23', async () => {
    await seedRuntime(app.db, { name: 'dev', labels: ['build:doris', 'agent:claude'] });
    const taskId = await seedTask(app.db, { key: 'T-720', state: 'triaging', runtime: 'dev' });
    await app.intake.emitTriage(taskId, null, { tier: 'fix', effort: 'small', targetBranch: 'branch-selectdb-doris-4.1', codeLocations: [{ file: 'be/src/exprs/vsearch.cpp', line: 193, symbol: 'f', why: 'x' }] });
    expect((await app.db.one<any>('SELECT base_branch FROM triage_cards WHERE task_id=$1', [taskId])).base_branch).toBe('branch-selectdb-doris-4.1');
    expect((await app.db.one<any>('SELECT base_branch FROM tasks WHERE id=$1', [taskId])).base_branch).toBe('branch-selectdb-doris-4.1');
    const a = await app.db.one<any>(`SELECT payload FROM approvals WHERE task_id=$1 AND action_type='triage_confirm'`, [taskId]);
    expect(a.payload.baseBranch).toBe('branch-selectdb-doris-4.1');
    expect(a.payload.summaryLine).toContain('基线 branch-selectdb-doris-4.1');
    // 补齐降级卡时不带 targetBranch，不能把已判断出的分支冲掉
    await app.intake.emitTriage(taskId, null, { tier: 'fix', effort: 'small', degraded: true, degradedReason: '重跑' });
    expect((await app.db.one<any>('SELECT base_branch FROM triage_cards WHERE task_id=$1', [taskId])).base_branch).toBe('branch-selectdb-doris-4.1');
  }));

  it('UT-S01-21: 代码定位受 agent 并发上限约束，名额释放后补派', () => withReport('UT-S01-21', async () => {
    for (const key of ['T-701', 'T-702', 'T-703']) {
      const id = await seedTask(app.db, { key, state: 'triaging' });
      await app.db.query(`INSERT INTO jobs (kind, status, required_label, args, dedupe_key, scheduled_at, created_at) VALUES ('code-locate','queued','build:doris',$1,$2,$3,$3)`, [JSON.stringify({ taskId: id }), `code-locate:${id}`, app.clock.now()]);
    }
    const creates: string[] = [];
    const w = new FakeWorker(app.ws, TEST_TOKEN); await w.connect(); workers.push(w);
    w.onAny((e) => { if (e.type === 'worktree.create') creates.push(String(e.payload.taskKey)); });
    await w.register({ name: 'dev', labels: ['build:doris', 'agent:claude', 'agent:codex'], agents: { claude: { bin: 'fake-claude', maxConcurrent: 1 }, codex: { bin: 'fake-codex', maxConcurrent: 1 } } });
    for (let i = 0; i < 30 && creates.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    expect(creates).toHaveLength(2);
    const planned = await app.db.query<any>(`SELECT id, agent FROM sessions WHERE kind='code_locate' AND state='planned' ORDER BY agent`);
    expect(planned.rows.map((r) => r.agent)).toEqual(['claude', 'codex']);
    expect(Number((await app.db.one<any>(`SELECT count(*) AS n FROM jobs WHERE kind='code-locate' AND status='queued'`)).n)).toBe(1);
    await app.dispatch.onSessionState('dev', { sessionId: planned.rows[0].id, state: 'failed', exitCode: 1, failureReason: 'x', source: 'exit' });
    for (let i = 0; i < 30 && creates.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    expect(creates).toHaveLength(3);
    expect(new Set(creates).size).toBe(3);
  }));

  it('UT-S01-22: 一直停在 planned 的代码定位也按 15 分钟超时', () => withReport('UT-S01-22', async () => {
    await seedRuntime(app.db, { name: 'dev', labels: ['build:doris', 'agent:claude'] });
    const taskId = await seedTask(app.db, { key: 'T-704', state: 'triaging', runtime: 'dev' });
    const sid = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'claude', kind: 'code_locate', state: 'planned', startedAt: null });
    await app.db.query(`UPDATE sessions SET created_at=$2, started_at=NULL WHERE id=$1`, [sid, new Date(app.clock.now().getTime() - 16 * 60_000)]);
    // 已交付分流卡但停在 waiting_input：按完成处理，不降级已有卡，关掉钩子推断的问题
    const t2 = await seedTask(app.db, { key: 'T-705', state: 'triaging', runtime: 'dev' });
    const s2 = await seedSession(app.db, { taskId: t2, runtime: 'dev', agent: 'claude', kind: 'code_locate', state: 'waiting_input', startedAt: new Date(app.clock.now().getTime() - 16 * 60_000) });
    await app.intake.emitTriage(t2, s2, { tier: 'fix', effort: 'small', codeLocations: [{ path: 'be/src/olap/a.cpp', line: 10, symbol: 'f', why: 'x' }] });
    await app.db.query(`INSERT INTO questions (task_id, session_id, text, origin, status, asked_at, expires_at) VALUES ($1,$2,'✻Brewed for 3m · done','hook','open',$3,$4)`, [t2, s2, app.clock.now(), new Date(app.clock.now().getTime() + 30 * 60_000)]);
    await app.intake.watchCodeLocateTimeouts();
    expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [sid])).state).toBe('stopped');
    expect((await app.db.one<any>('SELECT degraded_reason FROM triage_cards WHERE task_id=$1', [taskId])).degraded_reason).toContain('超时');
    expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [s2])).state).toBe('done');
    const card2 = await app.db.one<any>('SELECT degraded, code_locations FROM triage_cards WHERE task_id=$1', [t2]);
    expect(card2.degraded).toBe(false); expect(card2.code_locations).toHaveLength(1);
    expect((await app.db.one<any>('SELECT status FROM questions WHERE session_id=$1', [s2])).status).toBe('timeout');
  }));
});
