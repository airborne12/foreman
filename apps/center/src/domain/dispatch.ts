/**
 * 派发与会话生命周期（S03）：拍板后路由、选家、并发闸门、worktree、会话启动、产物、子任务、失败与重试、镜像回写。
 * 来源：core-S03-decide-and-dispatch.md（Step 1–34，EX-4.1…34.1）；S01 Step 12–19 的 worktree/会话共用；S05 EX-23.1 离线排队补发。
 */
import type { Db, Queryable } from '../db.js';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events.js';
import type { WorkerHub } from '../hub/workerHub.js';
import type { Tasks } from './tasks.js';
import type { Approvals, ApprovalRow, ApprovalDecision } from './approvals.js';
import type { Intake } from './intake.js';
import type { Notifications } from './notifications.js';
import type { Questions } from './questions.js';
import { ApiError, routingCategory, type CenterConfig, type AgentName, type Envelope } from '@foreman/shared';
import { Intake as IntakeStatics } from './intake.js';
import { serializeMessage } from './tasks.js';

type SessionKind = 'implement' | 'review' | 'code_locate' | 'plan' | 'proto';

export class Dispatch {
  questions!: Questions;
  constructor(private db: Db, private clock: Clock, private events: EventBus, private cfg: CenterConfig, private hub: WorkerHub, private tasks: Tasks, private approvals: Approvals, private intake: Intake, private notifications: Notifications) {}

  // ---------------- 拍板后（S03 Step 6–8） ----------------
  async onApprovalDecided(a: ApprovalRow, d: ApprovalDecision) {
    if (a.action_type === 'triage_confirm') {
      if (!d.approved) { await this.db.query(`UPDATE tasks SET state='paused', state_before_pause='pending_decision', terminal_at=$2, updated_at=$2 WHERE id=$1`, [a.task_id, this.clock.now()]); await this.broadcastTask(a.task_id); return; }
      const ov = (d.overrides ?? {}) as Record<string, string | undefined>;
      const t = await this.db.one<any>('SELECT * FROM tasks WHERE id=$1', [a.task_id]);
      // 基线分支：拍板覆盖 > 分流卡判断出的目标分支 > 任务已有值（为空则建 worktree 时回退到仓库级默认）
      const card = await this.db.one<{ base_branch: string | null }>('SELECT base_branch FROM triage_cards WHERE task_id=$1', [a.task_id]);
      const baseBranch = ov.baseBranch ?? card?.base_branch ?? t.base_branch ?? null;
      const decision = { path: ov.path ?? t.path ?? 'fix', repo: ov.repo ?? t.repo_name, baseBranch, runtime: ov.runtime ?? null, agent: ov.agent ?? null, modified: !!(ov.path || ov.repo || ov.baseBranch || ov.runtime || ov.agent), decidedVia: d.via, decidedAt: this.clock.now().toISOString() };
      await this.db.query(`UPDATE tasks SET state='queued', path=$2, repo_name=$3, repo_source=CASE WHEN $4::boolean THEN 'manual' ELSE repo_source END, base_branch=$5, decision=$6, updated_at=$7 WHERE id=$1`,
        [a.task_id, decision.path, decision.repo, !!ov.repo, baseBranch, JSON.stringify(decision), this.clock.now()]);
      await this.threadEvent(a.task_id, `已拍板（${d.via === 'feishu' ? '飞书 ✅' : d.via === 'auto' ? '自动' : '面板'}${decision.modified ? '，修改' : '，原样确认'}）· 路径 ${decision.path}${baseBranch ? ` · 基线 ${baseBranch}` : ''}`);
      await this.dispatchTask(a.task_id, { runtime: ov.runtime ?? null, agent: (ov.agent as AgentName | undefined) ?? null });
      return;
    }
    if (a.action_type === 'create_pr' && d.approved && a.session_id) {
      // EX-22.1：等待超时后会话已结束 → 续接送回批准
      const s = await this.db.one<any>(`SELECT s.*, r.name AS runtime FROM sessions s JOIN runtimes r ON r.id=s.runtime_id WHERE s.id=$1`, [a.session_id]);
      if (s && ['done', 'stopped', 'failed'].includes(s.state)) {
        this.hub.send(s.runtime, 'session.resume', { sessionId: s.id, text: `审批 ${a.key} 已批准，继续创建 PR` });
        await this.db.query(`UPDATE sessions SET state='running', updated_at=$2 WHERE id=$1`, [s.id, this.clock.now()]);
        await this.db.query(`UPDATE tasks SET state='running', updated_at=$2 WHERE id=$1`, [a.task_id, this.clock.now()]);
        await this.threadEvent(a.task_id, `已恢复会话 ${s.agent_session_id ?? s.id.slice(0, 6)}：送入「已批准」`);
        await this.broadcastTask(a.task_id);
      }
      return;
    }
    if (a.action_type === 'start_implement' && d.approved) await this.implementFromPlan(a.task_id);
  }

