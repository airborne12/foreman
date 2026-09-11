/**
 * 来源：api/runtimes.yaml → runtimeAuthCheck、listRuntimes、getRuntime、runtimeGc
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, CENTER_VERSION, MIN_WORKER_VERSION } from '@foreman/shared';
import type { AppContext } from '../app.js';
import { parseBody } from './common.js';

export function runtimeRoutes(app: AppContext) {
  const r = new Hono();

  r.post('/api/runtimes/auth-check', (c) => c.json({ ok: true, centerVersion: CENTER_VERSION, minWorkerVersion: MIN_WORKER_VERSION }));

  const api = new Hono();

  api.get('/api/runtimes', async (c) => c.json({ items: await app.runtimes.list() }));

  api.get('/api/runtimes/:name', async (c) => c.json(await app.runtimes.detail(c.req.param('name'))));

  api.post('/api/runtimes/:name/gc', async (c) => {
    const name = c.req.param('name');
    const body = await parseBody(c, z.object({ dryRun: z.boolean().default(false), policy: z.enum(['retain_days', 'high_watermark']).default('retain_days') }));
    const rt = await app.runtimes.byName(name);
    if (!rt) throw new ApiError(404, 'NOT_FOUND', `runtime ${name} 不存在`);
    if (!app.workerHub.isOnline(name)) throw new ApiError(503, 'RUNTIME_OFFLINE', `${name} 离线`);
    const plan = await app.worktrees.plan(rt.id, body.policy, body.dryRun);
    // hub 在收到 worktree.gc.result 时已落库（applyResult），这里只返回结果
    const reply = await app.workerHub.request(name, 'worktree.gc', plan as unknown as Record<string, unknown>, 60_000);
    const result = (await import('@foreman/shared')).GcResult.parse(reply.payload);
    return c.json(result);
  });

  r.route('/', api);
  return r;
}
