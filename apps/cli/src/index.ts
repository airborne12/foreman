/**
 * foreman CLI（来源：core-03-runtime-cli-design.md §2 命令树；本批实现 worker/center/runtime/task 子集）
 */
import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkerConfig } from '@foreman/shared';
import { foremanHome, loadWorkerConfig, writeWorkerConfig, workerConfigPath, loadEnvFile } from '../../worker/src/config.js';
import { probe, formatProbe } from '../../worker/src/probe.js';
import { Worker } from '../../worker/src/worker.js';

const program = new Command();
program.name('foreman').description('foreman：任务为中心的 AI 协作平台 CLI').version('0.1.0');
program.option('--center-url <url>', '中心地址（默认读 FOREMAN_CENTER_URL 或 worker.yaml）').option('--json', '机器可读输出');

function centerHttp(): string {
  const o = program.opts();
  const url = o.centerUrl ?? process.env.FOREMAN_CENTER_URL ?? tryWorkerCenter() ?? 'http://127.0.0.1:7801';
  return url.replace(/^ws/, 'http').replace(/\/$/, '');
}
function tryWorkerCenter(): string | undefined {
  try { return loadWorkerConfig(process.env.FOREMAN_WORKER_CONFIG).center.url; } catch { return undefined; }
}
function panelToken(): string { loadEnvFile(); return process.env.FOREMAN_PANEL_TOKEN ?? process.env.FOREMAN_TOKEN ?? ''; }
async function api(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(centerHttp() + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? panelToken()}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}
function out(obj: unknown, human: () => string) { if (program.opts().json) console.log(JSON.stringify(obj, null, 2)); else console.log(human()); }

// ---------------- worker ----------------
const worker = program.command('worker').description('runtime 侧 worker');

worker.command('init').description('初始化 worker.yaml（探测本机能力）')
  .option('--non-interactive', '不提问，全部取参数')
  .option('--name <name>', 'runtime 名').option('--center <url>', '中心 ws 地址').option('--transport <t>', 'direct|reverse-tunnel|local', 'direct')
  .option('--token <token>', '预共享 token').option('--repo <name=path...>', '仓库 name=path，可重复').option('--labels <csv>', '额外标签').option('--config <path>', '输出路径')
  .action((o) => {
    const repos: Record<string, string> = {};
    for (const r of (o.repo as string[] | undefined) ?? []) { const [n, p] = r.split('='); if (n && p) repos[n] = p; }
    const p = probe({ repos });
    console.log('foreman worker · 初始化\n');
    console.log(formatProbe(p));
    if (!o.nonInteractive && (!o.name || !o.center || !o.token)) { console.error('\n非交互环境请提供 --non-interactive --name --center --token'); process.exit(2); }
    const name = o.name ?? 'laptop';
    const labels = [...new Set([...p.labels, ...String(o.labels ?? '').split(',').filter(Boolean)])];
    const agents: WorkerConfig['agents'] = {};
    for (const [a, r] of Object.entries(p.agents)) if (r.ok) agents[a] = { bin: r.bin, version: r.version, maxConcurrent: 3 };
    const cfg = WorkerConfig.parse({
      name, center: { url: o.center ?? 'ws://127.0.0.1:7801', token: o.token ?? '' }, transport: o.transport, labels, agents,
      repos: Object.fromEntries(Object.entries(p.repos).map(([n, r]) => [n, { main: r.main, worktreeRoot: r.worktreeRoot }])),
      capabilities: p.capabilities,
    });
    const path = writeWorkerConfig(cfg, o.config, { tokenLiteral: o.token });
    console.log(`\n已生成 ${path}\n  name: ${cfg.name}\n  transport: ${cfg.transport}\n  labels: ${labels.join(', ')}`);
    for (const w of p.warnings) console.log(`  ⚠ ${w}`);
    console.log('\n下一步：\n  foreman worker doctor    检查能力\n  foreman worker start     注册并常驻');
  });

