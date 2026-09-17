/**
 * 频道、调度员会话、草案与斜杠命令（S04）
 * 来源：core-S04-channel-dispatch.md（Step 1–40；EX-4.1/10.1/13.1/20.1/22.1/27.1/27.2/30.1/34.1）
 * 口语交给调度员会话（文本类 → 中心机），斜杠命令由解析器直出草案，不经 LLM。
 */
import type { Db, Queryable } from '../db.js';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events.js';
import type { WorkerHub } from '../hub/workerHub.js';
import type { Tasks } from './tasks.js';
import type { Intake } from './intake.js';
import type { Dispatch } from './dispatch.js';
import type { Approvals } from './approvals.js';
import { ApiError, TASK_PATHS, AGENTS, type CenterConfig, type TaskPath, type AgentName } from '@foreman/shared';
import { serializeMessage } from './tasks.js';

export const DISPATCHER_IDLE_MINUTES = 30;
export const DISPATCHER_RESPONSE_TIMEOUT_SECONDS = 60;

export interface DraftFields {
  source: string; sourceTitle?: string | null; repo?: string | null; repoSource?: string;
  path?: TaskPath | null; pickTargets?: string[]; runtime?: string | null; agent?: AgentName | null; note?: string | null;
}

/** 斜杠命令解析（EX-10.1；core-03 5.1 等价表） */
export interface ParsedCommand { command: string; sub?: string; args: Record<string, string>; positional: string[]; raw: string }
export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const tokens = t.slice(1).match(/"[^"]*"|\S+/g) ?? [];
  const command = (tokens.shift() ?? '').toLowerCase();
  const args: Record<string, string> = {}; const positional: string[] = [];
  let sub: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith('--')) { const key = tok.slice(2); const next = tokens[i + 1]; if (next && !next.startsWith('--')) { args[key] = strip(next); i += 1; } else args[key] = 'true'; }
    else if (sub === undefined && positional.length === 0 && /^[a-z-]+$/.test(tok)) sub = tok;
    else positional.push(strip(tok));
  }
  return { command, sub, args, positional, raw: t };
}
function strip(s: string) { return s.replace(/^"|"$/g, ''); }

export class Channels {
  constructor(
    private db: Db, private clock: Clock, private events: EventBus, private cfg: CenterConfig,
    private hub: WorkerHub, private tasks: Tasks, private intake: Intake, private dispatch: Dispatch, private approvals: Approvals,
  ) {}