  /** 路由 + 选家 + 并发闸门 → planned 会话 → worktree.create / session.start（S03 Step 7–14；EX-7.1/7.2） */
  async dispatchTask(taskId: string, opts?: { runtime?: string | null; agent?: AgentName | null; kind?: SessionKind; attempt?: number; promptSuffix?: string }) {
    const t = await this.db.one<any>('SELECT * FROM tasks WHERE id=$1', [taskId]);
    if (!t) return;
    const override = opts?.runtime ?? (t.decision?.runtime as string | null) ?? null;
    const route = await this.tasks.routeFor(t.kind ?? 'code', override, t.repo_name);
    if (!route.runtime || !this.hub.isOnline(route.runtime)) {
      const repoMissing = (route.missingLabels ?? []).find((l) => l.startsWith('repo:'));
      const reason = repoMissing ? `人工处理：没有 runtime 登记仓库 ${repoMissing.slice(5)}，在 runtime 配置里加上该仓库，或改选仓库后重新拍板`
        : override ? `等待 ${override} 上线` : `等待带 ${(route.missingLabels ?? []).join(',') || '所需标签'} 的 runtime（如 dev）上线`;
      await this.db.query(`UPDATE tasks SET state='queued', runtime_name=$2, queue_reason=$3, updated_at=$4 WHERE id=$1`, [taskId, route.runtime, reason, this.clock.now()]);
      if (t.queue_reason !== reason) await this.threadEvent(taskId, `${route.reason} · ${reason}`);
      await this.broadcastTask(taskId); return;
    }
    const rt = await this.db.one<any>('SELECT * FROM runtimes WHERE name=$1', [route.runtime]);
    const kind: SessionKind = opts?.kind ?? (t.path === 'plan' ? 'plan' : t.path === 'proto' ? 'proto' : 'implement');
    let agent: AgentName = opts?.agent ?? (t.decision?.agent as AgentName | null) ?? (t.agent as AgentName | null) ?? (kind === 'review' ? await this.reviewerFor(t) : await this.intake.nextAgent());
    await this.threadEvent(taskId, `${route.reason} · agent ${agent}`);
    // 并发闸门（EX-7.2）：planned + running + waiting_input 计入名额
    let running = await this.runningCount(rt.id, agent);
    const max = Number(rt.agents?.[agent]?.maxConcurrent ?? this.cfg.agent_concurrency[agent] ?? 3);
    if (running >= max) {
      const other = otherAgent(agent);
      const cat = routingCategory(t.kind ?? 'code');
      if (cat === 'analysis' && rt.agents?.[other] && (await this.runningCount(rt.id, other)) < Number(rt.agents[other].maxConcurrent ?? 3)) {
        await this.threadEvent(taskId, `已改派 ${other}（${agent} 满）`); agent = other; running = 0;
      } else {
        const pos = Number((await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE state='queued' AND runtime_name=$1 AND agent=$2 AND id<>$3 AND queue_reason LIKE '排队%'`, [rt.name, agent, taskId]))?.n ?? 0) + 1;
        const reason = `排队：${agent} 队列第 ${pos} 位（${running}/${max} 运行中）`;
        await this.db.query(`UPDATE tasks SET state='queued', runtime_name=$2, agent=$3, queue_reason=$4, updated_at=$5 WHERE id=$1`, [taskId, rt.name, agent, reason, this.clock.now()]);
        await this.threadEvent(taskId, reason); await this.broadcastTask(taskId); return;
      }
    }
    const now = this.clock.now();
    let wt = await this.db.one<any>(`SELECT * FROM worktrees WHERE task_id=$1 AND runtime_id=$2 AND state='ready'`, [taskId, rt.id]);
    // 代码定位阶段建 worktree 时还没判断出目标分支，用的是仓库默认基线；拍板定了别的基线后不能直接复用，
    // 否则 agent 会在错误的分支上改（2026-09-24 实验环境 T-1：worktree 基于 4.0，任务基线是 4.1）
    // 只重建「代码定位建的、还没有实现类会话用过」的 worktree：重试 / 新会话继续时里面已经有 agent 的改动，不能丢
    const wantBase = await this.intake.baseBranchFor(taskId, t.repo_name);
    const worked = wt ? await this.db.one(`SELECT 1 FROM sessions WHERE worktree_id=$1 AND kind<>'code_locate' LIMIT 1`, [wt.id]) : null;
    const rebase = !!wt && !worked && wt.base_branch !== wantBase;
    if (rebase) { await this.threadEvent(taskId, `基线已定为 ${wantBase}，现有工作区基于 ${wt.base_branch}（代码定位阶段所建），按新基线重建`); wt = null; }
    const session = await this.db.one<{ id: string }>(`INSERT INTO sessions (task_id, runtime_id, agent, kind, state, prompt, attempt, worktree_id, created_at, updated_at) VALUES ($1,$2,$3,$4,'planned',$8,$5,$6,$7,$7) RETURNING id`, [taskId, rt.id, agent, kind, opts?.attempt ?? 1, wt?.id ?? null, now, opts?.promptSuffix ?? '']);
    await this.db.query(`UPDATE tasks SET state='queued', runtime_name=$2, agent=$3, queue_reason=NULL, author_agent=CASE WHEN $4='implement' THEN $3 ELSE author_agent END, updated_at=$5 WHERE id=$1`, [taskId, rt.name, agent, kind, now]);
    await this.broadcastTask(taskId);
    if (wt) await this.startSession(session!.id, wt.path);
    else await this.intake.sendWorktreeCreate(taskId, rt.name, t.repo_name ?? 'apache/doris', kind === 'review' ? 'review' : 'implement', false, rebase);
  }

  /** runtime 上线（S03 EX-7.1 / S05 EX-23.1）：补派等待该 runtime 或等待标签的排队任务；补发的离线指令标记已送达 */
  async onRuntimeOnline(name: string, replayed: Envelope[] = []) {
    if (replayed.length) {
      const ids = replayed.map((e) => e.id);
      const rows = await this.db.query<{ id: string; task_id: string }>(`UPDATE messages SET delivery='delivered', delivered_at=$2 WHERE delivery='queued' AND payload->>'commandId' = ANY($1::text[]) RETURNING id, task_id`, [ids, this.clock.now()]);
      for (const r of rows.rows) { await this.events.record(this.db.pool, { type: 'message.updated', taskId: r.task_id, payload: { messageId: r.id, delivery: 'delivered' } }); }
      this.events.flush();
    }
    const queued = await this.db.query<any>(`SELECT id FROM tasks WHERE state='queued' AND (runtime_name=$1 OR runtime_name IS NULL) AND (queue_reason IS NULL OR queue_reason NOT LIKE '排队%') AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.task_id=tasks.id AND s.state IN ('planned','running','waiting_input')) ORDER BY created_at`, [name]);
    for (const t of queued.rows) await this.dispatchTask(t.id);
  }

  /** 会话结束后释放名额：按队列顺序补派同 runtime 同 agent 的排队任务（EX-7.2） */
  private async drainQueue(runtimeName: string, agent: string) {
    await this.intake.drainCodeLocate(runtimeName);
    const next = await this.db.one<{ id: string }>(`SELECT id FROM tasks WHERE state='queued' AND runtime_name=$1 AND agent=$2 AND queue_reason LIKE '排队%' ORDER BY updated_at LIMIT 1`, [runtimeName, agent]);
    if (next) await this.dispatchTask(next.id, { agent: agent as AgentName });
  }

  /** 会话终结时关掉它推断出来的问题（EX-19.1 的 origin=hook）：会话没了，这类问题没人能回答 */
  private async closeInferredQuestions(sessionId: string) {
    await this.db.query(`UPDATE questions SET status='timeout' WHERE session_id=$1 AND status='open' AND origin='hook'`, [sessionId]);
  }

  private async runningCount(runtimeId: string, agent: string) {
    return Number((await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM sessions WHERE runtime_id=$1 AND agent=$2 AND state IN ('planned','running','waiting_input')`, [runtimeId, agent]))?.n ?? 0);
  }
  /** review 子任务：与作者不同家（S03 Step 29） */
  async reviewerFor(t: any): Promise<AgentName> {
    const parent = t.parent_id ? await this.db.one<any>('SELECT author_agent FROM tasks WHERE id=$1', [t.parent_id]) : null;
    return otherAgent((parent?.author_agent ?? t.author_agent ?? 'claude') as AgentName);
  }

  // ---------------- worktree.ready → session.start（Step 12–17） ----------------
  async onWorktreeReady(runtimeName: string, ready: { taskKey: string; path: string; branchName: string; reused: boolean; baseBranch?: string | null; buildEnvMissing?: boolean }) {
    const t = await this.db.one<any>('SELECT * FROM tasks WHERE key=$1', [ready.taskKey]);
    const rt = await this.db.one<any>('SELECT * FROM runtimes WHERE name=$1', [runtimeName]);
    if (!t || !rt) return;
    const now = this.clock.now();
    const wt = await this.db.one<{ id: string }>(`INSERT INTO worktrees (task_id, runtime_id, repo_name, base_branch, branch_name, path, state, created_at) VALUES ($1,$2,$3,$4,$5,$6,'ready',$7) ON CONFLICT (runtime_id, path) DO UPDATE SET state='ready', branch_name=EXCLUDED.branch_name, task_id=EXCLUDED.task_id, base_branch=EXCLUDED.base_branch RETURNING id`,
      [t.id, rt.id, t.repo_name ?? 'apache/doris', ready.baseBranch ?? t.base_branch ?? this.cfg.repo_base_branch?.[t.repo_name] ?? 'master', ready.branchName, ready.path, now]);
    await this.db.query(`UPDATE tasks SET branch_name=$2, updated_at=$3 WHERE id=$1`, [t.id, ready.branchName, now]);
    // 该基线分支没有匹配的构建环境：说清楚，别让 agent 拿不匹配的依赖硬编译（4.1 的代码配 4.0 的 thirdparty 只会在链接阶段失败）
    if (ready.buildEnvMissing) await this.threadEvent(t.id, `worktree 已就绪（基线 ${ready.baseBranch ?? '仓库默认'}），但该分支没有匹配的构建环境：只做静态检查与改动，编译与单测交给 CI`, undefined);
    await this.db.query(`UPDATE jobs SET status='succeeded', finished_at=$2 WHERE kind='dispatch' AND status='dispatched' AND args->>'type'='worktree.create' AND args->>'taskId'=$1`, [t.id, now]);
    const pending = await this.db.one<{ id: string }>(`SELECT id FROM sessions WHERE task_id=$1 AND runtime_id=$2 AND state='planned' ORDER BY created_at DESC LIMIT 1`, [t.id, rt.id]);
    if (pending) { await this.db.query(`UPDATE sessions SET worktree_id=$2 WHERE id=$1`, [pending.id, wt!.id]); await this.startSession(pending.id, ready.path); return; }
    // 无 planned 会话：这是代码定位（S01 Step 15）
    const agent = await this.intake.nextAgent();
    const s = await this.db.one<{ id: string }>(`INSERT INTO sessions (task_id, runtime_id, agent, kind, state, prompt, worktree_id, created_at, updated_at) VALUES ($1,$2,$3,'code_locate','planned','',$4,$5,$5) RETURNING id`, [t.id, rt.id, agent, wt!.id, now]);
    await this.startSession(s!.id, ready.path);
  }

