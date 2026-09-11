/**
 * 来源：api/runtimes.yaml → healthz、getSourceHealth、getSettings；隧道端点（runtimes.yaml 追加）
 */
import { Hono } from 'hono';
import { CENTER_VERSION, ApiError } from '@foreman/shared';
import type { AppContext } from '../app.js';

export function systemRoutes(app: AppContext) {
  const r = new Hono();

  r.get('/healthz', async (c) => {
    let database: 'ok' | 'down' = 'ok';
    try { await app.db.query('SELECT 1'); } catch { database = 'down'; }
    const online = database === 'ok' ? Number((await app.db.one<{ n: string }>(`SELECT count(*) AS n FROM runtimes WHERE online`))?.n ?? 0) : 0;
    const body = {
      status: database === 'down' ? 'down' : 'ok',
      version: CENTER_VERSION,
      checks: { database, feishuSubscription: app.feishuSubscription, onlineRuntimes: online, scheduler: app.schedulerRunning ? 'ok' : 'down' },
    };
    return c.json(body, database === 'down' ? 503 : 200);
  });

  const api = new Hono();

  api.get('/api/system/sources', async (c) => {
    const rows = await app.db.query<any>('SELECT * FROM source_health ORDER BY source');
    return c.json({ items: rows.rows.map((s) => ({ source: s.source, status: s.status, lastSuccessAt: s.last_success_at ? new Date(s.last_success_at).toISOString() : null, lastError: s.last_error, consecutiveFailures: s.consecutive_failures, executedOn: s.executed_on })) });
  });

  api.get('/api/system/settings', (c) => {
    const cfg = app.config;
    return c.json({
      sourceChannels: cfg.source_channels,
      routing: cfg.routing,
      agentConcurrency: cfg.agent_concurrency,
      feishu: { appId: cfg.feishu.app ? cfg.feishu.app.slice(0, 8) + '…' : null, intakeEmoji: cfg.feishu.intake_emoji, approveEmoji: cfg.feishu.approve_emoji, rejectEmoji: cfg.feishu.reject_emoji, dailyPushLimit: cfg.feishu.daily_push_limit },
      jira: { pollSeconds: cfg.sources.jira.poll_seconds, projectRepoMap: cfg.sources.jira.project_repo_map },
      trust: { threshold: cfg.trust.threshold, lockedManual: cfg.trust.locked_manual },
      worktree: { retainDays: cfg.worktree.retain_days, diskHighWatermark: cfg.worktree.disk_high_watermark },
    });
  });

  api.get('/api/system/tunnels', (c) => c.json({ items: app.tunnels.list() }));
  api.get('/api/system/tunnels/:name', (c) => {
    const s = app.tunnels.status(c.req.param('name'));
    if (!s) throw new ApiError(404, 'NOT_FOUND', '隧道未启动');
    return c.json(s);
  });
  api.post('/api/system/tunnels/:name/up', async (c) => {
    try { return c.json(await app.tunnels.up(c.req.param('name'))); }
    catch (e) { throw new ApiError(404, 'NOT_FOUND', String((e as Error).message)); }
  });
  api.post('/api/system/tunnels/:name/down', async (c) => { await app.tunnels.down(c.req.param('name')); return c.json({ ok: true }); });

  r.route('/', api);
  return r;
}