  // ---------------- 频道（Step 1–5） ----------------
  async create(input: { slug: string; title?: string }) {
    const existing = await this.db.one('SELECT 1 FROM channels WHERE slug=$1', [input.slug]);
    if (existing) throw new ApiError(409, 'CHANNEL_EXISTS');
    const now = this.clock.now();
    const r = await this.db.one<any>(`INSERT INTO channels (slug, title, kind, created_at, updated_at) VALUES ($1,$2,'user',$3,$3) RETURNING *`, [input.slug, input.title ?? input.slug, now]);
    return this.serialize(r!);
  }
  async bySlug(slug: string, client?: Queryable) {
    const r = await this.db.one<any>('SELECT * FROM channels WHERE slug=$1 AND deleted_at IS NULL', [slug], client);
    if (!r) throw new ApiError(404, 'CHANNEL_NOT_FOUND', `频道 ${slug} 不存在`);
    return r;
  }
  async list() {
    const rows = await this.db.query<any>('SELECT * FROM channels WHERE deleted_at IS NULL ORDER BY created_at');
    return { items: await Promise.all(rows.rows.map((c) => this.serialize(c))) };
  }
  async detail(slug: string) { return this.serialize(await this.bySlug(slug)); }
  async update(slug: string, input: { title?: string }) {
    const c = await this.bySlug(slug);
    const r = await this.db.one<any>(`UPDATE channels SET title=COALESCE($2, title), updated_at=$3 WHERE id=$1 RETURNING *`, [c.id, input.title ?? null, this.clock.now()]);
    return this.serialize(r!);
  }
  async serialize(c: any) {
    const active = Number((await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE channel_id=$1 AND state NOT IN ('done','paused')`, [c.id]))?.n ?? 0);
    const pending = Number((await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM approvals a JOIN tasks t ON t.id=a.task_id WHERE t.channel_id=$1 AND a.status='pending'`, [c.id]))?.n ?? 0);
    const d = await this.db.one<any>(`SELECT * FROM sessions WHERE channel_id=$1 AND kind='dispatcher' ORDER BY created_at DESC LIMIT 1`, [c.id]);
    return {
      slug: c.slug, title: c.title, kind: c.kind, sourceType: c.source_type ?? null,
      activeTasks: active, pendingApprovals: pending, unreadThreads: 0,
      dispatcher: d ? { sessionId: d.id, agent: d.agent, state: d.state === 'running' || d.state === 'waiting_input' ? 'running' : d.state === 'stopped' || d.state === 'done' || d.state === 'failed' ? 'stopped' : 'idle', idleSince: d.last_activity_at ? new Date(d.last_activity_at).toISOString() : null } : null,
      createdAt: new Date(c.created_at).toISOString(),
    };
  }

  async threads(slug: string, q: { state?: string; page?: number; perPage?: number }) {
    const c = await this.bySlug(slug);
    const where: string[] = ['t.channel_id=$1', 't.parent_id IS NULL']; const params: unknown[] = [c.id];
    if (q.state) { params.push(q.state); where.push(`t.state=$${params.length}`); }
    const per = Math.min(Math.max(q.perPage ?? 20, 1), 100); const page = Math.max(q.page ?? 1, 1);
    const total = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM tasks t WHERE ${where.join(' AND ')}`, params);
    const rows = await this.db.query<any>(`SELECT t.* FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.last_activity_at DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, params);
    return { items: await Promise.all(rows.rows.map((t) => this.tasks.serializeSummary(t, c.slug))), total: Number(total?.n ?? 0) };
  }

  /** 频道级消息流（不含线程内消息） */
  async messages(slug: string, q: { after?: string; limit?: number }) {
    const c = await this.bySlug(slug);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 200);
    const params: unknown[] = [c.id]; let cursor = '';
    if (q.after) { params.push(q.after); cursor = `AND (m.created_at, m.seq) > (SELECT created_at, seq FROM messages WHERE id=$2)`; }
    const rows = await this.db.query<any>(`SELECT m.* FROM messages m WHERE m.channel_id=$1 AND m.task_id IS NULL ${cursor} ORDER BY m.created_at, m.seq LIMIT ${limit + 1}`, params);
    const items = rows.rows.slice(0, limit).map((m) => serializeMessage(m, null, c.slug));
    return { items, nextCursor: rows.rows.length > limit ? items[items.length - 1]!.id : null };
  }

  // ---------------- 频道发言（Step 6–17；EX-10.1、EX-13.1） ----------------
  async postMessage(slug: string, input: { text: string; replyToCandidate?: string | null }) {
    const c = await this.bySlug(slug);
    const now = this.clock.now();
    const m = await this.db.one<any>(`INSERT INTO messages (channel_id, kind, author, text, payload, created_at) VALUES ($1,'user','user',$2,$3,$4) RETURNING *`,
      [c.id, input.text, JSON.stringify(input.replyToCandidate ? { replyToCandidate: input.replyToCandidate } : {}), now]);
    await this.events.record(this.db.pool, { type: 'message.new', channelId: c.id, payload: { channel: c.slug, message: serializeMessage(m, null, c.slug) } });
    this.events.flush();

    if (input.text.trim().startsWith('/')) return { message: serializeMessage(m, null, c.slug), ...(await this.runCommand(c, input.text)) };

    // 口语 → 调度员（Step 11–17）
    const active = await this.activeDispatcher(c.id);
    if (active) {
      this.hub.send(active.runtime_name, 'session.resume', { sessionId: active.id, text: input.text });
      await this.db.query(`UPDATE sessions SET last_activity_at=$2, state=CASE WHEN state IN ('done','stopped') THEN 'running' ELSE state END, updated_at=$2 WHERE id=$1`, [active.id, now]);
      return { message: serializeMessage(m, null, c.slug), handling: 'dispatcher' as const };
    }
    const prompt = await this.dispatcherPrompt(c);
    const r = await this.dispatch.startTextSession({ channelId: c.id, kind: 'dispatcher', prompt });
    if ('error' in r) {
      // EX-13.1：不可用则提示命令，保留用户消息，不自动重放
      const hint = `/task new --source <引用> --repo <仓库> --path fix`;
      const text = `调度员不可用（${r.detail}），可用 ${hint} 手动创建`;
      await this.channelSystem(c, text, 'warn');
      await this.db.query(`INSERT INTO jobs (kind, status, args, error_code, error_message, scheduled_at, finished_at, created_at) VALUES ('dispatch','skipped',$1,$2,$3,$4,$4,$4)`,
        [JSON.stringify({ type: 'dispatcher.start', channel: c.slug }), r.error, r.detail, now]);
      return { message: serializeMessage(m, null, c.slug), handling: 'unavailable' as const, hint };
    }
    await this.channelSystem(c, `调度员会话拉起中（${r.runtime} · ${r.agent}）`, 'info');
    return { message: serializeMessage(m, null, c.slug), handling: 'dispatcher' as const };
  }

  /**
   * 把一件需要人和 agent 继续商量的事送进任务所属频道，并让调度员接住。
   * 审批被否决、会话失联这类情况，光在任务线程写一行系统消息没人接得住——
   * 任务会僵死在那里，讨论只能发生在平台之外。频道 + 调度员本来就是干这个的。
   */
  async escalateToChannel(taskId: string, text: string, payload: Record<string, unknown> = {}) {
    const t = await this.db.one<any>(`SELECT t.id, t.key, t.channel_id FROM tasks t WHERE t.id=$1`, [taskId]);
    if (!t) return { handled: 'no_task' as const };
    const c = await this.db.one<any>('SELECT * FROM channels WHERE id=$1', [t.channel_id]);
    if (!c) return { handled: 'no_channel' as const };
    const now = this.clock.now();
    const m = await this.db.one<any>(`INSERT INTO messages (channel_id, task_id, kind, author, text, payload, created_at) VALUES ($1,$2,'system','system',$3,$4,$5) RETURNING *`,
      [c.id, t.id, text, JSON.stringify({ level: 'warn', taskKey: t.key, ...payload }), now]);
    await this.events.record(this.db.pool, { type: 'message.new', channelId: c.id, payload: { channel: c.slug, message: serializeMessage(m, t.key, c.slug) } });
    this.events.flush();

    const active = await this.activeDispatcher(c.id);
    if (active) {
      this.hub.send(active.runtime_name, 'session.resume', { sessionId: active.id, text });
      await this.db.query(`UPDATE sessions SET last_activity_at=$2, state=CASE WHEN state IN ('done','stopped') THEN 'running' ELSE state END, updated_at=$2 WHERE id=$1`, [active.id, now]);
      return { handled: 'resumed' as const, channel: c.slug };
    }
    const r = await this.dispatch.startTextSession({ channelId: c.id, kind: 'dispatcher', prompt: `${await this.dispatcherPrompt(c)}\n\n【需要你接手的事】\n${text}` });
    if ('error' in r) {
      await this.channelSystem(c, `调度员不可用（${r.detail}），上面这件事需要你手动处理`, 'warn');
      return { handled: 'dispatcher_unavailable' as const, channel: c.slug };
    }
    return { handled: 'started' as const, channel: c.slug };
  }

  async activeDispatcher(channelId: string) {
    return this.db.one<any>(`SELECT s.*, r.name AS runtime_name FROM sessions s JOIN runtimes r ON r.id=s.runtime_id
      WHERE s.channel_id=$1 AND s.kind='dispatcher' AND s.state IN ('planned','running','waiting_input') ORDER BY s.created_at DESC LIMIT 1`, [channelId]);
  }

  /** Step 13：提示词含频道名、最近 50 条消息、在线 runtime 与标签、已登记仓库 */
  async dispatcherPrompt(c: any) {
    const msgs = await this.db.query<any>(`SELECT kind, author, text FROM messages WHERE channel_id=$1 AND task_id IS NULL ORDER BY created_at DESC, seq DESC LIMIT 50`, [c.id]);
    const rts = await this.db.query<any>(`SELECT name, labels, agents, repos FROM runtimes WHERE online ORDER BY name`);
    const repos = new Set<string>();
    for (const r of rts.rows) for (const k of Object.keys(r.repos ?? {})) repos.add(k);
    return [
      `你是频道 ${c.slug}（${c.title}）的调度员。把用户的口语变成任务草案，不要直接建任务。`,
      '行为规范：引用的 Jira 单或 PR 必须先用 lookup_jira / lookup_pr 查证；查不到就调用 ask_clarification 澄清，不要猜；一句话里有多个需求就调用多次 propose_task。',
      '可用 MCP 工具：lookup_jira(key)、lookup_pr(repo, number)、list_tasks({q, recent})、propose_task({channel, source, sourceTitle, repo, path, pickTargets})、ask_clarification({channel, text, candidates})。',
      `在线 runtime：${rts.rows.map((r) => `${r.name}[${(r.labels ?? []).join(',')}]`).join(' / ') || '（无）'}`,
      `已登记仓库：${[...repos].join(' / ') || '（无）'}`,
      `频道最近 ${msgs.rows.length} 条消息（新→旧）：`,
      ...msgs.rows.map((m) => `- [${m.kind}/${m.author}] ${String(m.text).slice(0, 300)}`),
    ].join('\n');
  }

  async channelSystem(c: any, text: string, level: 'info' | 'warn', payload: Record<string, unknown> = {}) {
    const now = this.clock.now();
    const m = await this.db.one<any>(`INSERT INTO messages (channel_id, kind, author, text, payload, created_at) VALUES ($1,'system','system',$2,$3,$4) RETURNING *`,
      [c.id, text, JSON.stringify({ level, ...payload }), now]);
    await this.events.record(this.db.pool, { type: 'channel.system', channelId: c.id, payload: { channel: c.slug, text, level } });
    this.events.flush();
    return m;
  }

  // ---------------- 斜杠命令（EX-10.1） ----------------
  private async runCommand(c: any, text: string): Promise<{ handling: 'command'; draft?: unknown }> {
    const p = parseCommand(text)!;
    const unknown = () => { throw new ApiError(422, 'VALIDATION_FAILED', `未知命令 /${p.command}，输入 / 查看列表`, { command: p.command }); };
    switch (p.command) {
      case 'task': {
        if (p.sub === 'new') {
          const fields: DraftFields = {
            source: p.args.source ?? p.positional[0] ?? '',
            sourceTitle: p.args.title ?? null,
            repo: p.args.repo ?? null,
            repoSource: p.args.repo ? 'manual' : 'llm',
            path: (TASK_PATHS as readonly string[]).includes(p.args.path ?? '') ? (p.args.path as TaskPath) : null,
            pickTargets: p.args.pick ? p.args.pick.split(',').map((x) => x.trim()).filter(Boolean) : [],
            runtime: p.args.runtime ?? null,
            agent: (AGENTS as readonly string[]).includes(p.args.agent ?? '') ? (p.args.agent as AgentName) : null,
          };
          const draft = await this.createDraft(c, fields, 'command');
          return { handling: 'command', draft };
        }
        if (p.sub === 'pause' || p.sub === 'resume') {
          const key = p.positional[0] ?? '';
          const t = await this.tasks.byKey(key);
          const now = this.clock.now();
          if (p.sub === 'pause') await this.db.query(`UPDATE tasks SET state='paused', state_before_pause=state, terminal_at=$2, updated_at=$2 WHERE id=$1 AND state<>'paused'`, [t.id, now]);
          else await this.db.query(`UPDATE tasks SET state=COALESCE(state_before_pause,'queued'), state_before_pause=NULL, terminal_at=NULL, updated_at=$2 WHERE id=$1 AND state='paused'`, [t.id, now]);
          await this.channelSystem(c, `${key} 已${p.sub === 'pause' ? '暂停' : '恢复'}`, 'info');
          await this.dispatch.threadEvent(t.id, `用户通过命令${p.sub === 'pause' ? '暂停' : '恢复'}了任务`);
          return { handling: 'command' };
        }
        return unknown();
      }
      case 'approve': case 'reject': {
        const key = p.positional[0] ?? '';
        const a = await this.approvals.byKey(key);
        if (!a) throw new ApiError(404, 'NOT_FOUND', `审批 ${key} 不存在`);
        await this.approvals.decide(key, { decision: p.command === 'approve' ? 'approve' : 'reject', bodyHash: a.body_hash, comment: p.positional.slice(1).join(' ') || null, via: 'panel' });
        await this.channelSystem(c, `${key} 已${p.command === 'approve' ? '确认' : '否决'}`, 'info');
        return { handling: 'command' };
      }
      case 'runtime': {
        const rts = await this.db.query<any>('SELECT name, online, labels FROM runtimes ORDER BY name');
        await this.channelSystem(c, `runtime：${rts.rows.map((r) => `${r.name} ${r.online ? '在线' : '离线'}[${(r.labels ?? []).join(',')}]`).join(' / ') || '（无）'}`, 'info');
        return { handling: 'command' };
      }
      default: return unknown();
    }
  }

  // ---------------- 草案（Step 27–34；EX-34.1） ----------------
  async createDraft(c: any, fields: DraftFields, origin: 'dispatcher' | 'command', sessionId?: string | null) {
    const now = this.clock.now();
    const highlight = (['source', 'repo', 'path'] as const).filter((k) => !fields[k]);
    const d = await this.db.one<any>(`INSERT INTO task_drafts (channel_id, session_id, origin, status, fields, expires_at, created_at, updated_at) VALUES ($1,$2,$3,'open',$4,$5,$6,$6) RETURNING *`,
      [c.id, sessionId ?? null, origin, JSON.stringify(fields), new Date(now.getTime() + 24 * 3600_000), now]);
    const m = await this.db.one<any>(`INSERT INTO messages (channel_id, kind, author, text, ref_type, ref_id, payload, created_at) VALUES ($1,'draft_card',$2,$3,'draft',$4,$5,$6) RETURNING *`,
      [c.id, origin === 'command' ? 'system' : 'claude', `草案：${fields.source || '（待补）'}${fields.sourceTitle ? ` · ${fields.sourceTitle}` : ''}`, d!.id, JSON.stringify({ fields, highlight, note: fields.note ?? null }), now]);
    await this.events.record(this.db.pool, { type: 'message.new', channelId: c.id, payload: { channel: c.slug, message: serializeMessage(m, null, c.slug) } });
    this.events.flush();
    return this.serializeDraft(d!, c.slug, highlight);
  }

  serializeDraft(d: any, channelSlug: string, highlight?: string[]) {
    const fields = d.fields as DraftFields;
    return {
      id: d.id, channel: channelSlug, status: d.status, origin: d.origin,
      fields: { source: fields.source ?? null, sourceTitle: fields.sourceTitle ?? null, repo: fields.repo ?? null, repoSource: fields.repoSource ?? 'llm', path: fields.path ?? null, pickTargets: fields.pickTargets ?? [], runtime: fields.runtime ?? null, agent: fields.agent ?? null },
      payload: { highlight: highlight ?? (['source', 'repo', 'path'] as const).filter((k) => !(fields as any)[k]), note: fields.note ?? null },
      taskKey: d.task_key ?? null, createdAt: new Date(d.created_at).toISOString(),
    };
  }

  async draftById(id: string) {
    const d = await this.db.one<any>(`SELECT d.*, c.slug AS channel_slug, t.key AS task_key FROM task_drafts d JOIN channels c ON c.id=d.channel_id LEFT JOIN tasks t ON t.id=d.task_id WHERE d.id=$1`, [id]);
    if (!d) throw new ApiError(404, 'NOT_FOUND', '草案不存在');
    return d;
  }

  /** Step 32–34：确认草案 → 建根任务并挂到频道，随后进入 S01 Step 11 */
  async confirmDraft(id: string, edits?: Partial<DraftFields>) {
    const d = await this.draftById(id);
    const now = this.clock.now();
    if (d.status === 'open' && d.expires_at && new Date(d.expires_at) <= now) {
      await this.db.query(`UPDATE task_drafts SET status='expired', updated_at=$2 WHERE id=$1`, [id, now]);
      throw new ApiError(409, 'DRAFT_NOT_OPEN', '草案已过期');
    }
    if (d.status !== 'open') throw new ApiError(409, 'DRAFT_NOT_OPEN', `草案已${d.status === 'confirmed' ? '确认' : d.status === 'cancelled' ? '取消' : '过期'}`);
    const f: DraftFields = { ...(d.fields as DraftFields), ...(edits ?? {}) };
    const repoSource = edits?.repo ? 'manual' : (f.repoSource ?? 'llm');
    const sourceType = /^[A-Z]+-\d+$/.test(f.source) ? 'jira' : /^[\w.-]+\/[\w.-]+#\d+$/.test(f.source) ? 'github' : 'channel';
    const created = await this.db.tx(async (c) => {
      const key = (await this.db.one<{ k: string }>(`SELECT 'T-' || nextval('task_key_seq') AS k`, [], c))!.k;
      const t = await this.db.one<any>(
        `INSERT INTO tasks (key, channel_id, title, state, kind, path, source_type, source_ref, repo_name, repo_source, runtime_name, agent, pick_targets, last_activity_at, created_at, updated_at)
         VALUES ($1,$2,$3,'triaging','code',$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12) RETURNING *`,
        [key, d.channel_id, (f.sourceTitle || f.source).slice(0, 200), f.path ?? 'fix', sourceType, f.source, f.repo ?? null, f.repo ? repoSource : 'unresolved', f.runtime ?? null, f.agent ?? null, f.pickTargets ?? [], now], c);
      await c.query(`INSERT INTO context_packs (task_id, summary, source_text, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`,
        [t.id, [f.sourceTitle, f.note].filter(Boolean).join(' · ') || f.source, [f.source, f.sourceTitle, f.note].filter(Boolean).join('\n'), now]);
      await c.query(`UPDATE task_drafts SET status='confirmed', task_id=$2, updated_at=$3 WHERE id=$1`, [id, t.id, now]);
      await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`,
        [d.channel_id, t.id, `由草案创建 · 来源 ${f.source}${(f.pickTargets ?? []).length ? ` · pick ${(f.pickTargets ?? []).join(',')}` : ''}`, now]);
      await this.events.record(c, { type: 'thread.created', taskId: t.id, channelId: d.channel_id, payload: { task: await this.tasks.serializeSummary(t, d.channel_slug), channel: d.channel_slug } });
      return t;
    });
    this.events.flush();
    await this.intake.scheduleCodeLocate(created.id);
    const fresh = await this.tasks.byKey(created.key);
    return this.tasks.serialize(fresh, d.channel_slug);
  }

  /** Step 31：取消草案（幂等） */
  async cancelDraft(id: string) {
    const d = await this.draftById(id);
    if (d.status === 'open') await this.db.query(`UPDATE task_drafts SET status='cancelled', updated_at=$2 WHERE id=$1`, [id, this.clock.now()]);
    return this.serializeDraft(await this.draftById(id), d.channel_slug);
  }

  // ---------------- 调度员 MCP 工具（Step 27–30） ----------------
  async proposeTask(session: any, input: DraftFields & { channel: string }) {
    const c = await this.bySlug(input.channel);
    await this.touchDispatcher(session.id);
    const d = await this.createDraft(c, input, 'dispatcher', session.id);
    return { draftId: d.id };
  }

  async askClarification(session: any, input: { channel: string; text: string; candidates?: Array<{ label: string; value: string }> }) {
    const c = await this.bySlug(input.channel);
    await this.touchDispatcher(session.id);
    const now = this.clock.now();
    const m = await this.db.one<any>(`INSERT INTO messages (channel_id, session_id, kind, author, text, payload, created_at) VALUES ($1,$2,'clarification',$3,$4,$5,$6) RETURNING *`,
      [c.id, session.id, session.agent, input.text, JSON.stringify({ candidates: input.candidates ?? [] }), now]);
    await this.events.record(this.db.pool, { type: 'message.new', channelId: c.id, payload: { channel: c.slug, message: serializeMessage(m, null, c.slug) } });
    this.events.flush();
    return { ok: true };
  }

  async listTasksForDispatcher(input: { q?: string | null; recent?: number; channel?: string | null }) {
    const per = Math.min(input.recent ?? 5, 20);
    const params: unknown[] = []; const where: string[] = ['t.parent_id IS NULL'];
    if (input.q) { params.push(`%${input.q}%`); where.push(`(t.title ILIKE $${params.length} OR t.source_ref ILIKE $${params.length})`); }
    if (input.channel) { params.push(input.channel); where.push(`c.slug=$${params.length}`); }
    const rows = await this.db.query<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE ${where.join(' AND ')} ORDER BY t.last_activity_at DESC LIMIT ${per}`, params);
    return { items: await Promise.all(rows.rows.map((t) => this.tasks.serializeSummary(t, t.channel_slug))) };
  }

  async touchDispatcher(sessionId: string) {
    await this.db.query(`UPDATE sessions SET last_activity_at=$2, last_progress_at=$2, updated_at=$2 WHERE id=$1`, [sessionId, this.clock.now()]);
  }

  /** 调度器 dispatcher-idle（Step 37–40 + EX-30.1）：60 秒无响应提示一次；空闲 30 分钟回收 */
  async watchDispatchers() {
    const now = this.clock.now();
    let warned = 0; let stopped = 0;
    const sessions = await this.db.query<any>(`SELECT s.*, r.name AS runtime_name, c.id AS ch_id, c.slug, c.title FROM sessions s JOIN runtimes r ON r.id=s.runtime_id JOIN channels c ON c.id=s.channel_id
      WHERE s.kind='dispatcher' AND s.state IN ('planned','running','waiting_input')`);
    for (const s of sessions.rows) {
      const lastUser = await this.db.one<any>(`SELECT id, created_at FROM messages WHERE channel_id=$1 AND task_id IS NULL AND kind='user' ORDER BY created_at DESC, seq DESC LIMIT 1`, [s.ch_id]);
      if (lastUser) {
        const replied = await this.db.one(`SELECT 1 FROM messages WHERE channel_id=$1 AND task_id IS NULL AND kind IN ('draft_card','clarification','dispatcher') AND created_at >= $2`, [s.ch_id, lastUser.created_at]);
        const warnedAlready = await this.db.one(`SELECT 1 FROM messages WHERE channel_id=$1 AND task_id IS NULL AND payload->>'responseTimeoutFor'=$2`, [s.ch_id, lastUser.id]);
        const waited = (now.getTime() - new Date(lastUser.created_at).getTime()) / 1000;
        if (!replied && !warnedAlready && waited >= DISPATCHER_RESPONSE_TIMEOUT_SECONDS) {
          await this.channelSystem({ id: s.ch_id, slug: s.slug }, `调度员响应超时（已等待 ${Math.round(waited)} 秒），会话继续，也可以用 /task new 手动创建`, 'warn', { responseTimeoutFor: lastUser.id });
          warned += 1;
        }
      }
      const last = s.last_activity_at ?? s.started_at ?? s.created_at;
      if ((now.getTime() - new Date(last).getTime()) / 60_000 >= DISPATCHER_IDLE_MINUTES) {
        this.hub.send(s.runtime_name, 'session.stop', { sessionId: s.id, reason: 'idle' });
        await this.db.query(`UPDATE sessions SET state='stopped', failure_reason='dispatcher idle', ended_at=$2, updated_at=$2 WHERE id=$1`, [s.id, now]);
        await this.channelSystem({ id: s.ch_id, slug: s.slug }, `调度员空闲 ${DISPATCHER_IDLE_MINUTES} 分钟已回收，下次发言会自动重新拉起`, 'info');
        stopped += 1;
      }
    }
    return { warned, stopped };
  }
}
