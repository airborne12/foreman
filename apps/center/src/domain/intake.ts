/**
 * 入库（S01）：Jira 轮询作业、任务创建与上下文包、代码定位会话、分流卡与审批。
 * 来源：core-S01-jira-intake.md（Step 1–31，EX-2.1/6.1/10.1/11.1/12.1/17.1/22.1/28.1/28.2）
 */
import { randomBytes } from 'node:crypto';
import type { Db, Queryable } from '../db.js';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events.js';
import type { Notifications } from './notifications.js';
import type { Approvals } from './approvals.js';
import type { WorkerHub } from '../hub/workerHub.js';
import type { Tasks } from './tasks.js';
import { AGENTS, CODE_LOCATE_TIMEOUT_MINUTES, type CenterConfig, type AgentName } from '@foreman/shared';
import { sha256 } from './approvals.js';

export interface JiraIssue { key: string; summary: string; description?: string; project?: string; component?: string | null; version?: string | null; priority?: string | null; assignee?: string | null; status?: string; updated?: string; comments?: Array<{ author: string; body: string }>; attachments?: Array<{ name: string; url: string }>; url?: string }

export class Intake {
  /** MCP lookup 等待者：jobId → resolve */
  private jobWaiters = new Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; cancel: () => void }>();

  constructor(private db: Db, private clock: Clock, private events: EventBus, private cfg: CenterConfig, private hub: WorkerHub, private tasks: Tasks, private approvals: Approvals, private notifications: Notifications) {}

  // ---------------- Jira 轮询（Step 1–9） ----------------
  async pollJira(): Promise<Record<string, unknown>> {
    const label = this.cfg.sources.jira.run_on_label;
    const existing = await this.db.one<{ id: string }>(`SELECT id FROM jobs WHERE dedupe_key='jira-poll' AND status IN ('queued','dispatched','running')`);
    if (existing) return { skipped: true, reason: 'already_queued', jobId: existing.id };
    const rt = await this.findRuntime(label, 'jira-poll');
    const health = await this.db.one<any>(`SELECT * FROM source_health WHERE source='jira'`);
    const since = health?.watermark ? new Date(health.watermark).toISOString() : '1970-01-01T00:00:00Z';
    const jql = `${this.cfg.sources.jira.jql} AND updated >= "${since}"`;
    const now = this.clock.now();
    const job = await this.db.one<{ id: string }>(`INSERT INTO jobs (kind, status, runtime_id, required_label, args, dedupe_key, scheduled_at, created_at) VALUES ('jira-poll',$1,$2,$3,$4,'jira-poll',$5,$5) RETURNING id`,
      [rt ? 'dispatched' : 'queued', rt?.id ?? null, label, JSON.stringify({ jql, since }), now]);
    if (!rt) {
      await this.db.query(`UPDATE source_health SET status='no_runtime', last_error=$1, updated_at=$2 WHERE source='jira'`, ['no online runtime with ' + label, now]);
      return { queued: true, jobId: job!.id };
    }
    await this.db.query(`UPDATE jobs SET dispatched_at=$2 WHERE id=$1`, [job!.id, now]);
    this.hub.send(rt.name, 'job.run', { kind: 'jira-poll', args: { jql, since }, timeoutSeconds: 60 }, { id: job!.id });
    return { dispatched: true, jobId: job!.id, runtime: rt.name };
  }

  private async findRuntime(label: string, capability?: string) {
    const rts = await this.db.query<{ id: string; name: string; labels: string[]; capabilities: string[] }>(`SELECT id, name, labels, capabilities FROM runtimes WHERE online ORDER BY name`);
    return rts.rows.find((r) => r.labels.includes(label) && this.hub.isOnline(r.name) && (!capability || (r.capabilities ?? []).includes(capability) || r.labels.includes(label))) ?? null;
  }

  /** runtime 上线：补派排队作业（EX-2.1）与排队的代码定位（EX-12.1） */
  async onRuntimeOnline(name: string) {
    const rt = await this.db.one<{ id: string; labels: string[] }>('SELECT id, labels FROM runtimes WHERE name=$1', [name]);
    if (!rt) return;
    const queued = await this.db.query<any>(`SELECT * FROM jobs WHERE status='queued' AND kind IN ('jira-poll','jira-lookup','jira-comment','code-locate') ORDER BY created_at`);
    for (const j of queued.rows) {
      if (j.required_label && !rt.labels.includes(j.required_label)) continue;
      if (j.kind === 'code-locate') { await this.startCodeLocate(j.args.taskId, j.id); continue; }
      await this.db.query(`UPDATE jobs SET status='dispatched', runtime_id=$2, dispatched_at=$3 WHERE id=$1`, [j.id, rt.id, this.clock.now()]);
      this.hub.send(name, 'job.run', { kind: j.kind, args: j.args, timeoutSeconds: 60 }, { id: j.id });
    }
  }

  /** 派一个系统作业并等待结果（MCP lookup_jira、jira_comment 执行器用） */
  async runJob(kind: 'jira-lookup' | 'jira-comment' | 'gh-pr-view', args: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    const label = kind.startsWith('jira') ? this.cfg.sources.jira.run_on_label : 'agent:claude';
    const rt = await this.findRuntime(label);
    if (!rt) throw Object.assign(new Error('SOURCE_UNAVAILABLE'), { code: 'SOURCE_UNAVAILABLE' });
    const now = this.clock.now();
    const job = await this.db.one<{ id: string }>(`INSERT INTO jobs (kind, status, runtime_id, required_label, args, scheduled_at, dispatched_at, created_at) VALUES ($1,'dispatched',$2,$3,$4,$5,$5,$5) RETURNING id`, [kind, rt.id, label, JSON.stringify(args), now]);
    const p = new Promise<Record<string, unknown>>((resolve, reject) => {
      const cancel = this.clock.after(timeoutMs, () => { this.jobWaiters.delete(job!.id); reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })); });
      this.jobWaiters.set(job!.id, { resolve, reject, cancel });
    });
    this.hub.send(rt.name, 'job.run', { kind, args, timeoutSeconds: Math.round(timeoutMs / 1000) }, { id: job!.id });
    return p;
  }

  /** worker → job.result（Step 8–9） */
  async onJobResult(jobId: string, runtimeName: string, result: { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } | null }) {
    const job = await this.db.one<any>('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (!job) return;
    const now = this.clock.now();
    await this.db.query(`UPDATE jobs SET status=$2, result=$3, error_code=$4, error_message=$5, finished_at=$6, attempts=attempts+1 WHERE id=$1`, [jobId, result.ok ? 'succeeded' : 'failed', JSON.stringify(result.result ?? {}), result.error?.code ?? null, result.error?.message ?? null, now]);
    const w = this.jobWaiters.get(jobId);
    if (w) { this.jobWaiters.delete(jobId); w.cancel(); if (result.ok) w.resolve(result.result ?? {}); else w.reject(Object.assign(new Error(result.error?.message ?? 'job failed'), { code: result.error?.code ?? 'INTERNAL' })); }
    if (job.kind === 'jira-poll') await this.onJiraPollResult(runtimeName, result);
  }

  private async onJiraPollResult(runtimeName: string, result: { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } | null }) {
    const now = this.clock.now();
    if (!result.ok) {
      // EX-6.1：连续失败计数，第 3 次告警（每小时最多一次）
      const h = await this.db.one<any>(`UPDATE source_health SET status='unreachable', consecutive_failures=consecutive_failures+1, last_error=$1, executed_on=$2, updated_at=$3 WHERE source='jira' RETURNING consecutive_failures`, [result.error?.message ?? 'unknown', runtimeName, now]);
      if (Number(h.consecutive_failures) >= 3) await this.notifications.alertOnce('Jira 不可达', `Jira 不可达，已连续失败 ${h.consecutive_failures} 次（最近：${result.error?.message ?? ''}）`, 'source');
      await this.db.query(`INSERT INTO events (type, actor, payload, broadcast, created_at) VALUES ('source.health','system',$1,true,$2)`, [JSON.stringify({ item: { source: 'jira', status: 'unreachable' } }), now]);
      return;
    }
    const issues = ((result.result?.issues as JiraIssue[] | undefined) ?? []);
    let maxUpdated: Date | null = null;
    for (const issue of issues) {
      await this.intakeJiraIssue(issue);
      const u = issue.updated ? new Date(issue.updated) : null;
      if (u && (!maxUpdated || u > maxUpdated)) maxUpdated = u;
    }
    await this.db.query(`UPDATE source_health SET status='ok', consecutive_failures=0, last_error=NULL, last_success_at=$1, executed_on=$2, watermark=COALESCE($3, watermark), updated_at=$1 WHERE source='jira'`, [now, runtimeName, maxUpdated]);
  }

  // ---------------- 入库（Step 10–11） ----------------
  async intakeJiraIssue(issue: JiraIssue): Promise<{ taskKey: string; created: boolean }> {
    const now = this.clock.now();
    const me = this.cfg.sources.jira.jql.includes('currentUser') ? null : null;
    void me;
    const existing = await this.db.one<{ id: string; task_id: string | null; raw: any }>(`SELECT id, task_id, raw FROM source_items WHERE source_type='jira' AND external_id=$1`, [issue.key]);
    if (existing?.task_id) {
      // EX-10.1：已存在 → 若 assignee 变回我，追加事件；paused/done 出现"是否重新打开"
      const t = await this.db.one<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1`, [existing.task_id]);
      const prevAssignee = existing.raw?.assignee ?? null;
      await this.db.query(`UPDATE source_items SET raw=$2, external_updated_at=$3, seen_at=$4 WHERE id=$1`, [existing.id, JSON.stringify(issue), issue.updated ? new Date(issue.updated) : null, now]);
      if (prevAssignee !== (issue.assignee ?? null) && t) {
        await this.db.tx(async (c) => {
          await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [t.channel_id, t.id, `来源重新分配：${prevAssignee ?? '-'} → ${issue.assignee ?? '-'}`, now]);
          await this.events.record(c, { type: 'source.reassigned', taskId: t.id, payload: { taskKey: t.key, from: prevAssignee, to: issue.assignee } });
          if (t.state === 'paused' || t.state === 'done') await this.events.record(c, { type: 'inbox.new', taskId: t.id, payload: { itemType: 'failure', item: { key: t.key, question: '是否重新打开' } } });
        });
        this.events.flush();
      }
      return { taskKey: t?.key, created: false };
    }
    const repo = this.cfg.sources.jira.project_repo_map[issue.project ?? issue.key.split('-')[0]!] ?? null;
    const task = await this.db.tx(async (c) => {
      const ch = await this.tasks.ensureChannel(this.cfg.source_channels.jira ?? 'jira', { kind: 'source_default', sourceType: 'jira', title: 'Jira' }, c);
      const key = (await this.db.one<{ k: string }>(`SELECT 'T-' || nextval('task_key_seq') AS k`, [], c))!.k;
      const t = await this.db.one<any>(
        `INSERT INTO tasks (key, channel_id, title, state, kind, source_type, source_ref, source_url, repo_name, repo_source, last_activity_at, created_at, updated_at)
         VALUES ($1,$2,$3,'triaging','code','jira',$4,$5,$6,$7,$8,$8,$8) RETURNING *`,
        [key, ch.id, `${issue.key} · ${issue.summary}`.slice(0, 200), issue.key, issue.url ?? null, repo, repo ? 'mapping' : 'unresolved', now], c);
      await c.query(`INSERT INTO source_items (source_type, external_id, task_id, raw, external_updated_at, seen_at) VALUES ('jira',$1,$2,$3,$4,$5) ON CONFLICT (source_type, external_id) DO UPDATE SET task_id=EXCLUDED.task_id, raw=EXCLUDED.raw, external_updated_at=EXCLUDED.external_updated_at, seen_at=EXCLUDED.seen_at`,
        [issue.key, t.id, JSON.stringify(issue), issue.updated ? new Date(issue.updated) : null, now]);
      const jira = { key: issue.key, project: issue.project ?? issue.key.split('-')[0], component: issue.component ?? null, version: issue.version ?? null, priority: issue.priority ?? null, commentsSummary: (issue.comments ?? []).slice(-5).map((x) => `${x.author}: ${x.body.slice(0, 200)}`).join('\n'), attachments: issue.attachments ?? [] };
      await c.query(`INSERT INTO context_packs (task_id, summary, source_text, jira, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)`, [t.id, issue.summary, `${issue.summary}\n\n${issue.description ?? ''}`.trim(), JSON.stringify(jira), now]);
      await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [ch.id, t.id, `来自 Jira · ${issue.key} · assignee 变更为我`, now]);
      await this.events.record(c, { type: 'thread.created', taskId: t.id, channelId: ch.id, payload: { task: await this.tasks.serializeSummary(t, ch.slug), channel: ch.slug } });
      return t;
    });
    this.events.flush();
    await this.scheduleCodeLocate(task.id);
    return { taskKey: task.key, created: true };
  }

  // ---------------- 代码定位（Step 12–23；EX-12.1/17.1/22.1） ----------------
  async scheduleCodeLocate(taskId: string) {
    const rt = await this.findRuntime('build:doris');
    if (!rt) {
      const existing = await this.db.one(`SELECT 1 FROM jobs WHERE kind='code-locate' AND status='queued' AND args->>'taskId'=$1`, [taskId]);
      if (!existing) await this.db.query(`INSERT INTO jobs (kind, status, required_label, args, dedupe_key, scheduled_at, created_at) VALUES ('code-locate','queued','build:doris',$1,$2,$3,$3)`, [JSON.stringify({ taskId }), `code-locate:${taskId}`, this.clock.now()]);
      await this.emitTriage(taskId, null, { degraded: true, degradedReason: '开发机离线，代码定位待补' });
      return;
    }
    await this.startCodeLocate(taskId, null, rt.name);
  }

  /** 创建 worktree → 由 dispatch 在 worktree.ready 后启动 code_locate 会话 */
  async startCodeLocate(taskId: string, jobId: string | null, runtimeName?: string) {
    const rt = runtimeName ? await this.db.one<{ id: string; name: string }>('SELECT id, name FROM runtimes WHERE name=$1', [runtimeName]) : await this.findRuntime('build:doris');
    if (!rt) return;
    if (jobId) await this.db.query(`UPDATE jobs SET status='dispatched', runtime_id=$2, dispatched_at=$3 WHERE id=$1`, [jobId, rt.id, this.clock.now()]);
    const t = await this.db.one<any>('SELECT * FROM tasks WHERE id=$1', [taskId]);
    const repo = t.repo_name ?? (Object.values(this.cfg.sources.jira.project_repo_map)[0] as string | undefined) ?? 'apache/doris';
    await this.db.query(`UPDATE tasks SET runtime_name=$2, updated_at=$3 WHERE id=$1`, [taskId, rt.name, this.clock.now()]);
    await this.sendWorktreeCreate(taskId, rt.name, repo, 'code_locate');
  }

  async sendWorktreeCreate(taskId: string, runtimeName: string, repo: string, purpose: 'code_locate' | 'implement' | 'review', fetchFirst = false) {
    const t = await this.db.one<any>('SELECT * FROM tasks WHERE id=$1', [taskId]);
    const cp = await this.db.one<any>('SELECT * FROM context_packs WHERE task_id=$1', [taskId]);
    const baseBranch = this.cfg.repo_base_branch?.[repo] ?? 'master';
    const md = `# ${t.key} 上下文包\n\n## 需求原文\n${cp?.source_text ?? ''}\n\n## 仓库\n${repo}（${t.repo_source}）\n\n## Jira\n${cp?.jira ? JSON.stringify(cp.jira, null, 2) : '-'}\n\n## 代码定位\n${JSON.stringify(cp?.code_locations ?? [], null, 2)}\n${cp?.plan_doc ? `\n## 方案\n${cp.plan_doc}\n` : ''}`;
    const env = this.hub.send(runtimeName, 'worktree.create', {
      taskKey: t.key, repo, baseBranch, branchName: `foreman/${t.key}`, reuseIfExists: true, fetchFirst,
      contextMarkdown: md, taskJson: { key: t.key, kind: t.kind, path: t.path, repo, purpose },
      hooks: { Notification: [{ matcher: 'agent_needs_input|agent_completed', hooks: [{ type: 'command', command: 'foreman-hook notify' }] }] },
    });
    await this.db.query(`INSERT INTO jobs (kind, status, args, scheduled_at, dispatched_at, created_at) VALUES ('dispatch','dispatched',$1,$2,$2,$2)`, [JSON.stringify({ commandId: env.id, type: 'worktree.create', taskId, purpose, runtime: runtimeName, repo, fetchFirst }), this.clock.now()]);
    return env.id;
  }

  /** deliver(triage)：分流卡 + 审批（Step 22–26）；降级卡补齐时原位更新（EX-12.1） */
  async emitTriage(taskId: string, sessionId: string | null, triage: { tier?: string; effort?: string; repo?: { name: string | null; confidence: number; candidates?: string[] }; suggestedPath?: string; codeLocations?: any[]; degraded?: boolean; degradedReason?: string }) {
    const now = this.clock.now();
    const t = await this.db.one<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1`, [taskId]);
    if (!t) return;
    const repoName = triage.repo && triage.repo.confidence >= 0.6 ? triage.repo.name : (t.repo_source === 'mapping' || t.repo_source === 'manual' ? t.repo_name : null);
    // 降级卡（还没跑过代码定位）不下调来源：入库时标的 llm/mapping 保留，等补齐后再定
    const repoSource = t.repo_source === 'mapping' || t.repo_source === 'manual' ? t.repo_source : repoName ? 'llm' : triage.degraded ? t.repo_source : 'unresolved';
    const tier = triage.tier ?? (t.path ?? 'fix'); const effort = triage.effort ?? (triage.degraded ? 'medium' : 'small');
    const defaultRuntime = (await this.tasks.routeFor(t.kind ?? 'code', null)).runtime;
    const defaultAgent = await this.nextAgent();
    const existing = await this.db.one<any>(`SELECT a.* FROM approvals a WHERE a.task_id=$1 AND a.action_type='triage_confirm' AND a.status='pending'`, [taskId]);
    // ContextPack.codeLocations maxItems 8（tasks.yaml）：超出截断并记事件
    const allLocations = triage.codeLocations ?? [];
    const truncated = allLocations.length > 8;
    const payload = { taskKey: t.key, tier, effort, repo: { name: repoName, source: repoSource, confidence: triage.repo?.confidence ?? null, candidates: triage.repo?.candidates ?? [] }, suggestedPath: triage.suggestedPath ?? '', codeLocations: allLocations.slice(0, 8), defaultRuntime, defaultAgent, degraded: !!triage.degraded, degradedReason: triage.degradedReason ?? null, summaryLine: `档位 ${tier} · 预估 ${effort} · 仓库 ${repoName ?? '待确认'} · runtime ${defaultRuntime ?? '-'} · agent ${defaultAgent}` };
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO triage_cards (task_id, tier, effort, repo_name, repo_confidence, repo_candidates, suggested_path, code_locations, default_runtime, default_agent, degraded, degraded_reason, session_id, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
        ON CONFLICT (task_id) DO UPDATE SET tier=EXCLUDED.tier, effort=EXCLUDED.effort, repo_name=EXCLUDED.repo_name, repo_confidence=EXCLUDED.repo_confidence, repo_candidates=EXCLUDED.repo_candidates, suggested_path=EXCLUDED.suggested_path, code_locations=EXCLUDED.code_locations, default_runtime=EXCLUDED.default_runtime, default_agent=EXCLUDED.default_agent, degraded=EXCLUDED.degraded, degraded_reason=EXCLUDED.degraded_reason, session_id=COALESCE(EXCLUDED.session_id, triage_cards.session_id), updated_at=EXCLUDED.updated_at`,
        [taskId, tier, effort, repoName, triage.repo?.confidence ?? null, triage.repo?.candidates ?? [], payload.suggestedPath, JSON.stringify(payload.codeLocations), defaultRuntime, defaultAgent, payload.degraded, payload.degradedReason, sessionId, now]);
      await c.query(`UPDATE context_packs SET code_locations=$2, updated_at=$3, version=version+1 WHERE task_id=$1`, [taskId, JSON.stringify(payload.codeLocations), now]);
      if (truncated) await this.events.record(c, { type: 'context_pack.truncated', taskId, broadcast: false, payload: { taskKey: t.key, field: 'codeLocations', from: allLocations.length, to: 8 } });
      await c.query(`UPDATE tasks SET state='pending_decision', repo_name=$2, repo_source=$3, repo_confidence=$4, repo_candidates=$5, path=$6, updated_at=$7 WHERE id=$1`, [taskId, repoName, repoSource, triage.repo?.confidence ?? null, triage.repo?.candidates ?? [], tier, now]);
      if (existing) {
        await c.query(`UPDATE approvals SET payload=$2, updated_at=$3 WHERE id=$1`, [existing.id, JSON.stringify(payload), now]);
        await c.query(`UPDATE triage_cards SET approval_id=$2 WHERE task_id=$1`, [taskId, existing.id]);
        await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [t.channel_id, taskId, '代码定位已补齐', now]);
        await this.events.record(c, { type: 'thread.event', taskId, payload: { taskKey: t.key, text: '代码定位已补齐' } });
        await this.events.record(c, { type: 'inbox.new', taskId, payload: { itemType: 'approval', item: { ...this.approvals.serialize(existing), payload }, updated: true } });
      }
    });
    this.events.flush();
    if (!existing) {
      const a = await this.approvals.request({ taskId, actionType: 'triage_confirm', title: `${t.key} · ${t.title.slice(0, 60)}`, body: `分流卡：${payload.summaryLine}\n建议：${payload.suggestedPath}`, payload, executor: 'center' });
      await this.db.query(`UPDATE triage_cards SET approval_id=(SELECT id FROM approvals WHERE key=$2) WHERE task_id=$1`, [taskId, a.key]);
    }
  }

  /** 轮换：上一实现任务的作者换一家（S03 Step 7） */
  async nextAgent(): Promise<AgentName> {
    const last = await this.db.one<{ author_agent: string | null }>(`SELECT author_agent FROM tasks WHERE author_agent IS NOT NULL ORDER BY updated_at DESC LIMIT 1`);
    const order: AgentName[] = AGENTS.filter((a) => a !== 'opencode');
    if (!last?.author_agent) return 'claude';
    const i = order.indexOf(last.author_agent as AgentName);
    return order[(i + 1) % order.length] ?? 'claude';
  }

  /** 会话 token（MCP 鉴权） */
  static newToken() { return randomBytes(24).toString('hex'); }
  static hash(token: string) { return sha256(token); }

  /** progress-watch：代码定位超时（EX-22.1） */
  async watchCodeLocateTimeouts() {
    const cutoff = new Date(this.clock.now().getTime() - CODE_LOCATE_TIMEOUT_MINUTES * 60_000);
    const stale = await this.db.query<any>(`SELECT s.id, s.task_id, r.name AS runtime FROM sessions s JOIN runtimes r ON r.id=s.runtime_id WHERE s.kind='code_locate' AND s.state IN ('running','planned') AND s.started_at <= $1`, [cutoff]);
    for (const s of stale.rows) {
      this.hub.send(s.runtime, 'session.stop', { sessionId: s.id, reason: 'timeout' });
      await this.db.query(`UPDATE sessions SET state='stopped', failure_reason='code-locate timeout', ended_at=$2, updated_at=$2 WHERE id=$1`, [s.id, this.clock.now()]);
      await this.emitTriage(s.task_id, s.id, { degraded: true, degradedReason: '代码定位失败：超时 15 分钟' });
    }
    return { stopped: stale.rows.length };
  }

  /** feishu-digest：延后的待拍板合并推送（EX-28.2） */
  async digest() {
    const deferred = await this.db.query<{ key: string }>(`SELECT key FROM approvals WHERE status='pending' AND feishu_deferred`);
    if (!deferred.rows.length) return { sent: 0 };
    await this.notifications.send({ kind: 'digest', target: this.cfg.feishu.owner_open_id ?? 'owner', text: `你有 ${deferred.rows.length} 项待拍板（今日推送已达上限，改为整点汇总）：${deferred.rows.map((r) => r.key).join(' · ')}\n面板：/inbox` });
    return { sent: deferred.rows.length };
  }
}
