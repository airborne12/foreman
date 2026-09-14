/**
 * S03 单元测试：UT-S03-01 ~ UT-S03-31（来源：logos/resources/test/core-S03-test-cases.md）
 * 拍板校验、先到先得与信任、路由/选家/并发、worktree 与会话指令、产物与子任务。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { claudeAdapter, codexStartArgs, codexResumeArgs } from '../../apps/worker/src/sessions.js';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { withReport } from '../helpers/reporter.js';
import { bootTestApp, http, TEST_TOKEN, type TestApp } from '../helpers/testApp.js';
import { FakeWorker } from '../helpers/fakeWorker.js';
import { seedTask, seedRuntime, seedSession, seedWorktree, runtimeId } from '../helpers/seed.js';
import { fixtures, type FixtureCtx } from '../orchestration/fixtures.js';
import { WorktreeCreate, SessionStart, WorkerConfig, makeEnvelope } from '@foreman/shared';
import { createWorktree } from '../../apps/worker/src/worktree.js';
import { Worker } from '../../apps/worker/src/worker.js';
import { Intake } from '../../apps/center/src/domain/intake.js';

let app: TestApp;
const workers: FakeWorker[] = [];
const DEV_REG = { labels: ['agent:claude', 'agent:codex', 'build:doris', 'repo:selectdb/selectdb-core', 'vpn:jira'], agents: { claude: { bin: 'fake-claude', maxConcurrent: 3 }, codex: { bin: 'fake-codex', maxConcurrent: 3 } }, repos: { 'selectdb/selectdb-core': { main: '/tmp/fx/core', worktreeRoot: '/tmp/fx/wt' } } };
async function fw(name: string, reg?: Record<string, unknown>) {
  const w = new FakeWorker(app.ws, TEST_TOKEN);
  await w.connect(); workers.push(w);
  const ack = await w.register({ name, ...DEV_REG, ...reg });
  if (ack.type !== 'register.ack') throw new Error(`注册失败 ${JSON.stringify(ack.payload)}`);
  await new Promise((r) => setTimeout(r, 100));
  return w;
}
/** 复用编排 fixture：pending_decision 任务 + 分流卡 + pending 审批 */
async function pending(key: string, a: Record<string, unknown> = {}) {
  const ctx: FixtureCtx = { db: app.db, now: () => app.clock.now(), vars: {}, env: {} };
  const taskId = (await fixtures['task.pendingDecision']!(ctx, { key, repo: 'selectdb/selectdb-core', tier: 'fix', channel: 'jira', source: 'jira:CIR-20001', ...a })) as string;
  const ap = await app.db.one<any>(`SELECT key, body_hash FROM approvals WHERE task_id=$1`, [taskId]);
  return { taskId, key: ap.key as string, hash: ap.body_hash as string };
}
async function mcpSession(taskKey: string, agent = 'codex', state = 'running') {
  await seedRuntime(app.db, { name: 'dev', labels: DEV_REG.labels, agents: DEV_REG.agents });
  const taskId = await seedTask(app.db, { key: taskKey, state, runtime: 'dev', agent, authorAgent: agent });
  const sessionId = await seedSession(app.db, { taskId, runtime: 'dev', agent, kind: 'implement' });
  const token = Intake.newToken();
  await app.db.query('UPDATE sessions SET mcp_token_hash=$2 WHERE id=$1', [sessionId, Intake.hash(token)]);
  return { taskId, sessionId, token };
}
async function mcpCall(token: string, tool: string, args: Record<string, unknown>) {
  const r = await fetch(app.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) });
  return r.json() as Promise<any>;
}
function gitRepo() {
  const main = mkdtempSync(resolve(tmpdir(), 'repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: main, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  git('init', '-q', '-b', 'master'); writeFileSync(resolve(main, 'README'), 'x'); git('add', '.'); git('commit', '-q', '-m', 'init');
  return { main, worktreeRoot: mkdtempSync(resolve(tmpdir(), 'wt-')) };
}

beforeAll(async () => { app = await bootTestApp(); });
afterAll(async () => { for (const w of workers) w.close(); await new Promise((r) => setTimeout(r, 300)); await app.close(); });
beforeEach(async () => { for (const w of workers.splice(0)) w.close(); await new Promise((r) => setTimeout(r, 80)); await http(app, 'POST', '/__test/reset'); });

describe('S03 1.1 拍板请求校验', () => {
  it('UT-S03-01: 缺 bodyHash 被拒', () => withReport('UT-S03-01', async () => {
    const { key } = await pending('T-231');
    const r = await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve' });
    expect(r.status).toBe(422); expect(r.body.code).toBe('VALIDATION_FAILED');
  }));
  it('UT-S03-02: decision 非法枚举被拒', () => withReport('UT-S03-02', async () => {
    const { key, hash } = await pending('T-231');
    expect((await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'maybe', bodyHash: hash })).status).toBe(422);
  }));
  it('UT-S03-03: overrides.path 非法枚举被拒', () => withReport('UT-S03-03', async () => {
    const { key, hash } = await pending('T-231');
    expect((await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash, overrides: { path: 'hotfix' } })).status).toBe(422);
  }));
  it('UT-S03-04: overrides.agent 非法被拒', () => withReport('UT-S03-04', async () => {
    const { key, hash } = await pending('T-231');
    expect((await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash, overrides: { agent: 'gemini' } })).status).toBe(422);
  }));
  it('UT-S03-05: approvalKey 不匹配 ^A-\\d+$ 返回 404', () => withReport('UT-S03-05', async () => {
    const r = await http(app, 'GET', '/api/approvals/X-1');
    expect(r.status).toBe(404); expect(r.body.code).toBe('NOT_FOUND');
  }));
});

