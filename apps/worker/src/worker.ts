/**
 * worker 守护进程（S05 Step 8–19；worker-channel.yaml）
 * - 拨中心 /ws/worker，注册，按 ack.heartbeatSeconds 心跳
 * - 认证失败按 60/120/300s 退避（EX-10.1）；其他断开 5s 重连
 * - 指令幂等：同 commandId 回放上次结果
 * - 指令：worktree.gc、worktree.create（S03 Step 11）、job.run（Jira / gh）、session.start/resume/stop/logs（S03 Step 13–19）
 */
import WebSocket from 'ws';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { Envelope, makeEnvelope, CENTER_TO_WORKER, type WorkerConfig } from '@foreman/shared';
import { runGc, diskUsedRatio } from './gc.js';
import { foremanHome } from './config.js';
import { createWorktree, WorktreeError, type GitRunner } from './worktree.js';
import { JiraClient, loadJiraConfig, runJiraJob } from './jira.js';
import { ADAPTERS, SessionStartError, tail, type TrackedSession, type AgentAdapter } from './sessions.js';

export const WORKER_VERSION = '0.1.0';
const AUTH_BACKOFF = [60_000, 120_000, 300_000];

export interface WorkerState { state: 'connecting' | 'connected' | 'auth_failed' | 'disconnected' | 'stopped'; lastError?: string; nextRetryAt?: string; runtimeId?: string; sessions: Record<string, number>; updatedAt: string }

export interface WorkerOptions {
  config: WorkerConfig;
  instanceId?: string;
  log?: (line: string) => void;
  stateFile?: string;
  /** 测试用：缩放退避时间 */
  backoffScale?: number;
  onCommand?: (env: Envelope) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  /** 测试用：替换 git / agent 适配器 / Jira 客户端 */
  git?: GitRunner;
  adapters?: Record<string, AgentAdapter>;
  jira?: JiraClient | null;
}

export class Worker {
  private ws: WebSocket | null = null;
  private stopped = false;
  private authFailures = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private executed = new Map<string, Envelope>();
  /** 本 worker 启动的会话（对账与 resume/stop 用） */
  readonly sessions = new Map<string, TrackedSession>();
  private jira: JiraClient | null | undefined;
  readonly instanceId: string;
  state: WorkerState = { state: 'connecting', sessions: {}, updatedAt: new Date().toISOString() };
  private log: (l: string) => void;
  private stateFile: string;

