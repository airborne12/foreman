/** Codex 单执行器回归：协议、配置、探测与真实子进程生命周期。 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AGENTS, WorkerConfig, CenterConfig, SessionStart, Register } from '@foreman/shared';
import { Worker } from '../../apps/worker/src/worker.js';
import { makeEnvelope } from '@foreman/shared';
import { ADAPTERS, codexAdapter, type TrackedSession } from '../../apps/worker/src/sessions.js';
import { probe } from '../../apps/worker/src/probe.js';
import { writeFakeBins } from '../helpers/fakeBins.js';
import { withReport } from '../helpers/reporter.js';

function fakeCodex(body: string) {
  const cwd = mkdtempSync(resolve(tmpdir(), 'foreman-codex-'));
  const bin = resolve(cwd, 'codex');
  writeFileSync(bin, `#!${process.execPath}\n${body}\n`); chmodSync(bin, 0o755);
  return { cwd, bin };
}
const input = (cwd: string) => ({ sessionId: crypto.randomUUID(), taskKey: 'T-900', kind: 'implement', agent: 'codex', prompt: '完成任务', cwd, mcp: { url: 'http://localhost/mcp', token: 'test' } });

describe('Codex 单执行器', () => {
  it('UT-S03-66: 执行协议仅接受 Codex', () => withReport('UT-S03-66', () => {
    expect(AGENTS).toEqual(['codex']); expect(Object.keys(ADAPTERS)).toEqual(['codex']);
    for (const agent of ['claude', 'opencode']) expect(SessionStart.safeParse({ ...input('/tmp'), agent }).success).toBe(false);
    expect(SessionStart.safeParse(input('/tmp')).success).toBe(true);
  }));
  it('UT-S03-67: 旧 worker 配置与注册过滤停用执行器和标签', () => withReport('UT-S03-67', () => {
    const agents = { claude: { bin: '/fake/claude', maxConcurrent: 9 }, codex: { bin: '/fake/codex', maxConcurrent: 2, sandbox: 'read-only' }, opencode: { bin: '/fake/opencode', maxConcurrent: 8 } };
    const labels = ['agent:claude', 'agent:codex', 'agent:opencode', 'build:doris'];
    const cfg = WorkerConfig.parse({ name: 'dev', center: { url: 'ws://x', token: 't' }, agents, labels });
    expect(Object.keys(cfg.agents)).toEqual(['codex']); expect(cfg.labels).toEqual(['agent:codex', 'build:doris']);
    expect(cfg.agents.codex?.sandbox).toBe('read-only');
    const reg = Register.parse({ name: 'dev', instanceId: crypto.randomUUID(), version: '0.1.0', transport: 'direct', labels, agents, repos: {} });
    expect(Object.keys(reg.agents)).toEqual(['codex']); expect(reg.labels).toEqual(cfg.labels);
    expect(CenterConfig.parse({ database: 'db', token: 't', panel_token: 'p' }).agent_concurrency).toEqual({ codex: 3 });
  }));
  it('UT-S03-68: 只探测 Codex，旧执行器不会生成能力标签', () => withReport('UT-S03-68', () => {
    const bins = writeFakeBins(mkdtempSync(resolve(tmpdir(), 'codex-probe-')), { codex: {}, claude: {}, opencode: {}, git: {} });
    const p = probe({ env: { PATH: bins, HOME: '/nonexistent' } });
    expect(Object.keys(p.agents)).toEqual(['codex']); expect(p.labels).toEqual(['agent:codex']);
    expect(p.tools.git?.ok).toBe(true);
  }));
  it('UT-S03-69: 快速完成的 Codex 子进程不会访问未初始化会话', () => withReport('UT-S03-69', async () => {
    const { cwd, bin } = fakeCodex('console.log(JSON.stringify({type:"thread.started",thread_id:"thread-fast"})); console.log(JSON.stringify({type:"turn.completed"}));');
    let exits = 0;
    const s = await codexAdapter.start(input(cwd), bin, (code) => { expect(code).toBe(0); exits++; });
    expect(s.agentSessionId).toBe('thread-fast'); expect(s.state).toBe('done'); expect(exits).toBe(1);
  }));
  it('UT-S03-70: 启动即失败与找不到二进制均返回明确错误', () => withReport('UT-S03-70', async () => {
    const { cwd, bin } = fakeCodex('console.error("订阅登录失效"); process.exit(7);');
    await expect(codexAdapter.start(input(cwd), bin, () => undefined)).rejects.toThrow(/7.*订阅登录失效/);
    await expect(codexAdapter.start(input(cwd), resolve(cwd, 'missing'), () => undefined)).rejects.toThrow(/未能启动|ENOENT/);
  }));
  it('UT-S03-71: 原线程续接保留 MCP 与沙箱并记录完成状态', () => withReport('UT-S03-71', async () => {
    const { cwd, bin } = fakeCodex('require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({type:"turn.completed"}));');
    const s: TrackedSession = { sessionId: crypto.randomUUID(), agent: 'codex', agentSessionId: 'thread-original', pid: null, cwd, logFile: resolve(cwd, 'session.log'), state: 'done', mcp: { url: 'http://localhost/mcp', token: 'test' } };
    const exited = new Promise<void>((resolve) => { void codexAdapter.resume(s, '继续任务', bin, (code) => { expect(code).toBe(0); resolve(); }, { sandbox: 'read-only' }); });
    await exited;
    const args = JSON.parse(readFileSync(resolve(cwd, 'args.json'), 'utf8'));
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']); expect(args.slice(-2)).toEqual(['thread-original', '继续任务']);
    expect(args).toContain('sandbox_mode="read-only"'); expect(args).toContain('mcp_servers.foreman.tool_timeout_sec=2100');
    expect(s.state).toBe('done');
  }));
  it('UT-S03-72: 没有 Codex 线程 ID 时拒绝续接', () => withReport('UT-S03-72', async () => {
    const { cwd, bin } = fakeCodex('process.exit(0);');
    const s: TrackedSession = { sessionId: crypto.randomUUID(), agent: 'codex', agentSessionId: 'pid-123', pid: null, cwd, logFile: resolve(cwd, 'absent.log'), state: 'done' };
    await expect(codexAdapter.resume(s, '继续', bin, () => undefined)).rejects.toThrow(/线程 id/);
  }));
  it('UT-S03-73: 停止 Codex 进程后状态保持 stopped', () => withReport('UT-S03-73', async () => {
    const { cwd, bin } = fakeCodex('console.log(JSON.stringify({type:"thread.started",thread_id:"thread-stop"})); setInterval(()=>{},1000);');
    const s = await codexAdapter.start(input(cwd), bin, () => undefined);
    await codexAdapter.stop(s); await new Promise((r) => setTimeout(r, 100));
    expect(s.state).toBe('stopped');
    expect(() => process.kill(s.pid!, 0)).toThrow();
  }));
  it('UT-S03-74: 重启后支持带空白的 Codex JSON 完成记录', () => withReport('UT-S03-74', async () => {
    const { cwd } = fakeCodex(''); const logFile = resolve(cwd, 'session.log');
    writeFileSync(logFile, '{"type": "turn.completed"}\n');
    const s: TrackedSession = { sessionId: crypto.randomUUID(), agent: 'codex', agentSessionId: 'thread-attach', pid: null, cwd, logFile, state: 'running' };
    await new Promise<void>((resolve) => codexAdapter.attach!(s, 'codex', (code) => { expect(code).toBe(0); resolve(); }, { pollMs: 10 }));
    expect(s.state).toBe('done');
  }));
});

it('UT-S03-75: 连续续接先结束前一进程，旧轮退出不能覆盖新轮', () => withReport('UT-S03-75', async () => {
  const { cwd, bin } = fakeCodex('console.log(JSON.stringify({type:"thread.started",thread_id:"thread-serial"})); setInterval(()=>{},1000);');
  let exits = 0;
  const s = await codexAdapter.start(input(cwd), bin, () => { exits++; });
  const original = s.pid!;
  try {
    await codexAdapter.resume(s, '第一条', bin, () => { exits++; });
    const first = s.pid!;
    expect(() => process.kill(original, 0)).toThrow();
    await Promise.all([
      codexAdapter.resume(s, '第二条', bin, () => { exits++; }),
      codexAdapter.resume(s, '第三条', bin, () => { exits++; }),
    ]);
    expect(() => process.kill(first, 0)).toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.state).toBe('running'); expect(exits).toBe(0);
  } finally { await codexAdapter.stop(s); try { process.kill(-original, 'SIGKILL'); } catch {} }
}));

it('UT-S03-76: 已完成会话续接和重复停止不会误计其他会话名额', () => withReport('UT-S03-76', async () => {
  const { cwd } = fakeCodex('');
  const config = WorkerConfig.parse({ name: 'dev', center: { url: 'ws://localhost', token: 't' }, agents: { codex: { bin: 'fake', maxConcurrent: 3 } } });
  const worker = new Worker({ config, stateFile: resolve(cwd, 'worker-state.json'), adapters: { codex: {
    start: async () => { throw new Error('本场景不启动'); },
    resume: async (s) => { s.state = 'running'; }, stop: async (s) => { s.state = 'stopped'; },
  } } });
  const first: TrackedSession = { sessionId: crypto.randomUUID(), agent: 'codex', agentSessionId: 'thread-first', pid: null, cwd, logFile: resolve(cwd, 'first.log'), state: 'done' };
  const second: TrackedSession = { ...first, sessionId: crypto.randomUUID(), state: 'running' };
  worker.sessions.set(first.sessionId, first); worker.sessions.set(second.sessionId, second);
  worker.state.sessions.codex = 1;
  const command = (type: string, payload: Record<string, unknown>) => (worker as any).handleCommand(makeEnvelope(type, payload));
  await command('session.resume', { sessionId: first.sessionId, text: '继续' });
  expect(worker.state.sessions.codex).toBe(2);
  await command('session.stop', { sessionId: first.sessionId, reason: 'user' });
  await command('session.stop', { sessionId: first.sessionId, reason: 'user' });
  expect(worker.state.sessions.codex).toBe(1); expect(second.state).toBe('running');
}));