  /** 文本类会话（dispatcher / candidate_scan）：无任务，挂在频道上（S02 Step 23、S04 Step 13） */
  async startTextSession(input: { channelId: string | null; kind: 'dispatcher' | 'candidate_scan'; prompt: string; timeoutMinutes?: number | null }): Promise<{ sessionId: string; runtime: string; agent: AgentName } | { error: 'NO_RUNTIME' | 'QUOTA'; detail: string }> {
    const route = await this.tasks.routeFor('text', null);
    if (!route.runtime || !this.hub.isOnline(route.runtime)) return { error: 'NO_RUNTIME', detail: route.runtime ? `${route.runtime} 离线` : '没有可用的文本类 runtime' };
    const rt = await this.db.one<any>('SELECT * FROM runtimes WHERE name=$1', [route.runtime]);
    const agent = await this.pickFreeAgent(rt);
    if (!agent) return { error: 'QUOTA', detail: `${rt.name} 上两家 agent 并发已满` };
    const now = this.clock.now();
    const s = await this.db.one<{ id: string }>(`INSERT INTO sessions (channel_id, runtime_id, agent, kind, state, prompt, created_at, updated_at) VALUES ($1,$2,$3,$4,'planned',$5,$6,$6) RETURNING id`,
      [input.channelId, rt.id, agent, input.kind, input.prompt, now]);
    await this.startSession(s!.id, '/tmp', input.prompt, input.timeoutMinutes ?? null);
    return { sessionId: s!.id, runtime: rt.name, agent };
  }

  /** 并发闸门：返回还有名额的 agent（claude 优先），都满返回 null（S02 EX-23.1、S04 EX-13.1） */
  async pickFreeAgent(rt: { id: string; agents?: Record<string, { maxConcurrent?: number }> }): Promise<AgentName | null> {
    for (const agent of ['claude', 'codex'] as AgentName[]) {
      const cfgMax = rt.agents?.[agent]?.maxConcurrent ?? this.cfg.agent_concurrency[agent];
      if (cfgMax == null) continue;
      if ((await this.runningCount(rt.id, agent)) < Number(cfgMax)) return agent;
    }
    return null;
  }

  async startSession(sessionId: string, cwd: string, promptOverride?: string | null, timeoutMinutes?: number | null) {
    const s = await this.db.one<any>(`SELECT s.*, r.name AS runtime, t.key AS task_key, t.path AS task_path, t.repo_name FROM sessions s JOIN runtimes r ON r.id=s.runtime_id LEFT JOIN tasks t ON t.id=s.task_id WHERE s.id=$1`, [sessionId]);
    if (!s) return;
    const token = IntakeStatics.newToken();
    const known = s.kind === 'code_locate' ? await this.intake.knownRepos() : undefined;
    const prompt = promptOverride ?? (this.promptFor(s.kind, s.task_key, s.task_path, s.repo_name, known) + (s.prompt ? `\n\n${s.prompt}` : ''));
    const now = this.clock.now();
    await this.db.query(`UPDATE sessions SET cwd=$2, prompt=$3, mcp_token_hash=$4, updated_at=$5 WHERE id=$1`, [sessionId, cwd, prompt, IntakeStatics.hash(token), now]);
    const env = this.hub.send(s.runtime, 'session.start', {
      sessionId, taskKey: s.task_key ?? null, kind: s.kind, agent: s.agent, model: null, prompt, cwd, name: `${s.task_key ?? 'ch'}-${s.kind}`,
      mcp: { url: `http://127.0.0.1:${this.cfg.listen.split(':')[1] ?? '7801'}/mcp`, token }, env: {},
      timeoutMinutes: timeoutMinutes ?? (s.kind === 'code_locate' ? 15 : s.kind === 'candidate_scan' ? 10 : null),
    });
    await this.db.query(`INSERT INTO jobs (kind, status, args, scheduled_at, dispatched_at, created_at) VALUES ('dispatch','dispatched',$1,$2,$2,$2)`, [JSON.stringify({ commandId: env.id, type: 'session.start', sessionId, taskId: s.task_id }), now]);
  }

  promptFor(kind: string, taskKey: string, path: string | null, repo: string | null, knownRepos?: string[]) {
    const base = `你在 foreman 任务 ${taskKey} 的 worktree 中工作（仓库 ${repo ?? '待定'}）。先调用 MCP 工具 get_task 读取上下文包；每完成一个可感知步骤调用 report_progress（≤200 字）；需要用户决策调用 ask_user；需要人确认的动作（如创建 PR）先调用 request_approval；产物用 deliver 回写。禁止使用任何 API key。`;
    switch (kind) {
      // 字段逐个写清：2026-09-29 claude 交回短仓库名（selectdb-core）、建议只写一个词 fix，codex 把基线写成「3.1 or 4.0」
      case 'code_locate': return `${base}
本会话只做代码定位与分流，不要修改代码。结束前调用一次 deliver，artifacts 里放一个 {kind:"triage", ...} 对象，字段要求：
- tier：fix（简单修复）/ plan（出方案）/ proto（出原型）
- effort：small（<2h）/ medium（半天）/ large（>1 天）
- repo：{ name, confidence（0–1）, candidates }。name 必须是 owner/name 全名，从已登记仓库中选：${(knownRepos ?? []).join('、') || '（无）'}；拿不准就把 name 置 null，可能的放进 candidates
- targetBranch：要改的那一条具体分支名（如 branch-selectdb-doris-4.1）；判断不了就填 null，不要写多个分支或写说明
- suggestedPath：一两句中文，说明建议怎么改、为什么
- codeLocations：最相关的 ≤8 处，每处 { file, line, symbol, why }，why 用中文写这处为什么相关`;
      case 'plan': return `${base}\n本会话产出方案文档：写到 docs/plan-${taskKey}.md 并 deliver({kind:"doc", path, title, content})。不要改业务代码。`;
      case 'proto': return `${base}\n本会话产出可运行 demo 分支加一页说明，deliver({kind:"branch", branch, readmePath})。`;
      case 'review': return `${base}\n本会话对同一任务的 PR 做 review：给出必须修/建议修/可忽略三类意见，通过 report_progress 回写结论。`;
      default: return `${base}\n本会话按路径 ${path ?? 'fix'} 实现修复：复现、修改、跑相关 UT，然后 request_approval(create_pr) 并在批准后用 create-doris-pr skill 建 PR，最后 deliver({kind:"pr", url, title, diffStat})。`;
    }
  }

