/**
 * S05 单元测试：UT-S05-01 ~ UT-S05-30（来源：logos/resources/test/core-S05-test-cases.md）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, statSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import YAML from 'yaml';
import { withReport } from '../helpers/reporter.js';
import { bootTestApp, http, TEST_TOKEN, TEST_PANEL_TOKEN, type TestApp } from '../helpers/testApp.js';
import { FakeWorker } from '../helpers/fakeWorker.js';
import { writeFakeBins } from '../helpers/fakeBins.js';
import { seedRuntime, seedTask, seedSession, seedWorktree, runtimeId } from '../helpers/seed.js';
import { probe } from '../../apps/worker/src/probe.js';
import { runGc } from '../../apps/worker/src/gc.js';
import { routeTask } from '@foreman/shared';
import { findRepoRoot } from '../../apps/center/src/db.js';

const ROOT = findRepoRoot();
const CLI = resolve(ROOT, 'apps/cli/src/index.ts');
const NODE = process.execPath;

/** 异步执行 CLI：center 与测试同进程，必须避免同步阻塞事件循环 */
function runCli(args: string[], env: Record<string, string>, opts?: { allowFail?: boolean }): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(NODE, ['--import', 'tsx', CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', cwd: ROOT, timeout: 60_000 }, (err, stdout, stderr) => {
      const out = String(stdout ?? '') + String(stderr ?? '');
      const code = err ? Number((err as any).code ?? 1) : 0;
      if (err && !opts?.allowFail) reject(new Error(`cli exit ${code}: ${out}`)); else resolve({ code, out });
    });
  });
}

let app: TestApp;
const workers: FakeWorker[] = [];
async function fw(name?: string, reg?: Record<string, unknown>) {
  const w = new FakeWorker(app.ws, TEST_TOKEN);
  await w.connect();
  workers.push(w);
  if (name) await w.register({ name, ...reg });
  return w;
}

beforeAll(async () => { app = await bootTestApp(); });
afterAll(async () => { for (const w of workers) w.close(); await new Promise((r) => setTimeout(r, 300)); await app.close(); });
beforeEach(async () => { for (const w of workers.splice(0)) w.close(); await http(app, 'POST', '/__test/reset'); });

describe('S05 1.1 worker init 与 doctor', () => {
  it('UT-S05-01: 探测到 claude 与 git、未探测到 codex 时标签正确', () => withReport('UT-S05-01', () => {
    const bins = writeFakeBins(mkdtempSync(resolve(tmpdir(), 'fb-')), { claude: { version: '2.1.260' }, git: {}, opencode: {} });
    const p = probe({ env: { PATH: bins, HOME: '/nonexistent' } });
    expect(p.labels).toContain('agent:claude');
    expect(p.labels).not.toContain('agent:codex');
    expect(p.agents.codex?.ok).toBe(false);
    expect(p.tools.git?.ok).toBe(true);
  }));

  it('UT-S05-02: 存在 thirdparty/installed 时打 build:doris', () => withReport('UT-S05-02', () => {
    const repo = mkdtempSync(resolve(tmpdir(), 'repo-'));
    mkdirSync(resolve(repo, 'thirdparty/installed'), { recursive: true });
    const p = probe({ env: { PATH: '/nonexistent', HOME: '/nonexistent' }, repos: { 'selectdb/selectdb-core': repo } });
    expect(p.labels).toContain('build:doris');
    expect(p.labels).toContain('repo:selectdb/selectdb-core');
  }));

  it('UT-S05-03: 生成的 worker.yaml 通过 schema 校验且权限 0600', () => withReport('UT-S05-03', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'fh-'));
    const bins = writeFakeBins(mkdtempSync(resolve(tmpdir(), 'fb-')), { claude: { version: '2.1.260' }, git: {} });
    await runCli(['worker', 'init', '--non-interactive', '--name', 'laptop', '--center', app.ws, '--transport', 'direct', '--token', TEST_TOKEN], { FOREMAN_HOME: home, PATH: `${bins}:${process.env.PATH}` });
    const f = resolve(home, 'worker.yaml');
    expect(existsSync(f)).toBe(true);
    expect((statSync(f).mode & 0o777).toString(8)).toBe('600');
    const y = YAML.parse(readFileSync(f, 'utf8'));
    expect(y.name).toBe('laptop'); expect(y.transport).toBe('direct'); expect(y.labels).toContain('agent:claude');
    expect(y.center.token).toBe('${FOREMAN_TOKEN}');
  }));

  it('UT-S05-04: doctor 在 token 401 时输出红项退出 1', () => withReport('UT-S05-04', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'fh-'));
    writeFileSync(resolve(home, 'worker.yaml'), YAML.stringify({ name: 'laptop', center: { url: app.ws, token: 'wrong-token' }, transport: 'direct' }));
    const r = await runCli(['worker', 'doctor'], { FOREMAN_HOME: home }, { allowFail: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain('token 无效');
  }));

  it('UT-S05-05: doctor 在中心不可达时按 transport 给提示', () => withReport('UT-S05-05', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'fh-'));
    writeFileSync(resolve(home, 'worker.yaml'), YAML.stringify({ name: 'dev', center: { url: 'ws://127.0.0.1:1', token: 'x' }, transport: 'reverse-tunnel' }));
    const r = await runCli(['worker', 'doctor'], { FOREMAN_HOME: home }, { allowFail: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain('foreman center tunnel');
  }));

  it('UT-S05-06: auth-check 用 workerToken 而非 panelToken', () => withReport('UT-S05-06', async () => {
    expect((await http(app, 'POST', '/api/runtimes/auth-check', undefined, TEST_PANEL_TOKEN)).status).toBe(401);
    const ok = await http(app, 'POST', '/api/runtimes/auth-check', undefined, TEST_TOKEN);
    expect(ok.status).toBe(200); expect(ok.body.ok).toBe(true);
  }));
});

