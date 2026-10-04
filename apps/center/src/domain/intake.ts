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
import { CODE_LOCATE_TIMEOUT_MINUTES, resolveVersionTarget, type CenterConfig, type AgentName, type VersionTarget } from '@foreman/shared';
import { sha256 } from './approvals.js';

export interface JiraIssue { key: string; summary: string; description?: string; project?: string; component?: string | null; version?: string | null; affectsVersions?: string[]; fixVersions?: string[]; priority?: string | null; assignee?: string | null; status?: string; updated?: string; comments?: Array<{ author: string; body: string }>; attachments?: Array<{ name: string; url: string }>; url?: string }

/**
 * JQL 日期字面量：Jira 只认 'yyyy-MM-dd HH:mm' 这类格式，ISO 8601（带 T 与 Z）会被判为无效日期。
 * 用本地时区格式化：Jira 按服务器/用户时区解释这个字面量，中心与 Jira 在同一时区。
 */
export function jqlDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
    const since = health?.watermark ? new Date(health.watermark) : new Date(0);
    const jql = `${this.cfg.sources.jira.jql} AND updated >= "${jqlDate(since)}"`;
    const now = this.clock.now();
    const job = await this.db.one<{ id: string }>(`INSERT INTO jobs (kind, status, runtime_id, required_label, args, dedupe_key, scheduled_at, created_at) VALUES ('jira-poll',$1,$2,$3,$4,'jira-poll',$5,$5) RETURNING id`,
      [rt ? 'dispatched' : 'queued', rt?.id ?? null, label, JSON.stringify({ jql, since: since.toISOString() }), now]);
    if (!rt) {
      await this.db.query(`UPDATE source_health SET status='no_runtime', last_error=$1, updated_at=$2 WHERE source='jira'`, ['no online runtime with ' + label, now]);
      return { queued: true, jobId: job!.id };
    }
    await this.db.query(`UPDATE jobs SET dispatched_at=$2 WHERE id=$1`, [job!.id, now]);
    this.hub.send(rt.name, 'job.run', { kind: 'jira-poll', args: { jql, since: since.toISOString() }, timeoutSeconds: 60 }, { id: job!.id });
    return { dispatched: true, jobId: job!.id, runtime: rt.name };
  }

  private async findRuntime(label: string, capability?: string) {
    const rts = await this.db.query<{ id: string; name: string; labels: string[]; capabilities: string[]; agents: Record<string, unknown> }>(`SELECT id, name, labels, capabilities, agents FROM runtimes WHERE online ORDER BY name`);
    return rts.rows.find((r) => r.labels.includes(label) && (label !== 'build:doris' || !!r.agents?.codex) && this.hub.isOnline(r.name) && (!capability || (r.capabilities ?? []).includes(capability) || r.labels.includes(label))) ?? null;
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
  async runJob(kind: 'jira-lookup' | 'jira-comment' | 'gh-pr-view' | 'git-publish', args: Record<string, unknown>, timeoutMs = 60_000, opts?: { runtime?: string }): Promise<Record<string, unknown>> {
    const label = kind.startsWith('jira') ? this.cfg.sources.jira.run_on_label : kind === 'git-publish' ? null : 'agent:codex';
    // 指定 runtime（git-publish 必须在任务工作区所在的机器上跑）
    const rt = opts?.runtime
      ? await this.db.one<{ id: string; name: string }>('SELECT id, name FROM runtimes WHERE name=$1 AND online', [opts.runtime]).then((r) => (r && this.hub.isOnline(r.name) ? r : null))
      : await this.findRuntime(label!);
    if (!rt) throw Object.assign(new Error(opts?.runtime ? `RUNTIME_OFFLINE：${opts.runtime} 不在线` : 'SOURCE_UNAVAILABLE'), { code: opts?.runtime ? 'RUNTIME_OFFLINE' : 'SOURCE_UNAVAILABLE' });
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
      // 影响版本改了（或旧数据没取过影响版本）且还没拍板：按新版本重算仓库与基线
      if (t && ['triaging', 'pending_decision'].includes(t.state) && JSON.stringify(existing.raw?.affectsVersions ?? null) !== JSON.stringify(issue.affectsVersions ?? null)) await this.applyJiraVersions(t.id, issue);
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
    // 仓库与基线：影响版本规则优先（确定性），其次项目映射，都没有再交给代码定位 agent
    const vt = this.versionTargetOf(issue);
    const repo = vt?.repo ?? this.cfg.sources.jira.project_repo_map[issue.project ?? issue.key.split('-')[0]!] ?? null;
    const task = await this.db.tx(async (c) => {
      const ch = await this.tasks.ensureChannel(this.cfg.source_channels.jira ?? 'jira', { kind: 'source_default', sourceType: 'jira', title: 'Jira' }, c);
      const key = (await this.db.one<{ k: string }>(`SELECT 'T-' || nextval('task_key_seq') AS k`, [], c))!.k;
      const t = await this.db.one<any>(
        `INSERT INTO tasks (key, channel_id, title, state, kind, source_type, source_ref, source_url, repo_name, repo_source, base_branch, pick_targets, last_activity_at, created_at, updated_at)
         VALUES ($1,$2,$3,'triaging','code','jira',$4,$5,$6,$7,$8,$9,$10,$10,$10) RETURNING *`,
        [key, ch.id, `${issue.key} · ${issue.summary}`.slice(0, 200), issue.key, issue.url ?? null, repo, vt ? 'version' : repo ? 'mapping' : 'unresolved', vt?.baseBranch ?? null, vt?.pickTargets ?? [], now], c);
      await c.query(`INSERT INTO source_items (source_type, external_id, task_id, raw, external_updated_at, seen_at) VALUES ('jira',$1,$2,$3,$4,$5) ON CONFLICT (source_type, external_id) DO UPDATE SET task_id=EXCLUDED.task_id, raw=EXCLUDED.raw, external_updated_at=EXCLUDED.external_updated_at, seen_at=EXCLUDED.seen_at`,
        [issue.key, t.id, JSON.stringify(issue), issue.updated ? new Date(issue.updated) : null, now]);
      const jira = { key: issue.key, project: issue.project ?? issue.key.split('-')[0], component: issue.component ?? null, version: issue.version ?? null, affectsVersions: issue.affectsVersions ?? [], fixVersions: issue.fixVersions ?? [], versionTarget: vt, priority: issue.priority ?? null, commentsSummary: (issue.comments ?? []).slice(-5).map((x) => `${x.author}: ${x.body.slice(0, 200)}`).join('\n'), attachments: issue.attachments ?? [] };
      await c.query(`INSERT INTO context_packs (task_id, summary, source_text, jira, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)`, [t.id, issue.summary, `${issue.summary}\n\n${issue.description ?? ''}`.trim(), JSON.stringify(jira), now]);
      await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [ch.id, t.id, `来自 Jira · ${issue.key} · assignee 变更为我`, now]);
      await this.events.record(c, { type: 'thread.created', taskId: t.id, channelId: ch.id, payload: { task: await this.tasks.serializeSummary(t, ch.slug), channel: ch.slug } });
      return t;
    });
    this.events.flush();
    if (vt) await this.threadNote(task.id, `影响版本 ${vt.versions.join('、')} → ${vt.repo} · 基线 ${vt.baseBranch}${vt.pickTargets.length ? ` · pick ${vt.pickTargets.join('、')}` : ''}`);
    await this.scheduleCodeLocate(task.id);
    return { taskKey: task.key, created: true };
  }

  /** 影响版本（没有则修复版本）按规则算仓库 / 基线 / pick */
  versionTargetOf(issue: Pick<JiraIssue, 'affectsVersions' | 'fixVersions'>): VersionTarget | null {
    const vs = issue.affectsVersions?.length ? issue.affectsVersions : (issue.fixVersions ?? []);
    return resolveVersionTarget(vs, this.cfg.sources.jira.version_rules);
  }

  private async threadNote(taskId: string, text: string) {
    const t = await this.db.one<{ key: string; channel_id: string }>('SELECT key, channel_id FROM tasks WHERE id=$1', [taskId]);
    if (!t) return;
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [t.channel_id, taskId, text, this.clock.now()]);
      await this.events.record(c, { type: 'thread.event', taskId, payload: { taskKey: t.key, text } });
    });
    this.events.flush();
  }

  /**
   * 按 Jira 最新的版本信息重算未拍板任务的仓库与基线（S01；2026-09-30 基线全被猜成 branch-selectdb-doris-4.1）。
   * 仓库变了且已有定位结果 → 定位作废、重新定位；仓库没变 → 分流卡原地改基线，不再跑 agent。
   */
  async applyJiraVersions(taskId: string, issue: JiraIssue, opts?: { updateCard?: boolean }): Promise<{ target: VersionTarget | null; relocated: boolean; changed: boolean }> {
    const t = await this.db.one<any>('SELECT * FROM tasks WHERE id=$1', [taskId]);
    if (!t || !['triaging', 'pending_decision'].includes(t.state)) return { target: null, relocated: false, changed: false };
    const vt = this.versionTargetOf(issue);
    const now = this.clock.now();
    await this.db.query(`UPDATE context_packs SET jira = COALESCE(jira, '{}'::jsonb) || $2::jsonb, updated_at=$3, version=version+1 WHERE task_id=$1`,
      [taskId, JSON.stringify({ version: issue.version ?? null, affectsVersions: issue.affectsVersions ?? [], fixVersions: issue.fixVersions ?? [], versionTarget: vt }), now]);
    if (!vt) return { target: null, relocated: false, changed: false };
    const changed = t.repo_name !== vt.repo || t.base_branch !== vt.baseBranch || JSON.stringify(t.pick_targets ?? []) !== JSON.stringify(vt.pickTargets);
    const repoChanged = t.repo_name !== vt.repo;
    await this.db.query(`UPDATE tasks SET repo_name=$2, repo_source='version', base_branch=$3, pick_targets=$4, updated_at=$5 WHERE id=$1`, [taskId, vt.repo, vt.baseBranch, vt.pickTargets, now]);
    if (!changed || opts?.updateCard === false) return { target: vt, relocated: false, changed };
    const card = await this.db.one<any>('SELECT * FROM triage_cards WHERE task_id=$1', [taskId]);
    const note = `影响版本 ${vt.versions.join('、')} → ${vt.repo} · 基线 ${vt.baseBranch}${vt.pickTargets.length ? ` · pick ${vt.pickTargets.join('、')}` : ''}`;
    if (card && repoChanged && !card.degraded) {
      // 在别的仓库里做的代码定位不能用：重新定位（新 worktree 按新仓库与基线建）
      await this.threadNote(taskId, `${note}（仓库变了，重新定位）`);
      await this.relocate(taskId);
      return { target: vt, relocated: true, changed: true };
    }
    await this.threadNote(taskId, note);
    if (card) {
      await this.emitTriage(taskId, card.session_id ?? null, {
        tier: card.tier ?? undefined, effort: card.effort ?? undefined,
        repo: { name: vt.repo, confidence: 1, candidates: card.repo_candidates ?? [] },
        targetBranch: vt.baseBranch, suggestedPath: card.suggested_path ?? undefined, codeLocations: card.code_locations ?? [],
        degraded: card.degraded, degradedReason: card.degraded_reason ?? undefined,
      }, { note: `分流卡按影响版本更新：${vt.repo} · 基线 ${vt.baseBranch}` });
    }
    return { target: vt, relocated: false, changed: true };
  }

  /** 从 Jira 重新拉单并按版本重算（面板「重新定位」前、存量卡回填用）；Jira 不可达时返回 null，不影响后续 */
  async refreshJira(taskId: string, opts?: { updateCard?: boolean }) {
    const t = await this.db.one<{ source_type: string; source_ref: string }>('SELECT source_type, source_ref FROM tasks WHERE id=$1', [taskId]);
    if (t?.source_type !== 'jira') return null;
    let issue: JiraIssue;
    try { issue = (await this.runJob('jira-lookup', { key: t.source_ref })) as unknown as JiraIssue; } catch { return null; }
    await this.db.query(`UPDATE source_items SET raw=$2, seen_at=$3 WHERE source_type='jira' AND external_id=$1`, [t.source_ref, JSON.stringify(issue), this.clock.now()]);
    return this.applyJiraVersions(taskId, issue, opts);
  }

  /** 重新定位：旧的基线结论清掉（版本规则算出的保留），重新跑代码定位 */
  async relocate(taskId: string) {
    const cp = await this.db.one<{ jira: any }>('SELECT jira FROM context_packs WHERE task_id=$1', [taskId]);
    const vt = (cp?.jira?.versionTarget ?? null) as VersionTarget | null;
    await this.db.query(`UPDATE triage_cards SET base_branch=$2 WHERE task_id=$1`, [taskId, vt?.baseBranch ?? null]);
    await this.db.query(`UPDATE tasks SET base_branch=$2 WHERE id=$1`, [taskId, vt?.baseBranch ?? null]);
    await this.scheduleCodeLocate(taskId);
  }

  // ---------------- 代码定位（Step 12–23；EX-12.1/17.1/22.1） ----------------
  async scheduleCodeLocate(taskId: string) {
    const rt = await this.findRuntime('build:doris');
    if (!rt) {
      await this.enqueueCodeLocate(taskId);
      await this.emitTriage(taskId, null, { degraded: true, degradedReason: '开发机离线，代码定位待补' });
      return;
    }
    await this.startCodeLocate(taskId, null, rt.name);
  }

  /**
   * 先占名额再建 worktree → 由 dispatch 在 worktree.ready 后启动 code_locate 会话。
   * 代码定位同样受「每家 agent 每 runtime 并发上限」约束（架构 §额度保护）：
   * planned 会话在发 worktree.create 前就写入，保证连续补派时计数立即生效；没有名额则作业留在队列，名额释放后由 drainCodeLocate 补派。
   * 返回是否已派出（或该任务已在定位中）。
   */
  async startCodeLocate(taskId: string, jobId: string | null, runtimeName?: string): Promise<boolean> {
    const found = runtimeName ? await this.db.one<{ id: string }>('SELECT id FROM runtimes WHERE name=$1', [runtimeName]) : await this.findRuntime('build:doris');
    const rt = found ? await this.db.one<{ id: string; name: string; agents: Record<string, { maxConcurrent?: number }> | null }>('SELECT id, name, agents FROM runtimes WHERE id=$1', [found.id]) : null;
    if (!rt) return false;
    const now = this.clock.now();
    const active = await this.db.one(`SELECT 1 FROM sessions WHERE task_id=$1 AND kind='code_locate' AND state IN ('planned','running','waiting_input')`, [taskId]);
    if (active) { if (jobId) await this.db.query(`UPDATE jobs SET status='dispatched', runtime_id=$2, dispatched_at=$3 WHERE id=$1`, [jobId, rt.id, now]); return true; }
    const agent = await this.freeAgent(rt);
    if (!agent) {
      if (!jobId) await this.enqueueCodeLocate(taskId);
      if (!(await this.db.one('SELECT 1 FROM triage_cards WHERE task_id=$1', [taskId]))) await this.emitTriage(taskId, null, { degraded: true, degradedReason: `代码定位排队中：${rt.name} 上 agent 并发已满` });
      return false;
    }
    if (jobId) await this.db.query(`UPDATE jobs SET status='dispatched', runtime_id=$2, dispatched_at=$3 WHERE id=$1`, [jobId, rt.id, now]);
    const t = await this.db.one<any>('SELECT * FROM tasks WHERE id=$1', [taskId]);
    // 任务上的仓库可能是早先 agent 交回的短名（2026-09-29 T-71：selectdb-core，建 worktree 报「未配置仓库」）：先按已登记仓库补全
    const known = await this.knownRepos();
    const fallback = (Object.values(this.cfg.sources.jira.project_repo_map)[0] as string | undefined) ?? known[0] ?? 'apache/doris';
    const named = t.repo_name ? normalizeRepo(t.repo_name, known) : null;
    const repo = named && known.includes(named) ? named : fallback;
    if (named && named !== t.repo_name && known.includes(named)) await this.db.query(`UPDATE tasks SET repo_name=$2 WHERE id=$1`, [taskId, named]);
    const reserved = await this.db.reserveCodex(rt.id, this.cfg.agent_concurrency.codex, async (c) => {
      const existing = await this.db.one(`SELECT 1 FROM sessions WHERE task_id=$1 AND kind='code_locate' AND state IN ('planned','running','waiting_input')`, [taskId], c);
      if (existing) return false;
      await this.db.query(`INSERT INTO sessions (task_id, runtime_id, agent, kind, state, prompt, created_at, updated_at) VALUES ($1,$2,$3,'code_locate','planned','',$4,$4)`, [taskId, rt.id, agent, now], c);
      return true;
    });
    if (reserved === false) return true;
    if (reserved === null) {
      if (jobId) await this.db.query(`UPDATE jobs SET status='queued', dispatched_at=NULL WHERE id=$1`, [jobId]);
      else await this.enqueueCodeLocate(taskId);
      return false;
    }
    await this.db.query(`UPDATE tasks SET runtime_name=$2, updated_at=$3 WHERE id=$1`, [taskId, rt.name, now]);
    await this.sendWorktreeCreate(taskId, rt.name, repo, 'code_locate');
    return true;
  }

  /** Codex 名额未满时可启动定位，缺少 Codex 时不能回退旧执行器。 */
  private async freeAgent(rt: { id: string; agents: Record<string, { maxConcurrent?: number }> | null }): Promise<AgentName | null> {
    if (!rt.agents?.codex) return null;
    const cap = rt.agents.codex.maxConcurrent ?? this.cfg.agent_concurrency.codex;
    const n = Number((await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM sessions WHERE runtime_id=$1 AND agent='codex' AND state IN ('planned','running','waiting_input')`, [rt.id]))?.n ?? 0);
    return n < Number(cap) ? 'codex' : null;
  }

  /** 名额释放后按入队顺序补派排队的代码定位（派不出去就停） */
  async drainCodeLocate(runtimeName: string) {
    const rt = await this.db.one<{ labels: string[] }>('SELECT labels FROM runtimes WHERE name=$1', [runtimeName]);
    if (!rt || !this.hub.isOnline(runtimeName)) return;
    const queued = await this.db.query<any>(`SELECT * FROM jobs WHERE status='queued' AND kind='code-locate' ORDER BY created_at`);
    for (const j of queued.rows) {
      if (j.required_label && !rt.labels.includes(j.required_label)) continue;
      if (!(await this.startCodeLocate(j.args.taskId, j.id, runtimeName))) break;
    }
  }

  /**
   * 基线分支三级回退：任务（拍板确定）> 分流卡（定位会话判断）> 仓库级默认。
   * 仓库级固定值对不上任务要改的分支时，agent 在 worktree 里根本找不到目标代码。
   */
  async baseBranchFor(taskId: string, repo?: string | null): Promise<string> {
    const t = await this.db.one<any>('SELECT base_branch, repo_name, parent_id FROM tasks WHERE id=$1', [taskId]);
    const card = await this.db.one<{ base_branch: string | null }>('SELECT base_branch FROM triage_cards WHERE task_id=$1', [taskId]);
    // 子任务（review / pr）沿用父任务定下的基线：T-81.2 的 review worktree 落在仓库默认 cloud-4.0，而 PR 是向 hotfix 分支提的
    const parent = !t?.base_branch && t?.parent_id ? await this.db.one<{ base_branch: string | null }>('SELECT base_branch FROM tasks WHERE id=$1', [t.parent_id]) : null;
    const r = repo ?? t?.repo_name ?? null;
    return t?.base_branch ?? card?.base_branch ?? parent?.base_branch ?? (r ? this.cfg.repo_base_branch?.[r] : undefined) ?? 'master';
  }

  async sendWorktreeCreate(taskId: string, runtimeName: string, repo: string, purpose: 'code_locate' | 'implement' | 'review', fetchFirst = false, resetToBase = false) {
    const t = await this.db.one<any>('SELECT * FROM tasks WHERE id=$1', [taskId]);
    const cp = await this.db.one<any>('SELECT * FROM context_packs WHERE task_id=$1', [taskId]);
    const baseBranch = await this.baseBranchFor(taskId, repo);
    const md = `# ${t.key} 上下文包\n\n## 需求原文\n${cp?.source_text ?? ''}\n\n## 仓库\n${repo}（${t.repo_source}）\n\n## Jira\n${cp?.jira ? JSON.stringify(cp.jira, null, 2) : '-'}\n\n## 代码定位\n${JSON.stringify(cp?.code_locations ?? [], null, 2)}\n${cp?.plan_doc ? `\n## 方案\n${cp.plan_doc}\n` : ''}`;
    const env = this.hub.send(runtimeName, 'worktree.create', {
      taskKey: t.key, repo, baseBranch, branchName: `foreman/${t.key}`, reuseIfExists: true, fetchFirst, ...(resetToBase ? { resetToBase: true } : {}),
      contextMarkdown: md, taskJson: { key: t.key, kind: t.kind, path: t.path, repo, purpose },
    });
    await this.db.query(`INSERT INTO jobs (kind, status, args, scheduled_at, dispatched_at, created_at) VALUES ('dispatch','dispatched',$1,$2,$2,$2)`, [JSON.stringify({ commandId: env.id, type: 'worktree.create', taskId, purpose, runtime: runtimeName, repo, fetchFirst, resetToBase }), this.clock.now()]);
    return env.id;
  }

  /** deliver(triage)：分流卡 + 审批（Step 22–26）；降级卡补齐时原位更新（EX-12.1） */
  /**
   * 代码定位排队（幂等）。先收掉这张单遗留的「已派发」作业：它们在会话结束后从没被关，
   * 会撞上 dedupe 唯一索引（2026-09-29 批量重新定位，名额满时 5 张单直接 500、没进队列）。
   */
  async enqueueCodeLocate(taskId: string) {
    const active = await this.db.one(`SELECT 1 FROM sessions WHERE task_id=$1 AND kind='code_locate' AND state IN ('planned','running','waiting_input')`, [taskId]);
    if (active) return;
    await this.closeCodeLocateJobs(taskId, 'skipped');
    await this.db.query(`INSERT INTO jobs (kind, status, required_label, args, dedupe_key, scheduled_at, created_at) VALUES ('code-locate','queued','build:doris',$1,$2,$3,$3)
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','dispatched','running') DO NOTHING`, [JSON.stringify({ taskId }), `code-locate:${taskId}`, this.clock.now()]);
  }

  /** 收掉该任务未完结（已派发 / 运行中）的代码定位作业：会话终结或重新排队前调用 */
  async closeCodeLocateJobs(taskId: string, status: 'succeeded' | 'failed' | 'skipped') {
    await this.db.query(`UPDATE jobs SET status=$2, finished_at=$3 WHERE kind='code-locate' AND status IN ('dispatched','running') AND args->>'taskId'=$1`, [taskId, status, this.clock.now()]);
  }

  /** 平台认得的仓库：runtime 登记的、Jira 项目映射里的、配了仓库级基线的 */
  async knownRepos(): Promise<string[]> {
    const rows = await this.db.query<{ repos: Record<string, unknown> | null }>('SELECT repos FROM runtimes');
    const set = new Set<string>();
    for (const r of rows.rows) for (const k of Object.keys(r.repos ?? {})) set.add(k);
    for (const v of Object.values(this.cfg.sources.jira.project_repo_map ?? {})) set.add(String(v));
    for (const k of Object.keys(this.cfg.repo_base_branch ?? {})) set.add(k);
    return [...set].sort();
  }

  async emitTriage(taskId: string, sessionId: string | null, input: { tier?: string; effort?: string; repo?: { name: string | null; confidence: number; candidates?: string[] }; targetBranch?: string | null; suggestedPath?: string; codeLocations?: any[]; degraded?: boolean; degradedReason?: string }, opts?: { note?: string }) {
    const triage = normalizeTriage(input, await this.knownRepos());
    const now = this.clock.now();
    const t = await this.db.one<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1`, [taskId]);
    if (!t) return;
    const cpJira = (await this.db.one<{ jira: any }>('SELECT jira FROM context_packs WHERE task_id=$1', [taskId]))?.jira ?? null;
    // 影响版本规则算出的仓库 / 基线是确定的，agent 的判断不能覆盖（2026-09-30：agent 看不到版本，照示例填了 4.1）
    const vt = (cpJira?.versionTarget ?? null) as VersionTarget | null;
    if (vt) { triage.repo = { name: vt.repo, confidence: 1, candidates: triage.repo?.candidates ?? [] }; triage.targetBranch = vt.baseBranch; }
    const repoName = vt ? vt.repo : triage.repo && triage.repo.confidence >= 0.6 ? triage.repo.name : (t.repo_source === 'mapping' || t.repo_source === 'manual' ? t.repo_name : null);
    // 降级卡（还没跑过代码定位）不下调来源：入库时标的 llm/mapping 保留，等补齐后再定
    const repoSource = vt ? 'version' : t.repo_source === 'mapping' || t.repo_source === 'manual' ? t.repo_source : repoName ? 'llm' : triage.degraded ? t.repo_source : 'unresolved';
    const tier = triage.tier ?? (t.path ?? 'fix'); const effort = triage.effort ?? (triage.degraded ? 'medium' : 'small');
    const defaultRuntime = (await this.tasks.routeFor(t.kind ?? 'code', null, repoName)).runtime;
    const defaultAgent = await this.nextAgent();
    const existing = await this.db.one<any>(`SELECT a.* FROM approvals a WHERE a.task_id=$1 AND a.action_type='triage_confirm' AND a.status='pending'`, [taskId]);
    // ContextPack.codeLocations maxItems 8（tasks.yaml）：超出截断并记事件
    const allLocations = triage.codeLocations ?? [];
    const truncated = allLocations.length > 8;
    // 目标分支：定位会话判断出来的优先，其次沿用任务上已有的（补齐降级卡时不要丢掉先前的判断）
    // 沿用任务上已有的基线前也要确认是一条合法分支（2026-09-29 之前入库的卡里有「3.1 or 4.0」这种）
    const targetBranch = triage.targetBranch ?? (t.base_branch && isBranchName(t.base_branch) ? t.base_branch : null);
    const versions: string[] = cpJira?.affectsVersions?.length ? cpJira.affectsVersions : (cpJira?.fixVersions ?? []);
    const pickTargets: string[] = vt?.pickTargets ?? t.pick_targets ?? [];
    const payload = { taskKey: t.key, tier, effort, repo: { name: repoName, source: repoSource, confidence: triage.repo?.confidence ?? null, candidates: triage.repo?.candidates ?? [] }, baseBranch: targetBranch, baseSource: vt ? 'version' : triage.targetBranch ? 'agent' : targetBranch ? 'task' : null, versions, pickTargets, suggestedPath: triage.suggestedPath ?? '', codeLocations: allLocations.slice(0, 8), defaultRuntime, defaultAgent, degraded: !!triage.degraded, degradedReason: triage.degradedReason ?? null, summaryLine: `档位 ${tier} · 预估 ${effort} · 仓库 ${repoName ?? '待确认'} · 基线 ${targetBranch ?? '仓库默认'}${pickTargets.length ? ` · pick ${pickTargets.join('、')}` : ''}${versions.length ? ` · 影响版本 ${versions.join('、')}` : ''} · runtime ${defaultRuntime ?? '-'} · agent ${defaultAgent}` };
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO triage_cards (task_id, tier, effort, repo_name, repo_confidence, repo_candidates, base_branch, suggested_path, code_locations, default_runtime, default_agent, degraded, degraded_reason, session_id, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
        ON CONFLICT (task_id) DO UPDATE SET tier=EXCLUDED.tier, effort=EXCLUDED.effort, repo_name=EXCLUDED.repo_name, repo_confidence=EXCLUDED.repo_confidence, repo_candidates=EXCLUDED.repo_candidates, base_branch=COALESCE(EXCLUDED.base_branch, triage_cards.base_branch), suggested_path=EXCLUDED.suggested_path, code_locations=EXCLUDED.code_locations, default_runtime=EXCLUDED.default_runtime, default_agent=EXCLUDED.default_agent, degraded=EXCLUDED.degraded, degraded_reason=EXCLUDED.degraded_reason, session_id=COALESCE(EXCLUDED.session_id, triage_cards.session_id), updated_at=EXCLUDED.updated_at`,
        [taskId, tier, effort, repoName, triage.repo?.confidence ?? null, triage.repo?.candidates ?? [], targetBranch, payload.suggestedPath, JSON.stringify(payload.codeLocations), defaultRuntime, defaultAgent, payload.degraded, payload.degradedReason, sessionId, now]);
      await c.query(`UPDATE context_packs SET code_locations=$2, updated_at=$3, version=version+1 WHERE task_id=$1`, [taskId, JSON.stringify(payload.codeLocations), now]);
      if (truncated) await this.events.record(c, { type: 'context_pack.truncated', taskId, broadcast: false, payload: { taskKey: t.key, field: 'codeLocations', from: allLocations.length, to: 8 } });
      await c.query(`UPDATE tasks SET state='pending_decision', repo_name=$2, repo_source=$3, repo_confidence=$4, repo_candidates=$5, path=$6, base_branch=COALESCE($7, base_branch), updated_at=$8 WHERE id=$1`, [taskId, repoName, repoSource, triage.repo?.confidence ?? null, triage.repo?.candidates ?? [], tier, targetBranch, now]);
      if (existing) {
        await c.query(`UPDATE approvals SET payload=$2, updated_at=$3 WHERE id=$1`, [existing.id, JSON.stringify(payload), now]);
        await c.query(`UPDATE triage_cards SET approval_id=$2 WHERE task_id=$1`, [taskId, existing.id]);
        const note = opts?.note ?? (payload.degraded ? `代码定位未完成：${payload.degradedReason ?? '原因未知'}` : '代码定位已补齐');
        await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [t.channel_id, taskId, note, now]);
        await this.events.record(c, { type: 'thread.event', taskId, payload: { taskKey: t.key, text: note } });
        await this.events.record(c, { type: 'inbox.new', taskId, payload: { itemType: 'approval', item: { ...this.approvals.serialize(existing), payload }, updated: true } });
      }
    });
    this.events.flush();
    if (!existing) {
      const a = await this.approvals.request({ taskId, actionType: 'triage_confirm', title: `${t.key} · ${t.title.slice(0, 60)}`, body: `分流卡：${payload.summaryLine}\n建议：${payload.suggestedPath}`, payload, executor: 'center' });
      await this.db.query(`UPDATE triage_cards SET approval_id=(SELECT id FROM approvals WHERE key=$2) WHERE task_id=$1`, [taskId, a.key]);
    }
  }

  /** 所有任务统一使用 Codex。 */
  async nextAgent(): Promise<AgentName> { return 'codex'; }

  /** 会话 token（MCP 鉴权） */
  static newToken() { return randomBytes(24).toString('hex'); }
  static hash(token: string) { return sha256(token); }

  /** progress-watch：代码定位超时（EX-22.1） */
  async watchCodeLocateTimeouts() {
    const cutoff = new Date(this.clock.now().getTime() - CODE_LOCATE_TIMEOUT_MINUTES * 60_000);
    // planned 会话还没 started_at（worktree 一直没好）也按创建时间算，否则会永远占着并发名额
    const stale = await this.db.query<any>(`SELECT s.id, s.task_id, s.state, r.name AS runtime, COALESCE((SELECT NOT c.degraded FROM triage_cards c WHERE c.task_id=s.task_id), false) AS delivered FROM sessions s JOIN runtimes r ON r.id=s.runtime_id WHERE s.kind='code_locate' AND s.state IN ('running','planned','waiting_input') AND COALESCE(s.started_at, s.created_at) <= $1`, [cutoff]);
    for (const s of stale.rows) {
      if (s.state !== 'planned') this.hub.send(s.runtime, 'session.stop', { sessionId: s.id, reason: 'timeout' });
      if (s.delivered) {
        // 已交付分流卡、只是会话没收尾（例如一轮结束被当成等输入）：按完成处理，不能用降级卡覆盖已有结果
        await this.db.query(`UPDATE sessions SET state='done', ended_at=$2, updated_at=$2 WHERE id=$1`, [s.id, this.clock.now()]);
        await this.db.query(`UPDATE questions SET status='timeout' WHERE session_id=$1 AND status='open' AND origin='hook'`, [s.id]);
        continue;
      }
      await this.db.query(`UPDATE sessions SET state='stopped', failure_reason='code-locate timeout', ended_at=$2, updated_at=$2 WHERE id=$1`, [s.id, this.clock.now()]);
      await this.emitTriage(s.task_id, s.id, { degraded: true, degradedReason: '代码定位失败：超时 15 分钟' });
    }
    for (const name of new Set(stale.rows.map((s) => s.runtime as string))) await this.drainCodeLocate(name);
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

/** 仓库名归一：短名 / 大小写不同但能唯一对上已登记仓库的，换成全名；对不上或有歧义则原样 */
export function normalizeRepo(name: string, known: string[]): string {
  if (known.includes(name)) return name;
  const base = (x: string) => x.split('/').pop()!.toLowerCase();
  const hits = known.filter((k) => k.toLowerCase() === name.toLowerCase() || base(k) === base(name));
  return hits.length === 1 ? hits[0]! : name;
}

/** 是否像一条具体的 git 分支名（不能有空格、说明文字、多个分支） */
export function isBranchName(b: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(b) && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock');
}

/** 定位结论入库前的兜底：仓库名补全、非法基线清空并把原文留给拍板的人 */
export function normalizeTriage<T extends { repo?: { name: string | null; confidence: number; candidates?: string[] }; targetBranch?: string | null; suggestedPath?: string }>(t: T, known: string[]): T {
  const out = { ...t };
  if (t.repo) {
    out.repo = { ...t.repo, name: t.repo.name ? normalizeRepo(t.repo.name, known) : null, ...(t.repo.candidates ? { candidates: [...new Set(t.repo.candidates.map((c) => normalizeRepo(c, known)))] } : {}) };
  }
  const b = t.targetBranch?.trim();
  if (b && !isBranchName(b)) {
    out.targetBranch = null;
    out.suggestedPath = `${t.suggestedPath ? `${t.suggestedPath}\n` : ''}（定位给出的基线不是一条具体分支，拍板时请确认：${b}）`;
  } else if (t.targetBranch !== undefined) out.targetBranch = b || null;
  return out;
}
