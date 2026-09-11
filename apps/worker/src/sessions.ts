/**
 * agent 会话适配器（S03 Step 13–19、31–33；core-03 §2 决策 Q10/Q11）
 * - 只走订阅版 CLI：claude --bg / claude --bg --resume；codex exec / codex exec resume
 * - 绝不注入 API key（FORBIDDEN_ENV_KEYS 从环境剔除）
 * - MCP 通过 cwd/.mcp.json（claude）或 -c mcp_servers（codex）指向中心 /mcp，token 为任务级
 * - 状态：进程退出即 done/failed（source=exit）；claude --bg 另通过 `claude agents --json` 轮询（source=poll）
 */
import { spawn, execFile } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FORBIDDEN_ENV_KEYS } from '@foreman/shared';

export interface SessionStartInput { sessionId: string; taskKey: string | null; kind: string; agent: string; model?: string | null; prompt: string; cwd: string; name?: string; mcp: { url: string; token: string }; env?: Record<string, string>; timeoutMinutes?: number | null }
export interface TrackedSession { sessionId: string; agent: string; agentSessionId: string; pid: number | null; cwd: string; logFile: string; state: 'running' | 'done' | 'failed' | 'stopped'; exitCode?: number | null }

export class SessionStartError extends Error { constructor(message: string, public retryable = true) { super(message); } }

export interface AgentAdapter {
  start(input: SessionStartInput, bin: string, onExit: (code: number | null, err: string) => void): Promise<TrackedSession>;
  resume(s: TrackedSession, text: string, bin: string, onExit: (code: number | null, err: string) => void): Promise<void>;
  stop(s: TrackedSession): Promise<void>;
}

export function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(extra ?? {}) };
  for (const k of FORBIDDEN_ENV_KEYS) delete env[k];
  return env;
}

function logPath(cwd: string, sessionId: string) { const dir = resolve(cwd, '.foreman/logs'); mkdirSync(dir, { recursive: true }); return resolve(dir, `${sessionId}.log`); }

function spawnDetached(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string, onExit: (code: number | null, err: string) => void) {
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

/** claude --bg（订阅版后台代理） */
export const claudeAdapter: AgentAdapter = {
  async start(input, bin, onExit) {
    // MCP 服务器写入 cwd/.mcp.json（项目级配置）
    writeFileSync(resolve(input.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { foreman: { type: 'http', url: input.mcp.url, headers: { Authorization: `Bearer ${input.mcp.token}` } } } }, null, 2));
    const log = logPath(input.cwd, input.sessionId);
    const name = input.name ?? `foreman-${input.sessionId.slice(0, 8)}`;
    const args = ['--bg', '--name', name, ...(input.model ? ['--model', input.model] : []), input.prompt];
    const out = await run(bin, args, input.cwd, cleanEnv(input.env), 60_000).catch((e) => { throw new SessionStartError(`claude --bg 失败：${String(e.message).slice(0, 300)}`); });
    const id = (out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]) ?? (await findClaudeAgentByName(bin, name, input.cwd)) ?? name;
    writeFileSync(log, out);
    const s: TrackedSession = { sessionId: input.sessionId, agent: 'claude', agentSessionId: id, pid: null, cwd: input.cwd, logFile: log, state: 'running' };
    pollClaude(bin, s, onExit);
    return s;
  },
  async resume(s, text, bin, onExit) {
    await run(bin, ['--bg', '--resume', s.agentSessionId, text], s.cwd, cleanEnv(), 60_000).catch((e) => { throw new SessionStartError(`claude --bg --resume 失败：${String(e.message).slice(0, 300)}`, false); });
    s.state = 'running'; pollClaude(bin, s, onExit);
  },
  async stop(s) { try { await run('claude', ['agents', 'kill', s.agentSessionId], s.cwd, cleanEnv(), 15_000); } catch { /* ignore */ } s.state = 'stopped'; },
};