  // ---------------- 会话状态（Step 17–19、31–33；EX-32.1） ----------------
  async onSessionStarted(runtimeName: string, p: { sessionId: string; agentSessionId: string; startedAt: string; pid?: number | null }) {
    const now = this.clock.now();
    const s = await this.db.one<any>(`UPDATE sessions SET state='running', agent_session_id=$2, started_at=$3, pid=$4, last_activity_at=$5, updated_at=$5 WHERE id=$1 RETURNING *`, [p.sessionId, p.agentSessionId, new Date(p.startedAt), p.pid ?? null, now]);
    if (!s) return;
    await this.db.query(`UPDATE jobs SET status='succeeded', finished_at=$2 WHERE kind='dispatch' AND status='dispatched' AND args->>'sessionId'=$1`, [s.id, now]);
    if (!s.task_id) return; // dispatcher / candidate_scan 会话无任务线程
    if (s.kind !== 'code_locate') await this.db.query(`UPDATE tasks SET state='running', queue_reason=NULL, updated_at=$2 WHERE id=$1`, [s.task_id, now]);
    await this.threadEvent(s.task_id, s.kind === 'code_locate' ? `代码定位：${runtimeName} · ${s.agent} · 运行中` : `会话已启动 ${runtimeName} · ${s.agent} · ${p.agentSessionId.slice(0, 8)}`);
    await this.broadcastTask(s.task_id);
  }

  async onSessionState(runtimeName: string, p: { sessionId: string; state: string; failureReason?: string | null; exitCode?: number | null; source: string }) {
    const s = await this.db.one<any>('SELECT * FROM sessions WHERE id=$1', [p.sessionId]);
    if (!s) return;
    const now = this.clock.now();
    if (!s.task_id) {
      // 频道会话（dispatcher / candidate_scan）：只更新会话状态
      const st = ['done', 'failed', 'stopped', 'waiting_input', 'running'].includes(p.state) ? p.state : 'running';
      await this.db.query(`UPDATE sessions SET state=$2, exit_code=$3, failure_reason=$4, ended_at=CASE WHEN $2 IN ('done','failed','stopped') THEN $5 ELSE ended_at END, updated_at=$5 WHERE id=$1`, [s.id, st, p.exitCode ?? null, p.failureReason ?? null, now]);
      await this.drainQueue(runtimeName, s.agent);
      return;
    }
    if (p.state === 'done') {
      if (['done', 'failed', 'stopped'].includes(s.state)) return;
      await this.db.query(`UPDATE sessions SET state='done', exit_code=$2, ended_at=$3, updated_at=$3 WHERE id=$1`, [s.id, p.exitCode ?? 0, now]);
      const t = await this.db.one<any>('SELECT * FROM tasks WHERE id=$1', [s.task_id]);
      if (s.kind === 'code_locate') {
        // 已有的降级卡（排队中 / 开发机离线）也要刷新原因，否则会话跑完了卡上还写着「排队中」
        const card = await this.db.one<{ degraded: boolean }>('SELECT degraded FROM triage_cards WHERE task_id=$1', [s.task_id]);
        if (!card || card.degraded) await this.intake.emitTriage(s.task_id, s.id, { degraded: true, degradedReason: '代码定位失败：会话结束但未回写分流结果' });
      } else if (s.kind === 'review') {
        await this.db.query(`UPDATE tasks SET state='done', terminal_at=$2, updated_at=$2 WHERE id=$1`, [t.id, now]);
        await this.threadEvent(t.id, `review 完成（${s.agent}）`);
      } else {
        // 本会话没交付任何产物（如建 PR 被否决后 agent 停下）：不算交付，暂停并进收件箱等人接手
        const produced = await this.db.one('SELECT 1 FROM artifacts WHERE session_id=$1 LIMIT 1', [s.id]);
        if (!produced && t.state === 'running') {
          const last = await this.db.one<{ text: string }>(`SELECT text FROM messages WHERE task_id=$1 AND kind='progress' ORDER BY created_at DESC, seq DESC LIMIT 1`, [t.id]);
          const reason = `人工处理：会话结束但没有产物${last ? `（最后进展：${last.text.slice(0, 80)}）` : ''}，在线程里回复即可让 agent 接着做`;
          await this.db.query(`UPDATE tasks SET state='paused', state_before_pause='running', queue_reason=$2, updated_at=$3 WHERE id=$1`, [t.id, reason, now]);
          await this.threadEvent(t.id, `会话结束（${s.agent}），没有交付产物 · 任务已暂停，回复即在原会话继续`);
        } else {
          if (t.state === 'running') await this.db.query(`UPDATE tasks SET state='delivered', updated_at=$2 WHERE id=$1`, [t.id, now]);
          await this.threadEvent(t.id, `会话完成（${s.agent}）`);
          if (t.state !== 'waiting_approval') await this.afterDelivered(t.id);
        }
      }
      await this.broadcastTask(s.task_id);
      await this.drainQueue(runtimeName, s.agent);
      return;
    }
    if (p.state === 'failed') {
      if (['done', 'failed', 'stopped'].includes(s.state)) return;
      await this.db.query(`UPDATE sessions SET state='failed', exit_code=$2, failure_reason=$3, ended_at=$4, updated_at=$4 WHERE id=$1`, [s.id, p.exitCode ?? null, p.failureReason ?? null, now]);
      await this.closeInferredQuestions(s.id);
      if (s.kind === 'code_locate') await this.intake.emitTriage(s.task_id, s.id, { degraded: true, degradedReason: `代码定位失败：${p.failureReason ?? 'exit ' + p.exitCode}` });
      else await this.failTask(s.task_id, `会话失败：${p.failureReason ?? 'exit ' + p.exitCode}`, ['retry', 'switch_agent', 'abandon']);
      await this.drainQueue(runtimeName, s.agent);
      return;
    }
    if (p.state === 'stopped') {
      const r = await this.db.query(`UPDATE sessions SET state='stopped', ended_at=$2, updated_at=$2 WHERE id=$1 AND state NOT IN ('done','failed','stopped')`, [s.id, now]);
      await this.closeInferredQuestions(s.id);
      if (r.rowCount && s.kind !== 'code_locate') {
        // S07 Step 46：人工停止 → 任务 paused，worktree 保留
        await this.db.query(`UPDATE tasks SET state='paused', state_before_pause=state, updated_at=$2 WHERE id=$1 AND state IN ('running','waiting_input','queued')`, [s.task_id, now]);
        await this.threadEvent(s.task_id, `会话已停止（${s.agent}）· 任务已暂停，worktree 保留`);
        await this.broadcastTask(s.task_id);
      }
      await this.drainQueue(runtimeName, s.agent); return;
    }
    if (p.state === 'waiting_input') {
      await this.db.query(`UPDATE sessions SET state='waiting_input', updated_at=$2 WHERE id=$1 AND state IN ('planned','running','waiting_input')`, [s.id, now]);
      // EX-19.1：钩子或轮询（claude state=blocked）说需要输入但没有 ask_user 问题 → 从日志推断
      if ((p.source === 'hook' || p.source === 'poll') && this.questions) await this.questions.inferFromHook(s, runtimeName);
      return;
    }
    if (p.state === 'running') { await this.db.query(`UPDATE sessions SET state='running', last_activity_at=$2, updated_at=$2 WHERE id=$1 AND state NOT IN ('failed')`, [s.id, now]); }
  }

