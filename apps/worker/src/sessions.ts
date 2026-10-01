/** Codex 订阅 CLI 会话：启动、续接、停止与进程恢复；禁止注入 API key。 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FORBIDDEN_ENV_KEYS, APPROVAL_WAIT_MINUTES } from '@foreman/shared';

/** MCP 审批与回答可能等待 30 分钟，工具超时增加 5 分钟余量。 */
export const FOREMAN_MCP_TIMEOUT_MS = (APPROVAL_WAIT_MINUTES + 5) * 60_000;

export interface SessionStartInput { sessionId: string; taskKey: string | null; kind: string; agent: string; model?: string | null; prompt: string; cwd: string; name?: string; mcp: { url: string; token: string }; env?: Record<string, string>; timeoutMinutes?: number | null }
export interface TrackedSession { sessionId: string; agent: string; agentSessionId: string; pid: number | null; cwd: string; logFile: string; state: 'running' | 'done' | 'failed' | 'stopped'; exitCode?: number | null; mcp?: { url: string; token: string } }
export interface AdapterOptions {
  /** Codex 沙箱，缺省 workspace-write。 */
  sandbox?: string | null;
  /** 测试用：进程状态轮询间隔。 */
  pollMs?: number;
}

export class SessionStartError extends Error { constructor(message: string, public retryable = true) { super(message); } }

type OnExit = (code: number | null, err: string) => void;
export interface AgentAdapter {
  start(input: SessionStartInput, bin: string, onExit: OnExit, opts?: AdapterOptions): Promise<TrackedSession>;
  /** worker 重启后重新盯住仍在跑的会话（会话记录从 sessions.json 恢复） */
  attach?(s: TrackedSession, bin: string, onExit: OnExit, opts?: AdapterOptions): void;
  resume(s: TrackedSession, text: string, bin: string, onExit: OnExit, opts?: AdapterOptions): Promise<void>;
  stop(s: TrackedSession, bin?: string): Promise<void>;
  logs?(s: TrackedSession, limit: number, bin: string): Promise<string[]>;
}

export function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(extra ?? {}) };
  for (const k of FORBIDDEN_ENV_KEYS) delete env[k];
  return env;
}

function logPath(cwd: string, sessionId: string) { const dir = resolve(cwd, '.foreman/logs'); mkdirSync(dir, { recursive: true }); return resolve(dir, `${sessionId}.log`); }

function spawnDetached(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string, onExit: OnExit) {
  const fd = openSync(log, 'a');
  const p = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let spawnErr = '';
  p.on('error', (e) => { spawnErr = String(e.message); });
  p.on('exit', (code) => onExit(code, spawnErr || tail(log)));
  p.unref();
  return p;
}

export function tail(file: string, lines = 20) { try { return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return ''; } }

// ---------------- codex exec ----------------

/**
 * 沙箱里 /etc/ssh/ssh_config.d/*.conf 的属主显示为 nobody，ssh 以「Bad owner or permissions」拒绝运行，
 * git@github.com 形式的远端 fetch 不了（T-77）。codex 会话里把 GitHub 的 ssh 地址改写成 https：
 * 公开仓库无需登录，推 fork 走 gh 凭据。
 */
export function codexEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return cleanEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'git@github.com:', ...(extra ?? {}) });
}

function codexCommon(mcp: { url: string; token: string } | undefined, sandbox?: string | null) {
  return [
    '--json', '--skip-git-repo-check',
    '-c', `sandbox_mode="${sandbox ?? 'workspace-write'}"`, '-c', 'sandbox_workspace_write.network_access=true',
    // codex 0.158（2026-09-28 自动更新）起 MCP 工具调用默认要审批，后台 exec 的审批策略是 never，
    // 平台工具（get_task / report_progress / deliver…）会全部被拒：只放行 foreman 这一个服务器，shell 等其他审批不变
    ...(mcp ? ['-c', `mcp_servers.foreman.url="${mcp.url}"`, '-c', `mcp_servers.foreman.http_headers.Authorization="Bearer ${mcp.token}"`, '-c', 'mcp_servers.foreman.default_tools_approval_mode="approve"', '-c', `mcp_servers.foreman.tool_timeout_sec=${FOREMAN_MCP_TIMEOUT_MS / 1000}`] : []),
  ];
}
export function codexStartArgs(input: SessionStartInput, sandbox?: string | null) {
  return ['exec', '-C', input.cwd, ...codexCommon(input.mcp, sandbox), ...(input.model ? ['-m', input.model] : []), input.prompt];
}
/** `codex exec resume` 不支持 -C / -s：工作目录靠 spawn cwd，沙箱靠 -c sandbox_mode */
export function codexResumeArgs(s: TrackedSession, threadId: string, text: string, sandbox?: string | null) {
  return ['exec', 'resume', ...codexCommon(s.mcp, sandbox), threadId, text];
}

