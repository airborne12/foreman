/**
 * API 编排测试运行器（执行 logos/resources/scenario/core-Sxx-*.json；格式见 core-00-format.schema.json）
 * 每个 case 以 test-cases.md 的 ST 编号上报 JSONL。
 */
import { readFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';
import YAML from 'yaml';
import { bootTestApp, http, TEST_TOKEN, TEST_PANEL_TOKEN, type TestApp } from '../helpers/testApp.js';
import { FakeWorker } from '../helpers/fakeWorker.js';
import { writeFakeSsh } from '../helpers/fakeSsh.js';
import { writeFakeBins } from '../helpers/fakeBins.js';
import { resolveFixture, type FixtureCtx } from './fixtures.js';
import { findRepoRoot } from '../../apps/center/src/db.js';
import type { Envelope } from '@foreman/shared';

export interface ScenarioFile { scenario: string; name: string; presets: Record<string, Step[]>; cases: Case[] }
export interface Case { id: string; title: string; covers: string; kind?: string; use?: string[]; setup?: Step[]; steps: Step[]; teardown?: Step[]; timeoutMs?: number; include?: { case: string; throughStep?: string } }
export interface Assertion { path: string; equals?: unknown; notEquals?: unknown; contains?: string; matches?: string; exists?: boolean; gte?: number; lte?: number; length?: number; minLength?: number; in?: unknown[] }
export interface Step { step: string; method?: string; url?: string; headers?: Record<string, string>; auth?: string; body?: unknown; expected_status?: number; action?: string; args?: Record<string, any>; assert?: Assertion[]; extract?: Record<string, string>; timeoutMs?: number; background?: boolean }

const ROOT = findRepoRoot();
const CLI = resolve(ROOT, 'apps/cli/src/index.ts');

export class StepError extends Error { constructor(public step: string, msg: string) { super(`[${step}] ${msg}`); } }

async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}

export class Runner {
  app!: TestApp;
  private sshDir!: string; private binsDir!: string; private sshModeFile!: string; private sshListen = 17801;
  vars: Record<string, unknown> = {};
  private fakeWorkers = new Map<string, FakeWorker>();
  private procs: Array<{ name: string; proc: ChildProcess; out: string }> = [];
  private caseHome!: string;
  private panelEvents: any[] = [];
  private panelWs: WebSocket | null = null;
  private lastCliOutput: { exitCode: number; stdout: string; stderr: string; json?: unknown } | null = null;
  /** 假 agent 脚本引擎记录的 MCP 调用（mcp.expectCall 用） */
  private mcpCalls: Array<{ taskKey: string; tool: string; arguments: Record<string, unknown>; result: any; error: any; sessionId: string; pending?: boolean; handle?: string }> = [];
  /** 假外部命令（gh 等）的调用记录（mock.expect 用） */
  private mockCalls: Array<{ handle: string; kind: string; args: string; ok: boolean }> = [];
  /** 中心下发的 session.start（sessionId → payload），供脚本引擎取 mcp token */
  private sessionStarts = new Map<string, { name: string; payload: any }>();
  private scriptErrors: string[] = [];
  /** 假 agent 脚本的 onResume 挂起点：sessionId → 条件与后续步骤 */
  private resumeHandlers = new Map<string, { cond: any; then: any[] }>();
  /** 最近一次 POST 的消息正文（脚本里的 {{regex:...}} 参数据此解析） */
  private lastPostedText = '';
  /** 最近一次 list_tasks 的返回（{{fromListTasks:N}} 用） */
  private lastListTasks: any[] = [];
  /** 下一步是否显式等待 job.run：是则假 Jira 自动应答让位给 runtime.expectCommand */
  private upcoming: Step | null = null;
  /** 复用其他 case 的驱动序列且本 case 改写了 mock（Jira 单 / agent 脚本）时，被复用步骤里的字面值断言降级为"存在即可" */
  private relaxed = false;

  async boot() {
    this.sshDir = mkdtempSync(resolve(tmpdir(), 'fssh-'));
    this.sshModeFile = resolve(this.sshDir, 'mode');
    writeFileSync(this.sshModeFile, 'forward-local');
    const ssh = writeFakeSsh(this.sshDir);
    this.binsDir = writeFakeBins(mkdtempSync(resolve(tmpdir(), 'fbins-')), { claude: { version: '2.1.260' }, opencode: { version: '0.9.2' }, codex: { fail: true }, 'fake-claude': {}, 'fake-codex': {} });
    process.env.FAKE_SSH_MODE_FILE = this.sshModeFile;
    process.env.FAKE_SSH_LISTEN = String(this.sshListen);
    const port = await freePort();
    this.app = await bootTestApp({ listen: `127.0.0.1:${port}`, ssh_bin: ssh, tunnels: { dev: { ssh: 'jiangkai@10.26.20.3', remote_port: 7801, local_port: port } } });
  }
  async shutdown() { await this.cleanupCase(); await this.app.close(); }

  private cliEnv(extra?: Record<string, string>): Record<string, string> {
    return {
      ...process.env as Record<string, string>,
      FOREMAN_HOME: this.caseHome,
      FOREMAN_PANEL_TOKEN: TEST_PANEL_TOKEN,
      FOREMAN_TOKEN: TEST_TOKEN,
      FOREMAN_CENTER_URL: this.app.url,
      FOREMAN_WORKER_STATE: resolve(this.caseHome, 'worker-state.json'),
      FOREMAN_BACKOFF_SCALE: '0.01',
      PATH: `${this.binsDir}:${process.env.PATH}`,
      ...extra,
    };
  }

  async runCase(file: ScenarioFile, c: Case, allCases: Map<string, Case>) {
    await this.cleanupCase();
    this.vars = { now: () => this.app.clock.now().toISOString() };
    this.caseHome = mkdtempSync(resolve(tmpdir(), 'fh-'));
    await http(this.app, 'POST', '/__test/reset');
    writeFileSync(this.sshModeFile, 'forward-local');
    await this.connectPanel();
    if (c.include) {
      const inc = allCases.get(c.include.case); if (!inc) throw new Error(`include ${c.include.case} 不存在`);
      const ov = (c.setup ?? []).some((x) => x.action === 'mock.set' && x.args?.script);
      await this.runSteps(file, inc, allCases, { throughStep: c.include.throughStep, skipSetup: !!c.use?.length, skipScriptExpect: ov, relax: (c.setup ?? []).some((x) => x.action === 'mock.set' && (x.args?.issues || x.args?.script)) });
    }
    for (const p of c.use ?? []) { const steps = file.presets[p]; if (!steps) throw new Error(`preset ${p} 不存在`); await this.runList(steps, (s) => this.execStep(s)); }
    await this.runList(c.setup ?? [], (s) => this.execStepOrInclude(file, c, s, allCases));
    await this.runList(c.steps, (s) => this.execStepOrInclude(file, c, s, allCases));
    await this.runList(c.teardown ?? [], (s) => this.execStep(s));
  }

