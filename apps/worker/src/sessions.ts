/**
 * agent 会话适配器（S03 Step 13–19、31–33；core-03 §2 决策 Q10/Q11）
 * - 只走订阅版 CLI：claude --bg / claude --bg --resume；codex exec / codex exec resume
 * - 绝不注入 API key（FORBIDDEN_ENV_KEYS 从环境剔除）
 * - MCP：claude 用 --mcp-config=<json>（必须带 =，该参数是变长的，空格写法会吞掉 prompt）；codex 用 -c mcp_servers.*
 * - 状态：codex 进程退出即 done/failed（source=exit）；claude --bg 通过 `claude agents --json --all` 轮询（source=poll）
 *
 * claude 2.1.26x 实测行为（2026-09-14，开发机）：
 * - `claude --bg` 输出 `backgrounded · <8 位短 id> · <name>`；`agents --json` 里 id 是短 id、sessionId 是完整 UUID
 * - 一轮结束后 state=done 但进程仍在（status=idle）；此时 --resume 会开副本，所以续接前先 `claude stop <短 id>`
 * - `--resume` 要完整 UUID，短 id 也会开副本；stop / logs 只认短 id
 * - 权限等待时 state=blocked、status=waiting
 */
import { spawn, execFile } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FORBIDDEN_ENV_KEYS, APPROVAL_WAIT_MINUTES } from '@foreman/shared';

/**
 * foreman 的 request_approval / ask_user 会阻塞到人处理（最长 30 分钟），而两家 CLI 的 MCP 工具调用默认 60 秒就超时：
 * 2026-09-29 T-81 的 claude 两次申请建 PR 都在 60 秒报 "The operation timed out"，重复建出 A-90/A-91 后放弃。
 * 按服务器把超时放到等待上限 + 5 分钟（实测 claude 的 timeout、codex 的 tool_timeout_sec 都能等满 90 秒）。
 */
export const FOREMAN_MCP_TIMEOUT_MS = (APPROVAL_WAIT_MINUTES + 5) * 60_000;

export interface SessionStartInput { sessionId: string; taskKey: string | null; kind: string; agent: string; model?: string | null; prompt: string; cwd: string; name?: string; mcp: { url: string; token: string }; env?: Record<string, string>; timeoutMinutes?: number | null }
export interface TrackedSession { sessionId: string; agent: string; agentSessionId: string; shortId?: string | null; pid: number | null; cwd: string; logFile: string; state: 'running' | 'done' | 'failed' | 'stopped'; exitCode?: number | null; mcp?: { url: string; token: string } }
export interface AdapterOptions {
  /** claude --permission-mode，缺省 auto（后台会话没人点确认，manual 会卡在 blocked） */
  permissionMode?: string | null;
  /** codex 沙箱，缺省 workspace-write（exec 缺省只读，改不了代码） */
  sandbox?: string | null;
  /** claude 禁用的工具（只收紧不放权）：危险命令直接禁掉，免得停在没人点的确认框上 */
  disallowedTools?: string[] | null;
  /** 观察到会话在等输入/权限（claude state=blocked） */
  onWaiting?: () => void;
  /** 测试用：轮询间隔 */
  pollMs?: number;
}

export class SessionStartError extends Error { constructor(message: string, public retryable = true) { super(message); } }