describe('S03 1.2 先到先得与信任计数', () => {
  it('UT-S03-06: 条件更新只在 pending 且 hash 匹配时生效', () => withReport('UT-S03-06', async () => {
    const { key, hash } = await pending('T-231');
    const bad = await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: 'deadbeef' });
    expect(bad.status).toBe(409); expect(bad.body.code).toBe('APPROVAL_BODY_CHANGED');
    const ok = await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash });
    expect(ok.status).toBe(200); expect(ok.body.approval.status).toBe('approved');
    const row = await app.db.one<any>('SELECT status, decided_via FROM approvals WHERE key=$1', [key]);
    expect(row.status).toBe('approved'); expect(row.decided_via).toBe('panel');
  }));
  it('UT-S03-07: 已决定的审批再次决定影响 0 行 → 409', () => withReport('UT-S03-07', async () => {
    const { key, hash } = await pending('T-231');
    await app.approvals.decide(key, { decision: 'approve', via: 'feishu' });
    const r = await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash });
    expect(r.status).toBe(409); expect(r.body.code).toBe('APPROVAL_ALREADY_DECIDED'); expect(r.body.details.decidedVia).toBe('feishu');
  }));
  it('UT-S03-08: 原样确认使 triage_confirm streak +1', () => withReport('UT-S03-08', async () => {
    await app.db.query(`UPDATE trust_counters SET streak=1 WHERE action_type='triage_confirm'`);
    const { key, hash } = await pending('T-231');
    const r = await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash });
    expect(r.body.trust.streak).toBe(2); expect(r.body.approval.modified).toBe(false);
    expect(Number((await app.db.one<any>(`SELECT streak FROM trust_counters WHERE action_type='triage_confirm'`)).streak)).toBe(2);
  }));
  it('UT-S03-09: 带 overrides 确认不计数且 modified = true', () => withReport('UT-S03-09', async () => {
    await app.db.query(`UPDATE trust_counters SET streak=1 WHERE action_type='triage_confirm'`);
    const { key, hash } = await pending('T-231');
    const r = await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash, overrides: { runtime: 'laptop' } });
    expect(r.status).toBe(200); expect(r.body.trust.streak).toBe(1); expect(r.body.approval.modified).toBe(true);
    const t = await app.tasks.byKey('T-231');
    expect(t.decision.modified).toBe(true); expect(t.decision.runtime).toBe('laptop');
  }));
  it('UT-S03-10: 仓库待确认且无 override 时 422 REPO_REQUIRED 且事务回滚', () => withReport('UT-S03-10', async () => {
    const { key, hash } = await pending('T-233', { repo: null, source: 'jira:DORIS-300' });
    const r = await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash });
    expect(r.status).toBe(422); expect(r.body.code).toBe('REPO_REQUIRED');
    expect((await app.db.one<any>('SELECT status FROM approvals WHERE key=$1', [key])).status).toBe('pending');
    expect((await app.tasks.byKey('T-233')).state).toBe('pending_decision');
  }));
});