  /** 顺序执行并维护 upcoming（下一步）指针 */
  private async runList(steps: Step[], fn: (s: Step) => Promise<void>, stop?: (s: Step, i: number) => boolean) {
    const groupOf = (s: Step) => (s.args?.parallelGroup as string | undefined) ?? s.headers?.['X-Parallel-Group'] ?? null;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      if (stop?.(s, i)) break;
      this.upcoming = steps[i + 1] ?? null;
      // 同一 parallelGroup 的连续步骤并发执行（S06 EX-18.1 两通道竞争）
      const g = groupOf(s);
      if (g) {
        const batch = [s]; while (i + 1 < steps.length && groupOf(steps[i + 1]!) === g) { i += 1; batch.push(steps[i]!); }
        this.upcoming = steps[i + 1] ?? null;
        await Promise.all(batch.map((b) => fn(b)));
        continue;
      }
      await fn(s);
    }
  }
  private explicitJobRunAhead() { return this.upcoming?.action === 'runtime.expectCommand' && this.upcoming.args?.type === 'job.run'; }

  /**
   * note 里写「include ST-Sxx-nn Step a–b」/「复用 ST-Sxx-nn 的 Step a–b」等价于 include 字段（文档约定）。
   * 被引用 case 的 presets/setup 在引用方自带 use 时跳过（引用方已按自己的 mock 设置好环境）；
   * 「至 <字段> <值>」表示执行到第一个断言 <字段> equals <值> 的步骤为止。
   */
  private async execStepOrInclude(file: ScenarioFile, owner: Case, s: Step, allCases: Map<string, Case>) {
    const text = s.action === 'note' ? String(s.args?.text ?? '') : '';
    const m = text && /include|复用/.test(text) ? text.match(/(ST-S\d{2}-\d{2,3})/) : null;
    if (!m) return this.execStep(s);
    const inc = allCases.get(m[1]!); if (!inc) throw new StepError(s.step, `include ${m[1]} 不存在`);
    const range = text.match(/Step\s*(\d+)\s*[–-]\s*(\d+)/);
    const until = text.match(/至\s*([\w.]+)\s+(\w+)/);
    const overridesScript = (owner.setup ?? []).some((x) => x.action === 'mock.set' && x.args?.script);
    const overridesData = (owner.setup ?? []).some((x) => x.action === 'mock.set' && (x.args?.issues || x.args?.script));
    await this.runSteps(file, inc, allCases, { throughStep: range ? `#${range[2]}` : undefined, untilAssert: until ? { field: until[1]!.split('.').pop()!, value: until[2]! } : undefined, skipSetup: !!owner.use?.length, skipScriptExpect: overridesScript, relax: overridesData });
  }

  private async runSteps(file: ScenarioFile, c: Case, allCases: Map<string, Case>, opt: { throughStep?: string; untilAssert?: { field: string; value: string }; skipSetup?: boolean; skipScriptExpect?: boolean; relax?: boolean }) {
    const prevRelaxed = this.relaxed; if (opt.relax) this.relaxed = true;
    try { await this.runStepsInner(file, c, allCases, opt); } finally { this.relaxed = prevRelaxed; }
  }
  private async runStepsInner(file: ScenarioFile, c: Case, allCases: Map<string, Case>, opt: { throughStep?: string; untilAssert?: { field: string; value: string }; skipSetup?: boolean; skipScriptExpect?: boolean; relax?: boolean }) {
    if (!opt.skipSetup) {
      for (const p of c.use ?? []) await this.runList(file.presets[p] ?? [], (s) => this.execStep(s));
      await this.runList(c.setup ?? [], (s) => this.execStepOrInclude(file, c, s, allCases));
    }
    const endNo = opt.throughStep?.startsWith('#') ? Number(opt.throughStep.slice(1)) : null;
    let done = false;
    await this.runList(c.steps, async (s) => {
      // 引用方改写了 agent 脚本时，被引用 case 里对脚本调用的期待不再成立，跳过
      if (opt.skipScriptExpect && s.action === 'mcp.expectCall') return;
      await this.execStepOrInclude(file, c, s, allCases);
      if (opt.throughStep && !endNo && s.step === opt.throughStep) done = true;
      if (opt.untilAssert) { const hit = [...(s.assert ?? []), ...((s.args?.assert as Assertion[] | undefined) ?? [])].some((a) => a.path.endsWith(opt.untilAssert!.field) && String(a.equals) === opt.untilAssert!.value); if (hit) done = true; }
    }, (s) => {
      if (done) return true;
      if (endNo) { const nums = (s.step.match(/\d+/g) ?? []).map(Number); const lo = nums[0] ?? -1; if (lo > endNo) return true; }
      return false;
    });
  }

  private async cleanupCase() {
    for (const w of this.fakeWorkers.values()) w.close();
    this.fakeWorkers.clear();
    for (const p of this.procs) { try { p.proc.kill('SIGTERM'); } catch { /* ignore */ } }
    this.procs = [];
    this.panelWs?.close(); this.panelWs = null; this.panelEvents = [];
    this.mcpCalls = []; this.mockCalls = []; this.sessionStarts.clear(); this.scriptErrors = [];
    this.resumeHandlers.clear(); this.lastPostedText = ''; this.lastListTasks = [];
    if (this.app) { try { await this.app.tunnels.resetForTest(); } catch { /* ignore */ } }
    await new Promise((r) => setTimeout(r, 50));
  }

  private async connectPanel() {
    await new Promise<void>((res, rej) => {
      const ws = new WebSocket(`${this.app.ws}/ws/panel?token=${TEST_PANEL_TOKEN}`);
      ws.on('open', () => res()); ws.on('error', rej);
      ws.on('message', (d) => { try { this.panelEvents.push(JSON.parse(String(d))); } catch { /* ignore */ } });
      this.panelWs = ws;
    });
  }

  // ---------------- 变量与断言 ----------------
  async interpolate(v: unknown): Promise<unknown> {
    if (typeof v === 'string') {
      const whole = v.match(/^\{\{(.+)\}\}$/s);
      if (whole) return this.resolveExpr(whole[1]!.trim());
      const parts: Array<string | Promise<unknown>> = [];
      let out = ''; let idx = 0; const re = /\{\{(.+?)\}\}/g; let m: RegExpExecArray | null;
      while ((m = re.exec(v))) { out += v.slice(idx, m.index); const r = await this.resolveExpr(m[1]!.trim()); out += typeof r === 'string' ? r : JSON.stringify(r); idx = m.index + m[0].length; }
      void parts; out += v.slice(idx);
      return out;
    }
    if (Array.isArray(v)) return Promise.all(v.map((x) => this.interpolate(x)));
    if (v && typeof v === 'object') { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) o[k] = await this.interpolate(x); return o; }
    return v;
  }

  private async resolveExpr(expr: string): Promise<unknown> {
    if (expr.startsWith('env.')) {
      const k = expr.slice(4);
      if (k === 'CENTER_URL') return this.app.url;
      if (k === 'CENTER_WS') return this.app.ws;
      if (k === 'FOREMAN_HOME') return this.caseHome;
      if (k === 'FOREMAN_TOKEN') return TEST_TOKEN;
      if (k === 'FOREMAN_PANEL_TOKEN') return TEST_PANEL_TOKEN;
      return process.env[k] ?? '';
    }
    if (expr.startsWith('fixture:')) { const ctx: FixtureCtx = { db: this.app.db, now: () => this.app.clock.now(), vars: this.vars, env: { CENTER_WS: this.app.ws, FOREMAN_TOKEN: TEST_TOKEN } }; return resolveFixture(expr.slice(8), ctx); }
    const nowm = expr.match(/^now(?:([+-])(\d+)([smhd]))?$/);
    if (nowm) { let t = this.app.clock.now().getTime(); if (nowm[1]) { const n = Number(nowm[2]); const mult = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[nowm[3]!]!; t += (nowm[1] === '+' ? 1 : -1) * n * mult; } return new Date(t).toISOString(); }
    if (expr.startsWith('mock.')) { const m = expr.match(/^mock\.(\w+)\.?(.*)$/)!; const base = this.vars[`mock.${m[1]}`]; return m[2] ? getPath(base, m[2]) : base; }
    if (expr.startsWith('db:')) { const m = expr.match(/^db:(\w+)\.(\w+) where (.+)$/); if (m) { const r = await this.app.db.one<any>(`SELECT ${m[2]} FROM ${m[1]} WHERE ${await this.interpolate(m[3]!)}`); return r?.[m[2]!]; } }
    if (expr.startsWith('regex:')) return { __regex: expr.slice(6) };
    if (expr.startsWith('fromListTasks:')) return { __fromListTasks: Number(expr.slice(14)) };
    if (expr === 'resumeText' && this.vars.resumeText === undefined) return { __resumeText: true };
    const v = getPath(this.vars, expr);
    if (v === undefined) throw new Error(`变量未定义：${expr}`);
    return typeof v === 'function' ? (v as () => unknown)() : v;
  }

  private check(step: string, asserts: Assertion[] | undefined, data: unknown) {
    for (const a of asserts ?? []) {
      if (a.path === '$none' || a.path === '$statusIn') continue;
      const val = getPath(data, a.path);
      const fail = (msg: string) => { throw new StepError(step, `断言失败 ${a.path}: ${msg}；实际=${JSON.stringify(val)?.slice(0, 300)}`); };
      // 复用驱动序列时字面值可能与本 case 的 mock 不同（如 Jira 单号），只要求字段存在
      const soft = (msg: string) => { if (this.relaxed && val !== undefined && val !== null) return; fail(msg); };
      if ('equals' in a && !deepEq(val, a.equals)) soft(`期望 equals ${JSON.stringify(a.equals)}`);
      if ('notEquals' in a && deepEq(val, a.notEquals)) fail(`期望 notEquals ${JSON.stringify(a.notEquals)}`);
      if (a.contains !== undefined) { const ok = Array.isArray(val) ? val.some((x) => typeof x === 'string' ? x.includes(a.contains!) : deepEq(x, a.contains)) : typeof val === 'string' ? val.includes(a.contains) : false; if (!ok) soft(`期望 contains ${a.contains}`); }
      if (a.matches !== undefined) { const re = new RegExp(a.matches); const ok = Array.isArray(val) ? val.some((x) => re.test(String(x))) : re.test(String(val)); if (!ok) soft(`期望 matches ${a.matches}`); }
      if (a.exists !== undefined && ((val !== undefined && val !== null) !== a.exists)) fail(`期望 exists=${a.exists}`);
      if (a.gte !== undefined && !(Number(val) >= a.gte)) fail(`期望 >= ${a.gte}`);
      if (a.lte !== undefined && !(Number(val) <= a.lte)) fail(`期望 <= ${a.lte}`);
      if (a.length !== undefined && !(a.length === 0 && val === undefined) && (!Array.isArray(val) && typeof val !== 'string' || (val as any).length !== a.length)) fail(`期望 length ${a.length}`);
      if (a.minLength !== undefined && (!Array.isArray(val) && typeof val !== 'string' || (val as any).length < a.minLength)) fail(`期望 minLength ${a.minLength}`);
      if (a.in !== undefined && !a.in.some((x) => deepEq(x, val))) fail(`期望 in ${JSON.stringify(a.in)}`);
    }
  }

  private extract(extract: Record<string, string> | undefined, data: unknown) {
    for (const [k, p] of Object.entries(extract ?? {})) { this.vars[k] = getPath(data, p); }
  }

  // ---------------- 步骤执行 ----------------
  async execStep(raw: Step) {
    // runner.repeat 的子步骤每轮单独插值，这里保持原样
    const rawSteps = raw.action === 'mock.set' && raw.args?.handle === 'runner' ? raw.args.steps : undefined;
    const s = (await this.interpolate({ ...raw, args: rawSteps ? { ...raw.args, steps: undefined } : raw.args, assert: raw.assert, extract: raw.extract })) as Step;
    if (rawSteps) s.args = { ...(s.args ?? {}), steps: rawSteps };
    s.assert = raw.assert ? await Promise.all(raw.assert.map(async (a) => ({ ...a, path: String(await this.interpolate(a.path)), equals: 'equals' in a ? await this.interpolate(a.equals) : undefined, notEquals: 'notEquals' in a ? await this.interpolate(a.notEquals) : undefined }))) as Assertion[] : undefined;
    if (s.assert) s.assert.forEach((a, i) => { const orig = raw.assert![i]!; if (!('equals' in orig)) delete (a as any).equals; if (!('notEquals' in orig)) delete (a as any).notEquals; });
    s.extract = raw.extract ? Object.fromEntries(await Promise.all(Object.entries(raw.extract).map(async ([k, v]) => [k, String(await this.interpolate(v))]))) : undefined;
    (s as any).__fixtureRows = typeof raw.args?.rows === 'string' && raw.args.rows.startsWith('{{fixture:');
    if (s.method) return this.httpStep(s);
    if (s.action) return this.controlStep(s);
    throw new StepError(s.step, '既无 method 也无 action');
  }

  private async httpStep(s: Step) {
    const token = s.auth === 'worker' ? TEST_TOKEN : s.auth === 'none' ? null : TEST_PANEL_TOKEN;
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(s.headers ?? {}) };
    const r = await fetch(this.app.url + s.url!, { method: s.method!, headers, body: s.body === undefined ? undefined : JSON.stringify(s.body) });
    const text = await r.text(); let body: unknown = text; try { body = JSON.parse(text); } catch { /* text */ }
    const data = { status: r.status, body, headers: Object.fromEntries(r.headers.entries()) };
    const statusIn = s.assert?.find((a) => a.path === '$statusIn')?.in;
    if (statusIn ? !statusIn.includes(r.status) : r.status !== s.expected_status) throw new StepError(s.step, `期望状态 ${statusIn ?? s.expected_status}，实际 ${r.status}：${text.slice(0, 300)}`);
    this.check(s.step, s.assert, data);
    this.extract(s.extract, data);
    if (s.method === 'POST' && /\/messages$/.test(s.url ?? '') && (s.body as any)?.text) this.lastPostedText = String((s.body as any).text);
  }

  private worker(name: string): FakeWorker { const w = this.fakeWorkers.get(name); if (!w) throw new Error(`fake worker ${name} 未注册`); return w; }

  private async controlStep(s: Step) {
    const a = s.args ?? {};
    const timeout = s.timeoutMs ?? 10_000;
    switch (s.action) {
      case 'note': return;
      case 'clock.freeze': await http(this.app, 'POST', '/__test/clock/freeze', { at: a.at }); return;
      case 'clock.advance': {
        // 有真实 worker 子进程或进程内假 worker 时按 30s 分段推进：真实 worker 靠自身心跳；假 worker 每段补一次心跳，避免被判离线
        let ms = (a.seconds ?? 0) * 1000 + (a.minutes ?? 0) * 60_000;
        // 假 agent 脚本有在途 MCP 调用（如 request_approval 正在注册 30 分钟超时）时，先让其把定时器登记到假时钟
        if (this.mcpCalls.some((c) => c.pending)) await new Promise((r) => setTimeout(r, 400));
        const keepAlive = this.procs.length > 0 || this.fakeWorkers.size > 0;
        if (a.toNextHour || !keepAlive || ms <= 30_000) { await http(this.app, 'POST', '/__test/clock/advance', a); return; }
        const before = this.app.clock.now().getTime(); const total = ms;
        // 最多 40 段：短跳每段 30 秒（runtime 不会被判离线），长跳按比例放大后靠心跳把 runtime 拉回在线
        const chunk = Math.max(30_000, Math.ceil(ms / 40));
        while (ms > 0) {
          const step = Math.min(ms, chunk); const r = await http(this.app, 'POST', '/__test/clock/advance', { seconds: step / 1000 }); ms -= step;
          if (r.status !== 200) throw new StepError(s.step, `clock.advance 失败：${JSON.stringify(r.body).slice(0, 300)}`);
          if (this.fakeWorkers.size) await this.fakeHeartbeats(); else await new Promise((r) => setTimeout(r, 400));
        }
        if (this.app.clock.now().getTime() - before !== total) throw new StepError(s.step, `clock.advance 实际推进 ${this.app.clock.now().getTime() - before}ms ≠ ${total}ms`);
        return;
      }
      case 'scheduler.tick': {
        // worktree-gc 要等 worker 回 gc.result 才结束，后续步骤才会回包 → 不阻塞
        if (a.job === 'worktree-gc' && !s.assert?.length) { void http(this.app, 'POST', '/__test/scheduler/tick', { job: a.job }); await new Promise((res) => setTimeout(res, 200)); return; }
        const r = await http(this.app, 'POST', '/__test/scheduler/tick', { job: a.job }); this.check(s.step, s.assert, r.body);
        // 下一步不显式等待 job.run 时，给假 Jira 自动应答器留出回包时间
        if (a.job === 'jira-poll' && this.vars['mock.jira'] && !this.explicitJobRunAhead()) await new Promise((res) => setTimeout(res, 600));
        return;
      }
      case 'runtime.register': {
        // 同名重复注册（include 复用 preset）：先关旧连接，避免 RUNTIME_NAME_CONFLICT；显式期待冲突时保留旧连接
        if (!a.expectError && this.fakeWorkers.has(a.name)) { this.fakeWorkers.get(a.name)!.close(); this.fakeWorkers.delete(a.name); await new Promise((r) => setTimeout(r, 150)); }
        const w = new FakeWorker(this.app.ws, TEST_TOKEN); await w.connect();
        this.attachAutoResponders(a.name, w);
        const reply = await w.register({ name: a.name, ...(a.instanceId ? { instanceId: a.instanceId } : {}), transport: a.transport ?? 'direct', labels: a.labels ?? [], agents: a.agents ?? {}, repos: a.repos ?? {}, capabilities: a.capabilities ?? [], version: a.version ?? '0.1.0' });
        const data = reply.type === 'register.ack' ? { ack: reply.payload, error: null } : { ack: null, error: reply.payload };
        if (a.expectError) { if (data.error?.code !== a.expectError) throw new StepError(s.step, `期望错误 ${a.expectError}，实际 ${JSON.stringify(reply.payload)}`); w.close(); return; }
        if (!data.ack) throw new StepError(s.step, `注册失败：${JSON.stringify(reply.payload)}`);
        this.fakeWorkers.get(a.name)?.close(); this.fakeWorkers.set(a.name, w);
        w.injectReceived(((data.ack as any).pendingCommands ?? []) as Envelope[]);
        await new Promise((r) => setTimeout(r, 200));
        this.check(s.step, s.assert, data); this.extract(s.extract, data); return;
      }
      case 'runtime.heartbeat': {
        // 等待中心落库：轮询 last_seen_at 直到等于当前假时钟
        this.worker(a.name).send('heartbeat', { load: a.load ?? null, disk: a.disk, sessions: a.sessions ?? {} });
        const want = this.app.clock.now().toISOString();
        for (let i = 0; i < 40; i++) {
          const r = await this.app.db.one<any>('SELECT last_seen_at, disk_used_ratio FROM runtimes WHERE name=$1', [a.name]);
          if (r && new Date(r.last_seen_at).toISOString() === want && (a.disk?.usedRatio == null || Math.abs(Number(r.disk_used_ratio) - a.disk.usedRatio) < 1e-6)) break;
          await new Promise((res) => setTimeout(res, 50));
        }
        return;
      }
      case 'runtime.disconnect': { this.worker(a.name).close(); this.fakeWorkers.delete(a.name); await new Promise((r) => setTimeout(r, 100)); return; }
      case 'runtime.expectCommand': {
        const w = this.worker(a.name);
        const pred = (e: Envelope) => e.type === a.type && Object.entries(a.match ?? {}).every(([k, v]) => deepEq(getPath(e, k), v));
        if (s.assert?.some((x) => x.path === '$none')) {
          try { await w.expect(pred, timeout); } catch { return; }
          throw new StepError(s.step, `不应收到 ${a.type}`);
        }
        if (a.background && a.replyWith) { void w.expect(pred, timeout).then(async (env) => { const rw = await this.interpolate(a.replyWith) as any; w.send(rw.type, rw.payload, env.id); }); return; }
        const env = await w.expect(pred, timeout).catch((e) => { throw new StepError(s.step, String(e.message)); });
        this.check(s.step, s.assert, env); this.extract(s.extract, env); return;
      }
      case 'runtime.reply': {
        this.worker(a.name).send(a.type, a.payload ?? {}, a.ref ?? null);
        await new Promise((r) => setTimeout(r, 200));
        // 会话已启动 → 按 mock.<agent>.script 启动假 agent 脚本（通过 MCP 调工具）
        if (a.type === 'session.started' && a.payload?.sessionId) void this.runAgentScript(String(a.payload.sessionId));
        return;
      }
      case 'mock.set': return this.mockSet(s, a);
      case 'mock.expect': return this.mockExpect(s, a, timeout);
      case 'mock.emit': {
        if (a.handle === 'lark') { const r = await http(this.app, 'POST', '/__test/lark/emit', { event: a.event }); this.check(s.step, s.assert, r.body); await new Promise((res) => setTimeout(res, 200)); return; }
        throw new StepError(s.step, `mock.emit ${a.handle} 未实现`);
      }
      case 'ws.connect': if (!this.panelWs) await this.connectPanel(); return;
      case 'ws.expect': {
        const pred = (e: any) => e.type === a.type && Object.entries(a.match ?? {}).every(([k, v]) => matchLoose(getPath(e, k), v));
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) { const hit = this.panelEvents.find(pred); if (hit) { this.check(s.step, s.assert, hit); this.extract(s.extract, hit); return; } await new Promise((r) => setTimeout(r, 100)); }
        throw new StepError(s.step, `未收到面板事件 ${a.type} ${JSON.stringify(a.match ?? {})}`);
      }
      case 'db.assert': { const r = await this.app.db.query(a.sql); const data = { rows: r.rows.map(normalizeRow) }; this.check(s.step, s.assert, data); this.extract(s.extract, data); return; }
      case 'db.seed': {
        if (!(s as any).__fixtureRows && Array.isArray(a.rows)) {
          for (const row of a.rows) {
            const cols = Object.keys(row);
            if (a.table === 'trust_counters') { await this.app.db.query(`UPDATE trust_counters SET mode=COALESCE($2, mode), streak=COALESCE($3, streak) WHERE action_type=$1`, [row.action_type, row.mode ?? null, row.streak ?? null]); continue; }
            await this.app.db.query(`INSERT INTO ${a.table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`, cols.map((c) => (row as any)[c]));
          }
        }
        return; // fixture 型 rows 已在插值时写库
      }
      case 'wait.until': {
        const deadline = Date.now() + (a.timeoutMs ?? s.timeoutMs ?? 15_000);
        let last: unknown = null; let lastErr = '';
        while (Date.now() < deadline) {
          const r = await fetch(this.app.url + a.http.url, { method: a.http.method, headers: { authorization: `Bearer ${TEST_PANEL_TOKEN}`, 'content-type': 'application/json' }, body: a.http.body ? JSON.stringify(a.http.body) : undefined });
          const text = await r.text(); let body: unknown = text; try { body = JSON.parse(text); } catch { /* */ }
          last = { status: r.status, body };
          try { this.check(s.step, a.assert, last); this.extract(s.extract, last); return; } catch (e) { lastErr = String((e as Error).message); }
          await new Promise((r) => setTimeout(r, 200));
        }
        const procOut = this.procs.map((p) => `--- ${p.name} ---\n${p.out.slice(-600)}`).join('\n');
        throw new StepError(s.step, `wait.until 超时：${lastErr}${procOut ? `\n${procOut}` : ''}`);
      }
      case 'mcp.call': {
        // token：fixture 会话（vars.__token.<sessionId>）或中心下发的 session.start
        const fixtureToken = a.sessionId ? (this.vars[`__token.${a.sessionId}`] as string | undefined) : undefined;
        const st = [...this.sessionStarts.values()].reverse().find((x) => x.payload.taskKey === a.taskKey && (!a.sessionId || x.payload.sessionId === a.sessionId));
        const token = fixtureToken ?? st?.payload.mcp?.token;
        if (!token) throw new StepError(s.step, `任务 ${a.taskKey} 没有可用的 MCP token（无 fixture 会话也无 session.start）`);
        const rec = { taskKey: String(a.taskKey), tool: String(a.tool), arguments: a.arguments ?? {}, result: undefined as any, error: null as any, sessionId: String(a.sessionId ?? st?.payload.sessionId ?? ''), pending: true, handle: a.handle as string | undefined };
        this.mcpCalls.push(rec);
        const p = this.mcpCall(token, a.tool, { taskKey: a.taskKey, ...(a.arguments ?? {}) }).then((r) => { rec.result = r.result?.structuredContent ?? null; rec.error = r.error ?? null; rec.pending = false; return r; });
        if (a.background) { void p; await new Promise((res) => setTimeout(res, 300)); return; }
        const r = await p;
        const data = { result: r.result?.structuredContent ?? null, error: r.error ?? null, raw: r };
        this.check(s.step, s.assert, data); this.extract(s.extract, data); return;
      }
      case 'mcp.expectCall': {
        const want = Number(a.count ?? 1);
        const deadline = Date.now() + timeout;
        const matches = () => this.mcpCalls.filter((c) => !c.pending
          && (a.handle ? c.handle === a.handle : a.sessionId ? c.sessionId === a.sessionId && (!a.tool || c.tool === a.tool) : c.taskKey === a.taskKey && c.tool === a.tool)
          && (a.result === undefined || subsetEq(a.result, c.result) || subsetEq(a.result, { error: c.error?.message ?? c.error })));
        while (Date.now() < deadline) {
          const hit = matches();
          if (hit.length >= want) { const last = hit[hit.length - 1]!; this.check(s.step, s.assert, { result: last.result, arguments: last.arguments }); this.extract(s.extract, { result: last.result, arguments: last.arguments }); return; }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new StepError(s.step, `未等到 MCP 调用 ${a.tool ?? a.handle}(${a.taskKey ?? ''}) ×${want}${a.result ? ` result⊇${JSON.stringify(a.result)}` : ''}${this.scriptErrors.length ? `；脚本错误：${this.scriptErrors.join(' | ')}` : ''}；已记录：${JSON.stringify(this.mcpCalls.map((c) => ({ tool: c.tool, taskKey: c.taskKey, pending: c.pending, result: c.tool === 'get_task' ? '…' : c.result, error: c.error }))).slice(0, 800)}`);
      }
      default: throw new StepError(s.step, `未知动作 ${s.action}`);
    }
  }

  /** 推进假时钟后给每个假 worker 补一次心跳并等待落库 */
  private async fakeHeartbeats() {
    const want = this.app.clock.now().toISOString();
    for (const [name, w] of this.fakeWorkers) {
      try { w.send('heartbeat', { load: null, sessions: {} }); } catch { continue; }
      for (let i = 0; i < 30; i++) {
        const r = await this.app.db.one<any>('SELECT last_seen_at FROM runtimes WHERE name=$1', [name]);
        if (r && new Date(r.last_seen_at).toISOString() === want) break;
        await new Promise((res) => setTimeout(res, 20));
      }
    }
  }

  /**
   * 假 worker 自动应答：
   * - job.run（jira-*）：按 mock.jira 回 job.result（延迟 300ms，若期间被 runtime.expectCommand 显式消费则不应答）
   * - session.start：记录 payload（mcp token），供脚本引擎
   */
  private attachAutoResponders(name: string, w: FakeWorker) {
    w.onAny((env) => {
      if (env.type === 'session.start') { this.sessionStarts.set(String(env.payload.sessionId), { name, payload: env.payload }); return; }
      if (env.type === 'session.resume') {
        const h = this.resumeHandlers.get(String(env.payload.sessionId));
        if (h) {
          const text = String(env.payload.text ?? '');
          const ok = h.cond?.any === true || (h.cond?.contains ? text.includes(String(h.cond.contains)) : true);
          if (ok) { this.resumeHandlers.delete(String(env.payload.sessionId)); this.vars.resumeText = text; void this.runScriptSteps(String(env.payload.sessionId), h.then); }
        }
        // 假 claude 记录续接参数：--bg --resume <agentSessionId> "<text>"（S07 Step 40）
        void this.app.db.one<any>('SELECT agent, agent_session_id FROM sessions WHERE id=$1', [env.payload.sessionId]).then((s) => {
          this.mockCalls.push({ handle: s?.agent ?? 'claude', kind: 'exec', args: `--bg --resume ${s?.agent_session_id ?? ''} "${String(env.payload.text ?? '')}"`, ok: true });
        }).catch(() => undefined);
        return;
      }
      if (env.type !== 'job.run') return;
      const kind = String(env.payload.kind ?? '');
      if (!kind.startsWith('jira')) return;
      // 用例下一步会显式 runtime.expectCommand job.run（并自行 runtime.reply）：让位，不自动应答
      if (kind === 'jira-poll' && this.explicitJobRunAhead()) return;
      setTimeout(() => {
        if (!w.stillPending(env)) return;
        w.consume(env);
        const jira = (this.vars['mock.jira'] as Record<string, any> | undefined) ?? {};
        const args = (env.payload.args ?? {}) as Record<string, any>;
        let payload: Record<string, unknown>;
        if (kind === 'jira-poll') payload = jira.failWith ? { ok: false, error: { code: 'SOURCE_UNREACHABLE', message: String(jira.failWith) } } : { ok: true, result: { issues: jira.issues ?? [], fetchedAt: this.app.clock.now().toISOString() } };
        else if (kind === 'jira-lookup') { const issue = (jira.issues ?? []).find((i: any) => i.key === args.key); payload = jira.failWith ? { ok: false, error: { code: 'SOURCE_UNREACHABLE', message: String(jira.failWith) } } : issue ? { ok: true, result: issue } : { ok: false, error: { code: 'NOT_FOUND', message: `${args.key} 不存在` } }; }
        else {
          let fail: unknown = jira.commentFailWith;
          if (Number(jira.commentFailTimes ?? 0) > 0) { jira.commentFailTimes = Number(jira.commentFailTimes) - 1; fail = 500; }
          payload = fail ? { ok: false, error: { code: 'SOURCE_UNREACHABLE', message: `Jira ${fail}` } } : { ok: true, result: { commentId: `c-${Date.now()}` } };
          this.mockCalls.push({ handle: 'jira', kind: 'comment', args: JSON.stringify(args), ok: !fail });
        }
        try { w.send('job.result', payload, env.id); } catch { /* worker closed */ }
      }, 300);
    });
  }

  /** 假 agent 脚本引擎：按 mock.<agent>.script 顺序执行 tool / exec / exit / sleep / onResume，记录到 mcpCalls */
  private async runAgentScript(sessionId: string) {
    const st = this.sessionStarts.get(sessionId);
    if (!st) return;
    const agent = String(st.payload.agent);
    const script = ((this.vars[`mock.${agent}`] as Record<string, any> | undefined)?.script as any[] | undefined) ?? [];
    await this.runScriptSteps(sessionId, script);
  }

  private async runScriptSteps(sessionId: string, steps0: any[]): Promise<void> {
    const st = this.sessionStarts.get(sessionId);
    if (!st) return;
    const agent = String(st.payload.agent);
    const taskKey = st.payload.taskKey ? String(st.payload.taskKey) : null;
    const token = st.payload.mcp?.token as string;
    const run = async (steps: any[]): Promise<void> => {
      for (const step of steps) {
        if (step.exit !== undefined || step.sleepForever) return;
        if (step.onResume) { this.resumeHandlers.set(sessionId, { cond: step.onResume, then: step.then ?? [] }); return; }
        if (step.sleepSeconds) {
          // 按假时钟等待（编排里用 clock.advance 推进）
          const until = this.app.clock.now().getTime() + Number(step.sleepSeconds) * 1000;
          for (let i = 0; i < 600 && this.app.clock.now().getTime() < until; i++) await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        if (step.exec) {
          const cmd = String(step.exec);
          const gh = (this.vars['mock.gh'] as Record<string, any> | undefined) ?? {};
          const isPr = /^gh pr create/.test(cmd);
          const ok = isPr ? !gh.prCreate?.fail : true;
          this.mockCalls.push({ handle: 'gh', kind: isPr ? 'pr create' : cmd.split(' ').slice(1, 3).join(' '), args: cmd, ok });
          if (!ok && !step.expectFail) { this.scriptErrors.push(`${agent}: ${cmd} 失败：${gh.prCreate?.stderr ?? ''}`); return; }
          continue;
        }
        if (!step.tool) continue;
        const args = this.resolveScriptArgs(step.arguments ?? {});
        const rec = { taskKey: taskKey ?? '', tool: step.tool, arguments: args, result: undefined as any, error: null as any, sessionId, pending: true };
        this.mcpCalls.push(rec);
        const r = await this.mcpCall(token, step.tool, { ...(taskKey ? { taskKey } : {}), ...args });
        const result = r.result?.structuredContent ?? null;
        rec.result = result; rec.error = r.error ?? null; rec.pending = false;
        if (step.tool === 'list_tasks' && result?.items) this.lastListTasks = result.items as any[];
        // expect 里显式等待错误（如 SOURCE_UNAVAILABLE）时不算脚本失败
        const expectsError = step.expect && 'error' in step.expect;
        if (r.error && !expectsError) { this.scriptErrors.push(`${agent}: ${step.tool} → ${JSON.stringify(r.error).slice(0, 200)}`); return; }
        if (step.tool === 'request_approval' && result?.reason === 'timeout' && step.onTimeout) return run(step.onTimeout);
        if (step.expect && !expectMatch(step.expect, expectsError ? { error: String(r.error?.message ?? '') } : result)) { this.scriptErrors.push(`${agent}: ${step.tool} 期望 ${JSON.stringify(step.expect)}，实际 ${JSON.stringify(result ?? r.error).slice(0, 200)}`); return; }
      }
    };
    try { await run(steps0); } catch (e) { this.scriptErrors.push(`${agent}: ${String((e as Error).message)}`); }
  }

  /** 脚本参数里的标记：{{regex:…}} 取触发文本中的第一个匹配；{{fromListTasks:N}} 取上次 list_tasks 结果；{{resumeText}} 取续接文本 */
  private resolveScriptArgs(args: Record<string, any>): Record<string, any> {
    const walk = (v: any): any => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        if (typeof v.__regex === 'string') { const m = this.lastPostedText.match(new RegExp(v.__regex)); return m ? m[0] : v.__regex; }
        if (typeof v.__fromListTasks === 'number') return this.lastListTasks.slice(0, v.__fromListTasks).map((t: any) => ({ label: `${t.key} ${t.title}`, value: t.key }));
        if (v.__resumeText === true) return String(this.vars.resumeText ?? '');
        const o: Record<string, any> = {}; for (const [k, x] of Object.entries(v)) o[k] = walk(x); return o;
      }
      return v;
    };
    return walk(args);
  }

  private async mcpCall(token: string, tool: string, args: Record<string, unknown>): Promise<any> {
    const r = await fetch(this.app.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name: tool, arguments: args } }) });
    const text = await r.text(); try { return JSON.parse(text); } catch { return { error: { code: r.status, message: text } }; }
  }

  private async mockSet(s: Step, a: Record<string, any>) {
    switch (a.handle) {
      case 'cli': {
        if (a.exec) {
          const [bin, ...args] = a.exec as string[];
          const argv = bin === 'foreman' ? ['--import', 'tsx', CLI, ...args] : [bin, ...args];
          // 异步执行：center 与运行器同进程，同步 exec 会阻塞事件循环
          const { out, err, code } = await new Promise<{ out: string; err: string; code: number }>((res) => {
            execFile(process.execPath, argv, { env: this.cliEnv(), encoding: 'utf8', cwd: ROOT, timeout: 60_000 }, (e, stdout, stderr) => res({ out: String(stdout ?? ''), err: String(stderr ?? ''), code: e ? Number((e as any).code ?? 1) : 0 }));
          });
          let json: unknown; try { json = JSON.parse(out); } catch { json = undefined; }
          const data = { exitCode: code, stdout: out + err, stderr: err, json };
          this.lastCliOutput = data;
          try { this.check(s.step, s.assert, data); } catch (e) { throw new StepError(s.step, `${(e as Error).message}\n--- cli output ---\n${(out + err).slice(0, 800)}`); }
          this.extract(s.extract, data); return;
        }
        if (a.spawn) {
          const [bin, ...args] = a.spawn as string[];
          const argv = bin === 'foreman' ? ['--import', 'tsx', CLI, ...args] : [bin, ...args];
          const proc = spawn(process.execPath, argv, { env: this.cliEnv(), cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
          const rec = { name: 'cli', proc, out: '' };
          proc.stdout.on('data', (d) => (rec.out += String(d))); proc.stderr.on('data', (d) => (rec.out += String(d)));
          this.procs.push(rec);
          if (a.captureSeconds) await new Promise((r) => setTimeout(r, Number(a.captureSeconds) * 1000));
          return;
        }
        if (a.readFile) {
          const p = String(a.readFile).replace('{{env.FOREMAN_HOME}}', this.caseHome).replace('${FOREMAN_HOME}', this.caseHome);
          const text = readFileSync(p, 'utf8');
          const data = { mode: (statSync(p).mode & 0o777).toString(8).padStart(4, '0').replace(/^0/, '0'), text, yaml: YAML.parse(text) };
          (data as any).mode = (statSync(p).mode & 0o777).toString(8).padStart(4, '0');
          this.check(s.step, s.assert, { ...data, mode: (statSync(p).mode & 0o777).toString(8).padStart(4, '0') }); return;
        }
        return;
      }
      case 'ssh': {
        if (a.mode === 'forward-local') { writeFileSync(this.sshModeFile, 'forward-local'); if (a.listen) { this.sshListen = a.listen; process.env.FAKE_SSH_LISTEN = String(a.listen); } }
        if (a.failForever) writeFileSync(this.sshModeFile, 'fail-forever');
        if (a.kill) await this.app.tunnels.killForTest('dev');
        return;
      }
      case 'lark': {
        const body: Record<string, unknown> = {};
        for (const k of ['failSend', 'failReply', 'failGetOnce', 'failGet', 'owner', 'botOpenId'] as const) if (a[k] !== undefined) body[k] = a[k];
        if (a.chats) { body.chats = a.chats; body.scanEnabled = true; }
        if (a.recent) { body.recent = a.recent; body.scanEnabled = true; }
        const r = await http(this.app, 'POST', '/__test/lark/set', body);
        if (r.status !== 200) throw new StepError(s.step, `lark mock 设置失败：${JSON.stringify(r.body).slice(0, 300)}`);
        return;
      }
      case 'runner': {
        // repeat：把 steps 顺序执行 N 次（每次重新插值，extract 写入变量）
        for (let i = 0; i < Number(a.repeat ?? 1); i++) for (const st of (a.steps as Step[]) ?? []) await this.execStep({ ...st, step: `${s.step} #${i + 1}` });
        return;
      }
      default: {
        // 通用 mock 状态（jira / claude / codex / gh）：支持 issues[0].assignee 这类路径键
        const cur = (this.vars[`mock.${a.handle}`] as Record<string, unknown> | undefined) ?? {};
        for (const [k, v] of Object.entries(a)) { if (k === 'handle') continue; setPath(cur, k, v); }
        this.vars[`mock.${a.handle}`] = cur;
        // 中心侧假 Jira（执行器在无 vpn:jira runtime 时直接用）
        if (a.handle === 'jira' && (a.commentFailWith !== undefined || a.commentFailTimes !== undefined)) await http(this.app, 'POST', '/__test/mock/jira', { commentFailWith: a.commentFailWith ?? null, commentFailTimes: a.commentFailTimes ?? 0 });
        return;
      }
    }
  }

  private async mockExpect(s: Step, a: Record<string, any>, timeout: number) {
    const deadline = Date.now() + (a.timeoutMs ?? timeout);
    const find = async (): Promise<any | null> => {
      if (a.handle === 'lark') {
        const r = await http(this.app, 'GET', '/__test/lark/sent');
        return (r.body.items as any[]).find((m) => m.kind === a.kind && Object.entries(a.match ?? {}).every(([k, v]) => typeof v === 'string' ? String(m[k] ?? '').includes(v) : m[k] === v)) ?? null;
      }
      if (a.handle === 'cli') {
        const out = this.procs.filter((p) => p.name === 'cli').map((p) => p.out).join('') + (this.lastCliOutput?.stdout ?? '');
        return a.kind === 'stdout' && out.includes(a.match?.text ?? '') ? { text: out } : null;
      }
      // 其他 mock（gh / jira / claude / codex）：按 handle + kind + match 子串查调用记录
      return this.mockCalls.find((c) => c.handle === a.handle && c.kind === a.kind && Object.entries(a.match ?? {}).every(([k, v]) => String((c as any)[k] ?? '').includes(String(v)))) ?? null;
    };
    while (Date.now() < deadline) {
      const hit = await find();
      if (hit) { if (a.expectNone) throw new StepError(s.step, `不应出现：${JSON.stringify(hit).slice(0, 200)}`); this.check(s.step, s.assert, hit); this.extract(s.extract, { ...hit, message_id: hit.id ?? hit.message_id }); return; }
      if (a.expectNone && Date.now() + 100 >= deadline) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (a.expectNone) return;
    throw new StepError(s.step, `mock ${a.handle} 未记录到 ${a.kind} ${JSON.stringify(a.match ?? {})}`);
  }
}

// ---------------- 路径与比较 ----------------
export function getPath(data: unknown, path: string): unknown {
  if (path === '$none') return undefined;
  const tokens = path.match(/[^.[\]]+|\[[^\]]*\]/g) ?? [];
  let cur: any = data;
  for (let tok of tokens) {
    if (cur === undefined || cur === null) return undefined;
    if (tok.startsWith('[')) {
      tok = tok.slice(1, -1);
      if (tok === '*') { if (!Array.isArray(cur)) return undefined; continue; }
      const f = tok.match(/^\?\(@\.(\w+)==['"](.+)['"]\)$/);
      if (f) { const arr = Array.isArray(cur) ? cur.filter((x) => String(x?.[f[1]!]) === f[2]) : []; if (!arr.length) return undefined; cur = arr.length === 1 ? arr[0] : arr; continue; }
      const i = Number(tok); cur = Array.isArray(cur) ? cur[i < 0 ? cur.length + i : i] : undefined; continue;
    }
    if (Array.isArray(cur) && tok !== 'length') { cur = cur.map((x) => x?.[tok]); continue; }
    cur = cur[tok];
  }
  return cur;
}

export function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  if (a instanceof Date) return deepEq(a.toISOString(), b);
  if (b && typeof b === 'object' && '__regex' in (b as any)) return new RegExp((b as any).__regex).test(String(a));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => deepEq((a as any)[k], (b as any)[k])); }
  return false;
}

/** 脚本 expect：{ 'a.b': 'contains:x' | value } 对结果按路径比较 */
function expectMatch(expect: Record<string, unknown>, result: unknown): boolean {
  return Object.entries(expect).every(([path, want]) => {
    const val = getPath(result, path);
    if (typeof want === 'string' && want.startsWith('contains:')) return String(val ?? '').includes(want.slice(9));
    return matchLoose(val, want);
  });
}
/** 字符串按包含匹配，其余按 deepEq（ws.expect / mock.match 用） */
export function matchLoose(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected);
  return deepEq(actual, expected);
}

/** want 的每个键在 got 上相等（子集比较） */
export function subsetEq(want: unknown, got: unknown): boolean {
  if (!want || typeof want !== 'object') return matchLoose(got, want);
  return Object.entries(want as Record<string, unknown>).every(([k, v]) => matchLoose((got as any)?.[k], v));
}
/** 设置路径键：issues[0].assignee */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const tokens = path.match(/[^.[\]]+/g) ?? [];
  let cur: any = obj;
  tokens.forEach((tok, i) => {
    const last = i === tokens.length - 1;
    const next = tokens[i + 1];
    if (last) { cur[tok] = value; return; }
    if (cur[tok] == null) cur[tok] = /^\d+$/.test(next!) ? [] : {};
    cur = cur[tok];
  });
}

function normalizeRow(r: Record<string, unknown>) {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) o[k] = v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : v;
  return o;
}

export function loadScenario(file: string): ScenarioFile {
  return JSON.parse(readFileSync(resolve(ROOT, 'logos/resources/scenario', file), 'utf8'));
}
export { ROOT, dirname };