describe('S05 1.2 注册与心跳', () => {
  it('UT-S05-07: Register 缺 instanceId 被拒', () => withReport('UT-S05-07', async () => {
    const w = await fw();
    const p = w.expect((e) => e.type === 'error');
    w.send('register', { name: 'dev', version: '0.1.0', transport: 'direct', labels: [], agents: {}, repos: [] });
    const e = await p;
    expect(e.payload.code).toBe('VALIDATION');
  }));

  it('UT-S05-08: agents.maxConcurrent < 1 被拒', () => withReport('UT-S05-08', async () => {
    const w = await fw();
    const e = await w.register({ name: 'dev', agents: { claude: { bin: 'claude', maxConcurrent: 0 } } });
    expect(e.type).toBe('error'); expect(e.payload.code).toBe('VALIDATION');
  }));

  it('UT-S05-09: 注册成功 upsert runtimes online=true 且 ack.heartbeatSeconds=30', () => withReport('UT-S05-09', async () => {
    const w = await fw();
    const ack = await w.register({ name: 'dev', labels: ['agent:claude'] });
    expect(ack.type).toBe('register.ack'); expect(ack.payload.heartbeatSeconds).toBe(30);
    const row = await app.db.one<any>('SELECT * FROM runtimes WHERE name=$1', ['dev']);
    expect(row.online).toBe(true); expect(row.registered_at).toBeTruthy();
  }));

  it('UT-S05-10: 连接后 5 秒未 register 被断开', () => withReport('UT-S05-10', async () => {
    const w = await fw();
    await app.fakeClock.advance(5001);
    const c = await w.waitClose();
    expect(c.code).toBe(4002);
  }));

  it('UT-S05-11: 错误 token 关闭码 4001 且返回 AUTH_INVALID', () => withReport('UT-S05-11', async () => {
    const w = new FakeWorker(app.ws, 'wrong'); workers.push(w);
    await w.connect();
    const c = await w.waitClose();
    expect(c.code).toBe(4001);
    expect(w.errors[0]?.payload.code).toBe('AUTH_INVALID');
  }));

  it('UT-S05-12: 版本过旧返回 VERSION_UNSUPPORTED', () => withReport('UT-S05-12', async () => {
    const w = await fw();
    const e = await w.register({ name: 'dev', version: '0.0.1' });
    expect(e.payload.code).toBe('VERSION_UNSUPPORTED');
    expect((await w.waitClose()).code).toBe(4004);
  }));

  it('UT-S05-13: 同名不同 instanceId 且旧连接活跃 → RUNTIME_NAME_CONFLICT', () => withReport('UT-S05-13', async () => {
    const a = await fw('dev', { instanceId: '11111111-1111-1111-1111-111111111111' });
    const b = await fw();
    const e = await b.register({ name: 'dev', instanceId: '22222222-2222-2222-2222-222222222222' });
    expect(e.payload.code).toBe('RUNTIME_NAME_CONFLICT');
    expect(a.closeInfo).toBeNull();
  }));

  it('UT-S05-14: 同名同 instanceId 重连替换旧连接并回放 pendingCommands', () => withReport('UT-S05-14', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const a = await fw('dev', { instanceId: id });
    a.close(); await a.waitClose();
    await new Promise((r) => setTimeout(r, 50));
    app.workerHub.send('dev', 'session.resume', { sessionId: crypto.randomUUID(), text: 'hi' });
    const b = await fw();
    const ack = await b.register({ name: 'dev', instanceId: id });
    expect(ack.type).toBe('register.ack');
    expect((ack.payload.pendingCommands as any[]).length).toBe(1);
    expect((ack.payload.pendingCommands as any[])[0].type).toBe('session.resume');
  }));

  it('UT-S05-15: 心跳更新 last_seen_at、disk、load', () => withReport('UT-S05-15', async () => {
    const w = await fw('dev');
    await app.fakeClock.advance(30_000);
    w.send('heartbeat', { load: 12.5, disk: { usedRatio: 0.71, freeBytes: 100 }, sessions: { claude: 1 } });
    await new Promise((r) => setTimeout(r, 100));
    const row = await app.db.one<any>('SELECT * FROM runtimes WHERE name=$1', ['dev']);
    expect(Number(row.disk_used_ratio)).toBeCloseTo(0.71); expect(Number(row.load)).toBe(12.5);
    expect(new Date(row.last_seen_at).toISOString()).toBe(app.fakeClock.now().toISOString());
  }));

  it('UT-S05-16: 心跳 disk ≥ 0.85 触发 worktree.gc high_watermark 且保护运行中任务', () => withReport('UT-S05-16', async () => {
    const w = await fw('dev');
    const t = await seedTask(app.db, { key: 'T-900', state: 'running' });
    await seedWorktree(app.db, { taskId: t, runtime: 'dev', path: '/tmp/wt/T-900' });
    const p = w.expect((e) => e.type === 'worktree.gc');
    w.send('heartbeat', { disk: { usedRatio: 0.9 }, sessions: {} });
    const gc = await p;
    expect(gc.payload.policy).toBe('high_watermark');
    expect(gc.payload.protectedTaskKeys).toEqual(['T-900']);
  }));

  it('UT-S05-17: runtimes.name 不符合 slug 规则被 CHECK 拒绝', () => withReport('UT-S05-17', async () => {
    await expect(app.db.query(`INSERT INTO runtimes (name, transport) VALUES ('Dev Box', 'direct')`)).rejects.toThrow(/check/i);
  }));
});