describe('S03 1.3 路由与选家', () => {
  it('UT-S03-11: code 类任务要求 build:doris，命中 dev', () => withReport('UT-S03-11', async () => {
    await fw('dev');
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'queued' });
    await app.dispatch.dispatchTask(taskId);
    const t = await app.tasks.byKey('T-231');
    expect(t.runtime_name).toBe('dev');
    const m = await app.tasks.messages('T-231', {});
    expect(m.items.some((x) => x.text.includes('routing: code') && x.text.includes('build:doris') && x.text.includes('dev'))).toBe(true);
  }));
  it('UT-S03-12: 无满足标签的在线 runtime 时 queued 并记原因', () => withReport('UT-S03-12', async () => {
    await seedRuntime(app.db, { name: 'dev', online: false, labels: DEV_REG.labels });
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'queued' });
    await app.dispatch.dispatchTask(taskId);
    const t = await app.tasks.byKey('T-231');
    expect(t.state).toBe('queued'); expect(t.queue_reason).toContain('dev');
    expect(await app.db.one('SELECT 1 FROM sessions')).toBeNull();
  }));
  it('UT-S03-13: 手动覆盖优先于规则', () => withReport('UT-S03-13', async () => {
    await fw('dev'); await fw('laptop');
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'queued' });
    await app.dispatch.dispatchTask(taskId, { runtime: 'laptop' });
    expect((await app.tasks.byKey('T-231')).runtime_name).toBe('laptop');
    const rid = await runtimeId(app.db, 'laptop');
    expect(await app.db.one('SELECT 1 FROM sessions WHERE runtime_id=$1', [rid])).not.toBeNull();
  }));
  it('UT-S03-14: 开发 agent 轮换：上次 claude 则本次 codex', () => withReport('UT-S03-14', async () => {
    await seedTask(app.db, { key: 'T-100', state: 'done', authorAgent: 'claude', terminalAt: app.clock.now() });
    expect(await app.intake.nextAgent()).toBe('codex');
    await app.db.query(`UPDATE tasks SET author_agent='codex', updated_at=now() WHERE key='T-100'`);
    expect(await app.intake.nextAgent()).toBe('claude');
  }));
  it('UT-S03-15: review 子任务 agent 必须不同于 author_agent', () => withReport('UT-S03-15', async () => {
    const { sessionId } = await mcpSession('T-231', 'codex');
    await app.dispatch.deliver(sessionId, [{ kind: 'pr', url: 'https://github.com/selectdb/selectdb-core/pull/1', title: 'x' }]);
    const review = await app.db.one<any>(`SELECT agent FROM tasks WHERE key='T-231.2'`);
    expect(review.agent).toBe('claude');
    expect(await app.dispatch.reviewerFor({ author_agent: 'codex' })).toBe('claude');
    expect(await app.dispatch.reviewerFor({ author_agent: 'claude' })).toBe('codex');
  }));
  it('UT-S03-16: 并发闸门：同 runtime 同 agent planned+running ≥ 3 时排队', () => withReport('UT-S03-16', async () => {
    await fw('dev');
    for (let i = 0; i < 3; i++) await seedSession(app.db, { taskId: await seedTask(app.db, { key: `T-70${i}`, state: 'running', runtime: 'dev' }), runtime: 'dev', agent: 'codex' });
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'queued' });
    await app.dispatch.dispatchTask(taskId, { agent: 'codex' });
    const t = await app.tasks.byKey('T-231');
    expect(t.state).toBe('queued'); expect(t.queue_reason).toMatch(/codex 队列第 1 位/);
  }));
  it('UT-S03-17: 分析类任务并发满时换家，代码类不换', () => withReport('UT-S03-17', async () => {
    await fw('dev');
    for (let i = 0; i < 3; i++) await seedSession(app.db, { taskId: await seedTask(app.db, { key: `T-70${i}`, state: 'running', runtime: 'dev' }), runtime: 'dev', agent: 'codex' });
    const analysis = await seedTask(app.db, { key: 'T-231', state: 'queued', kind: 'analysis' });
    await app.dispatch.dispatchTask(analysis, { agent: 'codex' });
    const s = await app.db.one<any>('SELECT agent FROM sessions WHERE task_id=$1', [analysis]);
    expect(s.agent).toBe('claude');
    expect((await app.tasks.messages('T-231', {})).items.some((m) => m.text.includes('已改派 claude'))).toBe(true);
    const code = await seedTask(app.db, { key: 'T-232', state: 'queued', kind: 'code' });
    await app.dispatch.dispatchTask(code, { agent: 'codex' });
    expect((await app.tasks.byKey('T-232')).state).toBe('queued');
    expect(await app.db.one('SELECT 1 FROM sessions WHERE task_id=$1', [code])).toBeNull();
  }));
  it('UT-S03-18: planned 会话占用并发名额', () => withReport('UT-S03-18', async () => {
    await fw('dev');
    for (let i = 0; i < 2; i++) await seedSession(app.db, { taskId: await seedTask(app.db, { key: `T-70${i}`, state: 'running', runtime: 'dev' }), runtime: 'dev', agent: 'codex' });
    await seedSession(app.db, { taskId: await seedTask(app.db, { key: 'T-709', state: 'queued', runtime: 'dev' }), runtime: 'dev', agent: 'codex', state: 'planned' });
    const taskId = await seedTask(app.db, { key: 'T-231', state: 'queued' });
    await app.dispatch.dispatchTask(taskId, { agent: 'codex' });
    expect((await app.tasks.byKey('T-231')).queue_reason).toMatch(/排队/);
  }));
});

