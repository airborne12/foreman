/**
 * 实验环境用的模拟 worker —— 不跑真实 agent，不消耗任何 Claude / Codex 额度。
 *
 * 按剧本说 worker 协议、并以任务级 token 调中心的 MCP，把一条真实链路完整走一遍：
 *   Jira 入库 → 代码定位 → 分流卡拍板 → 实现 / 出方案 → 提问 → 申请建 PR → 交付
 * 频道里的口语派活由模拟调度员接住（查单 → 出草案，查不到就澄清）。
 *
 * 同时注册两台 runtime：
 *   dev    —— 代码类（build:doris、repo:selectdb/selectdb-core）+ Jira 轮询
 *   center —— 文本类（调度员、候选扫描）
 *
 * 用法：LAB_CENTER=http://127.0.0.1:7899 node --import tsx scripts/lab/sim-worker.ts
 */
import WebSocket from 'ws';
import { request as httpRequest } from 'node:http';
import { makeEnvelope, type Envelope } from '../../packages/shared/src/protocol.js';

const CENTER = process.env.LAB_CENTER ?? 'http://127.0.0.1:7899';
const TOKEN = process.env.LAB_WORKER_TOKEN ?? 'lab-worker-token';
/** 剧本节奏（毫秒）；调小可以更快跑完一轮 */
const BEAT = Number(process.env.LAB_BEAT_MS ?? 2500);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- 假 Jira

type Issue = {
  key: string; summary: string; description: string; project: string; priority: string;
  component: string; version: string; assignee: string; status: string; updated?: string;
  url: string; comments: Array<{ author: string; body: string }>; attachments: Array<{ name: string; url: string }>;
};

const mk = (key: string, summary: string, description: string, priority: string, component: string, version: string, comment?: string): Issue => ({
  key, summary, description, project: key.split('-')[0]!, priority, component, version,
  assignee: 'jiangkai', status: 'Open', url: `https://jira.lab.local/browse/${key}`,
  comments: comment ? [{ author: '客户成功', body: comment }] : [], attachments: [],
});

/** 逐轮放出：第一轮 3 张，之后每轮多 1 张，模拟真实的来单节奏 */
const ISSUES: Issue[] = [
  mk('CIR-30101', 'variant 子列上 match_phrase 查询结果为空', '客户在 variant 列的子路径 `payload.msg` 上建了倒排索引，match_phrase 返回 0 行，match_any 正常。4.1.7 复现。', 'P1', 'inverted-index', '4.1.7', '客户线上阻塞，今天需要结论'),
  mk('CIR-30102', 'ngram 分词 min_gram=1 写入报错 must be less than max_gram', 'ES 迁移场景 min_gram=1,max_gram=8，建索引后写入报 `min_gram must be less than max_gram`。', 'P2', 'inverted-index', '4.0.5'),
  mk('DORIS-31200', '[社区流水线] test_search_score_topn 不稳定', '社区流水线 branch-4.1 上约 1/20 失败，报 SearchExpr should not be executed without inverted index。', 'P2', 'regression', 'master'),
  mk('CIR-30103', 'cumu compaction 之后 search() 少行', '执行 cumulative compaction 后同一条 search() 查询少返回 3 行，full compaction 后恢复。', 'P0', 'storage', '4.1.7', '已拿到复现数据，见附件'),
  mk('DORIS-31201', '文档：倒排索引 support_phrase 参数说明缺失', '官网倒排索引文档没有写 support_phrase 的默认值与对存储的影响。', 'P3', 'docs', 'master'),
];
let released = 0;
const releasedAt = new Map<string, string>();
function pollIssues(): Issue[] {
  released = Math.min(ISSUES.length, released === 0 ? 3 : released + 1);
  return ISSUES.slice(0, released).map((i) => {
    if (!releasedAt.has(i.key)) releasedAt.set(i.key, new Date().toISOString());
    return { ...i, updated: releasedAt.get(i.key)! };
  });
}

// ---------------------------------------------------------------- 会话剧本

type Sess = {
  id: string; runtime: string; kind: string; agent: string; taskKey: string | null;
  mcp: { url: string; token: string }; prompt: string; state: 'running' | 'done' | 'failed' | 'stopped';
  logs: string[]; onResume?: (text: string) => void;
};
const sessions = new Map<string, Sess>();