describe('S05 1.3 离线判定与对账', () => {
  it('UT-S05-18: last_seen 超过 90 秒标离线并把其会话 reachable=false', () => withReport('UT-S05-18', async () => {
    await seedRuntime(app.db, { name: 'dev', lastSeenAt: new Date(app.fakeClock.now().getTime() - 91_000) });
    const t = await seedTask(app.db, { key: 'T-901', state: 'running' });
    await seedSession(app.db, { taskId: t, runtime: 'dev', agent: 'claude' });
    await seedSession(app.db, { taskId: t, runtime: 'dev', agent: 'codex' });
    await app.scheduler.tick('heartbeat-check');
    const rt = await app.db.one<any>('SELECT online FROM runtimes WHERE name=$1', ['dev']);
    expect(rt.online).toBe(false);
    const s = await app.db.query<any>('SELECT reachable FROM sessions');
    expect(s.rows.every((x) => x.reachable === false)).toBe(true);
    expect((await app.db.one<any>('SELECT state FROM tasks WHERE key=$1', ['T-901'])).state).toBe('running');
  }));

  it('UT-S05-19: 89 秒不判离线', () => withReport('UT-S05-19', async () => {
    await seedRuntime(app.db, { name: 'dev', lastSeenAt: new Date(app.fakeClock.now().getTime() - 89_000) });
    await app.scheduler.tick('heartbeat-check');
    expect((await app.db.one<any>('SELECT online FROM runtimes WHERE name=$1', ['dev'])).online).toBe(true);
  }));

  it('UT-S05-22: 会话失联后有善后：定位出降级卡、实现类进失败卡，并送进频道', () => withReport('UT-S05-22', async () => {
    const w = await fw('dev');
    const t1 = await seedTask(app.db, { key: 'T-910', state: 'triaging' });
    const t2 = await seedTask(app.db, { key: 'T-911', state: 'running' });
    const s1 = await seedSession(app.db, { taskId: t1, runtime: 'dev', agent: 'claude', kind: 'code_locate' });
    const s2 = await seedSession(app.db, { taskId: t2, runtime: 'dev', agent: 'claude', kind: 'implement' });
    await app.db.query('UPDATE sessions SET reachable=false');
    w.send('session.list', { sessions: [] });
    for (let i = 0; i < 40; i++) {
      const c = await app.db.one<any>('SELECT 1 FROM triage_cards WHERE task_id=$1', [t1]);
      if (c && (await app.tasks.byKey('T-911')).state === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [s1])).state).toBe('lost');
    expect((await app.db.one<any>('SELECT state FROM sessions WHERE id=$1', [s2])).state).toBe('lost');
    // 代码定位 → 降级卡；实现类 → 失败卡三选一
    expect((await app.db.one<any>('SELECT degraded, degraded_reason FROM triage_cards WHERE task_id=$1', [t1])).degraded).toBe(true);
    expect((await app.tasks.byKey('T-911')).state).toBe('failed');
    // 两者都要送进所属频道，让人能接着说怎么办
    const msgs = await app.db.query<any>(`SELECT task_id FROM messages WHERE payload->>'reason'='session_lost'`);
    expect(msgs.rows.map((r) => r.task_id).sort()).toEqual([t1, t2].sort());
  }));

  it('UT-S05-20: session.list 对账，本机不存在的会话标 lost', () => withReport('UT-S05-20', async () => {
    const w = await fw('dev');
    const t = await seedTask(app.db, { key: 'T-902' });
    const s1 = await seedSession(app.db, { taskId: t, runtime: 'dev', agent: 'claude' });
    const s2 = await seedSession(app.db, { taskId: t, runtime: 'dev', agent: 'claude' });
    const s3 = await seedSession(app.db, { taskId: t, runtime: 'dev', agent: 'codex' });
    await app.db.query('UPDATE sessions SET reachable=false');
    // 丢失的会话推断出来的问题应当一起关掉，否则永远挂在收件箱里没人能回答
    await app.db.query(`INSERT INTO questions (task_id, session_id, text, origin, status, asked_at, expires_at) VALUES ($1,$2,'✻Brewed for 3m · done','hook','open',$3,$4)`, [t, s3, app.clock.now(), new Date(app.clock.now().getTime() + 30 * 60_000)]);
    w.send('session.list', { sessions: [{ sessionId: s1, state: 'running' }, { sessionId: s2, state: 'waiting_input' }] });
    await new Promise((r) => setTimeout(r, 150));
    const rows = Object.fromEntries((await app.db.query<any>('SELECT id, state, reachable FROM sessions')).rows.map((r) => [r.id, r]));
    expect(rows[s1].state).toBe('running'); expect(rows[s1].reachable).toBe(true);
    expect(rows[s2].state).toBe('waiting_input');
    expect(rows[s3].state).toBe('lost');
    expect((await app.db.one<any>('SELECT status FROM questions WHERE session_id=$1', [s3])).status).toBe('timeout');
  }));

  it('UT-S05-21: 离线期间指令写入 pendingCommands 并在 ack 时按序回放', () => withReport('UT-S05-21', async () => {
    app.workerHub.send('dev', 'session.resume', { sessionId: crypto.randomUUID(), text: 'first' });
    app.workerHub.send('dev', 'worktree.create', { taskKey: 'T-1', repo: 'r', baseBranch: 'main' });
    const w = await fw();
    const ack = await w.register({ name: 'dev' });
    const pc = ack.payload.pendingCommands as any[];
    expect(pc.map((x) => x.type)).toEqual(['session.resume', 'worktree.create']);
  }));

  it('UT-S05-22: 连续离线 5 分钟只推一次飞书告警', () => withReport('UT-S05-22', async () => {
    await seedRuntime(app.db, { name: 'dev', online: false, lastSeenAt: new Date(app.fakeClock.now().getTime() - 301_000) });
    await app.scheduler.tick('heartbeat-check');
    await app.fakeClock.advance(300_000);
    await app.scheduler.tick('heartbeat-check');
    const alerts = app.fakeFeishu.sent.filter((m) => m.text.includes('[告警]') && m.text.includes('dev 离线'));
    expect(alerts.length).toBe(1);
  }));
});

