/**
 * S03 单元测试：UT-S03-01 ~ UT-S03-65（来源：logos/resources/test/core-S03-test-cases.md）
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
import { WorktreeCreate, SessionStart, WorkerConfig, makeEnvelope, routeTask } from '@foreman/shared';
import { createWorktree, pickBuildEnv, resolveBaseRef, belongsTo } from '../../apps/worker/src/worktree.js';
import { Worker, textWorkspace } from '../../apps/worker/src/worker.js';
import { Intake, normalizeRepo, isBranchName, normalizeTriage } from '../../apps/center/src/domain/intake.js';
import { isManagedPath, setClaudeTrust } from '../../apps/worker/src/claudeTrust.js';
import { runGc } from '../../apps/worker/src/gc.js';
import { statSync, mkdirSync } from 'node:fs';
import { SessionStartError } from '../../apps/worker/src/sessions.js';
import { gitPublish, GitPublishError } from '../../apps/worker/src/gitPublish.js';

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
  it('UT-S03-20: 默认 branchName = foreman/<taskKey>', () => withReport('UT-S03-20', async () => {
    const repo = gitRepo();
    const out = await createWorktree({ taskKey: 'T-231', repo: 'x/y', baseBranch: 'master' }, repo);
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
  it('UT-S03-23: 同任务重试复用已有 worktree', () => withReport('UT-S03-23', async () => {
    const repo = gitRepo();
    const a = await createWorktree({ taskKey: 'T-231', repo: 'x/y', baseBranch: 'master' }, repo);
    const b = await createWorktree({ taskKey: 'T-231', repo: 'x/y', baseBranch: 'master', reuseIfExists: true }, repo);
    expect(a.reused).toBe(false); expect(b.reused).toBe(true); expect(b.path).toBe(a.path);
  }));
  it('UT-S03-24: worker 写入 .foreman/context.md、task.json，并把 buildEnv 写进 custom_env.sh', () => withReport('UT-S03-24', async () => {
    const repo = gitRepo();
    const tp = '/mnt/disk6/common/doris-thirdparties/doris-thirdparty-3.0';
    const out = await createWorktree({ taskKey: 'T-231', repo: 'x/y', baseBranch: 'master', contextMarkdown: '# T-231 上下文', taskJson: { key: 'T-231', kind: 'code' }, buildEnv: { DORIS_THIRDPARTY: tp } }, repo);
    expect(existsSync(resolve(out.path, '.foreman/context.md'))).toBe(true);
    expect(readFileSync(resolve(out.path, '.foreman/context.md'), 'utf8')).toContain('T-231');
    expect(JSON.parse(readFileSync(resolve(out.path, '.foreman/task.json'), 'utf8')).key).toBe('T-231');
    expect(readFileSync(resolve(out.path, 'custom_env.sh'), 'utf8')).toContain(`export DORIS_THIRDPARTY="${tp}"`);
    expect(existsSync(resolve(out.path, '.claude/settings.json'))).toBe(false);
    // .foreman/ 是上下文包与日志，必须被 worktree 自己的 exclude 挡住，否则 agent 的 git add -A 会带进 PR
    const excl = resolve(out.path, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: out.path, encoding: 'utf8' }).trim());
    expect(readFileSync(excl, 'utf8')).toContain('.foreman/');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: out.path, encoding: 'utf8' })).not.toContain('.foreman');
  }));
  it('UT-S03-32: 拍板可覆盖基线分支，落到任务与决策记录', () => withReport('UT-S03-32', async () => {
    const { taskId, key, hash } = await pending('T-232');
    const r = await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash, overrides: { baseBranch: 'branch-selectdb-doris-4.1' } });
    expect(r.status).toBe(200);
    const t = await app.db.one<any>('SELECT base_branch, decision FROM tasks WHERE id=$1', [taskId]);
    expect(t.base_branch).toBe('branch-selectdb-doris-4.1');
    expect(t.decision.baseBranch).toBe('branch-selectdb-doris-4.1');
    expect(t.decision.modified).toBe(true); // 覆盖了基线分支即视为修改，不计入信任
  }));

  it('UT-S03-33: 构建环境按基线分支匹配（同名 > 最长前缀 > default > 缺失）', () => withReport('UT-S03-33', () => {
    const byBranch = { 'branch-selectdb-doris-4.1': { DORIS_THIRDPARTY: '/tp/4.1' }, '4.0': { DORIS_THIRDPARTY: '/tp/4.0' }, default: { DORIS_THIRDPARTY: '/tp/def' } };
    expect(pickBuildEnv(byBranch, 'branch-selectdb-doris-4.1').matched).toBe('branch-selectdb-doris-4.1');
    expect(pickBuildEnv(byBranch, 'branch-selectdb-cloud-4.0-hotfix').matched).toBe('4.0');
    expect(pickBuildEnv(byBranch, 'branch-未知线').matched).toBe('default');
    expect(pickBuildEnv({ '4.1': { X: '1' } }, 'master')).toEqual({ env: null, matched: null });
    expect(pickBuildEnv(undefined, 'master')).toEqual({ env: null, matched: null });
  }));

  const gitIn = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });

  it('UT-S03-34: 基线变了就按新基线重建 worktree；有未提交改动时拒绝', () => withReport('UT-S03-34', async () => {
    const repo = gitRepo();
    gitIn(repo.main, 'checkout', '-q', '-b', 'rel'); writeFileSync(resolve(repo.main, 'REL'), 'r'); gitIn(repo.main, 'add', '.'); gitIn(repo.main, 'commit', '-q', '-m', 'rel'); gitIn(repo.main, 'checkout', '-q', 'master');
    const a = await createWorktree({ taskKey: 'T-240', repo: 'x/y', baseBranch: 'master' }, repo);
    expect(existsSync(resolve(a.path, 'REL'))).toBe(false);
    // 代码定位阶段按 master 建的；拍板把基线定成 rel → 重建
    const b = await createWorktree({ taskKey: 'T-240', repo: 'x/y', baseBranch: 'rel', resetToBase: true }, repo);
    expect(b.reused).toBe(false);
    expect(existsSync(resolve(b.path, 'REL'))).toBe(true);
    // 工作区有未提交改动：拒绝重建，绝不丢改动
    writeFileSync(resolve(b.path, 'README'), 'changed');
    await expect(createWorktree({ taskKey: 'T-240', repo: 'x/y', baseBranch: 'master', resetToBase: true }, repo)).rejects.toThrow(/未提交/);
    expect(readFileSync(resolve(b.path, 'README'), 'utf8')).toBe('changed');
  }));

  it('UT-S03-35: 主仓库只有远端跟踪分支时，基线解析为 origin/<分支> 且能建出 worktree', () => withReport('UT-S03-35', async () => {
    const repo = gitRepo();
    gitIn(repo.main, 'update-ref', 'refs/remotes/origin/branch-x', 'HEAD');
    expect(await resolveBaseRef('master', repo.main)).toBe('master');
    expect(await resolveBaseRef('branch-x', repo.main)).toBe('origin/branch-x');
    const w = await createWorktree({ taskKey: 'T-241', repo: 'x/y', baseBranch: 'branch-x' }, repo);
    expect(existsSync(resolve(w.path, 'README'))).toBe(true);
  }));

  it('UT-S03-36: 已有 worktree 的基线与任务不一致时，派发改为按新基线重建', () => withReport('UT-S03-36', async () => {
    const w = await fw('dev');
    const taskId = await seedTask(app.db, { key: 'T-242', state: 'queued', runtime: 'dev' });
    await app.db.query(`UPDATE tasks SET base_branch='branch-selectdb-doris-4.1' WHERE id=$1`, [taskId]);
    await app.db.query(`INSERT INTO worktrees (task_id, runtime_id, repo_name, base_branch, branch_name, path, state, created_at) VALUES ($1,$2,'selectdb/selectdb-core','selectdb-cloud-4.0','foreman/T-242','/tmp/fx/wt/T-242','ready',now())`, [taskId, await runtimeId(app.db, 'dev')]);
    await app.dispatch.dispatchTask(taskId);
    const env = await w.expect((e) => e.type === 'worktree.create');
    expect(env.payload.baseBranch).toBe('branch-selectdb-doris-4.1');
    expect(env.payload.resetToBase).toBe(true);
    const ev = await app.db.one<any>(`SELECT text FROM messages WHERE task_id=$1 AND text LIKE '%按新基线重建%'`, [taskId]);
    expect(ev?.text).toContain('selectdb-cloud-4.0');
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
    const s = await claudeAdapter.start({ sessionId: crypto.randomUUID(), taskKey: 'T-231', kind: 'implement', agent: 'claude', prompt: '实现 T-231', cwd: dir, name: 'T-231-implement', mcp: { url: 'http://127.0.0.1:7801/mcp', token: 'tok-1' } }, bin, () => undefined, { pollMs: 3_600_000, disallowedTools: ['Bash(rm:*)', 'Bash(git push:*)'] });
    s.state = 'stopped';
    const args = readFileSync(log, 'utf8').trimEnd().split('\n');
    expect(args.slice(0, 5)).toEqual(['--bg', '--name', 'T-231-implement', '--permission-mode', 'auto']);
    expect(args).toContain('--strict-mcp-config');
    const mcp = args.find((a) => a.startsWith('--mcp-config='))!;
    expect(JSON.parse(mcp.slice('--mcp-config='.length)).mcpServers.foreman).toMatchObject({ type: 'http', url: 'http://127.0.0.1:7801/mcp', headers: { Authorization: 'Bearer tok-1' } });
    // 阻塞式 request_approval / ask_user 最长 30 分钟：MCP 调用超时放到 35 分钟（claude 默认 60 秒，T-81 实测超时）
    expect(JSON.parse(mcp.slice('--mcp-config='.length)).mcpServers.foreman.timeout).toBe(35 * 60_000);
    // 黑名单同样要用 = 写法，且不能挤掉最后一个位置参数 prompt
    expect(args).toContain('--disallowedTools=Bash(rm:*),Bash(git push:*)');
    expect(args[args.length - 1]).toBe('实现 T-231');
    expect(s.agentSessionId).toBe(uuid); expect(s.shortId).toBe('3f171235');
  }));
  it('UT-S03-31: codex 启动带 workspace-write 沙箱，续接不带 -C', () => withReport('UT-S03-31', () => {
    const input = { sessionId: crypto.randomUUID(), taskKey: 'T-231', kind: 'implement', agent: 'codex', prompt: '实现', cwd: '/tmp/fx/wt/T-231', mcp: { url: 'http://127.0.0.1:7801/mcp', token: 'tok-2' } };
    const start = codexStartArgs(input);
    expect(start.slice(0, 3)).toEqual(['exec', '-C', '/tmp/fx/wt/T-231']);
    expect(start).toContain('sandbox_mode="workspace-write"');
    expect(start).toContain('mcp_servers.foreman.http_headers.Authorization="Bearer tok-2"');
    // codex 0.158 起 MCP 工具默认要审批：只放行 foreman 服务器（2026-09-29 生产 12 个定位会话 deliver 全被拒）
    expect(start).toContain('mcp_servers.foreman.default_tools_approval_mode="approve"');
    expect(start).toContain('mcp_servers.foreman.tool_timeout_sec=2100');
    const s = { sessionId: input.sessionId, agent: 'codex', agentSessionId: 'th-1', pid: 1, cwd: input.cwd, logFile: '/dev/null', state: 'done' as const, mcp: input.mcp };
    const resume = codexResumeArgs(s, 'th-1', '继续');
    expect(resume.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(resume).not.toContain('-C');
    expect(resume).toContain('mcp_servers.foreman.url="http://127.0.0.1:7801/mcp"');
    expect(resume).toContain('mcp_servers.foreman.default_tools_approval_mode="approve"');
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

describe('S03 1.6 实验环境回归（2026-09-24）', () => {
  it('UT-S03-37: 会话结束但本会话没有产物 → 任务暂停进收件箱，回复续接后原因清除', () => withReport('UT-S03-37', async () => {
    const w = await fw('dev');
    const taskId = await seedTask(app.db, { key: 'T-243', state: 'running', runtime: 'dev', agent: 'claude' });
    const sid = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'claude', kind: 'implement' });
    await app.db.query(`INSERT INTO messages (channel_id, task_id, kind, author, text) SELECT channel_id, id, 'progress', 'claude', '建 PR 没被批准，本轮停在这里' FROM tasks WHERE id=$1`, [taskId]);
    await app.dispatch.onSessionState('dev', { sessionId: sid, state: 'done', source: 'hook' });
    const t = await app.tasks.byKey('T-243');
    expect(t.state).toBe('paused');
    expect(t.queue_reason).toMatch(/^人工处理：会话结束但没有产物/);
    expect(t.queue_reason).toContain('建 PR 没被批准');
    const inbox = await http(app, 'GET', '/api/inbox');
    expect(inbox.body.failures.map((f: any) => f.key)).toContain('T-243');
    const r = await http(app, 'POST', '/api/tasks/T-243/messages', { text: '补上描述再提' });
    expect(r.status).toBe(202);
    const env = await w.expect((e) => e.type === 'session.resume');
    expect(env.payload.sessionId).toBe(sid);
    const after = await app.tasks.byKey('T-243');
    expect(after.state).toBe('running'); expect(after.queue_reason).toBeNull();
  }));
  it('UT-S03-38: 代码任务只派给登记了该仓库的 runtime；都没有时进收件箱说明原因', () => withReport('UT-S03-38', async () => {
    const rules = { code: { require: ['build:doris'], prefer: 'dev' }, text: { require: [] } };
    const rts = [
      { name: 'dev', online: true, labels: ['build:doris'], runningSessions: 0, repos: ['selectdb/selectdb-core'] },
      { name: 'dev2', online: true, labels: ['build:doris'], runningSessions: 0, repos: ['apache/doris'] },
    ];
    expect(routeTask({ kind: 'code', rules, runtimes: rts, repo: 'apache/doris' }).runtime).toBe('dev2');
    expect(routeTask({ kind: 'code', rules, runtimes: rts, repo: 'x/y' })).toMatchObject({ runtime: null, missingLabels: ['repo:x/y'] });
    expect(routeTask({ kind: 'code', rules, runtimes: rts, repo: 'x/y', override: 'dev' }).runtime).toBeNull();
    expect(routeTask({ kind: 'text', rules, runtimes: rts, repo: 'x/y' }).runtime).not.toBeNull();
    // 没上报仓库的 runtime（旧 worker）不做仓库过滤
    expect(routeTask({ kind: 'code', rules, runtimes: [{ name: 'old', online: true, labels: ['build:doris'], runningSessions: 0 }], repo: 'x/y' }).runtime).toBe('old');

    const w = await fw('dev');
    const taskId = await seedTask(app.db, { key: 'T-244', state: 'queued', repo: 'apache/doris' });
    await app.dispatch.dispatchTask(taskId);
    const t = await app.tasks.byKey('T-244');
    expect(t.state).toBe('queued');
    expect(t.queue_reason).toBe('人工处理：没有 runtime 登记仓库 apache/doris，在 runtime 配置里加上该仓库，或改选仓库后重新拍板');
    await expect(w.expect((e) => e.type === 'worktree.create', 400)).rejects.toThrow();
    const inbox = await http(app, 'GET', '/api/inbox');
    expect(inbox.body.failures.map((f: any) => f.key)).toContain('T-244');
  }));
  it('UT-S03-39: 拍板改选没有 runtime 登记的仓库 → 422 REPO_UNAVAILABLE，审批保持 pending', () => withReport('UT-S03-39', async () => {
    await fw('dev');
    const { key, hash } = await pending('T-245', { repo: null });
    const bad = await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash, overrides: { repo: 'apache/doris' } });
    expect(bad.status).toBe(422); expect(bad.body.code).toBe('REPO_UNAVAILABLE');
    expect(bad.body.message).toContain('dev: selectdb/selectdb-core');
    expect((await app.db.one<any>('SELECT status FROM approvals WHERE key=$1', [key])).status).toBe('pending');
    // 改选已登记的仓库正常通过
    const ok = await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash, overrides: { repo: 'selectdb/selectdb-core' } });
    expect(ok.status).toBe(200);
    // 没改选时校验分流卡上的仓库（T-77：卡上是 apache/doris，原样批准后卡在队列）
    const b = await pending('T-266', { repo: 'apache/doris' });
    const asIs = await http(app, 'POST', `/api/approvals/${b.key}/decide`, { decision: 'approve', bodyHash: b.hash });
    expect(asIs.status).toBe(422); expect(asIs.body.code).toBe('REPO_UNAVAILABLE');
    expect((await http(app, 'POST', `/api/approvals/${b.key}/decide`, { decision: 'reject', bodyHash: b.hash })).status).toBe(200); // 否决不受影响
  }));
  it('UT-S03-40: 降级分流卡可从面板重新定位；已拍板的任务返回 409', () => withReport('UT-S03-40', async () => {
    const w = await fw('dev');
    const { taskId } = await pending('T-246');
    await app.db.query(`UPDATE triage_cards SET degraded=true, degraded_reason='开发机离线，代码定位待补', base_branch='3.1 or 4.0' WHERE task_id=$1`, [taskId]);
    await app.db.query(`UPDATE tasks SET base_branch='3.1 or 4.0' WHERE id=$1`, [taskId]);
    const r = await http(app, 'POST', '/api/tasks/T-246/relocate');
    expect(r.status).toBe(202);
    const env = await w.expect((e) => e.type === 'worktree.create');
    expect(env.payload.taskKey).toBe('T-246');
    expect(await app.db.one(`SELECT 1 FROM sessions WHERE task_id=$1 AND kind='code_locate' AND state='planned'`, [taskId])).not.toBeNull();
    expect(await app.db.one(`SELECT 1 FROM messages WHERE task_id=$1 AND text='已从面板发起重新定位'`, [taskId])).not.toBeNull();
    // 旧的基线结论清掉，由新一轮定位重新判断
    expect((await app.db.one<any>('SELECT base_branch FROM triage_cards WHERE task_id=$1', [taskId])).base_branch).toBeNull();
    expect((await app.db.one<any>('SELECT base_branch FROM tasks WHERE id=$1', [taskId])).base_branch).toBeNull();
    // 重复点击不重复派
    await http(app, 'POST', '/api/tasks/T-246/relocate');
    expect(Number((await app.db.one<any>(`SELECT count(*) AS n FROM sessions WHERE task_id=$1 AND kind='code_locate'`, [taskId])).n)).toBe(1);
    await seedTask(app.db, { key: 'T-247', state: 'running', runtime: 'dev' });
    const bad = await http(app, 'POST', '/api/tasks/T-247/relocate');
    expect(bad.status).toBe(409); expect(bad.body.code).toBe('INVALID_STATE');
  }));
  it('UT-S03-41: 停止会话后从暂停恢复，续接原会话而不是只改状态', () => withReport('UT-S03-41', async () => {
    const w = await fw('dev');
    const taskId = await seedTask(app.db, { key: 'T-248', state: 'running', runtime: 'dev', agent: 'codex' });
    const sid = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'codex', kind: 'implement' });
    await app.dispatch.onSessionState('dev', { sessionId: sid, state: 'stopped', source: 'worker' });
    expect((await app.tasks.byKey('T-248')).state).toBe('paused');
    const r = await http(app, 'POST', '/api/tasks/T-248/resume');
    expect(r.status).toBe(200); expect(r.body.state).toBe('running');
    const env = await w.expect((e) => e.type === 'session.resume');
    expect(env.payload.sessionId).toBe(sid);
    expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [sid])).state).toBe('running');
  }));
  it('UT-S03-43: worktree 已被实现会话用过时，基线不同也原样复用（重试不丢改动）', () => withReport('UT-S03-43', async () => {
    const w = await fw('dev');
    const taskId = await seedTask(app.db, { key: 'T-251', state: 'queued', runtime: 'dev' });
    await app.db.query(`UPDATE tasks SET base_branch='branch-selectdb-doris-4.1' WHERE id=$1`, [taskId]);
    const wt = await seedWorktree(app.db, { taskId, runtime: 'dev', path: '/tmp/fx/wt/T-251' });
    await seedSession(app.db, { taskId, runtime: 'dev', agent: 'claude', kind: 'implement', state: 'failed' }).then((sid) => app.db.query('UPDATE sessions SET worktree_id=$2 WHERE id=$1', [sid, wt]));
    await app.dispatch.dispatchTask(taskId, { attempt: 2 });
    const env = await w.expect((e) => e.type === 'session.start' || e.type === 'worktree.create');
    expect(env.type).toBe('session.start');
    expect(await app.db.one(`SELECT 1 FROM messages WHERE task_id=$1 AND text LIKE '%按新基线重建%'`, [taskId])).toBeNull();
  }));
  it('UT-S03-44: agent 启动失败换家时守并发上限，另一家满了就排队', () => withReport('UT-S03-44', async () => {
    const w = await fw('dev');
    // codex 已满 3/3
    for (let i = 0; i < 3; i++) {
      const t = await seedTask(app.db, { key: `T-26${i}`, state: 'running', runtime: 'dev', agent: 'codex' });
      await seedSession(app.db, { taskId: t, runtime: 'dev', agent: 'codex', kind: 'implement' });
    }
    const count = async () => Number((await app.db.one<any>(`SELECT count(*) AS n FROM sessions WHERE agent='codex' AND state IN ('planned','running','waiting_input')`)).n);
    // 实现会话：claude 起不来 → codex 满 → 任务排队，不新建 codex 会话
    const impl = await seedTask(app.db, { key: 'T-252', state: 'queued', runtime: 'dev', agent: 'claude' });
    const s1 = await seedSession(app.db, { taskId: impl, runtime: 'dev', agent: 'claude', kind: 'implement', state: 'planned' });
    await app.dispatch.startSession(s1, '/tmp/fx/wt/T-252');
    const e1 = await w.expect((e) => e.type === 'session.start' && e.payload.sessionId === s1);
    w.send('error', { code: 'AGENT_START_FAILED', message: 'Workspace not trusted', retryable: false }, e1.id);
    for (let i = 0; i < 30; i++) { if ((await app.tasks.byKey('T-252')).queue_reason) break; await new Promise((r) => setTimeout(r, 100)); }
    const t = await app.tasks.byKey('T-252');
    expect(t.state).toBe('queued'); expect(t.agent).toBe('codex'); expect(t.queue_reason).toMatch(/^排队：claude 启动失败/);
    expect(await count()).toBe(3);
    // 代码定位：同样不硬塞，改回 code-locate 队列
    const loc = await seedTask(app.db, { key: 'T-253', state: 'triaging', runtime: 'dev' });
    const s2 = await seedSession(app.db, { taskId: loc, runtime: 'dev', agent: 'claude', kind: 'code_locate', state: 'planned' });
    await app.dispatch.startSession(s2, '/tmp/fx/wt/T-253');
    const e2 = await w.expect((e) => e.type === 'session.start' && e.payload.sessionId === s2);
    w.send('error', { code: 'AGENT_START_FAILED', message: 'Workspace not trusted', retryable: false }, e2.id);
    for (let i = 0; i < 30; i++) { if (await app.db.one(`SELECT 1 FROM jobs WHERE kind='code-locate' AND status='queued' AND args->>'taskId'=$1`, [loc])) break; await new Promise((r) => setTimeout(r, 100)); }
    expect(await app.db.one(`SELECT 1 FROM jobs WHERE kind='code-locate' AND status='queued' AND args->>'taskId'=$1`, [loc])).not.toBeNull();
    expect(await count()).toBe(3);
  }));
  it('UT-S03-45: 文本会话的占位 cwd /tmp 改到 ~/.foreman/workspace，worktree 会话原样', () => withReport('UT-S03-45', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'fhome-'));
    const t = textWorkspace({ cwd: '/tmp', sessionId: 's1' }, home);
    expect(t.cwd).toBe(resolve(home, 'workspace')); expect(existsSync(t.cwd)).toBe(true); expect(t.sessionId).toBe('s1');
    const w = textWorkspace({ cwd: '/mnt/wt/T-1' }, home);
    expect(w.cwd).toBe('/mnt/wt/T-1');
  }));
  it('UT-S03-46: 代码定位会话结束未回写时，已有的降级卡也刷新原因', () => withReport('UT-S03-46', async () => {
    await fw('dev');
    const taskId = await seedTask(app.db, { key: 'T-254', state: 'triaging', runtime: 'dev' });
    await app.intake.emitTriage(taskId, null, { degraded: true, degradedReason: '代码定位排队中：dev 上 agent 并发已满' });
    const sid = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'codex', kind: 'code_locate' });
    await app.dispatch.onSessionState('dev', { sessionId: sid, state: 'done', source: 'exit' });
    const card = await app.db.one<any>('SELECT degraded, degraded_reason FROM triage_cards WHERE task_id=$1', [taskId]);
    expect(card.degraded).toBe(true); expect(card.degraded_reason).toBe('代码定位失败：会话结束但未回写分流结果');
    const aps = await app.db.query<any>(`SELECT status, payload FROM approvals WHERE task_id=$1 AND action_type='triage_confirm'`, [taskId]);
    expect(aps.rows).toHaveLength(1); expect(aps.rows[0].status).toBe('pending');
    expect(aps.rows[0].payload.degradedReason).toBe('代码定位失败：会话结束但未回写分流结果');
  }));
  it('UT-S03-47: claude 工作区信任只写 worker 管理的目录，保留其他内容，坏文件不覆盖', () => withReport('UT-S03-47', async () => {
    const scope = { childrenOf: ['/mnt/wt'], exact: ['/home/u/.foreman/workspace'] };
    expect(isManagedPath('/mnt/wt/T-1', scope)).toBe(true);
    expect(isManagedPath('/mnt/wt/T-1/sub', scope)).toBe(true);
    expect(isManagedPath('/mnt/wt', scope)).toBe(false);
    expect(isManagedPath('/mnt/wt-other/T-1', scope)).toBe(false);
    expect(isManagedPath('/home/u/.foreman/workspace', scope)).toBe(true);
    expect(isManagedPath('/home/u', scope)).toBe(false);

    const dir = mkdtempSync(resolve(tmpdir(), 'ctrust-'));
    const f = resolve(dir, '.claude.json');
    writeFileSync(f, JSON.stringify({ userID: 'u1', projects: { '/mnt/wt/T-2': { lastCost: 3, allowedTools: ['Read'] } } }), { mode: 0o600 });
    expect(setClaudeTrust('/mnt/wt/T-1', true, f)).toBe(true);
    expect(setClaudeTrust('/mnt/wt/T-1', true, f)).toBe(false); // 幂等
    expect(setClaudeTrust('/mnt/wt/T-2', true, f)).toBe(true);
    const d = JSON.parse(readFileSync(f, 'utf8'));
    expect(d.userID).toBe('u1');
    expect(d.projects['/mnt/wt/T-1']).toMatchObject({ hasTrustDialogAccepted: true, allowedTools: [], mcpServers: {} });
    expect(d.projects['/mnt/wt/T-2']).toMatchObject({ hasTrustDialogAccepted: true, lastCost: 3, allowedTools: ['Read'] });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(setClaudeTrust('/mnt/wt/T-1', false, f)).toBe(true);
    expect(JSON.parse(readFileSync(f, 'utf8')).projects['/mnt/wt/T-1']).toBeUndefined();
    // 解析失败：抛错且文件原样
    writeFileSync(f, '{ broken');
    expect(() => setClaudeTrust('/mnt/wt/T-3', true, f)).toThrow();
    expect(readFileSync(f, 'utf8')).toBe('{ broken');
    // 回收回调
    const removed: string[] = [];
    await runGc({ policy: 'retain_days', dryRun: false, highWatermark: 0.85, protectedTaskKeys: [], candidates: [{ taskKey: 'T-9', path: resolve(dir, 'wt-T-9'), terminalAt: null }] }, { remove: () => undefined, onRemoved: (p) => removed.push(p) });
    expect(removed).toEqual([]); // 目录不存在时不算删除，不回调
    mkdirSync(resolve(dir, 'wt-T-9'));
    await runGc({ policy: 'retain_days', dryRun: false, highWatermark: 0.85, protectedTaskKeys: [], candidates: [{ taskKey: 'T-9', path: resolve(dir, 'wt-T-9'), terminalAt: null }] }, { remove: () => undefined, onRemoved: (p) => removed.push(p) });
    expect(removed).toEqual([resolve(dir, 'wt-T-9')]);
  }));
  it('UT-S03-48: worker 起 claude 前自动信任自己建的 worktree；被冲掉时补标重试；管理范围外的目录不碰', () => withReport('UT-S03-48', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'chome-'));
    const root = mkdtempSync(resolve(tmpdir(), 'cwt-'));
    const prev = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = home;
    const f = resolve(home, '.claude.json');
    writeFileSync(f, JSON.stringify({ projects: {} }), { mode: 0o600 });
    let calls = 0; let dropOnce = true;
    const trusted = (cwd: string) => JSON.parse(readFileSync(f, 'utf8')).projects?.[cwd]?.hasTrustDialogAccepted === true;
    // 假 claude：模拟 2.1.284 的信任检查；第一次调用时模拟另一个 claude 进程回写旧内容冲掉条目
    const fakeClaude = {
      async start(input: any) {
        calls += 1;
        if (dropOnce && trusted(input.cwd)) { dropOnce = false; writeFileSync(f, JSON.stringify({ projects: {} })); }
        if (!trusted(input.cwd)) throw new SessionStartError(`claude --bg 失败：Workspace not trusted. Run \`claude\` in ${input.cwd} once`);
        return { sessionId: input.sessionId, agent: 'claude', agentSessionId: 'cl-x', pid: 1, cwd: input.cwd, logFile: '/dev/null', state: 'running' as const };
      },
      async resume() {}, async stop() {},
    };
    const cfg = WorkerConfig.parse({ name: 'w48', center: { url: app.ws, token: TEST_TOKEN }, transport: 'direct', labels: ['agent:claude'], agents: { claude: { bin: 'fake-claude', maxConcurrent: 3 } }, repos: { 'selectdb/selectdb-core': { main: '/tmp/fx/core', worktreeRoot: root } } });
    const w = new Worker({ config: cfg, log: () => undefined, stateFile: resolve(home, 'state.json'), adapters: { claude: fakeClaude } as any });
    try {
      w.start();
      for (let i = 0; i < 50 && !app.workerHub.isOnline('w48'); i++) await new Promise((r) => setTimeout(r, 100));
      const wt = resolve(root, 'T-255'); mkdirSync(wt);
      const taskId = await seedTask(app.db, { key: 'T-255', state: 'queued', runtime: 'w48' });
      const sid = await seedSession(app.db, { taskId, runtime: 'w48', agent: 'claude', kind: 'code_locate', state: 'planned' });
      app.workerHub.send('w48', 'session.start', { sessionId: sid, taskKey: 'T-255', kind: 'code_locate', agent: 'claude', prompt: 'p', cwd: wt, mcp: { url: 'http://x/mcp', token: 't' } });
      for (let i = 0; i < 50; i++) { if ((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [sid])).state === 'running') break; await new Promise((r) => setTimeout(r, 100)); }
      expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [sid])).state).toBe('running');
      expect(calls).toBe(2); // 首次被冲掉 → 补标后重试成功
      expect(trusted(wt)).toBe(true);
      // 管理范围外的目录：不写信任，照常报启动失败
      const outside = mkdtempSync(resolve(tmpdir(), 'outside-'));
      const sid2 = await seedSession(app.db, { taskId, runtime: 'w48', agent: 'claude', kind: 'code_locate', state: 'planned' });
      app.workerHub.send('w48', 'session.start', { sessionId: sid2, taskKey: 'T-255', kind: 'code_locate', agent: 'claude', prompt: 'p', cwd: outside, mcp: { url: 'http://x/mcp', token: 't' } });
      for (let i = 0; i < 20 && calls < 3; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 200));
      expect(calls).toBe(3); // 只试一次，不补标重试
      expect(JSON.parse(readFileSync(f, 'utf8')).projects[outside]).toBeUndefined();
    } finally {
      w.stop();
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  }));
  it('UT-S03-49: 定位结论入库前兜底——短仓库名补全、非法基线清空并留给拍板', () => withReport('UT-S03-49', async () => {
    const known = ['apache/doris', 'selectdb/selectdb-core'];
    expect(normalizeRepo('selectdb-core', known)).toBe('selectdb/selectdb-core');
    expect(normalizeRepo('SelectDB/SelectDB-Core', known)).toBe('selectdb/selectdb-core');
    expect(normalizeRepo('apache/doris', known)).toBe('apache/doris');
    expect(normalizeRepo('foo/bar', known)).toBe('foo/bar');
    expect(normalizeRepo('doris', ['apache/doris', 'selectdb/doris'])).toBe('doris'); // 有歧义不猜
    expect(isBranchName('branch-selectdb-doris-4.1')).toBe(true);
    expect(isBranchName('origin/branch-4.0')).toBe(true);
    expect(isBranchName('branch-selectdb-doris-3.1 or branch-selectdb-doris-4.0; scan version unspecified')).toBe(false);
    expect(isBranchName('a..b')).toBe(false);
    const n = normalizeTriage({ repo: { name: 'selectdb-core', confidence: 0.6, candidates: ['selectdb-core', 'doris'] }, targetBranch: '3.1 or 4.0', suggestedPath: '先确认扫描版本' }, known);
    expect(n.repo).toEqual({ name: 'selectdb/selectdb-core', confidence: 0.6, candidates: ['selectdb/selectdb-core', 'apache/doris'] });
    expect(n.targetBranch).toBeNull();
    expect(n.suggestedPath).toBe('先确认扫描版本\n（定位给出的基线不是一条具体分支，拍板时请确认：3.1 or 4.0）');
    expect(normalizeTriage({ targetBranch: '  branch-4.1 ' }, known).targetBranch).toBe('branch-4.1');
    // 任务上遗留的非法基线不被沿用
    const legacy = await seedTask(app.db, { key: 'T-259', state: 'triaging', runtime: 'dev' });
    await app.db.query(`UPDATE tasks SET base_branch='3.1 or 4.0' WHERE id=$1`, [legacy]);
    await app.intake.emitTriage(legacy, null, { tier: 'fix', effort: 'small', repo: { name: 'selectdb/selectdb-core', confidence: 0.9 }, suggestedPath: 'x' });
    expect((await app.db.one<any>('SELECT base_branch FROM triage_cards WHERE task_id=$1', [legacy])).base_branch).toBeNull();
    // 端到端：MCP deliver 短名 → 分流卡仓库为全名，且能路由到登记该仓库的 dev
    await fw('dev');
    const taskId = await seedTask(app.db, { key: 'T-256', state: 'triaging', runtime: 'dev', repo: null });
    const sid = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'claude', kind: 'code_locate' });
    const token = Intake.newToken();
    await app.db.query('UPDATE sessions SET mcp_token_hash=$2 WHERE id=$1', [sid, Intake.hash(token)]);
    const r = await mcpCall(token, 'deliver', { taskKey: 'T-256', artifacts: [{ kind: 'triage', tier: 'fix', effort: 'small', repo: { name: 'selectdb-core', confidence: 0.8 }, targetBranch: '4.0 or 4.1', suggestedPath: '补判空', codeLocations: [{ file: 'be/src/x.cpp', line: 1, why: '入口' }] }] });
    expect(r.error).toBeUndefined();
    const card = await app.db.one<any>('SELECT repo_name, base_branch, default_runtime, suggested_path FROM triage_cards WHERE task_id=$1', [taskId]);
    expect(card.repo_name).toBe('selectdb/selectdb-core'); expect(card.default_runtime).toBe('dev');
    expect(card.base_branch).toBeNull(); expect(card.suggested_path).toContain('拍板时请确认：4.0 or 4.1');
    // 定位提示词列出已登记仓库与字段要求
    expect(app.dispatch.promptFor('code_locate', 'T-256', null, null, known)).toContain('从已登记仓库中选：apache/doris、selectdb/selectdb-core');
  }));
  it('UT-S03-50: 代码定位作业随会话结束关闭；名额满时重新定位进队列，不因遗留作业 500', () => withReport('UT-S03-50', async () => {
    await fw('dev');
    // 测试时钟是冻结的假时钟，created_at 不能用来排先后：按状态排序比较
    const jobs = async (taskId: string) => (await app.db.query<any>(`SELECT status FROM jobs WHERE kind='code-locate' AND args->>'taskId'=$1 ORDER BY status`, [taskId])).rows.map((r) => r.status);
    // 1) 会话结束 → 已派发的作业关成 succeeded
    const a = await seedTask(app.db, { key: 'T-257', state: 'triaging', runtime: 'dev' });
    await app.db.query(`INSERT INTO jobs (kind, status, required_label, args, dedupe_key, dispatched_at, created_at) VALUES ('code-locate','dispatched','build:doris',$1,$2,now(),now())`, [JSON.stringify({ taskId: a }), `code-locate:${a}`]);
    const sa = await seedSession(app.db, { taskId: a, runtime: 'dev', agent: 'codex', kind: 'code_locate' });
    await app.dispatch.onSessionState('dev', { sessionId: sa, state: 'done', source: 'exit' });
    expect(await jobs(a)).toEqual(['succeeded']);
    // 2) 名额占满 + 遗留一条已派发作业（生产上从没被关过的那种）→ relocate 仍 202，作业进队列
    for (const [i, agent] of ['claude', 'claude', 'claude', 'codex', 'codex', 'codex'].entries()) {
      const t = await seedTask(app.db, { key: `T-27${i}`, state: 'running', runtime: 'dev' });
      await seedSession(app.db, { taskId: t, runtime: 'dev', agent, kind: 'implement' });
    }
    const { taskId: b } = await pending('T-258');
    await app.db.query(`UPDATE triage_cards SET degraded=true, degraded_reason='x' WHERE task_id=$1`, [b]);
    await app.db.query(`INSERT INTO jobs (kind, status, required_label, args, dedupe_key, dispatched_at, created_at) VALUES ('code-locate','dispatched','build:doris',$1,$2,now() - interval '3 hours',now() - interval '3 hours')`, [JSON.stringify({ taskId: b }), `code-locate:${b}`]);
    const r = await http(app, 'POST', '/api/tasks/T-258/relocate');
    expect(r.status).toBe(202);
    expect(await jobs(b)).toEqual(['queued', 'skipped']);
    // 3) 再点一次不重复排队
    expect((await http(app, 'POST', '/api/tasks/T-258/relocate')).status).toBe(202);
    expect(await jobs(b)).toEqual(['queued', 'skipped']);
  }));
  it('UT-S03-51: 任务上的短仓库名在定位建 worktree 前补全；降级更新的线程提示写「未完成」', () => withReport('UT-S03-51', async () => {
    const w = await fw('dev');
    const { taskId } = await pending('T-260');
    await app.db.query(`UPDATE tasks SET repo_name='selectdb-core' WHERE id=$1`, [taskId]);
    expect((await http(app, 'POST', '/api/tasks/T-260/relocate')).status).toBe(202);
    const env = await w.expect((e) => e.type === 'worktree.create' && e.payload.taskKey === 'T-260');
    expect(env.payload.repo).toBe('selectdb/selectdb-core');
    expect((await app.tasks.byKey('T-260')).repo_name).toBe('selectdb/selectdb-core');
    await app.intake.emitTriage(taskId, null, { degraded: true, degradedReason: 'worktree 创建失败' });
    const note = await app.db.one<any>(`SELECT text FROM messages WHERE task_id=$1 AND text LIKE '代码定位%' ORDER BY created_at DESC, seq DESC LIMIT 1`, [taskId]);
    expect(note.text).toBe('代码定位未完成：worktree 创建失败');
  }));
  it('UT-S03-52: 同一会话重复申请同类审批（客户端超时重试）时接着等原审批，不建重复', () => withReport('UT-S03-52', async () => {
    const { token, taskId } = await mcpSession('T-261', 'claude');
    // 测试时钟冻结：阻塞调用发出后手动推进时钟让它超时返回
    const timedOut = async (call: Promise<any>) => { await new Promise((r) => setTimeout(r, 300)); await app.fakeClock.advance(1_000); return call; };
    const req = () => timedOut(mcpCall(token, 'request_approval', { taskKey: 'T-261', actionType: 'create_pr', title: '创建 PR', body: '改动说明', timeoutMinutes: 0.01 }));
    const r1 = await req(); const r2 = await req();
    expect(r1.error).toBeUndefined(); expect(r2.error).toBeUndefined();
    expect(r2.result.structuredContent.approvalKey).toBe(r1.result.structuredContent.approvalKey);
    const rows = await app.db.query<any>(`SELECT key, status FROM approvals WHERE task_id=$1 AND action_type='create_pr'`, [taskId]);
    expect(rows.rows).toHaveLength(1); expect(rows.rows[0].status).toBe('pending');
    // 不同类动作仍单独建
    await timedOut(mcpCall(token, 'request_approval', { taskKey: 'T-261', actionType: 'jira_comment', title: '评论', body: 'x', timeoutMinutes: 0.01 }));
    expect(Number((await app.db.one<any>(`SELECT count(*) AS n FROM approvals WHERE task_id=$1`, [taskId])).n)).toBe(2);
  }));
  it('UT-S03-53: 会话结束时本会话还有待批审批 → 任务等待审批，不算「没产物」', () => withReport('UT-S03-53', async () => {
    const { token, taskId, sessionId } = await mcpSession('T-262', 'claude');
    const call = mcpCall(token, 'request_approval', { taskKey: 'T-262', actionType: 'create_pr', title: '创建 PR', body: '改动说明', timeoutMinutes: 0.01 });
    await new Promise((res) => setTimeout(res, 300)); await app.fakeClock.advance(1_000);
    const r = await call;
    const key = r.result.structuredContent.approvalKey;
    await app.db.query(`UPDATE tasks SET state='running' WHERE id=$1`, [taskId]);
    await app.dispatch.onSessionState('dev', { sessionId, state: 'done', source: 'exit' });
    const t = await app.tasks.byKey('T-262');
    expect(t.state).toBe('waiting_approval'); expect(t.queue_reason).toBeNull();
    expect(await app.db.one(`SELECT 1 FROM messages WHERE task_id=$1 AND text LIKE $2`, [taskId, `%等待 ${key} 审批%`])).not.toBeNull();
    const inbox = await http(app, 'GET', '/api/inbox');
    expect(inbox.body.failures.map((f: any) => f.key)).not.toContain('T-262');
    expect(inbox.body.approvals.map((a: any) => a.key)).toContain(key);
  }));
  it('UT-S03-54: worker 重启后恢复会话记录，等审批的会话仍能续接、不被判失联', () => withReport('UT-S03-54', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'w54-'));
    const calls: string[] = [];
    const fake = {
      async start(input: any) { calls.push('start'); return { sessionId: input.sessionId, agent: 'codex', agentSessionId: 'th-54', pid: null, cwd: input.cwd, logFile: '/dev/null', state: 'running' as const, mcp: input.mcp }; },
      async resume(s: any) { calls.push(`resume:${s.agentSessionId}`); s.state = 'running'; },
      async stop() {},
      attach(s: any) { calls.push(`attach:${s.sessionId}`); },
    };
    const cfg = WorkerConfig.parse({ name: 'w54', center: { url: app.ws, token: TEST_TOKEN }, transport: 'direct', labels: [], agents: { codex: { bin: 'fake-codex', maxConcurrent: 3 } }, repos: {} });
    const mk = () => new Worker({ config: cfg, log: () => undefined, stateFile: resolve(home, 'worker-state.json'), adapters: { codex: fake } as any });
    const online = async () => { for (let i = 0; i < 50 && !app.workerHub.isOnline('w54'); i++) await new Promise((r) => setTimeout(r, 100)); };
    const w1 = mk(); w1.start(); await online();
    const taskId = await seedTask(app.db, { key: 'T-263', state: 'waiting_approval', runtime: 'w54' });
    const sid = await seedSession(app.db, { taskId, runtime: 'w54', agent: 'codex', kind: 'implement', state: 'planned' });
    app.workerHub.send('w54', 'session.start', { sessionId: sid, taskKey: 'T-263', kind: 'implement', agent: 'codex', prompt: 'p', cwd: '/tmp', mcp: { url: 'http://x/mcp', token: 't54' } });
    for (let i = 0; i < 50; i++) { if ((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [sid])).state === 'running') break; await new Promise((r) => setTimeout(r, 100)); }
    const f = resolve(home, 'sessions.json');
    expect(existsSync(f)).toBe(true); expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, 'utf8'))[0]).toMatchObject({ sessionId: sid, agentSessionId: 'th-54', state: 'running' });
    w1.stop();
    for (let i = 0; i < 50 && app.workerHub.isOnline('w54'); i++) await new Promise((r) => setTimeout(r, 100));
    // 新进程（同一配置目录）：恢复记录，运行中的重新盯住；对账时会话在清单里，不判失联
    const w2 = mk(); w2.start(); await online();
    try {
      expect(w2.sessions.get(sid)?.agentSessionId).toBe('th-54');
      expect(calls).toContain(`attach:${sid}`);
      await new Promise((r) => setTimeout(r, 400));
      expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [sid])).state).not.toBe('lost');
      app.workerHub.send('w54', 'session.resume', { sessionId: sid, text: '审批 A-1 已批准，继续创建 PR' });
      for (let i = 0; i < 30 && !calls.includes('resume:th-54'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(calls).toContain('resume:th-54');
    } finally { w2.stop(); }
  }));
  it('UT-S03-55: 批准后续接已结束的会话失败 → 进失败卡，不假装在跑', () => withReport('UT-S03-55', async () => {
    const w = await fw('dev');
    const { token, taskId, sessionId } = await mcpSession('T-264', 'claude');
    const call = mcpCall(token, 'request_approval', { taskKey: 'T-264', actionType: 'create_pr', title: '创建 PR', body: '改动说明', timeoutMinutes: 0.01 });
    await new Promise((r) => setTimeout(r, 300)); await app.fakeClock.advance(1_000);
    const key = (await call).result.structuredContent.approvalKey;
    await app.dispatch.onSessionState('dev', { sessionId, state: 'done', source: 'exit' });
    expect((await app.tasks.byKey('T-264')).state).toBe('waiting_approval');
    const hash = (await app.db.one<any>('SELECT body_hash FROM approvals WHERE key=$1', [key])).body_hash;
    expect((await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: hash })).status).toBe(200);
    const env = await w.expect((e) => e.type === 'session.resume' && e.payload.sessionId === sessionId);
    expect(String(env.payload.text)).toContain('已批准');
    // 续接由 dispatch 负责：不再往频道送「没人接得住」、不拉调度员
    await new Promise((r) => setTimeout(r, 200));
    expect(await app.db.one(`SELECT 1 FROM messages WHERE payload->>'reason'='approval_decided_no_waiter' AND payload->>'approvalKey'=$1`, [key])).toBeNull();
    // worker 已不认识这个会话（例如重启丢了记录）
    w.send('error', { code: 'RESUME_FAILED', message: '会话不在本 runtime', retryable: false }, env.id);
    for (let i = 0; i < 30 && (await app.tasks.byKey('T-264')).state !== 'failed'; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await app.tasks.byKey('T-264')).state).toBe('failed');
    const card = await app.db.one<any>(`SELECT payload FROM messages WHERE task_id=$1 AND kind='failure_card' ORDER BY created_at DESC LIMIT 1`, [taskId]);
    expect(card.payload.options).toContain('fresh_session');
  }));
  it('UT-S03-56: review 子任务回写结论（kind=review），交 pr 被明确拒绝；review worktree 沿用父任务基线', () => withReport('UT-S03-56', async () => {
    const w = await fw('dev');
    const parent = await seedTask(app.db, { key: 'T-265', state: 'delivered', runtime: 'dev', agent: 'claude' });
    await app.db.query(`UPDATE tasks SET base_branch='branch-hotfix-x' WHERE id=$1`, [parent]);
    const child = await seedTask(app.db, { key: 'T-265.2', parentKey: 'T-265', state: 'queued', kind: 'review', runtime: 'dev', agent: 'codex' });
    // 基线沿用父任务
    await app.dispatch.dispatchTask(child, { kind: 'review', agent: 'codex' });
    const env = await w.expect((e) => e.type === 'worktree.create' && e.payload.taskKey === 'T-265.2');
    expect(env.payload.baseBranch).toBe('branch-hotfix-x');
    // 回写结论
    const sid = await seedSession(app.db, { taskId: child, runtime: 'dev', agent: 'codex', kind: 'review' });
    const token = Intake.newToken();
    await app.db.query('UPDATE sessions SET mcp_token_hash=$2 WHERE id=$1', [sid, Intake.hash(token)]);
    const bad = await mcpCall(token, 'deliver', { taskKey: 'T-265.2', artifacts: [{ kind: 'pr', url: 'https://github.com/o/r/pull/1' }] });
    expect(JSON.stringify(bad.error)).toContain('kind:\\"review\\"');
    const ok = await mcpCall(token, 'deliver', { taskKey: 'T-265.2', artifacts: [{ kind: 'review', verdict: 'comment', mustFix: [], suggestions: ['补序列化路径回归'], content: '## 结论\n可合', url: 'https://github.com/o/r/pull/1' }], summary: 'review 完成' });
    expect(ok.error).toBeUndefined();
    const art = await app.db.one<any>(`SELECT kind, url, payload FROM artifacts WHERE task_id=$1`, [child]);
    expect(art).toMatchObject({ kind: 'review', url: 'https://github.com/o/r/pull/1' });
    expect(art.payload).toMatchObject({ verdict: 'comment', mustFix: [], suggestions: ['补序列化路径回归'] });
    expect(Number((await app.db.one<any>(`SELECT count(*) AS n FROM tasks WHERE parent_id=$1`, [child])).n)).toBe(0); // 不派生孙任务
    const note = await app.db.one<any>(`SELECT text FROM messages WHERE task_id=$1 AND text LIKE 'T-265.2 review%'`, [parent]);
    expect(note.text).toContain('只有建议'); expect(note.text).toContain('补序列化路径回归');
  }));
  it('UT-S03-57: 任务换了仓库时不复用别的仓库建的工作区', () => withReport('UT-S03-57', async () => {
    // worker：同一 worktreeRoot 下，T-267 已由仓库 A 建出；按仓库 B 建时另起路径
    const a = gitRepo(); const b = gitRepo();
    const root = mkdtempSync(resolve(tmpdir(), 'wt57-'));
    const wa = await createWorktree({ taskKey: 'T-267', repo: 'x/a', baseBranch: 'master' }, { main: a.main, worktreeRoot: root });
    expect(await belongsTo(wa.path, a.main)).toBe(true); expect(await belongsTo(wa.path, b.main)).toBe(false);
    const wb = await createWorktree({ taskKey: 'T-267', repo: 'x/b', baseBranch: 'master' }, { main: b.main, worktreeRoot: root });
    expect(wb.reused).toBe(false); expect(wb.path).not.toBe(wa.path);
    expect(await belongsTo(wb.path, b.main)).toBe(true);
    // 再按 B 建一次：复用 B 自己那个
    const wb2 = await createWorktree({ taskKey: 'T-267', repo: 'x/b', baseBranch: 'master' }, { main: b.main, worktreeRoot: root });
    expect(wb2.path).toBe(wb.path);
    // 中心：任务仓库是 apache/doris，已有的 ready 工作区记的是 selectdb-core → 不复用，发 worktree.create
    const w = await fw('dev', { repos: { 'selectdb/selectdb-core': { main: '/tmp/fx/core', worktreeRoot: '/tmp/fx/wt' }, 'apache/doris': { main: '/tmp/fx/doris', worktreeRoot: '/tmp/fx/wt' } } });
    const taskId = await seedTask(app.db, { key: 'T-268', state: 'queued', runtime: 'dev', repo: 'apache/doris' });
    await seedWorktree(app.db, { taskId, runtime: 'dev', path: '/tmp/fx/wt/T-268', repo: 'selectdb/selectdb-core' });
    await app.dispatch.dispatchTask(taskId);
    const env = await w.expect((e) => e.type === 'worktree.create' || e.type === 'session.start');
    expect(env.type).toBe('worktree.create'); expect(env.payload.repo).toBe('apache/doris');
    // worker 回报实际仓库，中心据此记录
    w.send('worktree.ready', { taskKey: 'T-268', path: '/tmp/fx/wt/T-268@doris', branchName: 'foreman/T-268', reused: false, repo: 'apache/doris' }, env.id);
    for (let i = 0; i < 30; i++) { if (await app.db.one(`SELECT 1 FROM worktrees WHERE path='/tmp/fx/wt/T-268@doris'`)) break; await new Promise((r) => setTimeout(r, 100)); }
    expect((await app.db.one<any>(`SELECT repo_name FROM worktrees WHERE path='/tmp/fx/wt/T-268@doris'`)).repo_name).toBe('apache/doris');
  }));
  it('UT-S03-58: 重连对账不把刚派发的 planned 会话判失联；实现 worktree 就绪但会话不在时不擅自起代码定位', () => withReport('UT-S03-58', async () => {
    const w = await fw('dev');
    const t1 = await seedTask(app.db, { key: 'T-269', state: 'queued', runtime: 'dev' });
    const planned = await seedSession(app.db, { taskId: t1, runtime: 'dev', agent: 'codex', kind: 'implement', state: 'planned' });
    const t2 = await seedTask(app.db, { key: 'T-270', state: 'running', runtime: 'dev' });
    const running = await seedSession(app.db, { taskId: t2, runtime: 'dev', agent: 'codex', kind: 'implement', state: 'running' });
    w.send('session.list', { sessions: [] });
    for (let i = 0; i < 30 && (await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [running])).state !== 'lost'; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [running])).state).toBe('lost');
    expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [planned])).state).toBe('planned');
    // 实现 worktree 就绪，但没有等它的 planned 会话 → 只写线程提示，不起 code_locate
    await app.db.query(`UPDATE sessions SET state='lost' WHERE id=$1`, [planned]);
    await app.db.query(`INSERT INTO jobs (kind, status, args, scheduled_at, dispatched_at, created_at) VALUES ('dispatch','dispatched',$1,now(),now(),now())`, [JSON.stringify({ commandId: crypto.randomUUID(), type: 'worktree.create', taskId: t1, purpose: 'implement', runtime: 'dev', repo: 'selectdb/selectdb-core' })]);
    await app.dispatch.onWorktreeReady('dev', { taskKey: 'T-269', path: '/tmp/fx/wt/T-269', branchName: 'foreman/T-269', reused: false, repo: 'selectdb/selectdb-core' });
    expect(await app.db.one(`SELECT 1 FROM sessions WHERE task_id=$1 AND kind='code_locate'`, [t1])).toBeNull();
    expect(await app.db.one(`SELECT 1 FROM messages WHERE task_id=$1 AND text LIKE '%等它的会话已不在%'`, [t1])).not.toBeNull();
  }));
  it('UT-S03-59: git-publish 在工作区提交、推到 fork、建 PR；子模块指针不提交；PR 已存在取回链接；无改动报 NOTHING_TO_PUBLISH', () => withReport('UT-S03-59', async () => {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();
    const { main } = gitRepo();
    mkdirSync(resolve(main, 'sub')); writeFileSync(resolve(main, 'sub/f'), 'v1');
    writeFileSync(resolve(main, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = https://example.com/sub.git\n');
    sh(main, 'add', '.'); sh(main, 'commit', '-q', '-m', 'sub');
    const root = mkdtempSync(resolve(tmpdir(), 'gp-'));
    sh(root, 'clone', '-q', '--bare', main, 'origin.git'); sh(root, 'init', '-q', '--bare', 'fork.git');
    const clone = (name: string) => {
      sh(root, 'clone', '-q', resolve(root, 'origin.git'), name);
      const w = resolve(root, name);
      sh(w, 'config', 'user.name', 't'); sh(w, 'config', 'user.email', 't@x');
      // fork 远端写成 GitHub 地址（取 owner 用），推送改写到本地裸库
      sh(w, 'remote', 'add', 'fork', 'https://github.com/me/r.git');
      sh(w, 'config', `url.${resolve(root, 'fork.git')}.pushInsteadOf`, 'https://github.com/me/r.git');
      sh(w, 'checkout', '-q', '-b', 'foreman/T-271');
      return w;
    };
    const wt = clone('wt');
    writeFileSync(resolve(wt, 'README'), 'fixed'); writeFileSync(resolve(wt, 'sub/f'), 'v2');
    const gh: string[][] = [];
    let ghOut: () => string = () => 'https://github.com/o/r/pull/7\n';
    const run = async (bin: string, args: string[], cwd: string) => (bin === 'gh' ? (gh.push(args), ghOut()) : execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const args = { path: wt, repo: 'o/r', base: 'master', branch: 'foreman/T-271', pushRemote: 'fork', title: 'fix: T-271', body: '说明' };
    const r1 = await gitPublish(args, run);
    expect(r1).toMatchObject({ url: 'https://github.com/o/r/pull/7', created: true, committed: true, branch: 'foreman/T-271' });
    expect(sh(resolve(root, 'fork.git'), 'show', '--name-only', '--format=%s', 'foreman/T-271').split('\n').filter(Boolean)).toEqual(['fix: T-271', 'README']);
    expect(sh(wt, 'status', '--porcelain')).toContain('sub/f'); // 子模块指针留在工作区，不进提交
    expect(gh[0]).toEqual(['pr', 'create', '--repo', 'o/r', '--base', 'master', '--head', 'me:foreman/T-271', '--title', 'fix: T-271', '--body', '说明']);
    // 再推一次：PR 已存在 → 取回链接
    ghOut = () => { throw Object.assign(new Error('exit 1'), { stderr: 'a pull request for branch "me:foreman/T-271" into branch "master" already exists:\nhttps://github.com/o/r/pull/7\n' }); };
    expect(await gitPublish(args, run)).toMatchObject({ url: 'https://github.com/o/r/pull/7', created: false, committed: false });
    // 只有子模块指针变化 → 没东西可建 PR
    const wt2 = clone('wt2'); writeFileSync(resolve(wt2, 'sub/f'), 'v3');
    let err: unknown; try { await gitPublish({ ...args, path: wt2, branch: 'foreman/T-271b' }, run); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GitPublishError); expect((err as GitPublishError).code).toBe('NOTHING_TO_PUBLISH');
  }));
  /** 平台代做 git 的会话：dev 声明 git-publish、仓库配了 pushRemote，会话绑定就绪的 worktree */
  async function publishSession(key: string) {
    const w = await fw('dev', { capabilities: ['git-publish'], repos: { 'selectdb/selectdb-core': { main: '/tmp/fx/core', worktreeRoot: '/tmp/fx/wt', pushRemote: 'fork' } } });
    const taskId = await seedTask(app.db, { key, state: 'running', runtime: 'dev', agent: 'codex', authorAgent: 'codex' });
    const wtId = await seedWorktree(app.db, { taskId, runtime: 'dev', path: `/tmp/fx/wt/${key}` });
    const sessionId = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'codex', kind: 'implement' });
    const token = Intake.newToken();
    await app.db.query('UPDATE sessions SET mcp_token_hash=$2, worktree_id=$3 WHERE id=$1', [sessionId, Intake.hash(token), wtId]);
    return { w, taskId, sessionId, token };
  }
  const settle = async () => { await new Promise((r) => setTimeout(r, 100)); await Promise.all([...app.approvals.running]); };
  it('UT-S03-60: 平台代做 git：create_pr 审批带执行参数，批准后派 git-publish、交付 PR，不续接会话', () => withReport('UT-S03-60', async () => {
    const { w, taskId, sessionId, token } = await publishSession('T-272');
    const call = mcpCall(token, 'request_approval', { taskKey: 'T-272', actionType: 'create_pr', title: 'fix: 修 T-272', body: 'PR 描述', timeoutMinutes: 0.01 });
    await new Promise((r) => setTimeout(r, 300)); await app.fakeClock.advance(1_000);
    const key = (await call).result.structuredContent.approvalKey;
    const ap = await app.db.one<any>('SELECT payload, body_hash FROM approvals WHERE key=$1', [key]);
    expect(ap.payload.executor).toBe('center');
    expect(ap.payload.publish).toEqual({ runtime: 'dev', path: '/tmp/fx/wt/T-272', repo: 'selectdb/selectdb-core', base: 'main', branch: 'foreman/T-272', pushRemote: 'fork' });
    // 会话等审批超时退出：任务等审批，不算没产物
    await app.dispatch.onSessionState('dev', { sessionId, state: 'done', source: 'exit' });
    expect((await app.tasks.byKey('T-272')).state).toBe('waiting_approval');
    expect((await http(app, 'POST', `/api/approvals/${key}/decide`, { decision: 'approve', bodyHash: ap.body_hash })).status).toBe(200);
    const job = await w.expect((e) => e.type === 'job.run' && e.payload.kind === 'git-publish');
    expect(job.payload.args).toMatchObject({ path: '/tmp/fx/wt/T-272', branch: 'foreman/T-272', pushRemote: 'fork', base: 'main', title: 'fix: 修 T-272', body: 'PR 描述' });
    w.send('job.result', { ok: true, result: { url: 'https://github.com/selectdb/selectdb-core/pull/9', branch: 'foreman/T-272', commit: 'abc', created: true, committed: true } }, job.id);
    await settle();
    const t = await app.tasks.byKey('T-272');
    expect(t.state).toBe('delivered'); expect(t.pr_url).toBe('https://github.com/selectdb/selectdb-core/pull/9'); expect(t.branch_name).toBe('foreman/T-272');
    const kids = await app.db.query<any>('SELECT key, kind FROM tasks WHERE parent_id=$1 ORDER BY key', [taskId]);
    expect(kids.rows.map((k) => k.kind)).toEqual(['pr', 'review']);
    expect((await app.db.one<any>('SELECT x.status FROM approvals a JOIN actions x ON x.id=a.action_id WHERE a.key=$1', [key])).status).toBe('succeeded');
    // 会话已结束 → 交付后的动作由执行器补上：review 子任务派出、Jira 回写待批
    await w.expect((e) => e.type === 'worktree.create' && e.payload.taskKey === 'T-272.2');
    expect(await app.db.one(`SELECT 1 FROM approvals WHERE task_id=$1 AND action_type='jira_comment'`, [taskId])).not.toBeNull();
    expect(w.received.some((e) => e.type === 'session.resume')).toBe(false);
  }));
  it('UT-S03-61: 平台建 PR 失败 → 审批可重试、带错误；重试接口重新执行成功', () => withReport('UT-S03-61', async () => {
    const { w, token } = await publishSession('T-273');
    const call = mcpCall(token, 'request_approval', { taskKey: 'T-273', actionType: 'create_pr', title: 'fix: 修 T-273', body: 'PR 描述' });
    await new Promise((r) => setTimeout(r, 300));
    const ap = await app.db.one<any>(`SELECT key, body_hash FROM approvals WHERE action_type='create_pr' AND status='pending' ORDER BY created_at DESC LIMIT 1`);
    expect((await http(app, 'POST', `/api/approvals/${ap.key}/decide`, { decision: 'approve', bodyHash: ap.body_hash })).status).toBe(200);
    const out = (await call).result.structuredContent;
    expect(out.approved).toBe(true); expect(out.note).toContain('不用做任何 git 操作');
    const job = await w.expect((e) => e.type === 'job.run' && e.payload.kind === 'git-publish');
    w.send('job.result', { ok: false, error: { code: 'INTERNAL', message: 'PUSH_FAILED: 推送到 fork 失败' } }, job.id);
    await settle();
    const failed = await app.db.one<any>('SELECT status, payload FROM approvals WHERE key=$1', [ap.key]);
    expect(failed.status).toBe('failed'); expect(failed.payload.retryable).toBe(true); expect(failed.payload.error).toContain('PUSH_FAILED');
    expect((await http(app, 'GET', '/api/inbox')).body.approvals.map((a: any) => a.key)).toContain(ap.key);
    expect(await app.db.one(`SELECT 1 FROM messages WHERE text LIKE $1`, [`${ap.key}（提交并建 PR）执行失败%`])).not.toBeNull();
    // 重试：同步执行到结束
    const retry = http(app, 'POST', `/api/approvals/${ap.key}/retry`);
    const job2 = await w.expect((e) => e.type === 'job.run' && e.payload.kind === 'git-publish');
    w.send('job.result', { ok: true, result: { url: 'https://github.com/selectdb/selectdb-core/pull/10', created: true, committed: false } }, job2.id);
    const r = await retry;
    expect(r.status).toBe(200); expect(r.body.status).toBe('succeeded');
    const done = await app.db.one<any>('SELECT status, payload FROM approvals WHERE key=$1', [ap.key]);
    expect(done.status).toBe('approved'); expect(done.payload.retryable).toBeUndefined(); expect(done.payload.error).toBeUndefined();
    expect((await app.tasks.byKey('T-273')).pr_url).toBe('https://github.com/selectdb/selectdb-core/pull/10');
    expect((await http(app, 'POST', `/api/approvals/${ap.key}/retry`)).status).toBe(409);
  }));
  it('UT-S03-62: git-publish 执行期间 worker 不被卡住，取日志照常秒回', () => withReport('UT-S03-62', async () => {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();
    const { main, worktreeRoot } = gitRepo();
    const root = mkdtempSync(resolve(tmpdir(), 'gp62-'));
    sh(root, 'clone', '-q', '--bare', main, 'origin.git'); sh(root, 'init', '-q', '--bare', 'fork.git');
    sh(worktreeRoot, 'clone', '-q', resolve(root, 'origin.git'), 'T-274');
    const wt = resolve(worktreeRoot, 'T-274');
    sh(wt, 'config', 'user.name', 't'); sh(wt, 'config', 'user.email', 't@x');
    sh(wt, 'remote', 'add', 'fork', 'https://github.com/me/r.git');
    sh(wt, 'config', `url.${resolve(root, 'fork.git')}.pushInsteadOf`, 'https://github.com/me/r.git');
    sh(wt, 'checkout', '-q', '-b', 'foreman/T-274'); writeFileSync(resolve(wt, 'README'), 'fixed');
    // 慢 gh：模拟推送 / 建 PR 耗时
    const bin = mkdtempSync(resolve(tmpdir(), 'gh62-'));
    writeFileSync(resolve(bin, 'gh'), '#!/bin/sh\nsleep 3\necho https://github.com/o/r/pull/8\n'); chmodSync(resolve(bin, 'gh'), 0o755);
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
    const cfg = WorkerConfig.parse({ name: 'w62', center: { url: app.ws, token: TEST_TOKEN }, transport: 'direct', labels: [], agents: {}, repos: { 'o/r': { main, worktreeRoot, pushRemote: 'fork' } } });
    const w = new Worker({ config: cfg, log: () => undefined, stateFile: resolve(mkdtempSync(resolve(tmpdir(), 'w62-')), 'state.json') });
    w.start();
    try {
      for (let i = 0; i < 50 && !app.workerHub.isOnline('w62'); i++) await new Promise((r) => setTimeout(r, 100));
      expect((await app.db.one<any>(`SELECT capabilities FROM runtimes WHERE name='w62'`)).capabilities).toContain('git-publish');
      app.workerHub.send('w62', 'job.run', { kind: 'git-publish', args: { path: wt, repo: 'o/r', base: 'master', branch: 'foreman/T-274', pushRemote: 'fork', title: 'fix: T-274', body: 'b' }, timeoutSeconds: 60 });
      await new Promise((r) => setTimeout(r, 800)); // 此时 gh 正在 sleep
      const t0 = Date.now();
      const reply = await app.workerHub.request('w62', 'session.logs', { sessionId: crypto.randomUUID(), limit: 5 }, 10_000);
      expect(reply.type).toBe('session.logs.result');
      expect(Date.now() - t0).toBeLessThan(1500);
      for (let i = 0; i < 60; i++) { try { sh(resolve(root, 'fork.git'), 'rev-parse', '--verify', '--quiet', 'refs/heads/foreman/T-274'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
      expect(sh(resolve(root, 'fork.git'), 'log', '--format=%s', '-1', 'foreman/T-274')).toBe('fix: T-274');
    } finally { w.stop(); process.env.PATH = oldPath; }
  }));
  it('UT-S03-63: 换仓库 / 基线重来：停掉在跑的会话、作废旧审批、按新仓库派全新会话', () => withReport('UT-S03-63', async () => {
    const w = await fw('dev', { repos: { 'selectdb/selectdb-core': { main: '/tmp/fx/core', worktreeRoot: '/tmp/fx/wt' }, 'apache/doris': { main: '/tmp/fx/doris', worktreeRoot: '/tmp/fx/wt-doris' } } });
    const taskId = await seedTask(app.db, { key: 'T-275', state: 'waiting_approval', runtime: 'dev', agent: 'claude', authorAgent: 'claude', repo: 'selectdb/selectdb-core' });
    await app.db.query(`UPDATE tasks SET base_branch='branch-selectdb-doris-5.0-incr' WHERE id=$1`, [taskId]);
    await app.db.query(`UPDATE context_packs SET jira=$2 WHERE task_id=$1`, [taskId, JSON.stringify({ key: 'DORIS-29301', affectsVersions: ['5.0.0'], versionTarget: { repo: 'apache/doris', baseBranch: 'master', pickTargets: [], versions: ['5.0.0'], unmatched: [] } })]);
    const old = await seedSession(app.db, { taskId, runtime: 'dev', agent: 'claude', kind: 'implement', state: 'running' });
    const ap = await app.approvals.request({ taskId, sessionId: old, actionType: 'create_pr', title: 'fix', body: 'b', payload: { taskKey: 'T-275', executor: 'agent' } });
    // 还没拍板的不能重来；没登记的仓库拒绝
    const pd = await seedTask(app.db, { key: 'T-276', state: 'pending_decision' });
    void pd;
    expect((await http(app, 'POST', '/api/tasks/T-276/restart', { repo: 'apache/doris' })).status).toBe(409);
    expect((await http(app, 'POST', '/api/tasks/T-275/restart', { repo: 'x/unknown' })).status).toBe(422);
    const r = await http(app, 'POST', '/api/tasks/T-275/restart', { repo: 'apache/doris', baseBranch: 'master', reason: '影响版本 5.0.0' });
    expect(r.status).toBe(202);
    expect((await w.expect((e) => e.type === 'session.stop' && e.payload.sessionId === old)).payload.reason).toBe('user');
    expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [old])).state).toBe('stopped');
    expect((await app.approvals.byKey(ap.key))!.status).toBe('expired');
    expect((await http(app, 'GET', '/api/inbox')).body.approvals.map((a: any) => a.key)).not.toContain(ap.key);
    const t = await app.tasks.byKey('T-275');
    expect(t).toMatchObject({ repo_name: 'apache/doris', repo_source: 'manual', base_branch: 'master', pick_targets: [] });
    const wc = await w.expect((e) => e.type === 'worktree.create' && e.payload.taskKey === 'T-275');
    expect(wc.payload).toMatchObject({ repo: 'apache/doris', baseBranch: 'master' });
    const fresh = await app.db.one<any>(`SELECT attempt, state FROM sessions WHERE task_id=$1 AND kind='implement' AND id<>$2 ORDER BY created_at DESC LIMIT 1`, [taskId, old]);
    expect(fresh).toMatchObject({ attempt: 2, state: 'planned' });
    expect(await app.db.one(`SELECT 1 FROM messages WHERE task_id=$1 AND text LIKE $2`, [taskId, `重来：apache/doris · 基线 master · 已停止 1 个会话 · 作废审批 ${ap.key}%`])).not.toBeNull();
    // worker 随后回报旧会话 stopped：不能把新一轮暂停
    await app.dispatch.onSessionState('dev', { sessionId: old, state: 'stopped', source: 'exit' });
    expect((await app.tasks.byKey('T-275')).state).toBe('queued');
  }));
  it('UT-S03-64: 公开仓库的 create_pr 文案必须英文、不带内部单号，否则退回改写', () => withReport('UT-S03-64', async () => {
    const { token, taskId } = await mcpSession('T-277', 'claude');
    await app.db.query(`UPDATE tasks SET repo_name='apache/doris', source_ref='DORIS-29301' WHERE id=$1`, [taskId]);
    const req = (title: string, body: string) => mcpCall(token, 'request_approval', { taskKey: 'T-277', actionType: 'create_pr', title, body, timeoutMinutes: 0.01 });
    const zh = await req('[fix](fe) Check index jobs', '### 问题\n轻量 Schema Change 路径下 DROP INDEX 报错');
    expect(JSON.stringify(zh.error ?? zh.result)).toContain('含中文');
    const key = await req('[fix](fe) Check index jobs', 'Fixes DORIS-29301 and CORE-6212: DROP INDEX drops metadata before the conflict check.');
    expect(JSON.stringify(key.error ?? key.result)).toContain('含内部 Jira 单号');
    expect(await app.db.one(`SELECT 1 FROM approvals WHERE task_id=$1 AND action_type='create_pr'`, [taskId])).toBeNull();
    const okCall = req('[fix](fe) Check conflicting index change jobs before dropping index metadata', '### What problem does this PR solve?\n\nProblem Summary: DROP INDEX removed index metadata before checking conflicting IndexChangeJobs.\n\n### Release note\n\nNone');
    await new Promise((r) => setTimeout(r, 300)); await app.fakeClock.advance(1_000);
    const ok = await okCall;
    expect(ok.error).toBeUndefined(); expect(ok.result.structuredContent.approvalKey).toMatch(/^A-\d+$/);
    // 非公开仓库不限制
    const s2 = await mcpSession('T-278', 'claude');
    const zhCall = mcpCall(s2.token, 'request_approval', { taskKey: 'T-278', actionType: 'create_pr', title: '修复', body: '中文描述', timeoutMinutes: 0.01 });
    await new Promise((r) => setTimeout(r, 300)); await app.fakeClock.advance(1_000);
    expect((await zhCall).error).toBeUndefined();
  }));
  it('UT-S03-65: 工作区的 custom_env.sh 以主仓库的为底，再叠加 build_env 覆盖项', () => withReport('UT-S03-65', async () => {
    const repo = gitRepo();
    writeFileSync(resolve(repo.main, 'custom_env.sh'), 'export JAVA_HOME=/opt/jdk17\nexport DORIS_TOOLCHAIN=clang\n  export DORIS_THIRDPARTY=/old/tp\n');
    const out = await createWorktree({ taskKey: 'T-279', repo: 'x/y', baseBranch: 'master', buildEnv: { DORIS_THIRDPARTY: '/main/thirdparty' } }, repo);
    const env = readFileSync(resolve(out.path, 'custom_env.sh'), 'utf8');
    expect(env).toContain('export JAVA_HOME=/opt/jdk17'); expect(env).toContain('export DORIS_TOOLCHAIN=clang');
    expect(env.match(/DORIS_THIRDPARTY=/g)).toHaveLength(1); expect(env).toContain('export DORIS_THIRDPARTY="/main/thirdparty"');
    // 主仓库环境改了：复用工作区时跟着刷新，覆盖项仍只有一份
    writeFileSync(resolve(repo.main, 'custom_env.sh'), 'export JAVA_HOME=/opt/jdk21\n');
    await createWorktree({ taskKey: 'T-279', repo: 'x/y', baseBranch: 'master', buildEnv: { DORIS_THIRDPARTY: '/main/thirdparty' } }, repo);
    const env2 = readFileSync(resolve(out.path, 'custom_env.sh'), 'utf8');
    expect(env2).toContain('export JAVA_HOME=/opt/jdk21'); expect(env2).not.toContain('jdk17'); expect(env2.match(/DORIS_THIRDPARTY=/g)).toHaveLength(1);
  }));
  it('UT-S03-42: 收件箱与任务带出 Jira 优先级；runtime 列表带出登记的仓库', () => withReport('UT-S03-42', async () => {
    await fw('dev');
    const { taskId } = await pending('T-249');
    await app.db.query(`UPDATE context_packs SET jira='{"key":"CIR-20001","priority":"P0"}'::jsonb WHERE task_id=$1`, [taskId]);
    const inbox = await http(app, 'GET', '/api/inbox');
    expect(inbox.body.approvals.find((a: any) => a.taskKey === 'T-249').priority).toBe('P0');
    expect((await http(app, 'GET', '/api/tasks/T-249')).body.priority).toBe('P0');
    const rts = await http(app, 'GET', '/api/runtimes');
    expect(rts.body.items.find((r: any) => r.name === 'dev').repos).toEqual(['selectdb/selectdb-core']);
  }));
});