/**
 * 用 node:http 而不是 fetch：ask_user / request_approval 会阻塞到人回应（最长 30 分钟），
 * fetch（undici）默认 5 分钟等不到响应头就断开，会被误报成「会话失败：fetch failed」。
 */
function postJson(url: string, token: string, body: unknown): Promise<any> {
  return new Promise((resolveP, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${token}` } }, (res) => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolveP(JSON.parse(buf)); } catch { reject(new Error(`MCP 返回非 JSON：${buf.slice(0, 120)}`)); } });
    });
    req.setTimeout(0); req.on('error', reject); req.end(data);
  });
}

async function mcp(s: Sess, tool: string, args: Record<string, unknown>): Promise<any> {
  s.logs.push(`> ${tool} ${JSON.stringify(args).slice(0, 160)}`);
  const j: any = await postJson(s.mcp.url, s.mcp.token, { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } });
  if (j.error) throw new Error(`${tool}: ${j.error.message ?? JSON.stringify(j.error)}`);
  const out = j.result?.structuredContent ?? j.result;
  s.logs.push(`< ${JSON.stringify(out).slice(0, 160)}`);
  return out;
}
const progress = (s: Sess, text: string) => mcp(s, 'report_progress', { taskKey: s.taskKey, text });
const num = (key: string | null) => Number(/(\d+)(?!.*\d)/.exec(key ?? '')?.[1] ?? 0);

/** 读一下任务来源，决定剧本分支（社区单与客户单走不同仓库判断） */
async function sourceOf(s: Sess): Promise<string> {
  try { return JSON.stringify(await mcp(s, 'get_task', { taskKey: s.taskKey })); } catch { return ''; }
}

async function codeLocate(s: Sess) {
  await sleep(BEAT); await progress(s, `已读取 ${s.taskKey} 的上下文包，开始在 selectdb-core 里定位相关代码`);
  const src = await sourceOf(s);
  const community = /DORIS-\d+/.test(src);
  const docsOnly = /文档|docs/.test(src);
  await sleep(BEAT); await progress(s, docsOnly ? '这是文档类问题，不涉及代码改动' : '在 be/src/storage/index 与 be/src/exprs 下找到 4 处相关代码，正在判断改动范围');
  await sleep(BEAT);
  const n = num(s.taskKey);
  await mcp(s, 'deliver', {
    taskKey: s.taskKey,
    summary: '代码定位完成',
    artifacts: [{
      kind: 'triage',
      tier: docsOnly ? 'plan' : n % 3 === 0 ? 'plan' : 'fix',
      effort: n % 2 === 0 ? 'medium' : 'small',
      // 社区单：agent 拿不准仓库（置信度低 → 面板要求先选仓库）；客户单：明确是 selectdb-core
      repo: community ? { name: null, confidence: 0.35, candidates: ['apache/doris', 'selectdb/selectdb-core'] } : { name: 'selectdb/selectdb-core', confidence: 0.92, candidates: ['selectdb/selectdb-core'] },
      suggestedPath: docsOnly ? '出方案：补文档说明，不改代码' : '简单修复：在索引下推前判断子列类型，补回归用例',
      targetBranch: n % 2 === 1 ? 'branch-selectdb-doris-4.1' : null,
      codeLocations: docsOnly ? [] : [
        { file: 'be/src/storage/index/inverted/inverted_index_reader.cpp', line: 412, symbol: 'InvertedIndexReader::query', why: '子列路径没有展开成真实列名' },
        { file: 'be/src/exprs/vsearch.cpp', line: 193, symbol: 'VSearchExpr::execute_column', why: '无索引时直接报错，没有降级' },
        { file: 'be/src/exec/operator/olap_scan_operator.cpp', line: 488, symbol: '_should_push_down_common_expr', why: '下推条件受 session 变量控制' },
        { file: 'regression-test/suites/search/test_search_variant.groovy', line: null, symbol: null, why: '现有用例未覆盖子列' },
      ],
    }],
  });
  finish(s, 'done');
}

async function implement(s: Sess) {
  const n = num(s.taskKey);
  await sleep(BEAT); await progress(s, '开始复现：按 Jira 描述建表写数，已稳定复现');
  await sleep(BEAT); await progress(s, '根因：子列路径在下推时没有展开，读到的是父列的空索引');
  if (n % 2 === 0) {
    s.state = 'running';
    const a = await mcp(s, 'ask_user', { taskKey: s.taskKey, question: '修复要同时回合到 master 吗？还是只修 4.1 分支？', options: ['只修 4.1', '4.1 和 master 都修'] });
    await progress(s, a?.answered ? `收到回答：「${a.answer}」，按这个范围改` : '提问超时，先按只修 4.1 处理，PR 里写明');
  }
  await sleep(BEAT); await progress(s, '改动完成（3 个文件 +48/-6），本地 UT 12/12 通过');
  const branch = `foreman/${s.taskKey}`;
  const ap = await mcp(s, 'request_approval', {
    taskKey: s.taskKey, actionType: 'create_pr',
    title: `创建 PR：airborne12:${branch} → selectdb/selectdb-core branch-selectdb-doris-4.1`,
    body: `## 改了什么\n子列路径在倒排索引下推前展开成真实列名，修复 variant 子列上 match_phrase 返回空。\n\n## 怎么验证\n- 新增回归用例 test_search_variant_subcolumn\n- 本地 BE UT 12/12 通过\n\n## 影响\n只影响 variant 子列上的倒排索引查询。`,
    payload: { executor: 'agent', repo: 'selectdb/selectdb-core', head: `airborne12:${branch}`, base: 'branch-selectdb-doris-4.1', commit: 'a1b2c3d4e5f6', pushRemote: 'fork' },
  });
  if (ap?.approved) {
    await sleep(BEAT);
    await mcp(s, 'deliver', { taskKey: s.taskKey, summary: 'PR 已创建', artifacts: [{ kind: 'pr', url: `https://github.com/selectdb/selectdb-core/pull/${7000 + n}`, title: `[fix](search) expand variant sub-column before index pushdown (${s.taskKey})`, diffStat: { additions: 48, deletions: 6, files: 3 } }] });
  } else {
    await progress(s, `建 PR 没被批准${ap?.comment ? `：${ap.comment}` : ''}，本轮停在这里`);
  }
  finish(s, 'done');
}