/** 同一会话的续接和停止串行执行；退出回调只属于启动它的那一轮。 */
const sessionOperations = new WeakMap<TrackedSession, Promise<void>>();
const sessionRounds = new WeakMap<TrackedSession, number>();
function serializeSession(s: TrackedSession, operation: () => Promise<void>): Promise<void> {
  const next = (sessionOperations.get(s) ?? Promise.resolve()).catch(() => undefined).then(operation);
  sessionOperations.set(s, next);
  return next;
}
function invalidateRound(s: TrackedSession) {
  const round = (sessionRounds.get(s) ?? 0) + 1;
  sessionRounds.set(s, round);
  return round;
}
function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function stopCodexProcess(s: TrackedSession) {
  const pid = s.state === 'running' ? s.pid : null;
  invalidateRound(s); s.state = 'stopped';
  if (!pid) return;
  const signal = (value: NodeJS.Signals) => { try { process.kill(-pid, value); } catch { try { process.kill(pid, value); } catch { /* 已退出。 */ } } };
  signal('SIGTERM');
  for (let i = 0; i < 40 && processAlive(pid); i++) {
    if (i === 20) signal('SIGKILL');
    await new Promise((r) => setTimeout(r, 50));
  }
  if (processAlive(pid)) throw new SessionStartError('Codex 前一进程未退出，无法安全续接', false);
}

export const codexAdapter: AgentAdapter = {
  // codex exec 是 worker 起的子进程，重启后拿不到退出码：轮询进程是否还在，退出后按日志里有没有 turn.completed 判成败
  attach(s, _bin, onExit, opts = {}) {
    const t = setInterval(() => {
      if (s.state !== 'running') { clearInterval(t); return; }
      let alive = false;
      try { if (s.pid) { process.kill(s.pid, 0); alive = true; } } catch { alive = false; }
      if (alive) return;
      clearInterval(t);
      const ok = codexTurnCompleted(s.logFile);
      s.state = ok ? 'done' : 'failed';
      onExit(ok ? 0 : 1, ok ? '' : 'codex 进程已退出（worker 重启期间），日志里没有完成标记');
    }, opts.pollMs ?? 20_000);
    t.unref();
  },
  async start(input, bin, onExit, opts = {}) {
    const log = logPath(input.cwd, input.sessionId);
    const s: TrackedSession = { sessionId: input.sessionId, agent: 'codex', agentSessionId: '', pid: null, cwd: input.cwd, logFile: log, state: 'running', mcp: input.mcp };
    const p = spawnDetached(bin, codexStartArgs(input, opts.sandbox), input.cwd, codexEnv(input.env), log, (code, err) => {
      if (s.state === 'stopped' || (sessionRounds.get(s) ?? 0) !== 0) return;
      s.state = code === 0 ? 'done' : 'failed'; s.exitCode = code; onExit(code, err);
    });
    if (!p.pid) throw new SessionStartError('codex exec 未能启动');
    s.pid = p.pid;
    await new Promise((r) => setTimeout(r, 1500));
    if (p.exitCode !== null && p.exitCode !== 0) throw new SessionStartError(`codex exec 启动即退出（${p.exitCode}）：${tail(log, 5)}`);
    s.agentSessionId = readCodexThreadId(log) ?? `pid-${p.pid}`;
    return s;
  },
  resume(s, text, bin, onExit, opts = {}) {
    return serializeSession(s, async () => {
      const id = s.agentSessionId.startsWith('pid-') ? readCodexThreadId(s.logFile) : s.agentSessionId;
      if (!id) throw new SessionStartError('找不到 codex 线程 id，无法续接', false);
      await stopCodexProcess(s);
      const round = invalidateRound(s);
      const p = spawnDetached(bin, codexResumeArgs(s, id, text, opts.sandbox), s.cwd, codexEnv(), s.logFile, (code, err) => {
        if (s.state === 'stopped' || sessionRounds.get(s) !== round) return;
        s.state = code === 0 ? 'done' : 'failed'; s.exitCode = code; onExit(code, err);
      });
      if (!p.pid) { s.state = 'failed'; throw new SessionStartError('codex exec resume 未能启动', false); }
      s.pid = p.pid; s.agentSessionId = id; s.state = 'running';
    });
  },
  stop(s) { return serializeSession(s, () => stopCodexProcess(s)); },
};

function readCodexThreadId(log: string): string | null {
  if (!existsSync(log)) return null;
  for (const line of readFileSync(log, 'utf8').split('\n')) { try { const j = JSON.parse(line); const id = j.thread_id ?? j.thread?.id ?? j.session_id; if (id) return String(id); } catch { /* not json */ } }
  return null;
}

/** 按最后一轮 JSON 事件判断是否完成，不将前一轮完成记录当成本轮成功。 */
function codexTurnCompleted(log: string): boolean {
  let completed = false;
  for (const line of tail(log, 100).split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.completed') completed = true;
      else if (['thread.started', 'turn.started', 'turn.failed', 'error'].includes(event.type)) completed = false;
    } catch { /* 非 JSON 日志不影响事件判断。 */ }
  }
  return completed;
}

export const ADAPTERS: Record<string, AgentAdapter> = { codex: codexAdapter };
