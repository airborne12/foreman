/**
 * center 组装：HTTP（Hono）+ WebSocket（worker / panel）+ 领域核心 + 调度器 + 隧道。
 * 来源：architecture 2.2/2.3
 */
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import pino, { type Logger } from 'pino';
import { ApiError, HEARTBEAT_SECONDS, type CenterConfig } from '@foreman/shared';
import { Db, findRepoRoot } from './db.js';
import { SystemClock, FakeClock, type Clock } from './clock.js';
import { EventBus } from './events.js';
import { FakeFeishu, LarkCliFeishu, type FeishuAdapter } from './adapters/feishu.js';
import { Notifications } from './domain/notifications.js';
import { Runtimes } from './domain/runtimes.js';
import { Worktrees } from './domain/worktrees.js';
import { Tasks } from './domain/tasks.js';
import { Approvals } from './domain/approvals.js';
import { Intake } from './domain/intake.js';
import { Dispatch } from './domain/dispatch.js';
import { McpService } from './domain/mcp.js';
import { Questions } from './domain/questions.js';
import { FeishuIntake } from './domain/feishuIntake.js';
import { Channels } from './domain/channels.js';
import { WORKER_TO_CENTER } from '@foreman/shared';
import { WorkerHub } from './hub/workerHub.js';
import { PanelHub } from './hub/panelHub.js';
import { Scheduler } from './scheduler.js';
import { TunnelManager } from './tunnel.js';
import { systemRoutes } from './routes/system.js';
import { runtimeRoutes } from './routes/runtimes.js';
import { taskRoutes } from './routes/tasks.js';
import { testRoutes } from './routes/test.js';
import { approvalRoutes } from './routes/approvals.js';
import { mcpRoutes } from './routes/mcp.js';
import { channelRoutes } from './routes/channels.js';

export interface AppContext {
  config: CenterConfig;
  db: Db;
  clock: Clock;
  log: Logger;
  events: EventBus;
  feishu: FeishuAdapter | null;
  feishuSubscription: 'ok' | 'down' | 'disabled';
  notifications: Notifications;
  runtimes: Runtimes;
  worktrees: Worktrees;
  tasks: Tasks;
  approvals: Approvals;
  intake: Intake;
  dispatch: Dispatch;
  mcp: McpService;
  questions: Questions;
  feishuIntake: FeishuIntake;
  channels: Channels;
  workerHub: WorkerHub;
  panelHub: PanelHub;
  scheduler: Scheduler;
  schedulerRunning: boolean;
  tunnels: TunnelManager;
  hono: Hono;
}