async function plan(s: Sess) {
  await sleep(BEAT); await progress(s, '梳理现状与可选方案');
  await sleep(BEAT);
  await mcp(s, 'deliver', {
    taskKey: s.taskKey, summary: '方案文档已交付',
    artifacts: [{ kind: 'doc', path: `docs/plan-${s.taskKey}.md`, title: `${s.taskKey} 方案`, content: `# ${s.taskKey} 方案\n\n## 背景\n问题只在 4.1 线出现。\n\n## 方案 A（推荐）\n在下推前展开子列路径，改动 3 个文件。\n\n## 方案 B\n关闭该场景下推，性能下降约 30%。\n\n## 风险\n需要回归 variant 相关用例。` }],
  });
  finish(s, 'done');
}

async function simple(s: Sess, what: string) {
  await sleep(BEAT); await progress(s, `${what}进行中`);
  await sleep(BEAT); finish(s, 'done');
}

/** 模拟调度员：查单 → 出草案；看不出单号就澄清。会话常驻，后续消息通过 resume 送进来 */
async function dispatcher(s: Sess) {
  const channel = /你是频道 (\S+?)（/.exec(s.prompt)?.[1] ?? 'inbox';
  const handle = async (text: string) => {
    const key = /\b([A-Z]{2,}-\d+)\b/.exec(text)?.[1];
    await sleep(BEAT / 2);
    if (!key) {
      await mcp(s, 'ask_clarification', { channel, text: '没看到单号。你是想新建一个任务，还是指已有的某个任务？可以直接发 Jira 单号。' });
      return;
    }
    const j = await mcp(s, 'lookup_jira', { key });
    if (!j?.found) { await mcp(s, 'ask_clarification', { channel, text: `查不到 ${key}，是不是单号写错了？` }); return; }
    const cir = key.startsWith('CIR-');
    await mcp(s, 'propose_task', {
      channel, source: key, sourceTitle: j.issue?.summary ?? key,
      ...(cir ? { repo: 'selectdb/selectdb-core', repoSource: 'mapping' } : {}),
      path: /方案|设计/.test(text) ? 'plan' : 'fix', note: `按「${text.slice(0, 40)}」起草`,
    });
  };
  const first = /- \[user\/user\] (.+)/.exec(s.prompt)?.[1];
  if (first) await handle(first);
  s.onResume = (t) => { void handle(t).catch((e) => log('dispatcher', e.message)); };
}