async function findClaudeAgentByName(bin: string, name: string, cwd: string) {
  try { const list = JSON.parse(await run(bin, ['agents', '--json'], cwd, cleanEnv(), 15_000)); const a = (Array.isArray(list) ? list : list.agents ?? []).find((x: any) => x.name === name); return a?.id ?? a?.sessionId ?? null; } catch { return null; }
}

function pollClaude(bin: string, s: TrackedSession, onExit: (code: number | null, err: string) => void) {
  const t = setInterval(async () => {
    if (s.state !== 'running') { clearInterval(t); return; }
    try {
      const list = JSON.parse(await run(bin, ['agents', '--json'], s.cwd, cleanEnv(), 15_000));
      const a = (Array.isArray(list) ? list : list.agents ?? []).find((x: any) => x.id === s.agentSessionId || x.sessionId === s.agentSessionId || x.name === s.agentSessionId);
      const st = String(a?.status ?? a?.state ?? '').toLowerCase();
      if (!a || ['completed', 'done', 'finished', 'exited'].includes(st)) { clearInterval(t); s.state = 'done'; onExit(0, ''); }
      else if (['failed', 'error', 'crashed'].includes(st)) { clearInterval(t); s.state = 'failed'; onExit(1, String(a?.error ?? st)); }
    } catch { /* 轮询失败不改状态 */ }
  }, 20_000);
  t.unref();
}

/** codex exec（订阅版，非交互） */
export const codexAdapter: AgentAdapter = {
  async start(input, bin, onExit) {
    const log = logPath(input.cwd, input.sessionId);
    const mcpUrl = input.mcp.url;
    const args = ['exec', '--json', '-C', input.cwd, '--skip-git-repo-check', '-c', `mcp_servers.foreman.url="${mcpUrl}"`, '-c', `mcp_servers.foreman.http_headers.Authorization="Bearer ${input.mcp.token}"`, ...(input.model ? ['-m', input.model] : []), input.prompt];
    const p = spawnDetached(bin, args, input.cwd, cleanEnv(input.env), log, (code, err) => { s.state = code === 0 ? 'done' : 'failed'; s.exitCode = code; onExit(code, err); });
    if (!p.pid) throw new SessionStartError('codex exec 未能启动');
    await new Promise((r) => setTimeout(r, 1500));
    if (p.exitCode !== null && p.exitCode !== 0) throw new SessionStartError(`codex exec 启动即退出（${p.exitCode}）：${tail(log, 5)}`);
    const s: TrackedSession = { sessionId: input.sessionId, agent: 'codex', agentSessionId: readCodexThreadId(log) ?? `pid-${p.pid}`, pid: p.pid, cwd: input.cwd, logFile: log, state: 'running' };
    return s;
  },
  async resume(s, text, bin, onExit) {
    const id = s.agentSessionId.startsWith('pid-') ? readCodexThreadId(s.logFile) : s.agentSessionId;
    if (!id) throw new SessionStartError('找不到 codex 线程 id，无法续接', false);
    const p = spawnDetached(bin, ['exec', 'resume', '--json', '-C', s.cwd, id, text], s.cwd, cleanEnv(), s.logFile, (code, err) => { s.state = code === 0 ? 'done' : 'failed'; s.exitCode = code; onExit(code, err); });
    s.pid = p.pid ?? null; s.state = 'running';
  },
  async stop(s) { if (s.pid) { try { process.kill(-s.pid, 'SIGTERM'); } catch { try { process.kill(s.pid, 'SIGTERM'); } catch { /* ignore */ } } } s.state = 'stopped'; },
};

function readCodexThreadId(log: string): string | null {
  if (!existsSync(log)) return null;
  for (const line of readFileSync(log, 'utf8').split('\n')) { try { const j = JSON.parse(line); const id = j.thread_id ?? j.thread?.id ?? j.session_id; if (id) return String(id); } catch { /* not json */ } }
  return null;
}

export const ADAPTERS: Record<string, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter };

function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((res, rej) => execFile(bin, args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => (e ? rej(new Error(`${String(err ?? '').trim() || String(out ?? '').trim() || e.message}`)) : res(String(out ?? '')))));
}