export interface StartedApp extends AppContext {
  server: ServerType;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function createApp(config: CenterConfig, opts?: { clock?: Clock; feishu?: FeishuAdapter | null; log?: Logger; migrate?: boolean }): Promise<AppContext> {
  const log = opts?.log ?? pino({ level: process.env.LOG_LEVEL ?? (config.test_mode ? 'warn' : 'info') });
  const clock = opts?.clock ?? (config.test_mode ? new FakeClock() : new SystemClock());
  const db = new Db(config.database);
  if (opts?.migrate !== false) await db.migrate();
  const events = new EventBus(db, clock);
  const feishu: FeishuAdapter | null = opts?.feishu !== undefined ? opts.feishu : config.test_mode ? new FakeFeishu() : config.feishu.enabled ? new LarkCliFeishu(config.feishu.lark_cli, config.feishu.bot_open_id) : null;
  const notifications = new Notifications(db, clock, feishu, config);
  const runtimes = new Runtimes(db, clock, events, notifications);
  const worktrees = new Worktrees(db, clock, events, config.worktree);
  const tasks = new Tasks(db, clock, events, config, runtimes);
  const workerHub = new WorkerHub({ db, clock, runtimes, worktrees, workerToken: config.token, log, highWatermark: config.worktree.disk_high_watermark });
  const panelHub = new PanelHub({ events, clock, panelToken: config.panel_token });
  const scheduler = new Scheduler(db, clock, log);
  const tunnels = new TunnelManager({ db, clock, log, sshBin: config.ssh_bin, tunnels: config.tunnels, notifications });
  const approvals = new Approvals(db, clock, events, config, notifications);
  const intake = new Intake(db, clock, events, config, workerHub, tasks, approvals, notifications);
  const dispatch = new Dispatch(db, clock, events, config, workerHub, tasks, approvals, intake, notifications);
  const mcp = new McpService(db, clock, events, tasks, approvals, dispatch, intake);
  mcp.repoBase = config.repo_base_branch;
  const questions = new Questions(db, clock, events, config, notifications, workerHub);
  dispatch.questions = questions; mcp.questions = questions;
  const feishuIntake = new FeishuIntake(db, clock, events, config, feishu, tasks, intake, notifications, dispatch);
  const channels = new Channels(db, clock, events, config, workerHub, tasks, intake, dispatch, approvals);
  mcp.feishuIntake = feishuIntake; mcp.channels = channels;

  const ctx: AppContext = {
    config, db, clock, log, events, feishu, feishuSubscription: feishu ? (config.test_mode ? 'ok' : 'down') : 'disabled',
    notifications, runtimes, worktrees, tasks, approvals, intake, dispatch, mcp, questions, feishuIntake, channels, workerHub, panelHub, scheduler, schedulerRunning: false, tunnels, hono: new Hono(),
  };

  // 审批决定 → 派发；中心执行器（镜像回写）
  approvals.afterDecided((a, d) => dispatch.onApprovalDecided(a, d));
  approvals.registerExecutor('jira_comment', (x) => dispatch.mirrorToJira(x));
  approvals.registerExecutor('feishu_reply', (x) => dispatch.mirrorToFeishu(x));

  // worker → center 消息（S01 Step 8、S03 Step 12/17/31）
  workerHub.on('job.result', async (conn, env) => { const r = WORKER_TO_CENTER['job.result'].parse(env.payload); if (env.ref) await intake.onJobResult(env.ref, conn.name, r); });
  workerHub.on('worktree.ready', async (conn, env) => dispatch.onWorktreeReady(conn.name, WORKER_TO_CENTER['worktree.ready'].parse(env.payload)));
  workerHub.on('session.started', async (conn, env) => dispatch.onSessionStarted(conn.name, WORKER_TO_CENTER['session.started'].parse(env.payload)));
  workerHub.on('session.state', async (conn, env) => dispatch.onSessionState(conn.name, WORKER_TO_CENTER['session.state'].parse(env.payload)));
  workerHub.on('error', async (conn, env) => dispatch.onWorkerError(conn.name, env));
  workerHub.onRegistered(async (name, replayed) => { await intake.onRuntimeOnline(name); await dispatch.onRuntimeOnline(name, replayed); });
  // 会话失联（worker 重启等）：没有善后的话任务会无声僵死在 triaging / running
  workerHub.onSessionsLost(async (name, lost) => {
    for (const s of lost) {
      if (!s.task_id) continue;
      const t = await db.one<{ key: string }>('SELECT key FROM tasks WHERE id=$1', [s.task_id]);
      if (s.kind === 'code_locate') await intake.emitTriage(s.task_id, s.id, { degraded: true, degradedReason: `代码定位会话失联（${name} 上已不存在），可重试` });
      else await dispatch.failTask(s.task_id, `会话失联：${name} 上已不存在该会话`, ['retry', 'switch_agent', 'abandon']);
      await channels.escalateToChannel(s.task_id, `${t?.key ?? '任务'} 的${s.kind === 'code_locate' ? '代码定位' : ''}会话在 ${name} 上失联（worker 重启或进程退出），已按降级处理。需要的话在这里说一声怎么继续。`, { reason: 'session_lost', sessionKind: s.kind });
    }
  });

  // 审批决定后：等待者已不在时，把决定连同上下文送进频道，别让任务僵死（S06 Step 20 之后的分支）
  approvals.afterDecided(async (a, d) => {
    if (d.via === 'auto' || !a.task_id) return;
    if (d.hadWaiter) return; // 有人正阻塞等这个结果，原路返回即可
    if (a.action_type === 'triage_confirm') return; // 分流卡的去向由 onApprovalDecided 处理
    // 只承接「要 agent 接着做」的动作。jira_comment 这类由中心执行器代跑，批准后自有执行链路与失败卡，
    // 再往频道推一条只会盖掉真正该看的失败提示（口径与 approvals.execute 一致）
    const byAgent = (a.payload as any)?.executor === 'agent' || ((a.payload as any)?.executor !== 'center' && a.session_id);
    if (!byAgent) return;
    if (d.approved) {
      const s = a.session_id ? await db.one<any>('SELECT state FROM sessions WHERE id=$1', [a.session_id]) : null;
      if (s && ['done', 'stopped', 'failed'].includes(s.state)) return; // 可续接，dispatch 已送回「已批准」
    }
    const verb = d.approved ? '已批准' : '已否决';
    const reason = d.comment ? `\n理由：${d.comment}` : '';
    await channels.escalateToChannel(a.task_id, `审批 ${a.key}（${a.action_type}）${verb}，但关联会话已经结束，没人接得住这个结果。${reason}\n原正文摘要：${(a.final_body ?? a.body).slice(0, 500)}\n请在这里决定下一步怎么做。`, { reason: 'approval_decided_no_waiter', approvalKey: a.key, approved: d.approved });
  });

  // 调度作业（S05 Step 21；通知重试）
  scheduler.register('heartbeat-check', HEARTBEAT_SECONDS * 1000, async () => ({ offline: await runtimes.checkHeartbeats() }));
  scheduler.register('notification-retry', 60_000, async () => { await notifications.retryDue(); return {}; });
  // S01 Step 1：Jira 轮询；EX-22.1 代码定位超时；EX-28.2 整点汇总
  scheduler.register('jira-poll', config.sources.jira.poll_seconds * 1000, async () => (config.sources.jira.enabled ? intake.pollJira() : { skipped: true, reason: 'jira disabled' }));
  scheduler.register('progress-watch', 60_000, async () => ({ ...(await intake.watchCodeLocateTimeouts()), ...(await dispatch.watchStaleSessions()), ...(await feishuIntake.watchCandidateScanTimeouts()) }));
  // S02 Step 18：候选扫描；EX-8.1 上下文补齐；S04 Step 37：调度员空闲回收与响应超时
  scheduler.register('candidate-scan', config.sources.feishu.scan_seconds * 1000, async () => (config.sources.feishu.scan_enabled ? feishuIntake.scanCandidates() : { skipped: true, reason: 'DISABLED' }));
  scheduler.register('context-retry', 60_000, async () => feishuIntake.retryContext());
  scheduler.register('dispatcher-idle', 60_000, async () => channels.watchDispatchers());
  scheduler.register('feishu-digest', 3600_000, async () => intake.digest());
  scheduler.register('worktree-gc', 3600_000, async () => {
    const rts = await db.query<{ name: string; id: string }>(`SELECT name, id FROM runtimes WHERE online`);
    const out: Record<string, unknown> = {};
    for (const rt of rts.rows) {
      if (!workerHub.isOnline(rt.name)) continue;
      try { out[rt.name] = await workerHub.triggerGc({ ws: null as any, name: rt.name, instanceId: '', runtimeId: rt.id, executed: new Map() }, 'retain_days', false); }
      catch (e) { out[rt.name] = { error: String(e) }; }
    }
    return out;
  }, { detached: true });

  const hono = ctx.hono;
  hono.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as any);
    log.error({ err: String(err), stack: (err as Error).stack }, 'unhandled');
    return c.json({ code: 'INTERNAL', message: String(err) }, 500);
  });
  hono.notFound((c) => c.json({ code: 'NOT_FOUND', message: `${c.req.method} ${c.req.path} 不存在` }, 404));
  // 统一认证：/api/runtimes/auth-check 用 workerToken；其余 /api/* 与 /__test/* 用 panelToken；/healthz 无需认证
  hono.use('*', async (c, next) => {
    const p = c.req.path;
    const h = c.req.header('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (p === '/api/runtimes/auth-check') { if (token !== config.token) throw new ApiError(401, 'AUTH_INVALID'); }
    else if (p.startsWith('/api/') || p.startsWith('/__test/')) { if (token !== config.panel_token) throw new ApiError(401, 'UNAUTHORIZED'); }
    await next();
  });
  hono.route('/', systemRoutes(ctx));
  hono.route('/', runtimeRoutes(ctx));
  hono.route('/', taskRoutes(ctx));
  hono.route('/', approvalRoutes(ctx));
  hono.route('/', mcpRoutes(ctx));
  hono.route('/', channelRoutes(ctx));
  if (config.test_mode) hono.route('/', testRoutes(ctx));
  mountPanel(hono, log);
  return ctx;
}

