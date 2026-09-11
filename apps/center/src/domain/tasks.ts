/**
 * 任务领域（本批：最小创建 + 路由 + 查询；分流/会话在后续批次）
 * 来源：api/tasks.yaml createTask/listTasks/getTask/listTaskMessages；S05 Step 20；schema tasks/context_packs/channels/messages
 */
import type { Db, Queryable } from '../db.js';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events.js';
import { ApiError, routeTask, routingCategory, type CenterConfig } from '@foreman/shared';
import type { Runtimes } from './runtimes.js';

export class Tasks {
  constructor(private db: Db, private clock: Clock, private events: EventBus, private cfg: CenterConfig, private runtimes: Runtimes) {}

  /** 来源默认频道：不存在则创建（Phase 2 假设） */
  async ensureChannel(slug: string, opts?: { kind?: 'user' | 'source_default'; sourceType?: 'jira' | 'feishu' | null; title?: string }, client?: Queryable) {
    const existing = await this.db.one<{ id: string; slug: string }>('SELECT id, slug FROM channels WHERE slug=$1 AND deleted_at IS NULL', [slug], client);
    if (existing) return existing;
    const r = await this.db.one<{ id: string; slug: string }>(
      `INSERT INTO channels (slug, title, kind, source_type, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (slug) DO UPDATE SET updated_at=EXCLUDED.updated_at RETURNING id, slug`,
      [slug, opts?.title ?? slug, opts?.kind ?? 'source_default', opts?.sourceType ?? null, this.clock.now()], client);
    return r!;
  }

  async routeFor(kind: string, override?: string | null) {
    const rts = await this.db.query<any>('SELECT * FROM runtimes');
    const candidates = [];
    for (const r of rts.rows) {
      const running = await this.runtimes.runningByAgent(r.id);
      candidates.push({ name: r.name, online: r.online, labels: r.labels as string[], runningSessions: Object.values(running).reduce((a: number, b: any) => a + Number(b), 0) });
    }
    return routeTask({ kind: routingCategory(kind), rules: this.cfg.routing, runtimes: candidates, override });
  }