async function runScript(s: Sess) {
  try {
    switch (s.kind) {
      case 'code_locate': return await codeLocate(s);
      case 'implement': return await implement(s);
      case 'plan': return await plan(s);
      case 'proto': return await simple(s, '原型');
      case 'review': return await simple(s, 'review');
      case 'dispatcher': return await dispatcher(s);
      default: return await simple(s, s.kind);
    }
  } catch (e) {
    log('script failed', s.kind, s.taskKey, (e as Error).message);
    finish(s, 'failed', (e as Error).message);
  }
}

// ---------------------------------------------------------------- 协议

type Rt = { name: string; ws?: WebSocket; hb?: NodeJS.Timeout; reg: Record<string, unknown> };
const RUNTIMES: Rt[] = [
  { name: 'dev', reg: { transport: 'reverse-tunnel', labels: ['agent:claude', 'agent:codex', 'vpn:jira', 'repo:selectdb/selectdb-core', 'build:doris'], agents: { claude: { bin: 'claude', maxConcurrent: 3 }, codex: { bin: 'codex', maxConcurrent: 3 } }, repos: { 'selectdb/selectdb-core': { main: '/lab/selectdb-core', worktreeRoot: '/lab/wt' } }, capabilities: ['jira-poll', 'jira-lookup', 'gh'] } },
  { name: 'center', reg: { transport: 'local', labels: ['agent:claude', 'agent:codex', 'text'], agents: { claude: { bin: 'claude', maxConcurrent: 3 }, codex: { bin: 'codex', maxConcurrent: 3 } }, repos: {}, capabilities: [] } },
];
const rtOf = (name: string) => RUNTIMES.find((r) => r.name === name)!;
function send(rt: Rt, type: string, payload: Record<string, unknown>, ref?: string) {
  rt.ws?.send(JSON.stringify(makeEnvelope(type, payload, { ref: ref ?? null })));
}
function finish(s: Sess, state: 'done' | 'failed', failureReason?: string) {
  if (s.state === 'stopped') return;
  s.state = state;
  send(rtOf(s.runtime), 'session.state', { sessionId: s.id, state, source: 'exit', exitCode: state === 'done' ? 0 : 1, failureReason: failureReason ?? null, observedAt: new Date().toISOString() });
  log(`session ${s.kind} ${s.taskKey ?? ''} → ${state}`);
}