describe('S03 1.4 worktree 与会话指令', () => {
  it('UT-S03-19: worktree.create 缺 baseBranch 被拒', () => withReport('UT-S03-19', () => {
    const r = WorktreeCreate.safeParse({ taskKey: 'T-231', repo: 'selectdb/selectdb-core' });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues.map((i) => i.path.join('.'))).toContain('baseBranch');
  }));
  it('UT-S03-20: 默认 branchName = foreman/<taskKey>', () => withReport('UT-S03-20', () => {
    const repo = gitRepo();
    const out = createWorktree({ taskKey: 'T-231', repo: 'x/y', baseBranch: 'master' }, repo);
    expect(out.branchName).toBe('foreman/T-231'); expect(out.reused).toBe(false);
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: out.path, encoding: 'utf8' }).trim()).toBe('foreman/T-231');
  }));
  it('UT-S03-21: session.start 的 env 含 ANTHROPIC_API_KEY 被拒', () => withReport('UT-S03-21', () => {
    const base = { sessionId: crypto.randomUUID(), taskKey: 'T-231', kind: 'implement', agent: 'claude', prompt: 'p', cwd: '/tmp', mcp: { url: 'http://127.0.0.1:7801/mcp', token: 't' } };
    expect(SessionStart.safeParse({ ...base, env: { FOO: 'x' } }).success).toBe(true);
    const r = SessionStart.safeParse({ ...base, env: { ANTHROPIC_API_KEY: 'sk-x' } });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]!.message).toContain('FORBIDDEN_ENV');
  }));
  it('UT-S03-22: 同一 commandId 重放不重复创建 worktree', () => withReport('UT-S03-22', async () => {
    let executed = 0; let replies = 0;
    app.workerHub.on('custom.reply', () => { replies += 1; });
    const cfg = WorkerConfig.parse({ name: 'w22', center: { url: app.ws, token: TEST_TOKEN }, transport: 'direct', labels: [], agents: {}, repos: {} });
    const w = new Worker({ config: cfg, log: () => undefined, stateFile: resolve(mkdtempSync(resolve(tmpdir(), 'w22-')), 'state.json'), onCommand: () => { executed += 1; return { __type: 'custom.reply', ok: true }; } });
    w.start();
    for (let i = 0; i < 50 && !app.workerHub.isOnline('w22'); i++) await new Promise((r) => setTimeout(r, 100));
    expect(app.workerHub.isOnline('w22')).toBe(true);
    const id = crypto.randomUUID();
    app.workerHub.send('w22', 'custom.cmd', { taskKey: 'T-231' }, { id });
    await new Promise((r) => setTimeout(r, 300));
    app.workerHub.send('w22', 'custom.cmd', { taskKey: 'T-231' }, { id });
    await new Promise((r) => setTimeout(r, 300));
    expect(executed).toBe(1); expect(replies).toBe(2);
    w.stop();
  }));
  it('UT-S03-23: 同任务重试复用已有 worktree', () => withReport('UT-S03-23', () => {
    const repo = gitRepo();
    const a = createWorktree({ taskKey: 'T-231', repo: 'x/y', baseBranch: 'master' }, repo);
    const b = createWorktree({ taskKey: 'T-231', repo: 'x/y', baseBranch: 'master', reuseIfExists: true }, repo);
    expect(a.reused).toBe(false); expect(b.reused).toBe(true); expect(b.path).toBe(a.path);
  }));
  it('UT-S03-24: worker 写入 .foreman/context.md、task.json，并把 buildEnv 写进 custom_env.sh', () => withReport('UT-S03-24', () => {
    const repo = gitRepo();
    const tp = '/mnt/disk6/common/doris-thirdparties/doris-thirdparty-3.0';
    const out = createWorktree({ taskKey: 'T-231', repo: 'x/y', baseBranch: 'master', contextMarkdown: '# T-231 上下文', taskJson: { key: 'T-231', kind: 'code' }, buildEnv: { DORIS_THIRDPARTY: tp } }, repo);
    expect(existsSync(resolve(out.path, '.foreman/context.md'))).toBe(true);
    expect(readFileSync(resolve(out.path, '.foreman/context.md'), 'utf8')).toContain('T-231');
    expect(JSON.parse(readFileSync(resolve(out.path, '.foreman/task.json'), 'utf8')).key).toBe('T-231');
    expect(readFileSync(resolve(out.path, 'custom_env.sh'), 'utf8')).toContain(`export DORIS_THIRDPARTY="${tp}"`);
    expect(existsSync(resolve(out.path, '.claude/settings.json'))).toBe(false);
  }));
  it('UT-S03-30: claude --bg 启动参数与会话 id 解析', () => withReport('UT-S03-30', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'fclaude-'));
    const bin = resolve(dir, 'claude'); const log = resolve(dir, 'args.log');
    const uuid = '3f171235-0ea7-40ae-b928-49c2b4445518';
    writeFileSync(bin, [
      '#!/bin/sh',
      `if [ "$1" = "--bg" ]; then for a in "$@"; do printf '%s\\n' "$a"; done > "${log}"; echo "backgrounded · 3f171235 · T-231-implement"; fi`,
      `if [ "$1" = "agents" ]; then echo '[{"id":"3f171235","sessionId":"${uuid}","name":"T-231-implement","kind":"background","state":"working"}]'; fi`, '',
    ].join('\n')); chmodSync(bin, 0o755);
    const s = await claudeAdapter.start({ sessionId: crypto.randomUUID(), taskKey: 'T-231', kind: 'implement', agent: 'claude', prompt: '实现 T-231', cwd: dir, name: 'T-231-implement', mcp: { url: 'http://127.0.0.1:7801/mcp', token: 'tok-1' } }, bin, () => undefined, { pollMs: 3_600_000 });
    s.state = 'stopped';
    const args = readFileSync(log, 'utf8').trimEnd().split('\n');
    expect(args.slice(0, 5)).toEqual(['--bg', '--name', 'T-231-implement', '--permission-mode', 'auto']);
    expect(args).toContain('--strict-mcp-config');
    const mcp = args.find((a) => a.startsWith('--mcp-config='))!;
    expect(JSON.parse(mcp.slice('--mcp-config='.length)).mcpServers.foreman).toMatchObject({ type: 'http', url: 'http://127.0.0.1:7801/mcp', headers: { Authorization: 'Bearer tok-1' } });
    expect(args[args.length - 1]).toBe('实现 T-231');
    expect(s.agentSessionId).toBe(uuid); expect(s.shortId).toBe('3f171235');
  }));
  it('UT-S03-31: codex 启动带 workspace-write 沙箱，续接不带 -C', () => withReport('UT-S03-31', () => {
    const input = { sessionId: crypto.randomUUID(), taskKey: 'T-231', kind: 'implement', agent: 'codex', prompt: '实现', cwd: '/tmp/fx/wt/T-231', mcp: { url: 'http://127.0.0.1:7801/mcp', token: 'tok-2' } };
    const start = codexStartArgs(input);
    expect(start.slice(0, 3)).toEqual(['exec', '-C', '/tmp/fx/wt/T-231']);
    expect(start).toContain('sandbox_mode="workspace-write"');
    expect(start).toContain('mcp_servers.foreman.http_headers.Authorization="Bearer tok-2"');
    const s = { sessionId: input.sessionId, agent: 'codex', agentSessionId: 'th-1', pid: 1, cwd: input.cwd, logFile: '/dev/null', state: 'done' as const, mcp: input.mcp };
    const resume = codexResumeArgs(s, 'th-1', '继续');
    expect(resume.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(resume).not.toContain('-C');
    expect(resume).toContain('mcp_servers.foreman.url="http://127.0.0.1:7801/mcp"');
    expect(resume.slice(-2)).toEqual(['th-1', '继续']);
  }));
});