  constructor(private opts: WorkerOptions) {
    this.instanceId = opts.instanceId ?? crypto.randomUUID();
    this.log = opts.log ?? ((l) => console.log(l));
    this.stateFile = opts.stateFile ?? opts.config.state_file ?? resolve(foremanHome(), 'worker-state.json');
  }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close(1000, 'stop');
    this.setState({ state: 'stopped' });
  }

  private setState(patch: Partial<WorkerState>) {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    try { mkdirSync(dirname(this.stateFile), { recursive: true }); writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2)); } catch { /* 状态文件写失败不影响运行 */ }
  }

  private connect() {
    if (this.stopped) return;
    const cfg = this.opts.config;
    this.setState({ state: 'connecting' });
    this.log(`connecting ${cfg.center.url}/ws/worker …`);
    const url = cfg.center.url.replace(/\/$/, '') + '/ws/worker';
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.center.token}` } });
    this.ws = ws;
    ws.on('open', () => this.sendRegister());
    ws.on('message', (d) => { void this.onMessage(String(d)); });
    ws.on('error', (e) => { this.setState({ lastError: String(e) }); });
    ws.on('close', (code, reason) => this.onClose(code, String(reason)));
  }

  private sendRegister() {
    const cfg = this.opts.config;
    const disk = this.diskInfo();
    const env = makeEnvelope('register', {
      name: cfg.name, instanceId: this.instanceId, version: WORKER_VERSION, transport: cfg.transport,
      labels: cfg.labels, agents: cfg.agents, repos: cfg.repos, disk, capabilities: cfg.capabilities,
    });
    this.ws?.send(JSON.stringify(env));
  }

  private diskInfo() {
    const path = this.opts.config.worktree.disk_path ?? Object.values(this.opts.config.repos)[0]?.worktreeRoot ?? process.cwd();
    const usedRatio = diskUsedRatio(path);
    return usedRatio == null ? undefined : { path, usedRatio, freeBytes: undefined };
  }

  private async onMessage(raw: string) {
    let env: Envelope;
    try { env = Envelope.parse(JSON.parse(raw)); } catch (e) { this.log(`bad message: ${e}`); return; }
    if (env.type === 'register.ack') {
      const ack = CENTER_TO_WORKER['register.ack'].parse(env.payload);
      this.authFailures = 0;
      this.setState({ state: 'connected', runtimeId: ack.runtimeId, lastError: undefined, nextRetryAt: undefined });
      this.log(`registered as ${this.opts.config.name}\n  transport: ${this.opts.config.transport}\n  labels:    ${this.opts.config.labels.join(', ')}\n  agents:    ${Object.entries(this.opts.config.agents).map(([k, v]) => `${k} 0/${v.maxConcurrent}`).join(', ')}`);
      this.startHeartbeat(ack.heartbeatSeconds * 1000 * (this.opts.backoffScale ?? 1));
      // 重连对账（S05 Step 16）
      this.send('session.list', { sessions: [...this.sessions.values()].map((s) => ({ sessionId: s.sessionId, agentSessionId: s.agentSessionId, state: s.state })) });
      for (const cmd of ack.pendingCommands) await this.handleCommand(cmd);
      return;
    }
    if (env.type === 'error') {
      const code = String(env.payload.code ?? '');
      this.log(`error from center: ${code} ${env.payload.message ?? ''}`);
      if (code === 'AUTH_INVALID' || code === 'VERSION_UNSUPPORTED' || code === 'RUNTIME_NAME_CONFLICT') this.setState({ state: 'auth_failed', lastError: code });
      return;
    }
    await this.handleCommand(env);
  }

  private startHeartbeat(ms: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const beat = () => this.send('heartbeat', { load: null, disk: this.diskInfo(), sessions: this.state.sessions });
    this.heartbeatTimer = setInterval(beat, ms);
  }

  send(type: string, payload: Record<string, unknown>, ref?: string | null) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(makeEnvelope(type, payload, { ref: ref ?? null })));
  }

  private async handleCommand(env: Envelope) {
    const prev = this.executed.get(env.id);
    if (prev) { this.ws?.send(JSON.stringify(prev)); return; }
    let reply: Envelope | null = null;
    try {
      switch (env.type) {
        case 'worktree.gc': {
          const input = CENTER_TO_WORKER['worktree.gc'].parse(env.payload);
          const result = runGc(input, { diskPath: this.opts.config.worktree.disk_path });
          reply = makeEnvelope('worktree.gc.result', result as unknown as Record<string, unknown>, { ref: env.id });
          break;
        }
        case 'worktree.create': {
          const input = CENTER_TO_WORKER['worktree.create'].parse(env.payload);
          const repo = this.opts.config.repos[input.repo];
          if (!repo) { reply = makeEnvelope('error', { code: 'WORKTREE_FAILED', message: `本 runtime 未配置仓库 ${input.repo}`, retryable: false }, { ref: env.id }); break; }
          try {
            const out = createWorktree({ ...input, buildEnv: this.opts.config.build_env[input.repo]?.default }, repo, this.opts.git);
            reply = makeEnvelope('worktree.ready', out as unknown as Record<string, unknown>, { ref: env.id });
          } catch (e) {
            reply = makeEnvelope('error', { code: 'WORKTREE_FAILED', message: String((e as Error).message), retryable: e instanceof WorktreeError ? e.retryable : false }, { ref: env.id });
          }
          break;
        }
        case 'job.run': {
          const input = CENTER_TO_WORKER['job.run'].parse(env.payload);
          const result = input.kind.startsWith('jira') ? await runJiraJob(input.kind, input.args, this.jiraClient()) : await this.runGhJob(input.kind, input.args);
          reply = makeEnvelope('job.result', result as unknown as Record<string, unknown>, { ref: env.id });
          break;
        }
        case 'session.start': {
          const input = CENTER_TO_WORKER['session.start'].parse(env.payload);
          const bin = this.opts.config.agents[input.agent]?.bin;
          const adapter = (this.opts.adapters ?? ADAPTERS)[input.agent];
          if (!bin || !adapter) { reply = makeEnvelope('error', { code: 'AGENT_START_FAILED', message: `本 runtime 未配置 agent ${input.agent}`, retryable: false }, { ref: env.id }); break; }
          try {
            const s = await adapter.start(input, bin, (code, err) => this.onSessionExit(input.sessionId, code, err));
            this.sessions.set(input.sessionId, s);
            this.state.sessions[input.agent] = (this.state.sessions[input.agent] ?? 0) + 1; this.setState({});
            reply = makeEnvelope('session.started', { sessionId: input.sessionId, agentSessionId: s.agentSessionId, startedAt: new Date().toISOString(), pid: s.pid }, { ref: env.id });
          } catch (e) {
            reply = makeEnvelope('error', { code: 'AGENT_START_FAILED', message: String((e as Error).message).slice(0, 500), retryable: e instanceof SessionStartError ? e.retryable : true }, { ref: env.id });
          }
          break;
        }
        case 'session.resume': {
          const input = CENTER_TO_WORKER['session.resume'].parse(env.payload);
          const s = this.sessions.get(input.sessionId);
          const adapter = s ? (this.opts.adapters ?? ADAPTERS)[s.agent] : null;
          const bin = s ? this.opts.config.agents[s.agent]?.bin : null;
          if (!s || !adapter || !bin) { reply = makeEnvelope('error', { code: 'RESUME_FAILED', message: `会话 ${input.sessionId} 不在本 runtime`, retryable: false }, { ref: env.id }); break; }
          try { await adapter.resume(s, input.text, bin, (code, err) => this.onSessionExit(input.sessionId, code, err)); reply = makeEnvelope('session.state', { sessionId: s.sessionId, state: 'running', source: 'poll', observedAt: new Date().toISOString() }, { ref: env.id }); }
          catch (e) { reply = makeEnvelope('error', { code: 'RESUME_FAILED', message: String((e as Error).message).slice(0, 500), retryable: false }, { ref: env.id }); }
          break;
        }
        case 'session.stop': {
          const input = CENTER_TO_WORKER['session.stop'].parse(env.payload);
          const s = this.sessions.get(input.sessionId);
          if (s) { await ((this.opts.adapters ?? ADAPTERS)[s.agent]?.stop(s)); this.decSession(s.agent); }
          reply = makeEnvelope('session.state', { sessionId: input.sessionId, state: 'stopped', source: 'poll', observedAt: new Date().toISOString() }, { ref: env.id });
          break;
        }
        case 'session.logs': {
          const input = CENTER_TO_WORKER['session.logs'].parse(env.payload);
          const s = this.sessions.get(input.sessionId);
          const all = s && existsSync(s.logFile) ? readFileSync(s.logFile, 'utf8').split('\n') : [];
          reply = makeEnvelope('session.logs.result', { sessionId: input.sessionId, lines: all.slice(-input.limit), truncated: all.length > input.limit }, { ref: env.id });
          break;
        }
        default: {
          const custom = this.opts.onCommand ? await this.opts.onCommand(env) : null;
          if (custom) { reply = makeEnvelope(String(custom.__type ?? 'error'), stripType(custom), { ref: env.id }); break; }
          reply = makeEnvelope('error', { code: 'INTERNAL', message: `${env.type} 尚未实现（本批次）`, retryable: false }, { ref: env.id });
        }
      }
    } catch (e) {
      reply = makeEnvelope('error', { code: 'INTERNAL', message: String(e), retryable: false }, { ref: env.id });
    }
    if (reply) { this.executed.set(env.id, reply); this.ws?.send(JSON.stringify(reply)); }
  }

  private jiraClient() {
    if (this.jira === undefined) { const c = this.opts.jira !== undefined ? this.opts.jira : (() => { const cfg = loadJiraConfig(); return cfg ? new JiraClient(cfg) : null; })(); this.jira = c; }
    return this.jira;
  }

  private runGhJob(kind: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: { code: 'SOURCE_UNREACHABLE' | 'NOT_FOUND' | 'TIMEOUT' | 'INTERNAL'; message: string } }> {
    return new Promise((res) => {
      if (kind !== 'gh-pr-view') return res({ ok: false, error: { code: 'INTERNAL', message: `未知作业 ${kind}` } });
      execFile('gh', ['pr', 'view', String(args.url ?? args.number ?? ''), '--json', 'number,title,state,url,statusCheckRollup,reviews,mergeable', ...(args.repo ? ['--repo', String(args.repo)] : [])], { encoding: 'utf8', timeout: 60_000 }, (e, out, err) => {
        if (e) return res({ ok: false, error: { code: /not found|Could not resolve/i.test(String(err)) ? 'NOT_FOUND' : 'SOURCE_UNREACHABLE', message: String(err || e.message).slice(0, 300) } });
        try { res({ ok: true, result: JSON.parse(out) }); } catch { res({ ok: false, error: { code: 'INTERNAL', message: 'gh 输出不是 JSON' } }); }
      });
    });
  }

  private decSession(agent: string) { this.state.sessions[agent] = Math.max(0, (this.state.sessions[agent] ?? 0) - 1); this.setState({}); }

  /** 进程退出 → session.state（source=exit，S03 Step 31） */
  private onSessionExit(sessionId: string, code: number | null, err: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.state === 'stopped') return;
    s.state = code === 0 ? 'done' : 'failed'; s.exitCode = code;
    this.decSession(s.agent);
    this.send('session.state', { sessionId, state: s.state, source: 'exit', exitCode: code, failureReason: code === 0 ? null : (err || tail(s.logFile, 5)).slice(0, 500), observedAt: new Date().toISOString() });
  }

  private onClose(code: number, reason: string) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.stopped) return;
    const scale = this.opts.backoffScale ?? 1;
    if (code === 4001 || code === 4004 || code === 4005 || this.state.state === 'auth_failed') {
      const delay = AUTH_BACKOFF[Math.min(this.authFailures, AUTH_BACKOFF.length - 1)]! * scale;
      this.authFailures += 1;
      const next = new Date(Date.now() + delay);
      this.setState({ state: 'auth_failed', lastError: reason || `close ${code}`, nextRetryAt: next.toISOString() });
      this.log(`error: center rejected registration: ${reason || code}\nretrying in ${Math.round(delay / 1000 / scale)}s (attempt ${this.authFailures}, backoff 60s → 120s → 300s max)`);
      setTimeout(() => this.connect(), delay);
      return;
    }
    this.setState({ state: 'disconnected', lastError: reason || `close ${code}` });
    this.log(`disconnected (${code} ${reason}), reconnecting in 5s`);
    setTimeout(() => this.connect(), 5000 * scale);
  }
}

function stripType(o: Record<string, unknown>) { const { __type, ...rest } = o; return rest; }