  /** worker → error（EX-11.1 worktree 失败；EX-15.1 / S01 EX-17.1 agent 启动失败） */
  async onWorkerError(runtimeName: string, env: Envelope) {
    const code = String(env.payload.code ?? ''); const ref = env.ref;
    if (!ref) return;
    const job = await this.db.one<any>(`SELECT * FROM jobs WHERE kind='dispatch' AND args->>'commandId'=$1`, [ref]);
    if (!job) return;
    const args = job.args as any;
    const now = this.clock.now();
    await this.db.query(`UPDATE jobs SET status='failed', error_code=$2, error_message=$3, finished_at=$4 WHERE id=$1`, [job.id, code, String(env.payload.message ?? ''), now]);
    if (args.type === 'worktree.create' && code === 'WORKTREE_FAILED') {
      if (!args.fetchFirst && env.payload.retryable !== false) {
        await this.threadEvent(args.taskId, `worktree 创建失败：${String(env.payload.message ?? '').slice(0, 200)} · 先 fetch 再重试一次`);
        await this.intake.sendWorktreeCreate(args.taskId, args.runtime, args.repo, args.purpose, true, !!args.resetToBase); return;
      }
      await this.db.query(`UPDATE sessions SET state='failed', failure_reason=$2, ended_at=$3, updated_at=$3 WHERE task_id=$1 AND state='planned'`, [args.taskId, 'worktree failed', now]);
      if (args.purpose === 'code_locate') { await this.intake.emitTriage(args.taskId, null, { degraded: true, degradedReason: `代码定位失败：worktree 创建失败（${env.payload.message ?? ''}）` }); return; }
      await this.failTask(args.taskId, `worktree 创建失败：${env.payload.message ?? ''}（WORKTREE_FAILED）`, ['retry', 'abandon']);
      return;
    }
    if (args.type === 'session.resume' && code === 'RESUME_FAILED') {
      // S07 EX-40.1：原会话无法恢复 → 失败卡"以新会话继续 / 放弃"
      await this.db.query(`UPDATE sessions SET state='failed', failure_reason=$2, ended_at=$3, updated_at=$3 WHERE id=$1 AND state NOT IN ('failed')`, [args.sessionId, `RESUME_FAILED: ${env.payload.message ?? ''}`, now]);
      await this.threadEvent(args.taskId, `原会话无法恢复（RESUME_FAILED：${String(env.payload.message ?? '').slice(0, 200)}），可以新会话继续（带线程摘要）或放弃`);
      await this.failTask(args.taskId, `原会话无法恢复：${env.payload.message ?? ''}`, ['fresh_session', 'abandon']);
      return;
    }
    if (args.type === 'session.start' && code === 'AGENT_START_FAILED') {
      const s = await this.db.one<any>('SELECT * FROM sessions WHERE id=$1', [args.sessionId]);
      if (!s || ['failed', 'done'].includes(s.state)) return;
      await this.db.query(`UPDATE sessions SET state='failed', failure_reason=$2, ended_at=$3, updated_at=$3 WHERE id=$1`, [s.id, String(env.payload.message ?? 'start failed'), now]);
      await this.threadEvent(s.task_id, `agent ${s.agent} 启动失败（第 ${s.attempt} 次）：${String(env.payload.message ?? '').slice(0, 200)}`);
      if (Number(s.attempt) >= 2) {
        if (s.kind === 'code_locate') { await this.intake.emitTriage(s.task_id, s.id, { degraded: true, degradedReason: 'agent 两次启动失败，代码定位待补' }); return; }
        await this.failTask(s.task_id, `agent 两次启动失败（${otherAgent(s.agent)} / ${s.agent}）`, ['retry', 'switch_agent', 'abandon']); return;
      }
      // 换家重试一次，复用 worktree（EX-15.1）
      const wt = await this.db.one<any>(`SELECT id, path FROM worktrees WHERE task_id=$1 AND runtime_id=$2 AND state='ready'`, [s.task_id, s.runtime_id]);
      const other = otherAgent(s.agent as AgentName);
      // 换家也要守并发上限（EX-7.2）：另一家满了就排队，不能硬塞。
      // 2026-09-29 生产：claude 在 dev 上因目录未信任全部起不来，3 个代码定位同时换到 codex，codex 跑到 6/3
      const rt = await this.db.one<any>('SELECT name, agents FROM runtimes WHERE id=$1', [s.runtime_id]);
      const cap = Number(rt?.agents?.[other]?.maxConcurrent ?? this.cfg.agent_concurrency[other] ?? 3);
      const busy = await this.runningCount(s.runtime_id, other);
      if (busy >= cap) {
        if (s.kind === 'code_locate') {
          if (!(await this.db.one(`SELECT 1 FROM jobs WHERE kind='code-locate' AND status='queued' AND args->>'taskId'=$1`, [s.task_id]))) {
            await this.db.query(`INSERT INTO jobs (kind, status, required_label, args, dedupe_key, scheduled_at, created_at) VALUES ('code-locate','queued','build:doris',$1,$2,$3,$3)`, [JSON.stringify({ taskId: s.task_id }), `code-locate:${s.task_id}`, now]);
          }
          if (!(await this.db.one('SELECT 1 FROM triage_cards WHERE task_id=$1', [s.task_id]))) await this.intake.emitTriage(s.task_id, null, { degraded: true, degradedReason: `代码定位排队中：${s.agent} 启动失败，${other} 并发已满（${busy}/${cap}）` });
        } else {
          await this.db.query(`UPDATE tasks SET state='queued', agent=$2, queue_reason=$3, updated_at=$4 WHERE id=$1`, [s.task_id, other, `排队：${s.agent} 启动失败，等 ${other} 空出名额（${busy}/${cap}）`, now]);
          await this.broadcastTask(s.task_id);
        }
        await this.threadEvent(s.task_id, `${other} 并发已满（${busy}/${cap}），排队等名额再换 ${other} 重试`);
        return;
      }
      const ns = await this.db.one<{ id: string }>(`INSERT INTO sessions (task_id, runtime_id, agent, kind, state, prompt, attempt, worktree_id, created_at, updated_at) VALUES ($1,$2,$3,$4,'planned','',$5,$6,$7,$7) RETURNING id`, [s.task_id, s.runtime_id, other, s.kind, Number(s.attempt) + 1, wt?.id ?? s.worktree_id ?? null, now]);
      if (s.kind !== 'code_locate') await this.db.query(`UPDATE tasks SET agent=$2, author_agent=CASE WHEN $3='implement' THEN $2 ELSE author_agent END, updated_at=$4 WHERE id=$1`, [s.task_id, other, s.kind, now]);
      await this.threadEvent(s.task_id, `改用 ${other} 重试（第 2 次，复用 worktree）`);
      await this.startSession(ns!.id, wt?.path ?? s.cwd ?? '/tmp');
    }
  }

