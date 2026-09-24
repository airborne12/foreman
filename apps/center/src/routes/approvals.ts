/**
 * 来源：api/approvals.yaml → getInbox、listApprovals、getApproval、decideApproval（本批）；trust/actions/candidates 在 S06/S02 批次
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, TASK_PATHS, AGENTS, ACTION_TYPES } from '@foreman/shared';
import type { AppContext } from '../app.js';
import { parseBody, parseQuery } from './common.js';

const Decide = z.object({
  decision: z.enum(['approve', 'reject']),
  bodyHash: z.string().min(1),
  editedBody: z.string().max(20000).nullable().optional(),
  overrides: z.object({ path: z.enum(TASK_PATHS).optional(), repo: z.string().optional(), baseBranch: z.string().max(200).optional(), runtime: z.string().optional(), agent: z.enum(AGENTS).optional() }).strict().nullable().optional(),
  comment: z.string().max(2000).nullable().optional(),
});

export function approvalRoutes(app: AppContext) {
  const r = new Hono();

  r.get('/api/inbox', async (c) => {
    const approvals = await app.approvals.listInbox();
    // 失败三选一：state failed，或收件箱重试项（queue_reason 以"重试"开头，S03 EX-25.1）
    const rows = await app.db.query<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.state='failed' OR t.queue_reason LIKE '重试%' OR t.queue_reason LIKE '人工处理%' OR t.queue_reason LIKE '无进展%' ORDER BY t.updated_at DESC`);
    const failures = await Promise.all(rows.rows.map((t) => app.tasks.serializeSummary(t, t.channel_slug)));
    const questions = await app.questions.listOpen();
    const candidates = await app.feishuIntake.listCandidates();
    return c.json({ approvals, questions, failures, candidates, counts: { actionable: approvals.length + failures.length + questions.length, candidates: candidates.length } });
  });

  r.get('/api/approvals', async (c) => {
    const q = parseQuery(c, z.object({ status: z.string().optional(), taskKey: z.string().optional(), actionType: z.enum(ACTION_TYPES).optional(), page: z.coerce.number().int().min(1).optional(), perPage: z.coerce.number().int().min(1).max(100).optional() }));
    return c.json(await app.approvals.list(q));
  });

  r.get('/api/approvals/:key', async (c) => {
    const key = c.req.param('key');
    if (!/^A-\d+$/.test(key)) throw new ApiError(404, 'NOT_FOUND', `审批 ${key} 不存在`);
    const a = await app.approvals.byKey(key);
    if (!a) throw new ApiError(404, 'NOT_FOUND', `审批 ${key} 不存在`);
    return c.json(app.approvals.serialize(a));
  });

  r.post('/api/approvals/:key/decide', async (c) => {
    const key = c.req.param('key');
    if (!/^A-\d+$/.test(key)) throw new ApiError(404, 'NOT_FOUND', `审批 ${key} 不存在`);
    const body = await parseBody(c, Decide);
    // 拍板时改选的仓库必须至少有一个 runtime 登记过，否则拍完才在派发时卡住（2026-09-24 实验环境 T-3）
    const repo = body.decision === 'approve' ? (body.overrides as Record<string, unknown> | null | undefined)?.repo : undefined;
    if (typeof repo === 'string' && repo) {
      const rts = await app.db.query<{ name: string; repos: Record<string, unknown> | null }>('SELECT name, repos FROM runtimes');
      const reported = rts.rows.filter((r) => r.repos && Object.keys(r.repos).length);
      if (reported.length && !reported.some((r) => repo in r.repos!)) {
        throw new ApiError(422, 'REPO_UNAVAILABLE', `没有 runtime 登记仓库 ${repo}（已登记：${reported.map((r) => `${r.name}: ${Object.keys(r.repos!).join('、')}`).join('；')}）`);
      }
    }
    const result = await app.approvals.decide(key, { decision: body.decision, bodyHash: body.bodyHash, editedBody: body.editedBody ?? null, overrides: body.overrides ?? null, comment: body.comment ?? null, via: 'panel' });
    return c.json(result);
  });

  // 候选（S02 Step 30）
  r.post('/api/candidates/:id/intake', async (c) => c.json(await app.feishuIntake.intakeCandidate(c.req.param('id')), 201));
  r.post('/api/candidates/:id/dismiss', async (c) => c.json(await app.feishuIntake.dismissCandidate(c.req.param('id'))));

  // 信任视图与重置（S06 Step 22；Phase 2 S06.2）
  r.get('/api/trust', async (c) => c.json(await app.approvals.listTrust()));
  r.post('/api/trust/:type/reset', async (c) => {
    const t = c.req.param('type');
    if (!(ACTION_TYPES as readonly string[]).includes(t)) throw new ApiError(404, 'NOT_FOUND', `未知动作类型 ${t}`);
    return c.json(await app.approvals.resetTrust(t as any));
  });
  // 事后否决并回滚（S06 Step 28–32）
  r.post('/api/actions/:id/revoke', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'NOT_FOUND');
    const body = await parseBody(c, z.object({ reason: z.string().max(2000).optional() }));
    return c.json(await app.approvals.revoke(id, body.reason ?? null));
  });

  return r;
}