describe('S05 1.4 路由规则', () => {
  const rules = { code: { require: ['build:doris'], prefer: 'dev' }, analysis: { require: [], prefer: 'dev' }, text: { require: [], prefer: 'center' } };
  it('UT-S05-23: require 标签全部命中才候选', () => withReport('UT-S05-23', () => {
    const d = routeTask({ kind: 'code', rules, runtimes: [{ name: 'dev', online: true, labels: ['agent:claude'], runningSessions: 0 }] });
    expect(d.runtime).toBeNull(); expect(d.missingLabels).toEqual(['build:doris']);
  }));
  it('UT-S05-24: 多候选取 prefer', () => withReport('UT-S05-24', () => {
    const d = routeTask({ kind: 'code', rules, runtimes: [{ name: 'laptop', online: true, labels: ['build:doris'], runningSessions: 0 }, { name: 'dev', online: true, labels: ['build:doris'], runningSessions: 5 }] });
    expect(d.runtime).toBe('dev');
  }));
  it('UT-S05-25: prefer 不在线时取会话最少者', () => withReport('UT-S05-25', () => {
    const d = routeTask({ kind: 'code', rules, runtimes: [{ name: 'dev', online: false, labels: ['build:doris'], runningSessions: 0 }, { name: 'laptop', online: true, labels: ['build:doris'], runningSessions: 2 }, { name: 'center', online: true, labels: ['build:doris'], runningSessions: 0 }] });
    expect(d.runtime).toBe('center');
  }));
  it('UT-S05-26: text 类型 prefer center', () => withReport('UT-S05-26', () => {
    const d = routeTask({ kind: 'text', rules, runtimes: [{ name: 'dev', online: true, labels: [], runningSessions: 0 }, { name: 'center', online: true, labels: ['text'], runningSessions: 3 }] });
    expect(d.runtime).toBe('center');
  }));
});