  /** POST /api/tasks（CLI / 斜杠命令直出）。创建后进入 triaging，并计算默认路由写入线程。 */
  async create(input: { source: string; repo?: string; path: 'fix' | 'plan' | 'proto'; kind?: string; channel?: string; runtime?: string; agent?: string; pickTargets?: string[] }) {
    const kind = input.kind ?? (input.path === 'plan' && !input.repo ? 'text' : 'code');
    const now = this.clock.now();
    const route = await this.routeFor(kind, input.runtime ?? null);
    const created = await this.db.tx(async (c) => {
      const chSlug = input.channel ?? this.cfg.source_channels.cli ?? 'inbox';
      const ch = input.channel
        ? await this.db.one<{ id: string; slug: string }>('SELECT id, slug FROM channels WHERE slug=$1 AND deleted_at IS NULL', [input.channel], c)
        : await this.ensureChannel(chSlug, { kind: 'source_default', title: '收件' }, c);
      if (!ch) throw new ApiError(404, 'CHANNEL_NOT_FOUND', `频道 ${input.channel} 不存在`);
      const key = (await this.db.one<{ k: string }>(`SELECT 'T-' || nextval('task_key_seq') AS k`, [], c))!.k;
      const sourceType = /^[A-Z]+-\d+$/.test(input.source) ? 'jira' : /^[\w.-]+\/[\w.-]+#\d+$/.test(input.source) ? 'github' : 'cli';
      const repoSource = input.repo ? 'manual' : 'unresolved';
      const task = await this.db.one<any>(
        `INSERT INTO tasks (key, channel_id, title, state, kind, path, source_type, source_ref, repo_name, repo_source, runtime_name, agent, pick_targets, queue_reason, last_activity_at, created_at, updated_at)
         VALUES ($1,$2,$3,'triaging',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$14) RETURNING *`,
        [key, ch.id, input.source.slice(0, 200), kind, input.path, sourceType, input.source, input.repo ?? null, repoSource, route.runtime, input.agent ?? null, input.pickTargets ?? [], route.runtime ? null : route.reason, now], c);
      await c.query(`INSERT INTO context_packs (task_id, summary, source_text, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`, [task.id, input.source.slice(0, 200), input.source, now]);
      await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [ch.id, task.id, `来自 ${sourceType} · ${input.source}`, now]);
      await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, payload, created_at) VALUES ($1,$2,'system','system',$3,$4,$5)`, [ch.id, task.id, route.reason, JSON.stringify({ routing: route }), now]);
      await this.events.record(c, { type: 'thread.created', taskId: task.id, channelId: ch.id, payload: { task: await this.serializeSummary(task, ch.slug) } });
      return { task, slug: ch.slug };
    });
    this.events.flush();
    return this.serialize(created.task, created.slug);
  }

  /** 暂停任务（S04 EX-10.1 /task pause；S07 Step 46 停止会话后） */
  async pause(taskId: string) {
    const now = this.clock.now();
    await this.db.query(`UPDATE tasks SET state='paused', state_before_pause=state, terminal_at=$2, updated_at=$2 WHERE id=$1 AND state<>'paused'`, [taskId, now]);
    await this.events.record(this.db.pool, { type: 'task.updated', taskId, payload: { changed: ['state'], state: 'paused' } });
    this.events.flush();
  }
  /** 恢复到暂停前状态 */
  async resume(taskId: string) {
    const now = this.clock.now();
    await this.db.query(`UPDATE tasks SET state=COALESCE(state_before_pause,'queued'), state_before_pause=NULL, terminal_at=NULL, updated_at=$2 WHERE id=$1 AND state='paused'`, [taskId, now]);
    await this.events.record(this.db.pool, { type: 'task.updated', taskId, payload: { changed: ['state'] } });
    this.events.flush();
  }

  async byKey(key: string) {
    const t = await this.db.one<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.key=$1`, [key]);
    if (!t) throw new ApiError(404, 'NOT_FOUND', `任务 ${key} 不存在`);
    return t;
  }

  async list(q: { state?: string; channel?: string; runtime?: string; rootOnly?: boolean; page?: number; perPage?: number }) {
    const where: string[] = []; const params: unknown[] = [];
    if (q.state) { params.push(q.state); where.push(`t.state=$${params.length}`); }
    if (q.channel) { params.push(q.channel); where.push(`c.slug=$${params.length}`); }
    if (q.runtime) { params.push(q.runtime); where.push(`t.runtime_name=$${params.length}`); }
    if (q.rootOnly !== false) where.push('t.parent_id IS NULL');
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const per = Math.min(Math.max(q.perPage ?? 20, 1), 100); const page = Math.max(q.page ?? 1, 1);
    const total = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM tasks t JOIN channels c ON c.id=t.channel_id ${w}`, params);
    const rows = await this.db.query<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id ${w} ORDER BY t.last_activity_at DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, params);
    return { items: await Promise.all(rows.rows.map((r) => this.serializeSummary(r, r.channel_slug))), total: Number(total?.n ?? 0) };
  }

  async messages(key: string, q: { after?: string; limit?: number }) {
    const t = await this.byKey(key);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 200);
    const params: unknown[] = [t.id];
    let cursor = '';
    if (q.after) { params.push(q.after); cursor = `AND (m.created_at, m.seq) > (SELECT created_at, seq FROM messages WHERE id=$2)`; }
    const rows = await this.db.query<any>(`SELECT m.* FROM messages m WHERE m.task_id=$1 ${cursor} ORDER BY m.created_at, m.seq LIMIT ${limit + 1}`, params);
    const items = rows.rows.slice(0, limit).map((m) => serializeMessage(m, key, t.channel_slug));
    return { items, nextCursor: rows.rows.length > limit ? items[items.length - 1]!.id : null };
  }

  async serializeSummary(t: any, channelSlug: string) {
    return {
      key: t.key,
      parentKey: t.parent_id ? (await this.db.one<{ key: string }>('SELECT key FROM tasks WHERE id=$1', [t.parent_id]))?.key ?? null : null,
      title: t.title,
      state: t.state,
      kind: t.kind,
      path: t.path,
      channel: channelSlug,
      source: { type: t.source_type, ref: t.source_ref, url: t.source_url ?? null },
      repo: { name: t.repo_name, source: t.repo_source, confidence: t.repo_confidence == null ? null : Number(t.repo_confidence), candidates: t.repo_candidates ?? [] },
      runtime: t.runtime_name,
      agent: t.agent,
      queueReason: t.queue_reason,
      unreadCount: 0,
      createdAt: new Date(t.created_at).toISOString(),
      updatedAt: new Date(t.updated_at).toISOString(),
    };
  }

  async serialize(t: any, channelSlug: string) {
    return { ...(await this.serializeSummary(t, channelSlug)), pickTargets: t.pick_targets ?? [], decision: t.decision ?? null, failureReason: t.failure_reason ?? null, prUrl: t.pr_url ?? null, branchName: t.branch_name ?? null, terminalAt: t.terminal_at ? new Date(t.terminal_at).toISOString() : null };
  }

  async detail(key: string) {
    const t = await this.byKey(key);
    const base = await this.serialize(t, t.channel_slug);
    const cp = await this.db.one<any>('SELECT * FROM context_packs WHERE task_id=$1', [t.id]);
    const children = await this.db.query<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.parent_id=$1 ORDER BY t.key`, [t.id]);
    const sessions = await this.db.query<any>(`SELECT s.*, r.name AS runtime_name, $2::text AS task_key FROM sessions s JOIN runtimes r ON r.id=s.runtime_id WHERE s.task_id=$1 ORDER BY s.created_at DESC`, [t.id, key]);
    const { serializeSession } = await import('./runtimes.js');
    const sess = sessions.rows.map(serializeSession);
    const card = await this.db.one<any>(`SELECT tc.*, a.key AS approval_key FROM triage_cards tc LEFT JOIN approvals a ON a.id=tc.approval_id WHERE tc.task_id=$1`, [t.id]);
    const arts = await this.db.query<any>(`SELECT * FROM artifacts WHERE task_id=$1 ORDER BY created_at`, [t.id]);
    const pend = await this.db.query<any>(`SELECT key, action_type, title, status, created_at FROM approvals WHERE task_id=$1 AND status='pending' ORDER BY created_at`, [t.id]);
    const oq = await this.db.one<any>(`SELECT * FROM questions WHERE task_id=$1 AND status='open' ORDER BY asked_at DESC LIMIT 1`, [t.id]);
    return {
      ...base,
      contextPack: cp ? { summary: cp.summary, sourceText: cp.source_text, conversation: cp.conversation ?? [], jira: cp.jira ?? null, repo: base.repo, codeLocations: cp.code_locations ?? [], planDoc: cp.plan_doc ?? null, partial: cp.partial } : null,
      triageCard: card ? { tier: card.tier, effort: card.effort, repo: { name: card.repo_name, confidence: card.repo_confidence == null ? null : Number(card.repo_confidence), candidates: card.repo_candidates ?? [] }, suggestedPath: card.suggested_path, codeLocations: card.code_locations ?? [], defaultRuntime: card.default_runtime, defaultAgent: card.default_agent, degraded: card.degraded, degradedReason: card.degraded_reason, approvalKey: card.approval_key ?? null } : null,
      children: await Promise.all(children.rows.map((r) => this.serializeSummary(r, r.channel_slug))),
      currentSession: sess.find((s: any) => ['planned', 'running', 'waiting_input'].includes(s.state)) ?? sess[0] ?? null,
      sessions: sess,
      artifacts: arts.rows.map((a) => ({ id: a.id, kind: a.kind, url: a.url, title: a.title, path: a.path, branch: a.branch, diffStat: a.diff_stat ?? null, mirroredTo: a.mirrored_to ?? [], createdAt: new Date(a.created_at).toISOString() })),
      openQuestion: oq ? { id: oq.id, taskKey: key, sessionId: oq.session_id, text: oq.text, options: oq.options ?? [], origin: oq.origin, status: oq.status, answer: oq.answer ?? null, answeredVia: oq.answered_via ?? null, askedAt: new Date(oq.asked_at).toISOString(), answeredAt: oq.answered_at ? new Date(oq.answered_at).toISOString() : null } : null,
      pendingApprovals: pend.rows.map((a) => ({ key: a.key, actionType: a.action_type, title: a.title, status: a.status, createdAt: new Date(a.created_at).toISOString() })),
      trustSummary: [],
    };
  }
}

export function serializeMessage(m: any, taskKey: string | null, channel: string) {
  return {
    id: m.id, taskKey, channel, kind: m.kind, author: m.author, text: m.text,
    sessionId: m.session_id ?? null, refId: m.ref_id ?? null, payload: m.payload ?? {},
    delivery: m.delivery ?? null, createdAt: new Date(m.created_at).toISOString(),
  };
}