  async failTask(taskId: string, reason: string, options: string[]) {
    const now = this.clock.now();
    const t = await this.db.tx(async (c) => {
      const t = await this.db.one<any>(`UPDATE tasks SET state='failed', failure_reason=$2, queue_reason=NULL, updated_at=$3 WHERE id=$1 RETURNING *`, [taskId, reason, now], c);
      const ch = await this.db.one<{ slug: string }>('SELECT slug FROM channels WHERE id=$1', [t.channel_id], c);
      await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, payload, created_at) VALUES ($1,$2,'failure_card','system',$3,$4,$5)`, [t.channel_id, taskId, reason, JSON.stringify({ options }), now]);
      await this.events.record(c, { type: 'inbox.new', taskId, payload: { itemType: 'failure', item: await this.tasks.serializeSummary(t, ch?.slug ?? '') } });
      await this.events.record(c, { type: 'task.updated', taskId, payload: { task: await this.tasks.serialize(t, ch?.slug ?? ''), changed: ['state'] } });
      return t;
    });
    this.events.flush();
    return t;
  }

  // ---------------- MCP：产物与子任务（Step 27–30；EX-25.1） ----------------
  async deliver(sessionId: string, artifacts: any[], summary?: string) {
    const s = await this.db.one<any>(`SELECT s.*, t.key AS task_key, t.channel_id, t.source_type FROM sessions s JOIN tasks t ON t.id=s.task_id WHERE s.id=$1`, [sessionId]);
    if (!s) throw new ApiError(404, 'NOT_FOUND', '会话不存在');
    const now = this.clock.now();
    for (const a of artifacts) {
      if (a.kind === 'triage') { await this.intake.emitTriage(s.task_id, sessionId, a); continue; }
      if (a.kind === 'candidates') continue;
      await this.db.tx(async (c) => {
        await c.query(`INSERT INTO artifacts (task_id, session_id, kind, url, title, path, branch, content, diff_stat, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [s.task_id, sessionId, a.kind, a.url ?? null, a.title ?? null, a.path ?? a.readmePath ?? null, a.branch ?? null, a.content ?? null, a.diffStat ? JSON.stringify(a.diffStat) : null, now]);
        await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, session_id, payload, created_at) VALUES ($1,$2,'artifact_card',$3,$4,$5,$6,$7)`, [s.channel_id, s.task_id, s.agent, summary ?? `产物：${a.kind}`, sessionId, JSON.stringify(a), now]);
        if (a.kind === 'pr') {
          await c.query(`UPDATE tasks SET state='delivered', pr_url=$2, queue_reason=NULL, last_activity_at=$3, updated_at=$3 WHERE id=$1`, [s.task_id, a.url, now]);
          const n = Number((await this.db.one<{ n: string }>('SELECT count(*) AS n FROM tasks WHERE parent_id=$1', [s.task_id], c))?.n ?? 0);
          await c.query(`INSERT INTO tasks (key, parent_id, channel_id, title, state, kind, source_type, source_ref, source_url, repo_name, repo_source, runtime_name, agent, pr_url, last_activity_at, created_at, updated_at)
            SELECT $1, id, channel_id, $2, 'delivered', 'pr', 'github', $3, $3, repo_name, repo_source, runtime_name, agent, $3, $4, $4, $4 FROM tasks WHERE id=$5`, [`${s.task_key}.${n + 1}`, `PR ${a.title ?? a.url}`, a.url, now, s.task_id]);
          const reviewer = otherAgent(s.agent as AgentName);
          await c.query(`INSERT INTO tasks (key, parent_id, channel_id, title, state, kind, source_type, source_ref, repo_name, repo_source, runtime_name, agent, last_activity_at, created_at, updated_at)
            SELECT $1, id, channel_id, $2, 'queued', 'review', 'github', $3, repo_name, repo_source, runtime_name, $4, $5, $5, $5 FROM tasks WHERE id=$6`, [`${s.task_key}.${n + 2}`, `review（${reviewer}）`, a.url, reviewer, now, s.task_id]);
          await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [s.channel_id, s.task_id, `子任务 ${s.task_key}.${n + 1} PR 已创建 · 子任务 ${s.task_key}.${n + 2} review 由 ${reviewer} 执行（作者 ${s.agent}）`, now]);
        } else if (a.kind === 'doc') {
          await c.query(`UPDATE tasks SET state='delivered', last_activity_at=$2, updated_at=$2 WHERE id=$1`, [s.task_id, now]);
          await c.query(`UPDATE context_packs SET plan_doc=$2, updated_at=$3, version=version+1 WHERE task_id=$1`, [s.task_id, a.content ?? null, now]);
        } else if (a.kind === 'branch') {
          // EX-25.1：实现路径只交付分支 = 建 PR 失败 → 收件箱"重试创建 PR"，任务保持 running
          // 只有在"建 PR 失败"语境下（产物标记或最近进展提到创建 PR 失败）才进收件箱
          const lastProgress = await this.db.one<{ text: string }>(`SELECT text FROM messages WHERE task_id=$1 AND kind='progress' ORDER BY created_at DESC, seq DESC LIMIT 1`, [s.task_id], c);
          const prFailed = a.prFailed === true || /创建 PR 失败|pr create 失败|gh pr create/i.test(lastProgress?.text ?? '');
          const retryReason = s.kind === 'implement' && prFailed ? '重试创建 PR（gh pr create 失败，分支已推送）' : null;
          await c.query(`UPDATE tasks SET branch_name=$2, queue_reason=COALESCE($3, queue_reason), last_activity_at=$4, updated_at=$4 WHERE id=$1`, [s.task_id, a.branch, retryReason, now]);
          if (retryReason) {
            const t = await this.db.one<any>('SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1', [s.task_id], c);
            await this.events.record(c, { type: 'inbox.new', taskId: s.task_id, payload: { itemType: 'failure', item: await this.tasks.serializeSummary(t, t.channel_slug) } });
          }
        }
        await this.events.record(c, { type: 'message.new', taskId: s.task_id, payload: { taskKey: s.task_key, kind: 'artifact_card', artifact: a } });
      });
      this.events.flush();
      if (a.kind === 'doc') await this.approvals.request({ taskId: s.task_id, actionType: 'start_implement', title: `方案待拍板：${a.title ?? s.task_key}`, body: String(a.content ?? '').slice(0, 4000), payload: { taskKey: s.task_key, artifactKind: 'doc', path: a.path ?? null }, executor: 'center' });
    }
    await this.broadcastTask(s.task_id);
  }

  /** 会话完成后的后续动作（Step 34）：镜像回写审批 + review 子任务派发 */
  private async afterDelivered(taskId: string) {
    const t = await this.db.one<any>('SELECT * FROM tasks WHERE id=$1', [taskId]);
    const art = await this.db.one<any>(`SELECT * FROM artifacts WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1`, [taskId]);
    if (!art) return;
    const summary = art.kind === 'pr' ? `已提交 PR：${art.url}` : art.kind === 'doc' ? `方案已产出：${art.title ?? art.path}` : `分支：${art.branch}`;
    const dup = await this.db.one(`SELECT 1 FROM approvals WHERE task_id=$1 AND action_type IN ('jira_comment','feishu_reply') AND payload->>'artifactId'=$2`, [taskId, art.id]);
    if (!dup) {
      if (t.source_type === 'jira') await this.approvals.request({ taskId, actionType: 'jira_comment', title: `镜像到 Jira ${t.source_ref}`, body: summary, payload: { taskKey: t.key, issueKey: t.source_ref, artifactId: art.id }, executor: 'center' });
      else if (t.source_type === 'feishu') await this.approvals.request({ taskId, actionType: 'feishu_reply', title: '回帖到飞书原消息', body: summary, payload: { taskKey: t.key, messageId: t.source_ref, artifactId: art.id }, executor: 'center' });
    }
    const review = await this.db.one<any>(`SELECT * FROM tasks WHERE parent_id=$1 AND kind='review' AND state='queued'`, [taskId]);
    if (review) await this.dispatchTask(review.id, { kind: 'review', agent: review.agent });
  }

  /** 镜像回写执行器（S06 Step 20；S03 Step 34 / EX-34.1） */
  async mirrorToJira(input: { taskId: string; finalBody: string; payload: Record<string, unknown> }) {
    const r = await this.intake.runJob('jira-comment', { key: input.payload.issueKey, body: input.finalBody });
    await this.db.query(`UPDATE artifacts SET mirrored_to = mirrored_to || $2::jsonb WHERE id=$1`, [input.payload.artifactId, JSON.stringify([{ target: 'jira', key: input.payload.issueKey, at: this.clock.now().toISOString() }])]);
    return r;
  }
  async mirrorToFeishu(input: { taskId: string; finalBody: string; payload: Record<string, unknown> }) {
    const n = await this.notifications.send({ kind: 'reply', target: this.cfg.feishu.owner_open_id ?? 'owner', text: input.finalBody, replyTo: String(input.payload.messageId ?? ''), refType: 'task', refId: input.taskId });
    if (n.status !== 'sent') throw new Error('飞书回帖失败');
    return { messageId: n.externalMessageId };
  }

  /** POST /api/tasks/{key}/implement（Step 30） */
  async implementFromPlan(taskId: string) {
    const doc = await this.db.one<any>(`SELECT * FROM artifacts WHERE task_id=$1 AND kind='doc' ORDER BY created_at DESC LIMIT 1`, [taskId]);
    if (!doc) throw new ApiError(409, 'NO_PLAN_ARTIFACT');
    const now = this.clock.now();
    await this.db.query(`UPDATE tasks SET path='fix', state='queued', queue_reason=NULL, updated_at=$2 WHERE id=$1`, [taskId, now]);
    await this.db.query(`UPDATE context_packs SET plan_doc=COALESCE(plan_doc, $2), updated_at=$3 WHERE task_id=$1`, [taskId, doc.content ?? '', now]);
    await this.threadEvent(taskId, '按方案实现：以简单修复路径在同一 runtime 创建实现会话（方案全文已附加到上下文包）');
    await this.dispatchTask(taskId, { kind: 'implement' });
  }

  /** POST /api/tasks/{key}/retry（EX-32.1、EX-15.1、S07 EX-40.1） */
  async retry(taskId: string, mode: 'same_agent' | 'switch_agent' | 'abandon' | 'fresh_session') {
    const t = await this.db.one<any>('SELECT * FROM tasks WHERE id=$1', [taskId]);
    if (t.state !== 'failed') throw new ApiError(409, 'TASK_NOT_FAILED');
    const now = this.clock.now();
    if (mode === 'abandon') {
      await this.db.query(`UPDATE tasks SET state='paused', state_before_pause='failed', terminal_at=$2, updated_at=$2 WHERE id=$1`, [taskId, now]);
      await this.events.record(this.db.pool, { type: 'inbox.removed', taskId, payload: { itemType: 'failure', key: t.key, reason: 'abandoned' } }); this.events.flush();
      await this.threadEvent(taskId, '已放弃（worktree 保留 3 天）'); await this.broadcastTask(taskId); return;
    }
    const last = await this.db.one<any>(`SELECT * FROM sessions WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1`, [taskId]);
    const agent = mode === 'switch_agent' ? otherAgent((last?.agent ?? t.agent ?? 'claude') as AgentName) : ((last?.agent ?? t.agent) as AgentName | null);
    await this.db.query(`UPDATE tasks SET state='queued', failure_reason=NULL, agent=$2, updated_at=$3 WHERE id=$1`, [taskId, agent, now]);
    await this.events.record(this.db.pool, { type: 'inbox.removed', taskId, payload: { itemType: 'failure', key: t.key, reason: 'retried' } }); this.events.flush();
    await this.threadEvent(taskId, mode === 'switch_agent' ? `换 ${agent} 重试（复用 worktree）` : mode === 'fresh_session' ? '新会话重试（附线程摘要）' : '同 agent 重试（复用 worktree）');
    const kind = (last?.kind as SessionKind | undefined) ?? 'implement';
    let promptSuffix: string | undefined;
    if (mode === 'fresh_session') {
      const recent = await this.db.query<{ kind: string; author: string; text: string }>(`SELECT kind, author, text FROM messages WHERE task_id=$1 AND kind IN ('progress','ask','user_reply','user','artifact_card','system') ORDER BY created_at DESC, seq DESC LIMIT 12`, [taskId]);
      promptSuffix = `线程摘要（上一会话 ${last?.agent_session_id ?? ''} 无法恢复，以下为此前进展，请接着做）：\n` + recent.rows.reverse().map((m) => `- [${m.kind}/${m.author}] ${m.text.slice(0, 200)}`).join('\n');
    }
    await this.dispatchTask(taskId, { agent, attempt: Number(last?.attempt ?? 0) + 1, kind: kind === 'code_locate' ? 'implement' : kind, promptSuffix });
  }

  /**
   * POST /api/tasks/{key}/messages（S07 Step 21–28 / 36–38；EX-25.1、EX-37.1；S05 EX-23.1）
   * 有 open 问题 → 作为答案唤醒 MCP（answered）；钩子问题或无挂起请求 → session.resume（resumed）；runtime 离线 → 排队（queued）
   */
  async postMessage(taskId: string, text: string, questionId?: string | null) {
    const t = await this.db.one<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1`, [taskId]);
    const q = this.questions ? await this.questions.openFor(taskId, questionId) : null;
    if (q && q.status === 'open') {
      const r = await this.questions.answer(q, text, 'panel');
      const m = await this.questions.appendUserReply(taskId, q.session_id, text, 'panel');
      await this.events.record(this.db.pool, { type: 'message.new', taskId, payload: { taskKey: t.key, message: serializeMessage(m, t.key, t.channel_slug) } }); this.events.flush();
      if (r.woke) return { message: serializeMessage(m, t.key, t.channel_slug), delivery: 'answered' as const };
      // 钩子推断的问题或 MCP 等待已超时：直接送入会话
      const d = await this.resumeSession(taskId, text, m.id);
      return { message: { ...serializeMessage(m, t.key, t.channel_slug), delivery: d.delivery === 'resumed' ? 'delivered' : 'queued' }, delivery: d.delivery };
    }
    if (q && q.status !== 'open') {
      // EX-25.1：问题已被另一通道回答 → 消息仍追加并 resume，但返回 409
      const m = await this.questions.appendUserReply(taskId, q.session_id, text, 'panel');
      await this.resumeSession(taskId, text, m.id);
      throw new ApiError(409, 'QUESTION_ALREADY_ANSWERED', undefined, { questionId: q.id, answeredVia: q.answered_via, answeredAt: q.answered_at });
    }
    const now = this.clock.now();
    const m = await this.db.one<any>(`INSERT INTO messages (channel_id, task_id, session_id, kind, author, text, payload, delivery, created_at) VALUES ($1,$2,NULL,'user','user',$3,'{}','queued',$4) RETURNING *`, [t.channel_id, taskId, text, now]);
    const d = await this.resumeSession(taskId, text, m.id);
    const fresh = await this.db.one<any>('SELECT * FROM messages WHERE id=$1', [m.id]);
    await this.events.record(this.db.pool, { type: 'message.new', taskId, payload: { taskKey: t.key, message: serializeMessage(fresh, t.key, t.channel_slug) } }); this.events.flush();
    return { message: serializeMessage(fresh, t.key, t.channel_slug), delivery: d.delivery };
  }

  /** 把文本以 session.resume 送入最近会话；离线则由 hub 排队（Step 36–41 / EX-37.1） */
  async resumeSession(taskId: string, text: string, messageId?: string | null) {
    const s = await this.db.one<any>(`SELECT s.*, r.name AS runtime FROM sessions s JOIN runtimes r ON r.id=s.runtime_id WHERE s.task_id=$1 ORDER BY s.created_at DESC, s.attempt DESC LIMIT 1`, [taskId]);
    const now = this.clock.now();
    if (!s) return { delivery: 'queued' as const, commandId: null };
    const env = this.hub.send(s.runtime, 'session.resume', { sessionId: s.id, text });
    const online = this.hub.isOnline(s.runtime);
    await this.db.query(`INSERT INTO jobs (kind, status, args, scheduled_at, dispatched_at, created_at) VALUES ('dispatch',$2,$1,$3,$3,$3)`, [JSON.stringify({ commandId: env.id, type: 'session.resume', sessionId: s.id, taskId }), online ? 'dispatched' : 'queued', now]);
    if (messageId) await this.db.query(`UPDATE messages SET session_id=$2, payload = payload || $3::jsonb, delivery=$4, delivered_at=$5 WHERE id=$1`, [messageId, s.id, JSON.stringify({ commandId: env.id }), online ? 'delivered' : 'queued', online ? now : null]);
    if (online) {
      if (['done', 'stopped'].includes(s.state)) {
        await this.db.query(`UPDATE sessions SET state='running', last_activity_at=$2, updated_at=$2 WHERE id=$1`, [s.id, now]);
        await this.db.query(`UPDATE tasks SET state='running', state_before_pause=NULL, queue_reason=CASE WHEN queue_reason LIKE '人工处理：会话结束%' THEN NULL ELSE queue_reason END, updated_at=$2 WHERE id=$1 AND state IN ('delivered','paused','waiting_input')`, [taskId, now]);
        await this.threadEvent(taskId, `已恢复会话 ${s.agent_session_id ?? s.id.slice(0, 8)}（${s.agent}），消息已送入`);
        await this.broadcastTask(taskId);
      }
      return { delivery: 'resumed' as const, commandId: env.id };
    }
    return { delivery: 'queued' as const, commandId: env.id };
  }

  /** POST /api/sessions/{id}/stop（S07 Step 42–46）：幂等 */
  async stopSession(sessionId: string) {
    const s = await this.db.one<any>(`SELECT s.*, r.name AS runtime_name, t.key AS task_key FROM sessions s JOIN runtimes r ON r.id=s.runtime_id LEFT JOIN tasks t ON t.id=s.task_id WHERE s.id=$1`, [sessionId]);
    if (!s) throw new ApiError(404, 'NOT_FOUND', '会话不存在');
    if (['stopped', 'done', 'failed', 'lost'].includes(s.state)) return s;
    if (!this.hub.isOnline(s.runtime_name)) { this.hub.send(s.runtime_name, 'session.stop', { sessionId, reason: 'user' }); throw new ApiError(503, 'RUNTIME_OFFLINE', `${s.runtime_name} 离线，停止指令已排队`); }
    this.hub.send(s.runtime_name, 'session.stop', { sessionId, reason: 'user' });
    if (s.task_id) await this.threadEvent(s.task_id, `已请求停止会话（${s.agent}）`);
    return s;
  }

  /** GET /api/sessions/{id}/logs（S07 Step 6–12；EX-8.1） */
  async sessionLogs(sessionId: string, q: { from?: string | null; to?: string | null; limit: number }) {
    const s = await this.db.one<any>(`SELECT s.*, r.name AS runtime_name, r.online FROM sessions s JOIN runtimes r ON r.id=s.runtime_id WHERE s.id=$1`, [sessionId]);
    if (!s) throw new ApiError(404, 'NOT_FOUND', '会话不存在');
    if (!s.online || !this.hub.isOnline(s.runtime_name)) throw new ApiError(503, 'RUNTIME_OFFLINE', `${s.runtime_name} 离线，无法读取日志`);
    let reply: Envelope;
    try { reply = await this.hub.request(s.runtime_name, 'session.logs', { sessionId, from: q.from ?? null, to: q.to ?? null, limit: q.limit }, 15_000); }
    catch (e) { throw new ApiError(503, 'RUNTIME_OFFLINE', `${s.runtime_name} 未在 15 秒内返回日志：${String((e as Error).message)}`); }
    if (reply.type === 'error') throw new ApiError(503, 'RUNTIME_OFFLINE', String(reply.payload.message ?? 'worker error'));
    const lines = ((reply.payload as any).lines as string[] | undefined) ?? [];
    const truncated = Boolean((reply.payload as any).truncated) || lines.length > q.limit;
    return { lines: lines.slice(-q.limit), truncated, from: q.from ?? null, to: q.to ?? null };
  }

  /** progress-watch（S07 Step 47–49；EX-49.1）：10 分钟无进展广播 stale；30 分钟告警一次并进收件箱，不自动停止 */
  async watchStaleSessions() {
    const now = this.clock.now();
    const rows = await this.db.query<any>(`SELECT s.id, s.task_id, s.agent, t.key AS task_key, COALESCE(s.last_progress_at, s.started_at, s.created_at) AS last FROM sessions s JOIN tasks t ON t.id=s.task_id WHERE s.state='running' AND s.kind IN ('implement','review','plan','proto')`);
    let stale = 0;
    for (const r of rows.rows) {
      const minutes = Math.floor((now.getTime() - new Date(r.last).getTime()) / 60_000);
      if (minutes < 10) continue;
      stale += 1;
      await this.events.record(this.db.pool, { type: 'session.stale', taskId: r.task_id, sessionId: r.id, payload: { sessionId: r.id, taskKey: r.task_key, minutes: minutes >= 30 ? 30 : 10, lastProgressAt: new Date(r.last).toISOString() } });
      if (minutes >= 30) {
        // 去重键必须是告警正文的子串（alertOnce 按 text LIKE 匹配一小时内只发一次）
        const sent = await this.notifications.alertOnce(`${r.task_key} 无进展`, `${r.task_key} 无进展 30 分钟（${r.agent} 会话进程仍在）· 面板可查看日志或停止会话：/tasks/${r.task_key}`, 'task');
        await this.db.query(`UPDATE tasks SET queue_reason=$2, updated_at=$3 WHERE id=$1 AND (queue_reason IS NULL OR queue_reason NOT LIKE '无进展%')`, [r.task_id, `无进展 ${minutes} 分钟：查看日志 / 停止会话`, now]);
        if (sent) await this.events.record(this.db.pool, { type: 'inbox.new', taskId: r.task_id, payload: { itemType: 'failure', item: { key: r.task_key, queueReason: `无进展 ${minutes} 分钟：查看日志 / 停止会话` } } });
      }
    }
    this.events.flush();
    return { stale };
  }

  async threadEvent(taskId: string, text: string, client?: Queryable) {
    const t = await this.db.one<{ key: string; channel_id: string }>('SELECT key, channel_id FROM tasks WHERE id=$1', [taskId], client);
    if (!t) return;
    const run = async (c: Queryable) => {
      await this.db.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, created_at) VALUES ($1,$2,'system','system',$3,$4)`, [t.channel_id, taskId, text, this.clock.now()], c);
      await this.events.record(c, { type: 'thread.event', taskId, payload: { taskKey: t.key, text } });
    };
    if (client) await run(client); else { await run(this.db.pool); this.events.flush(); }
  }

  async broadcastTask(taskId: string) {
    const t = await this.db.one<any>(`SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1`, [taskId]);
    if (!t) return;
    await this.events.record(this.db.pool, { type: 'task.updated', taskId, payload: { task: await this.tasks.serialize(t, t.channel_slug), changed: ['state'] } });
    this.events.flush();
  }
}

export function otherAgent(a: AgentName): AgentName { return a === 'claude' ? 'codex' : 'claude'; }