/** 面板 SPA（apps/panel 构建到 apps/center/public）：静态资源 + 前端路由回退到 index.html */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};
export function mountPanel(hono: Hono, log: Logger, dir?: string) {
  const publicDir = dir ?? resolve(findRepoRoot(), 'apps/center/public');
  if (!existsSync(resolve(publicDir, 'index.html'))) { log.warn({ publicDir }, '面板产物不存在，/ 不可用（先跑 pnpm --filter @foreman/panel build）'); return; }
  hono.get('*', async (c, next) => {
    const p = c.req.path;
    if (p.startsWith('/api') || p.startsWith('/ws') || p.startsWith('/mcp') || p.startsWith('/__test') || p === '/healthz') return next();
    let file = resolve(publicDir, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(publicDir) || !existsSync(file) || statSync(file).isDirectory()) file = resolve(publicDir, 'index.html');
    const body = readFileSync(file);
    const isAsset = file.includes('/assets/');
    return c.body(body as any, 200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  });
}

export async function startApp(config: CenterConfig, opts?: Parameters<typeof createApp>[1] & { port?: number; host?: string }): Promise<StartedApp> {
  const ctx = await createApp(config, opts);
  const [host, portStr] = config.listen.split(':');
  const port = opts?.port ?? Number(portStr ?? 7801);
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: ctx.hono.fetch, port, hostname: opts?.host ?? host ?? '0.0.0.0' }, () => resolve(s));
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/ws/worker') ctx.workerHub.handleUpgrade(req, socket, head);
    else if (url.pathname === '/ws/panel') ctx.panelHub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  ctx.scheduler.start(); ctx.schedulerRunning = true;
  // 生产环境：把 center.yaml 里配置的反向隧道拉起来（带退避重连，状态见 /api/system/tunnels）
  if (!config.test_mode) for (const name of Object.keys(config.tunnels)) {
    ctx.tunnels.up(name).catch((e) => ctx.log.error({ err: String(e), tunnel: name }, 'tunnel up failed'));
  }
  const actualPort = (server.address() as any)?.port ?? port;
  const started: StartedApp = {
    ...ctx, server, port: actualPort, url: `http://127.0.0.1:${actualPort}`,
    async close() {
      ctx.scheduler.stop(); ctx.tunnels.closeAll(); ctx.workerHub.closeAll(); ctx.panelHub.close();
      // 阻塞中的 MCP 长请求（request_approval 等待）不应阻止关停
      (server as any).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await ctx.db.close();
    },
  };
  ctx.log.info({ port: actualPort, testMode: config.test_mode }, 'center started');
  return started;
}