describe('S05 1.5 worktree 回收', () => {
  async function seedWts(days: number[]) {
    const dir = mkdtempSync(resolve(tmpdir(), 'wt-'));
    const paths: string[] = [];
    for (let i = 0; i < days.length; i++) {
      const p = resolve(dir, `T-95${i}`); mkdirSync(p); writeFileSync(resolve(p, 'f'), 'x');
      const t = await seedTask(app.db, { key: `T-95${i}`, state: 'done', terminalAt: new Date(app.fakeClock.now().getTime() - days[i]! * 86400_000) });
      await seedWorktree(app.db, { taskId: t, runtime: 'dev', path: p, sizeBytes: 1000 });
      paths.push(p);
    }
    return paths;
  }

  it('UT-S05-27: dryRun 只列不删', () => withReport('UT-S05-27', async () => {
    const w = await fw('dev');
    const paths = await seedWts([4, 4, 4, 4]);
    w.expect((e) => e.type === 'worktree.gc').then((gc) => w.send('worktree.gc.result', runGc(gc.payload as any) as any, gc.id));
    const r = await http(app, 'POST', '/api/runtimes/dev/gc', { dryRun: true, policy: 'retain_days' });
    expect(r.status).toBe(200); expect(r.body.removed.length).toBe(4); expect(r.body.dryRun).toBe(true);
    expect(paths.every((p) => existsSync(p))).toBe(true);
    expect((await app.db.one<any>(`SELECT count(*) AS n FROM worktrees WHERE state='removed'`)).n).toBe('0');
  }));

  it('UT-S05-28: retain_days 策略只删终态超 3 天', () => withReport('UT-S05-28', async () => {
    await fw('dev');
    await seedWts([2, 4]);
    const plan = await app.worktrees.plan(await runtimeId(app.db, 'dev'), 'retain_days', false);
    expect(plan.candidates.map((c) => c.taskKey)).toEqual(['T-951']);
  }));

  it('UT-S05-29: protectedTaskKeys 中的 worktree 永不删', () => withReport('UT-S05-29', () => {
    const removed: string[] = [];
    const r = runGc({ policy: 'high_watermark', dryRun: false, highWatermark: 0.85, protectedTaskKeys: ['T-1'], candidates: [{ taskKey: 'T-1', path: '/nonexistent/a', terminalAt: null }, { taskKey: 'T-2', path: '/nonexistent/b', terminalAt: null }] }, { remove: (p) => removed.push(p) });
    expect(r.removed.map((x) => x.taskKey)).toEqual(['T-2']);
    expect(r.skippedRunning).toBe(1);
  }));

  it('UT-S05-30: 删除后写任务线程事件与 worktrees.removed_at', () => withReport('UT-S05-30', async () => {
    const w = await fw('dev');
    const paths = await seedWts([4, 4]);
    w.expect((e) => e.type === 'worktree.gc').then((gc) => w.send('worktree.gc.result', runGc(gc.payload as any) as any, gc.id));
    const r = await http(app, 'POST', '/api/runtimes/dev/gc', { dryRun: false, policy: 'retain_days' });
    expect(r.status).toBe(200); expect(r.body.removed.length).toBe(2);
    expect(paths.every((p) => !existsSync(p))).toBe(true);
    const wts = await app.db.query<any>(`SELECT state, removed_at FROM worktrees`);
    expect(wts.rows.every((x) => x.state === 'removed' && x.removed_at)).toBe(true);
    expect((await app.db.one<any>(`SELECT count(*) AS n FROM events WHERE type='thread.event' AND payload->>'text' LIKE '%回收%'`)).n).toBe('2');
  }));
});