function handle(rt: Rt, env: Envelope) {
  const p = env.payload as any;
  switch (env.type) {
    case 'register.ack': {
      log(`${rt.name} 已注册`);
      clearInterval(rt.hb);
      rt.hb = setInterval(() => {
        const running = [...sessions.values()].filter((s) => s.runtime === rt.name && s.state === 'running');
        const byAgent: Record<string, number> = {};
        for (const s of running) byAgent[s.agent] = (byAgent[s.agent] ?? 0) + 1;
        send(rt, 'heartbeat', { load: 0.3, disk: { path: '/lab', usedRatio: 0.42, freeBytes: 500_000_000_000 }, sessions: byAgent });
      }, Math.max(5, Number(p.heartbeatSeconds ?? 30)) * 1000);
      for (const c of (p.pendingCommands ?? []) as Envelope[]) handle(rt, c);
      return;
    }
    case 'job.run': {
      const kind = p.kind as string;
      if (kind === 'jira-poll') { const issues = pollIssues(); log(`jira-poll → ${issues.length} 张`); return send(rt, 'job.result', { ok: true, result: { issues, fetchedAt: new Date().toISOString() } }, env.id); }
      if (kind === 'jira-lookup') { const i = ISSUES.find((x) => x.key === p.args?.key); return send(rt, 'job.result', { ok: true, result: { found: !!i, issue: i ? { ...i, updated: new Date().toISOString() } : null } }, env.id); }
      if (kind === 'gh-pr-view') return send(rt, 'job.result', { ok: true, result: { number: p.args?.number ?? 0, title: 'lab PR', state: 'OPEN', url: 'https://github.com/lab/pr' } }, env.id);
      return send(rt, 'job.result', { ok: false, error: { code: 'INTERNAL', message: `实验环境不支持 ${kind}` } }, env.id);
    }
    case 'worktree.create': {
      const base = String(p.baseBranch ?? '');
      // 4.1 线在开发机上没有匹配的 thirdparty（真实情况），这里照实回报，把降级路径也走一遍
      return send(rt, 'worktree.ready', { taskKey: p.taskKey, path: `/lab/wt/${p.taskKey}`, branchName: p.branchName ?? `foreman/${p.taskKey}`, reused: false, baseBranch: base, buildEnvMissing: base.includes('4.1') }, env.id);
    }
    case 'worktree.gc':
      return send(rt, 'worktree.gc.result', { dryRun: !!p.dryRun, removed: [], skippedRunning: 0, freedBytes: 0, diskUsedRatioAfter: 0.42 }, env.id);
    case 'session.start': {
      const s: Sess = { id: p.sessionId, runtime: rt.name, kind: p.kind, agent: p.agent, taskKey: p.taskKey ?? null, mcp: p.mcp, prompt: p.prompt ?? '', state: 'running', logs: [`$ ${p.agent} (lab) ${p.kind} ${p.taskKey ?? ''}`] };
      sessions.set(s.id, s);
      send(rt, 'session.started', { sessionId: s.id, agentSessionId: `lab-${s.id.slice(0, 8)}`, startedAt: new Date().toISOString(), pid: null }, env.id);
      log(`session.start ${s.kind} ${s.taskKey ?? ''} on ${rt.name}/${s.agent}`);
      void runScript(s);
      return;
    }
    case 'session.resume': {
      const s = sessions.get(p.sessionId);
      if (!s) return send(rt, 'error', { code: 'RESUME_FAILED', message: '会话不在本 runtime', retryable: false }, env.id);
      s.state = 'running'; s.logs.push(`>> ${String(p.text).slice(0, 200)}`);
      send(rt, 'session.state', { sessionId: s.id, state: 'running', source: 'poll', observedAt: new Date().toISOString() }, env.id);
      if (s.onResume) s.onResume(String(p.text));
      else void (async () => { await sleep(BEAT); await progress(s, `收到补充说明：「${String(p.text).slice(0, 60)}」，已按此调整`); finish(s, 'done'); })().catch(() => undefined);
      return;
    }
    case 'session.stop': {
      const s = sessions.get(p.sessionId);
      if (s) s.state = 'stopped';
      return send(rt, 'session.state', { sessionId: p.sessionId, state: 'stopped', source: 'poll', observedAt: new Date().toISOString() }, env.id);
    }
    case 'session.logs': {
      const s = sessions.get(p.sessionId);
      const lines = s?.logs ?? [];
      return send(rt, 'session.logs.result', { sessionId: p.sessionId, lines: lines.slice(-(p.limit ?? 400)), truncated: lines.length > (p.limit ?? 400) }, env.id);
    }
    case 'error':
      return log(`${rt.name} 收到错误`, JSON.stringify(p));
    default:
      return send(rt, 'error', { code: 'UNKNOWN_COMMAND', message: env.type, retryable: false }, env.id);
  }
}

function connect(rt: Rt) {
  const ws = new WebSocket(`${CENTER.replace(/^http/, 'ws')}/ws/worker`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  rt.ws = ws;
  ws.on('open', () => send(rt, 'register', { name: rt.name, instanceId: crypto.randomUUID(), version: '0.1.0', disk: { path: '/lab', usedRatio: 0.42 }, ...rt.reg }));
  ws.on('message', (d) => { try { handle(rt, JSON.parse(String(d))); } catch (e) { log('handle', (e as Error).message); } });
  ws.on('close', () => { clearInterval(rt.hb); log(`${rt.name} 断开，3 秒后重连`); setTimeout(() => connect(rt), 3000); });
  ws.on('error', () => undefined);
}

for (const rt of RUNTIMES) connect(rt);
log(`模拟 worker 已启动 → ${CENTER}（节奏 ${BEAT}ms）`);