describe('S03 1.5 产物与子任务', () => {
  it('UT-S03-25: deliver artifacts 为空数组被拒', () => withReport('UT-S03-25', async () => {
    const { token } = await mcpSession('T-231');
    const r = await mcpCall(token, 'deliver', { taskKey: 'T-231', artifacts: [] });
    expect(r.error.code).toBe(-32602);
    expect(await app.db.one('SELECT 1 FROM artifacts')).toBeNull();
  }));
  it('UT-S03-26: PR 产物创建 T-231.1(kind pr) 与 T-231.2(kind review)', () => withReport('UT-S03-26', async () => {
    const { token } = await mcpSession('T-231', 'codex');
    const r = await mcpCall(token, 'deliver', { taskKey: 'T-231', artifacts: [{ kind: 'pr', url: 'https://github.com/selectdb/selectdb-core/pull/6612', title: '[fix](index) pass timeout', diffStat: { additions: 1, deletions: 0, files: 1 } }], summary: 'PR 已创建' });
    expect(r.error).toBeUndefined();
    const kids = await app.db.query<any>(`SELECT key, kind, state, agent FROM tasks WHERE parent_id=(SELECT id FROM tasks WHERE key='T-231') ORDER BY key`);
    expect(kids.rows.map((k) => [k.key, k.kind])).toEqual([['T-231.1', 'pr'], ['T-231.2', 'review']]);
    for (const k of kids.rows) expect(k.key).toMatch(/^T-\d+\.\d+$/);
    expect((await app.tasks.byKey('T-231')).state).toBe('delivered');
    expect((await app.tasks.detail('T-231')).artifacts[0]!.kind).toBe('pr');
  }));
  it('UT-S03-27: 出方案产物不创建 PR 子任务，implementFromPlan 可用', () => withReport('UT-S03-27', async () => {
    await fw('dev');
    const { token, taskId } = await mcpSession('T-231', 'claude');
    await app.db.query(`UPDATE tasks SET path='plan' WHERE id=$1`, [taskId]);
    await seedWorktree(app.db, { taskId, runtime: 'dev', path: '/tmp/fx/wt/T-231' });
    const content = '# 方案\n方案二：删除旧接口';
    const r = await mcpCall(token, 'deliver', { taskKey: 'T-231', artifacts: [{ kind: 'doc', path: 'docs/plan.md', title: '方案', content }] });
    expect(r.error).toBeUndefined();
    expect(await app.db.one(`SELECT 1 FROM tasks WHERE parent_id=$1`, [taskId])).toBeNull();
    const imp = await http(app, 'POST', '/api/tasks/T-231/implement');
    expect(imp.status).toBe(202); expect(['queued', 'running']).toContain(imp.body.state);
    const s = await app.db.one<any>(`SELECT kind, state FROM sessions WHERE task_id=$1 ORDER BY created_at DESC, attempt DESC LIMIT 1`, [taskId]);
    expect(s.kind).toBe('implement');
    expect((await app.db.one<any>('SELECT plan_doc FROM context_packs WHERE task_id=$1', [taskId])).plan_doc).toBe(content);
    expect(await app.db.one(`SELECT 1 FROM triage_cards WHERE task_id=$1`, [taskId])).toBeNull();
  }));
  it('UT-S03-28: 无方案产物时 implementFromPlan 409', () => withReport('UT-S03-28', async () => {
    await seedTask(app.db, { key: 'T-231', state: 'delivered' });
    const r = await http(app, 'POST', '/api/tasks/T-231/implement');
    expect(r.status).toBe(409); expect(r.body.code).toBe('NO_PLAN_ARTIFACT');
  }));
  it('UT-S03-29: retryTask 在非 failed 状态返回 409', () => withReport('UT-S03-29', async () => {
    await seedTask(app.db, { key: 'T-231', state: 'running' });
    const r = await http(app, 'POST', '/api/tasks/T-231/retry', { mode: 'same_agent' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('TASK_NOT_FAILED');
  }));
});