type OnExit = (code: number | null, err: string) => void;
export interface AgentAdapter {
  start(input: SessionStartInput, bin: string, onExit: OnExit, opts?: AdapterOptions): Promise<TrackedSession>;
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

// ---------------- claude --bg ----------------

export function claudeStartArgs(input: SessionStartInput, permissionMode?: string | null, disallowedTools?: string[] | null) {
  const name = input.name ?? `foreman-${input.sessionId.slice(0, 8)}`;
  const mcp = JSON.stringify({ mcpServers: { foreman: { type: 'http', url: input.mcp.url, headers: { Authorization: `Bearer ${input.mcp.token}` }, timeout: FOREMAN_MCP_TIMEOUT_MS } } });
  return [
    '--bg', '--name', name, '--permission-mode', permissionMode ?? 'auto', '--strict-mcp-config', `--mcp-config=${mcp}`,
    // 同样用 = 写法：这些参数都是变长的，空格写法会把 prompt 当成值吞掉
    ...(disallowedTools?.length ? [`--disallowedTools=${disallowedTools.join(',')}`] : []),
    ...(input.model ? ['--model', input.model] : []), input.prompt,
  ];
}

/** 从 `claude --bg` 输出取短 id */
export function parseClaudeBgId(out: string): string | null {
  return out.match(/backgrounded\s*·\s*([0-9a-f]{8})\b/i)?.[1]?.toLowerCase() ?? out.match(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[1]?.toLowerCase() ?? null;
}

// 状态栏、分隔线、输入框，以及以转圈字符开头的状态行（如 "✻Brewed for 3m 31s · done 10:27 AM"）
const CLAUDE_CHROME = [/auto mode on/i, /esc to interrupt/i, /weekly limit/i, /shift\+tab/i, /\/effort/i, /^[─━\s]+$/, /for agents/i, /^❯\s*$/, /^[✻✶✢✽✳✺·*]/, /running \w+ hooks/i];
/** `claude logs` 是终端画面流：光标移动当换行，去掉颜色码、转圈字符和状态栏 */
export function cleanClaudeLogs(raw: string): string[] {
  const text = raw
    .replace(/\x1b\[[0-9;?]*[HfBEJ]/g, '\n')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\r/g, '\n');
  const out: string[] = [];
  for (const l of text.split('\n').map((x) => x.trim())) {
    if (l.length < 3 || CLAUDE_CHROME.some((re) => re.test(l))) continue;
    if (out[out.length - 1] !== l) out.push(l);
  }
  return out;
}

type ClaudeAgent = { id?: string; sessionId?: string; name?: string; state?: string; status?: string; pid?: number; error?: string };
async function listClaudeAgents(bin: string, cwd: string): Promise<ClaudeAgent[] | null> {
  try { const j = JSON.parse(await run(bin, ['agents', '--json', '--all'], cwd, cleanEnv(), 15_000)); return Array.isArray(j) ? j : (j.agents ?? []); } catch { return null; }
}
const shortOf = (s: TrackedSession) => s.shortId ?? s.agentSessionId.slice(0, 8);

export const claudeAdapter: AgentAdapter = {
  async start(input, bin, onExit, opts = {}) {
    const log = logPath(input.cwd, input.sessionId);
    const args = claudeStartArgs(input, opts.permissionMode, opts.disallowedTools);
    const name = args[2]!;
    const out = await run(bin, args, input.cwd, cleanEnv(input.env), 60_000).catch((e) => { throw new SessionStartError(`claude --bg 失败：${String(e.message).slice(0, 300)}`); });
    writeFileSync(log, out);
    const list = await listClaudeAgents(bin, input.cwd);
    const shortId = parseClaudeBgId(out) ?? list?.find((a) => a.name === name)?.id ?? null;
    if (!shortId) throw new SessionStartError(`claude --bg 没有返回会话 id：${out.slice(0, 200)}`);
    const a = list?.find((x) => x.id === shortId);
    const s: TrackedSession = { sessionId: input.sessionId, agent: 'claude', agentSessionId: a?.sessionId ?? shortId, shortId, pid: a?.pid ?? null, cwd: input.cwd, logFile: log, state: 'running', mcp: input.mcp };
    pollClaude(bin, s, onExit, opts);
    return s;
  },
  async resume(s, text, bin, onExit, opts = {}) {
    // 一轮结束后进程仍在，直接 --resume 会开副本：先停再按完整 UUID 唤醒（沿用原 --mcp-config / --permission-mode）
    await run(bin, ['stop', shortOf(s)], s.cwd, cleanEnv(), 15_000).catch(() => '');
    const out = await run(bin, ['--bg', '--resume', s.agentSessionId, text], s.cwd, cleanEnv(), 60_000).catch((e) => { throw new SessionStartError(`claude --bg --resume 失败：${String(e.message).slice(0, 300)}`, false); });
    if (/started a copy/i.test(out)) throw new SessionStartError(`claude 续接变成了副本：${out.slice(0, 200)}`, false);
    try { appendFileSync(s.logFile, out); } catch { /* ignore */ }
    s.state = 'running'; pollClaude(bin, s, onExit, opts);
  },
  async stop(s, bin = 'claude') { await run(bin, ['stop', shortOf(s)], s.cwd, cleanEnv(), 15_000).catch(() => ''); s.state = 'stopped'; },
  async logs(s, limit, bin) {
    try { return cleanClaudeLogs(await run(bin, ['logs', shortOf(s)], s.cwd, cleanEnv(), 15_000)).slice(-limit); }
    catch { return existsSync(s.logFile) ? readFileSync(s.logFile, 'utf8').split('\n').slice(-limit) : []; }
  },
};

function pollClaude(bin: string, s: TrackedSession, onExit: OnExit, opts: AdapterOptions) {
  let waiting = false;
  let sawBusy = false;
  const since = Date.now();
  const t = setInterval(async () => {
    if (s.state !== 'running') { clearInterval(t); return; }
    const list = await listClaudeAgents(bin, s.cwd);
    if (!list || s.state !== 'running') return; // 轮询失败不改状态
    const a = list.find((x) => x.sessionId === s.agentSessionId || x.id === s.shortId);
    const st = String(a?.state ?? '').toLowerCase();
    const status = String(a?.status ?? '').toLowerCase();
    if (status === 'busy' || st === 'working') sawBusy = true;
    // 实测：一轮结束后 status=idle，state 可能是 done，也可能是 blocked（最后一句话在等人回复）——都算本轮完成；
    // 刚启动还没开始干活时也可能短暂 idle，所以要先见过 busy 或已超过 60 秒
    const turnOver = status === 'idle' && st !== 'failed' && (sawBusy || Date.now() - since > 60_000);
    if (!a || ['done', 'completed', 'finished', 'exited'].includes(st) || turnOver) {
      clearInterval(t); s.state = 'done';
      await run(bin, ['stop', shortOf(s)], s.cwd, cleanEnv(), 15_000).catch(() => ''); // 释放空闲进程，便于之后按同一 id 续接
      onExit(0, '');
    } else if (['failed', 'error', 'crashed'].includes(st)) {
      clearInterval(t); s.state = 'failed'; onExit(1, String(a.error ?? 'claude 后台会话失败'));
    } else if (st === 'blocked' || String(a.status ?? '').toLowerCase() === 'waiting') {
      if (!waiting) { waiting = true; opts.onWaiting?.(); }
    } else waiting = false;
  }, opts.pollMs ?? 20_000);
  t.unref();
}

// ---------------- codex exec ----------------

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

export const codexAdapter: AgentAdapter = {
  async start(input, bin, onExit, opts = {}) {
    const log = logPath(input.cwd, input.sessionId);
    const p = spawnDetached(bin, codexStartArgs(input, opts.sandbox), input.cwd, cleanEnv(input.env), log, (code, err) => { s.state = code === 0 ? 'done' : 'failed'; s.exitCode = code; onExit(code, err); });
    if (!p.pid) throw new SessionStartError('codex exec 未能启动');
    await new Promise((r) => setTimeout(r, 1500));
    if (p.exitCode !== null && p.exitCode !== 0) throw new SessionStartError(`codex exec 启动即退出（${p.exitCode}）：${tail(log, 5)}`);
    const s: TrackedSession = { sessionId: input.sessionId, agent: 'codex', agentSessionId: readCodexThreadId(log) ?? `pid-${p.pid}`, pid: p.pid, cwd: input.cwd, logFile: log, state: 'running', mcp: input.mcp };
    return s;
  },
  async resume(s, text, bin, onExit, opts = {}) {
    const id = s.agentSessionId.startsWith('pid-') ? readCodexThreadId(s.logFile) : s.agentSessionId;
    if (!id) throw new SessionStartError('找不到 codex 线程 id，无法续接', false);
    const p = spawnDetached(bin, codexResumeArgs(s, id, text, opts.sandbox), s.cwd, cleanEnv(), s.logFile, (code, err) => { s.state = code === 0 ? 'done' : 'failed'; s.exitCode = code; onExit(code, err); });
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