worker.command('doctor').description('自检：中心连通、token、agent、仓库、磁盘').option('--config <path>')
  .action(async (o) => {
    let cfg: WorkerConfig;
    try { cfg = loadWorkerConfig(o.config); } catch (e) { console.error(String((e as Error).message)); process.exit(1); }
    const http = cfg.center.url.replace(/^ws/, 'http').replace(/\/$/, '');
    let errors = 0, warnings = 0;
    const line = (ok: boolean | 'warn', label: string, msg: string) => { console.log(`  ${label.padEnd(10)}${ok === true ? '✓' : ok === 'warn' ? '⚠' : '✗'} ${msg}`); if (ok === false) errors++; if (ok === 'warn') warnings++; };
    console.log('');
    try {
      const t0 = Date.now();
      const h = await fetch(`${http}/healthz`, { signal: AbortSignal.timeout(5000) });
      line(h.ok, '中心连通', `${http} (${Date.now() - t0}ms)`);
    } catch {
      const hint = cfg.transport === 'reverse-tunnel' ? '请先在中心机运行 foreman center tunnel <name> up' : '请检查网络与中心地址';
      line(false, '中心连通', `失败：${http}，${hint}`);
    }
    if (errors === 0) {
      const r = await fetch(`${http}/api/runtimes/auth-check`, { method: 'POST', headers: { authorization: `Bearer ${cfg.center.token}` } }).catch(() => null);
      if (r?.status === 200) line(true, 'token', '有效'); else line(false, 'token', 'token 无效（AUTH_INVALID）');
    }
    for (const [a, ac] of Object.entries(cfg.agents)) line(existsSync(ac.bin) || probe({}).agents[a]?.ok === true, a, ac.bin);
    if (!cfg.agents.codex) line('warn', 'codex', '未标记 agent:codex（未找到可用二进制）');
    for (const [n, r] of Object.entries(cfg.repos)) line(existsSync(r.main), '仓库', `${n} → ${r.main}`);
    console.log(`\n${errors} error, ${warnings} warning · ${errors === 0 ? '可以启动' : '请先修复错误'}`);
    process.exit(errors === 0 ? 0 : 1);
  });

