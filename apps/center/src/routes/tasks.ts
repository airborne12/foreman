/**
 * 来源：api/tasks.yaml → listTasks、createTask、getTask、listTaskMessages（本批最小实现）
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, TASK_STATES, TASK_KINDS, TASK_PATHS, AGENTS } from '@foreman/shared';
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
    // 恢复到 running / waiting_input 但会话已结束（人工停止、会话无产物）：拉起原会话继续，否则任务会空转
    const back = await app.tasks.byKey(t.key);
    const live = await app.db.one(`SELECT 1 FROM sessions WHERE task_id=$1 AND state IN ('planned','running','waiting_input')`, [t.id]);
    if (['running', 'waiting_input'].includes(back.state) && !live) await app.dispatch.resumeSession(t.id, '继续之前的工作（任务已从暂停恢复）');
    const fresh = await app.tasks.byKey(t.key);
    return c.json(await app.tasks.serialize(fresh, fresh.channel_slug));
  });

  // 重新代码定位：分流卡降级（定位失败 / 开发机离线）时从面板手动重跑，结果原地更新待拍板的分流卡
  r.post('/api/tasks/:key/relocate', async (c) => {
    const t = await app.tasks.byKey(c.req.param('key'));
    if (!['triaging', 'pending_decision'].includes(t.state)) throw new ApiError(409, 'INVALID_STATE', `任务 ${t.key} 已拍板，不能重新定位`);
    const active = await app.db.one(`SELECT 1 FROM sessions WHERE task_id=$1 AND kind='code_locate' AND state IN ('planned','running','waiting_input')`, [t.id]);
    if (!active) {
      await app.db.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [t.channel_id, t.id, '已从面板发起重新定位', app.clock.now()]);
      // 先按最近一次轮询存下的 Jira 单重算仓库与基线（不现查 Jira，免得被它卡住），再清掉 agent 旧的基线结论重新定位
      const raw = await app.db.one<{ raw: any }>(`SELECT raw FROM source_items WHERE source_type='jira' AND task_id=$1`, [t.id]);
      if (raw?.raw) await app.intake.applyJiraVersions(t.id, raw.raw, { updateCard: false });
      await app.intake.relocate(t.id);
    }
    const fresh = await app.tasks.byKey(t.key);
    return c.json(await app.tasks.serialize(fresh, fresh.channel_slug), 202);
  });

  // 换仓库 / 基线 / agent 重来：停掉在跑的会话、作废旧审批、派全新实现会话
  r.post('/api/tasks/:key/restart', async (c) => {
    const body = await parseBody(c, z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(), baseBranch: z.string().min(1).max(200).optional(), agent: z.enum(AGENTS).optional(), reason: z.string().max(500).optional() }).strict());
    const t = await app.tasks.byKey(c.req.param('key'));
    if (body.repo) {
      const rts = await app.db.query<{ repos: Record<string, unknown> | null }>('SELECT repos FROM runtimes');
      if (!rts.rows.some((r) => r.repos && body.repo! in r.repos)) throw new ApiError(422, 'REPO_UNAVAILABLE', `没有 runtime 登记仓库 ${body.repo}`);
    }
    await app.dispatch.restart(t.id, body);
    const fresh = await app.tasks.byKey(t.key);
    return c.json(await app.tasks.serialize(fresh, fresh.channel_slug), 202);
  });

  // 从 Jira 重新拉单、按影响版本重算仓库与基线（未拍板的任务）；仓库变了会自动重新定位
  r.post('/api/tasks/:key/refresh-source', async (c) => {
    const t = await app.tasks.byKey(c.req.param('key'));
    if (!['triaging', 'pending_decision'].includes(t.state)) throw new ApiError(409, 'INVALID_STATE', `任务 ${t.key} 已拍板，不再按版本调整`);
    const r = await app.intake.refreshJira(t.id);
    if (!r) throw new ApiError(503, 'SOURCE_UNAVAILABLE', `取不到 ${t.source_ref} 的 Jira 信息（非 Jira 任务或 Jira 不可达）`);
    const fresh = await app.tasks.byKey(t.key);
    return c.json({ ...r, task: await app.tasks.serialize(fresh, fresh.channel_slug) });
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
