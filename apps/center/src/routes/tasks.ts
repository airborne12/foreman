/**
 * 来源：api/tasks.yaml → listTasks、createTask、getTask、listTaskMessages（本批最小实现）
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { TASK_STATES, TASK_KINDS, TASK_PATHS, AGENTS } from '@foreman/shared';
import type { AppContext } from '../app.js';
import { parseBody, parseQuery } from './common.js';

const CreateTask = z.object({
  source: z.string().min(1),
  repo: z.string().optional(),
  path: z.enum(TASK_PATHS),
  kind: z.enum(TASK_KINDS).optional(),
  channel: z.string().optional(),
  runtime: z.string().optional(),
  agent: z.enum(AGENTS).optional(),
  pickTargets: z.array(z.string()).optional(),
});

export function taskRoutes(app: AppContext) {
  const r = new Hono();

  r.get('/api/tasks', async (c) => {
    const q = parseQuery(c, z.object({
      state: z.enum(TASK_STATES).optional(), channel: z.string().optional(), runtime: z.string().optional(),
      rootOnly: z.enum(['true', 'false']).optional(), page: z.coerce.number().int().min(1).optional(), perPage: z.coerce.number().int().min(1).max(100).optional(),
    }));
    return c.json(await app.tasks.list({ ...q, rootOnly: q.rootOnly !== 'false' }));
  });

  r.post('/api/tasks', async (c) => {
    const body = await parseBody(c, CreateTask);
    return c.json(await app.tasks.create(body), 201);
  });

  r.get('/api/tasks/:key', async (c) => c.json(await app.tasks.detail(c.req.param('key'))));

  r.get('/api/tasks/:key/messages', async (c) => {
    const q = parseQuery(c, z.object({ after: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }));
    return c.json(await app.tasks.messages(c.req.param('key'), q));
  });

  // postTaskMessage（S07 Step 36 / S05 EX-23.1）：本批实现续接与离线排队；回答 ask_user 在 S07 批次
  r.post('/api/tasks/:key/messages', async (c) => {
    const body = await parseBody(c, z.object({ text: z.string().min(1).max(20000), questionId: z.string().uuid().optional() }));
    const t = await app.tasks.byKey(c.req.param('key'));
    return c.json(await app.dispatch.postMessage(t.id, body.text, body.questionId ?? null), 202);
  });

  // 会话日志与停止（S07 Step 6–12、42–46）
  r.get('/api/sessions/:id/logs', async (c) => {
    const q = parseQuery(c, z.object({ from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().min(1).max(2000).optional() }));
    return c.json(await app.dispatch.sessionLogs(c.req.param('id'), { from: q.from ?? null, to: q.to ?? null, limit: q.limit ?? 400 }));
  });
  r.post('/api/sessions/:id/stop', async (c) => {
    const s = await app.dispatch.stopSession(c.req.param('id'));
    const { serializeSession } = await import('../domain/runtimes.js');
    return c.json(serializeSession(s));
  });

  // retryTask（S03 EX-32.1 / EX-15.1）
  r.post('/api/tasks/:key/retry', async (c) => {
    const body = await parseBody(c, z.object({ mode: z.enum(['same_agent', 'switch_agent', 'abandon', 'fresh_session']) }));
    const t = await app.tasks.byKey(c.req.param('key'));
    await app.dispatch.retry(t.id, body.mode);
    const fresh = await app.tasks.byKey(t.key);
    return c.json(await app.tasks.serialize(fresh, fresh.channel_slug), 202);
  });

  // pause / resume（S04 EX-10.1、S02 EX-5.1 的恢复入口）
  r.post('/api/tasks/:key/pause', async (c) => {
    const t = await app.tasks.byKey(c.req.param('key'));
    await app.tasks.pause(t.id);
    const fresh = await app.tasks.byKey(t.key);
    return c.json(await app.tasks.serialize(fresh, fresh.channel_slug));
  });
  r.post('/api/tasks/:key/resume', async (c) => {
    const t = await app.tasks.byKey(c.req.param('key'));
    await app.tasks.resume(t.id);
    const fresh = await app.tasks.byKey(t.key);
    return c.json(await app.tasks.serialize(fresh, fresh.channel_slug));
  });

  // implementFromPlan（S03 Step 30）
  r.post('/api/tasks/:key/implement', async (c) => {
    const t = await app.tasks.byKey(c.req.param('key'));
    await app.dispatch.implementFromPlan(t.id);
    const fresh = await app.tasks.byKey(t.key);
    return c.json(await app.tasks.serialize(fresh, fresh.channel_slug), 202);
  });

  return r;
}