worker.command('start').description('启动 worker（本批只支持 --foreground）').option('--config <path>').option('--foreground', '前台运行')
  .action((o) => {
    const cfg = loadWorkerConfig(o.config);
    const w = new Worker({ config: cfg, stateFile: process.env.FOREMAN_WORKER_STATE, backoffScale: process.env.FOREMAN_BACKOFF_SCALE ? Number(process.env.FOREMAN_BACKOFF_SCALE) : undefined });
    w.start();
    const stop = () => { w.stop(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  });

worker.command('status').description('本机 worker 状态').option('--config <path>')
  .action((o) => {
    const f = process.env.FOREMAN_WORKER_STATE ?? resolve(foremanHome(), 'worker-state.json');
    if (!existsSync(f)) { out({ state: 'unknown' }, () => 'worker 未运行（无状态文件）'); return; }
    const s = JSON.parse(readFileSync(f, 'utf8'));
    out(s, () => `state: ${s.state}${s.lastError ? ` · ${s.lastError}` : ''}${s.nextRetryAt ? ` · next retry ${s.nextRetryAt}` : ''}`);
  });

worker.command('gc').description('回收终态 worktree（经中心决策）').option('--dry-run').option('--config <path>')
  .action(async (o) => {
    const cfg = loadWorkerConfig(o.config);
    const r = await api('POST', `/api/runtimes/${cfg.name}/gc`, { dryRun: !!o.dryRun, policy: 'retain_days' });
    if (r.status !== 200) { console.error(r.json?.message ?? r.json); process.exit(1); }
    const res = r.json;
    out(res, () => [`候选（终态超过 3 天）：`, ...res.removed.map((x: any) => `  ${x.taskKey.padEnd(28)}${(x.terminalAt ?? '').slice(0, 10)}  ${(x.bytes / 1e9).toFixed(1)}G  ${x.path}`), `合计可释放 ${(res.freedBytes / 1e9).toFixed(1)}G`, res.dryRun ? 'dry-run：未删除任何文件。去掉 --dry-run 执行。' : '已删除。'].join('\n'));
  });

// ---------------- center ----------------
const center = program.command('center').description('中心服务');
center.command('start').description('启动中心（前台）').action(async () => { await import('../../center/src/index.js'); });
center.command('status').description('中心健康').action(async () => {
  const r: any = await fetch(`${centerHttp()}/healthz`).then((x) => x.json()).catch((e) => ({ status: 'down', error: String(e) }));
  out(r, () => `center: ${r.status} · db ${r.checks?.database} · feishu ${r.checks?.feishuSubscription} · runtimes ${r.checks?.onlineRuntimes}`);
});
// 设计文法：foreman center tunnel <runtime> up|down|status
center.command('tunnel <name> <action>').description('反向隧道：up | down | status').action(async (name: string, action: string) => {
  if (action === 'up') {
    const r = await api('POST', `/api/system/tunnels/${name}/up`);
    if (r.status !== 200) { console.error(r.json?.message ?? JSON.stringify(r.json)); process.exit(1); }
    out(r.json, () => `tunnel ${name}: ${r.json.state}\n  remote 127.0.0.1:7801 → center 127.0.0.1:7801`);
  } else if (action === 'down') {
    const r = await api('POST', `/api/system/tunnels/${name}/down`);
    out(r.json, () => `tunnel ${name}: down`);
  } else if (action === 'status') {
    const r = await api('GET', `/api/system/tunnels/${name}`);
    if (r.status !== 200) { out({ state: 'down' }, () => `tunnel ${name}: not started`); process.exit(1); }
    out(r.json, () => `tunnel ${name}: ${r.json.state} (reconnects: ${r.json.reconnects}${r.json.lastError ? `, last error: ${r.json.lastError}` : ''})`);
  } else { console.error(`未知动作 ${action}（up | down | status）`); process.exit(2); }
});

// ---------------- runtime ----------------
const runtime = program.command('runtime').description('runtime 查询');
runtime.command('list').action(async () => {
  const r = await api('GET', '/api/runtimes');
  out(r.json, () => ['NAME     STATE                         TRANSPORT        SESSIONS  DISK  LABELS', ...r.json.items.map((x: any) => `${x.name.padEnd(9)}${(x.online ? 'online' : `offline (last heartbeat ${ago(x.lastSeenAt)})`).padEnd(30)}${x.transport.padEnd(17)}${`${x.sessions}/${x.maxSessions}`.padEnd(10)}${(x.diskUsedRatio == null ? '–' : Math.round(x.diskUsedRatio * 100) + '%').padEnd(6)}${x.labels.join(' ')}`)].join('\n'));
});
runtime.command('show <name>').action(async (name) => { const r = await api('GET', `/api/runtimes/${name}`); out(r.json, () => JSON.stringify(r.json, null, 2)); });

// ---------------- task ----------------
const task = program.command('task').description('任务');
task.command('new').requiredOption('--source <ref>').option('--repo <repo>').requiredOption('--path <p>', 'fix|plan|proto').option('--kind <k>').option('--runtime <n>').option('--agent <a>').option('--channel <slug>')
  .action(async (o) => {
    const r = await api('POST', '/api/tasks', { source: o.source, repo: o.repo, path: o.path, kind: o.kind, runtime: o.runtime, agent: o.agent, channel: o.channel });
    if (r.status !== 201) { console.error(r.json?.message ?? JSON.stringify(r.json)); process.exit(1); }
    const t = r.json;
    out(t, () => `${t.key} created (${t.state})\n  source:  ${t.source.type} ${t.source.ref}\n  repo:    ${t.repo.name ?? '待确认'}\n  path:    ${t.path}\n  routing: ${t.runtime ?? `queued（${t.queueReason}）`}`);
  });
task.command('list').option('--state <s>').action(async (o) => {
  const r = await api('GET', `/api/tasks${o.state ? `?state=${o.state}` : ''}`);
  out(r.json, () => ['ID     STATE               RUNTIME  AGENT   TITLE', ...r.json.items.map((t: any) => `${t.key.padEnd(7)}${t.state.padEnd(20)}${(t.runtime ?? '-').padEnd(9)}${(t.agent ?? '-').padEnd(8)}${t.title}`)].join('\n'));
});
task.command('show <key>').action(async (key) => { const r = await api('GET', `/api/tasks/${key}`); out(r.json, () => JSON.stringify(r.json, null, 2)); });

function ago(iso: string | null) { if (!iso) return 'never'; const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s ago` : `${Math.floor(s / 3600)}h ago`; }

program.parseAsync(process.argv).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
