/**
 * 来源：api/channels.yaml（listChannels/createChannel/getChannel/updateChannel/listChannelThreads/listChannelMessages/postChannelMessage）
 * 与 api/tasks.yaml 的 confirmDraft / cancelDraft
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { TASK_STATES, TASK_PATHS, AGENTS } from '@foreman/shared';
import type { AppContext } from '../app.js';
import { parseBody, parseQuery } from './common.js';

const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40);

export function channelRoutes(app: AppContext) {
  const r = new Hono();

  r.get('/api/channels', async (c) => c.json(await app.channels.list()));
  r.post('/api/channels', async (c) => {
    const b = await parseBody(c, z.object({ slug: Slug, title: z.string().max(80).optional() }));
    return c.json(await app.channels.create(b), 201);
  });
  r.get('/api/channels/:slug', async (c) => c.json(await app.channels.detail(c.req.param('slug'))));
  r.patch('/api/channels/:slug', async (c) => {
    const b = await parseBody(c, z.object({ title: z.string().max(80).optional() }));
    return c.json(await app.channels.update(c.req.param('slug'), b));
  });
  r.get('/api/channels/:slug/threads', async (c) => {
    const q = parseQuery(c, z.object({ state: z.enum(TASK_STATES).optional(), page: z.coerce.number().int().min(1).optional(), perPage: z.coerce.number().int().min(1).max(100).optional() }));
    return c.json(await app.channels.threads(c.req.param('slug'), q));
  });
  r.get('/api/channels/:slug/messages', async (c) => {
    const q = parseQuery(c, z.object({ after: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }));
    return c.json(await app.channels.messages(c.req.param('slug'), q));
  });
  r.post('/api/channels/:slug/messages', async (c) => {
    const b = await parseBody(c, z.object({ text: z.string().min(1).max(20000), replyToCandidate: z.string().nullable().optional() }));
    return c.json(await app.channels.postMessage(c.req.param('slug'), b), 202);
  });

  // 草案（tasks.yaml → confirmDraft / cancelDraft）
  r.post('/api/drafts/:id/confirm', async (c) => {
    const b = await parseBody(c, z.object({
      edits: z.object({ repo: z.string().optional(), path: z.enum(TASK_PATHS).optional(), runtime: z.string().optional(), agent: z.enum(AGENTS).optional(), pickTargets: z.array(z.string()).optional() }).optional(),
      force: z.boolean().optional(),
    }));
    return c.json(await app.channels.confirmDraft(c.req.param('id'), b.edits, b.force ?? false), 201);
  });
  r.post('/api/drafts/:id/cancel', async (c) => c.json(await app.channels.cancelDraft(c.req.param('id'))));

  return r;
}
