/**
 * MCP 端点（POST /mcp，JSON-RPC 2.0）。来源：api/mcp.yaml。
 * 本批工具：get_task、report_progress、request_approval（阻塞）、deliver、lookup_jira。
 */
import { z } from 'zod';
import type { Db } from '../db.js';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events.js';
import type { Approvals } from './approvals.js';
import type { Dispatch } from './dispatch.js';
import type { Intake } from './intake.js';
import type { Tasks } from './tasks.js';
import type { Questions } from './questions.js';
import type { FeishuIntake } from './feishuIntake.js';
import type { Channels } from './channels.js';
import { QUESTION_WAIT_MINUTES } from './questions.js';
import { Intake as IntakeStatics } from './intake.js';
import { ACTION_TYPES, APPROVAL_WAIT_MINUTES, TASK_PATHS, publicPrProblems } from '@foreman/shared';

/** mcp.yaml → TriageArtifact（tier 必填；codeLocations 由 emitTriage 截断到 8） */
const TriageArtifact = z.object({
  kind: z.literal('triage'),
  tier: z.enum(TASK_PATHS),
  effort: z.enum(['small', 'medium', 'large']).default('small'),
  repo: z.object({ name: z.string().nullable(), confidence: z.number().min(0).max(1), candidates: z.array(z.string()).optional() }).optional(),
  suggestedPath: z.string().max(2000).optional(),
  /** 目标代码所在分支：与仓库级默认基线不同时由定位会话给出，worktree 据此拉取 */
  targetBranch: z.string().max(200).nullable().optional(),
  // mcp.yaml 里 line / symbol 是 nullable：agent 定位到文件但说不出行号时会传 null，不能因此整张分流卡作废
  codeLocations: z.array(z.object({ file: z.string(), line: z.number().int().nullable().optional(), symbol: z.string().nullable().optional(), why: z.string().nullable().optional() })).optional(),
});
const CandidatesArtifact = z.object({
  kind: z.literal('candidates'),
  candidates: z.array(z.object({ messageId: z.string(), reason: z.string(), confidence: z.number().min(0).max(1) })).min(1),
});
const OtherArtifact = z.object({ kind: z.enum(['pr', 'doc', 'branch']) }).passthrough();
/** review 子任务的结论（0003 迁移）：不派生子任务，写进 review 与父任务两条线程 */
const ReviewArtifact = z.object({
  kind: z.literal('review'),
  verdict: z.enum(['approve', 'request_changes', 'comment']),
  mustFix: z.array(z.string().max(1000)).max(50).default([]),
  suggestions: z.array(z.string().max(1000)).max(50).default([]),
  content: z.string().max(20000).optional(),
  url: z.string().max(500).optional(),
});
export const ArtifactInput = z.union([TriageArtifact, OtherArtifact]);

const TOOLS = [
  { name: 'get_task', description: '读取任务上下文包、任务树与最近线程', inputSchema: { type: 'object', required: ['taskKey'], properties: { taskKey: { type: 'string' } } } },
  { name: 'report_progress', description: '回写进展摘要（≤200 字）', inputSchema: { type: 'object', required: ['taskKey', 'text'], properties: { taskKey: { type: 'string' }, text: { type: 'string' }, step: { type: 'string' } } } },
  { name: 'request_approval', description: '申请需人确认的动作，阻塞直到结果（最长 30 分钟）', inputSchema: { type: 'object', required: ['taskKey', 'actionType', 'title', 'body'], properties: { taskKey: { type: 'string' }, actionType: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, payload: { type: 'object' }, timeoutMinutes: { type: 'number' } } } },
  { name: 'ask_user', description: '向用户提问并阻塞等待回答（最长 30 分钟）', inputSchema: { type: 'object', required: ['taskKey', 'question'], properties: { taskKey: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, timeoutMinutes: { type: 'number' } } } },
  { name: 'deliver', description: '回写产物（pr / doc / branch / triage / candidates）', inputSchema: { type: 'object', required: ['taskKey', 'artifacts'], properties: { taskKey: { type: 'string' }, artifacts: { type: 'array' }, summary: { type: 'string' } } } },
  { name: 'lookup_jira', description: '查证 Jira 单', inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } } },
  { name: 'lookup_pr', description: '查证 GitHub PR', inputSchema: { type: 'object', required: ['repo', 'number'], properties: { repo: { type: 'string' }, number: { type: 'number' } } } },
  { name: 'list_tasks', description: '列出最近或匹配的任务（调度员用）', inputSchema: { type: 'object', properties: { q: { type: 'string' }, recent: { type: 'number' }, channel: { type: 'string' } } } },
  { name: 'propose_task', description: '提出任务草案（调度员用，不直接建任务）', inputSchema: { type: 'object', required: ['channel', 'source', 'path'], properties: { channel: { type: 'string' }, source: { type: 'string' }, sourceTitle: { type: 'string' }, repo: { type: 'string' }, repoSource: { type: 'string' }, path: { type: 'string' }, pickTargets: { type: 'array', items: { type: 'string' } }, runtime: { type: 'string' }, agent: { type: 'string' }, note: { type: 'string' } } } },
  { name: 'ask_clarification', description: '向用户澄清（调度员用）', inputSchema: { type: 'object', required: ['channel', 'text'], properties: { channel: { type: 'string' }, text: { type: 'string' }, candidates: { type: 'array', items: { type: 'object' } } } } },
];

export class McpService {
  questions!: Questions;
  feishuIntake!: FeishuIntake;
  channels!: Channels;
  constructor(private db: Db, private clock: Clock, private events: EventBus, private tasks: Tasks, private approvals: Approvals, private dispatch: Dispatch, private intake: Intake) {}

  /** 任务级 token → 会话 */
  async authenticate(token: string) {
    if (!token) return null;
    const s = await this.db.one<any>(`SELECT s.*, t.key AS task_key, t.state AS task_state, COALESCE(s.channel_id, t.channel_id) AS channel_id FROM sessions s LEFT JOIN tasks t ON t.id=s.task_id WHERE s.mcp_token_hash=$1`, [IntakeStatics.hash(token)]);
    if (!s) return null;
    // 任务终态后 token 失效（mcp.yaml mcpTaskToken）
    if (s.task_state === 'done') return null;
    if (s.mcp_token_expires_at && new Date(s.mcp_token_expires_at) < this.clock.now()) return null;
    return s;
  }

  async handle(session: any, req: { id: unknown; method: string; params?: any }) {
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
    const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
    switch (req.method) {
      case 'initialize': return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'foreman', version: '0.1.0' } });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = req.params?.name as string; const args = (req.params?.arguments ?? {}) as Record<string, any>;
        if (args.taskKey && session.task_key && args.taskKey !== session.task_key) return err(-32001, `TASK_MISMATCH: token 绑定 ${session.task_key}`);
        try {
          const result = await this.call(session, name, args);
          return ok({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
        } catch (e: any) {
          if (e instanceof z.ZodError) return err(-32602, `VALIDATION_FAILED: ${e.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
          if (e?.code === 'SOURCE_UNAVAILABLE' || e?.code === 'TIMEOUT') return err(-32003, `SOURCE_UNAVAILABLE: ${e.message}`);
          return err(-32000, String(e?.message ?? e));
        }
      }
      default: return err(-32601, `Method not found: ${req.method}`);
    }
  }

  private baseBranch(repo: string) { return this.repoBase[repo] ?? 'master'; }
  repoBase: Record<string, string> = {};
  /** 公开仓库与内部 Jira 项目前缀（create_pr 文案检查） */
  publicRepos: string[] = [];
  jiraProjects: string[] = [];

  private async call(session: any, name: string, args: Record<string, any>): Promise<Record<string, unknown>> {
    const now = this.clock.now();
    switch (name) {
      case 'get_task': {
        z.object({ taskKey: z.string() }).parse(args);
        const detail = await this.tasks.detail(session.task_key);
        const thread = await this.tasks.messages(session.task_key, { limit: 50 });
        return { task: detail, contextPack: detail.contextPack, thread: thread.items, repoConfig: detail.repo?.name ? { name: detail.repo.name, baseBranch: this.baseBranch(detail.repo.name) } : null };
      }
      case 'report_progress': {
        const a = z.object({ taskKey: z.string(), text: z.string().min(1), step: z.string().optional() }).parse(args);
        const truncated = a.text.length > 200;
        const last = await this.db.one<any>(`SELECT created_at FROM messages WHERE task_id=$1 AND kind='progress' ORDER BY created_at DESC, seq DESC LIMIT 1`, [session.task_id]);
        const logFrom = last?.created_at ?? session.started_at ?? now;
        const ch = await this.db.one<{ slug: string }>('SELECT slug FROM channels WHERE id=$1', [session.channel_id]);
        await this.db.tx(async (c) => {
          const m = await this.db.one<any>(`INSERT INTO messages (channel_id, task_id, session_id, kind, author, text, payload, log_from, log_to, created_at) VALUES ($1,$2,$3,'progress',$4,$5,$6,$7,$8,$8) RETURNING *`,
            [session.channel_id, session.task_id, session.id, session.agent, a.text.slice(0, 200), JSON.stringify({ truncated, step: a.step ?? null, logFrom: new Date(logFrom).toISOString(), logTo: now.toISOString() }), logFrom, now], c);
          await c.query(`UPDATE sessions SET last_progress_at=$2, last_activity_at=$2, updated_at=$2 WHERE id=$1`, [session.id, now]);
          await c.query(`UPDATE tasks SET last_activity_at=$2, queue_reason=CASE WHEN queue_reason LIKE '无进展%' THEN NULL ELSE queue_reason END WHERE id=$1`, [session.task_id, now]);
          const { serializeMessage } = await import('./tasks.js');
          await this.events.record(c, { type: 'message.new', taskId: session.task_id, payload: { taskKey: session.task_key, message: serializeMessage(m, session.task_key, ch?.slug ?? '') } });
        });
        this.events.flush();
        return { ok: true, truncated };
      }
      case 'request_approval': {
        const a = z.object({ taskKey: z.string(), actionType: z.enum(ACTION_TYPES), title: z.string().max(200), body: z.string().max(20000), payload: z.record(z.unknown()).optional(), timeoutMinutes: z.number().max(APPROVAL_WAIT_MINUTES).optional() }).parse(args);
        // 同一会话对同一类动作已有待批审批（多半是客户端超时后重试）：接着等那条，不再建重复审批（T-81 的 A-90/A-91）
        const dup = await this.db.one<{ id: string }>(`SELECT id FROM approvals WHERE session_id=$1 AND action_type=$2 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [session.id, a.actionType]);
        // 公开仓库的 PR 文案：英文、不带内部单号（2026-09-30 T-83 的 apache/doris PR 描述是中文且写了 DORIS-29301）
        if (!dup && a.actionType === 'create_pr') {
          const t = await this.db.one<{ repo_name: string | null; source_ref: string | null }>('SELECT repo_name, source_ref FROM tasks WHERE id=$1', [session.task_id]);
          if (t?.repo_name && this.publicRepos.includes(t.repo_name)) {
            const projects = [...this.jiraProjects, ...(t.source_ref && /^[A-Z][A-Z0-9_]*-\d+$/.test(t.source_ref) ? [t.source_ref.split('-')[0]!] : [])];
            const problems = publicPrProblems(`${a.title}\n${a.body}`, projects);
            if (problems.length) throw new Error(`${t.repo_name} 是公开仓库，PR 标题与描述必须是英文、按 .github/PULL_REQUEST_TEMPLATE.md 填写，且不能出现内部 Jira 单号 / 客户名 / 内网地址。问题：${problems.join('；')}。请改写后重新调用 request_approval`);
          }
        }
        // create_pr：worker 支持 git-publish 时由平台提交、推送、建 PR（codex 沙箱里 .git 只读，agent 做不了）
        const plan = !dup && a.actionType === 'create_pr' ? await this.dispatch.publishPlan(session.id) : null;
        const row = dup ? (await this.approvals.byId(dup.id))! : await this.approvals.request({ taskId: session.task_id, sessionId: session.id, actionType: a.actionType, title: a.title, body: a.body, payload: { ...(a.payload ?? {}), taskKey: session.task_key, executor: 'agent', ...(plan ?? {}) } });
        const byPlatform = (row.payload as any)?.executor === 'center' && a.actionType === 'create_pr';
        const note = byPlatform ? '平台会提交、推送并建 PR（结果写在任务线程），你不用做任何 git 操作，结束本轮即可' : null;
        if (row.status === 'auto_approved') return { approved: true, approvalKey: row.key, via: 'auto', finalBody: row.body, reason: null, comment: null, ...(note ? { note } : {}) };
        const d = await this.approvals.waitFor(row.id, (a.timeoutMinutes ?? APPROVAL_WAIT_MINUTES) * 60_000);
        if (d.reason === 'timeout') {
          await this.db.query(`UPDATE tasks SET state='waiting_approval', updated_at=$2 WHERE id=$1 AND state='running'`, [session.task_id, this.clock.now()]);
          await this.dispatch.broadcastTask(session.task_id);
        }
        return { approved: d.approved, approvalKey: row.key, via: d.via, finalBody: d.finalBody, reason: d.reason, comment: d.comment, ...(note && d.approved ? { note } : {}) };
      }
      case 'ask_user': {
        const a = z.object({ taskKey: z.string(), question: z.string().min(1).max(4000), options: z.array(z.string()).optional(), timeoutMinutes: z.number().int().max(QUESTION_WAIT_MINUTES).optional() }).parse(args);
        const q = await this.questions.ask(session, { question: a.question, options: a.options, origin: 'mcp' });
        const r = await this.questions.waitFor(q.id, (a.timeoutMinutes ?? QUESTION_WAIT_MINUTES) * 60_000);
        return r as unknown as Record<string, unknown>;
      }
      case 'deliver': {
        const a = z.object({ taskKey: z.string().optional(), artifacts: z.array(z.record(z.unknown())).min(1), summary: z.string().max(2000).optional() }).parse(args);
        // 按 kind 分别校验，保证错误信息指向具体字段（如 tier、confidence）
        const artifacts = a.artifacts.map((x) => (x.kind === 'triage' ? TriageArtifact.parse(x) : x.kind === 'candidates' ? CandidatesArtifact.parse(x) : x.kind === 'review' ? ReviewArtifact.parse(x) : OtherArtifact.parse(x)));
        // review 会话交 pr 会给子任务再建孙任务（撞 tasks_key_check）：直接给出该怎么交
        if (session.kind === 'review' && artifacts.some((x: any) => x.kind !== 'review')) throw new Error('review 会话请用 {kind:"review", verdict, mustFix, suggestions, content, url} 回写结论，不要交 pr / doc / branch');
        if (!session.task_id) {
          // 候选扫描会话（S02 Step 26–29）：只接受 candidates
          const cands = artifacts.filter((x: any) => x.kind === 'candidates').flatMap((x: any) => x.candidates as Array<{ messageId: string; reason: string; confidence: number }>);
          if (!cands.length) throw new Error('该会话没有绑定任务，只能回写 candidates');
          return this.feishuIntake.onCandidates(session, cands);
        }
        await this.dispatch.deliver(session.id, artifacts as any[], a.summary);
        return { ok: true };
      }
      case 'lookup_pr': {
        const a = z.object({ repo: z.string(), number: z.number().int() }).parse(args);
        return { found: true, pr: await this.intake.runJob('gh-pr-view', { repo: a.repo, number: a.number }) };
      }
      case 'list_tasks': {
        const a = z.object({ q: z.string().nullable().optional(), recent: z.number().int().max(20).optional(), channel: z.string().nullable().optional() }).parse(args);
        return this.channels.listTasksForDispatcher({ q: a.q ?? null, recent: a.recent ?? 5, channel: a.channel ?? null });
      }
      case 'propose_task': {
        const a = z.object({
          channel: z.string(), source: z.string(), sourceTitle: z.string().optional(), repo: z.string().nullable().optional(),
          repoSource: z.enum(['mapping', 'llm', 'manual']).optional(), path: z.enum(TASK_PATHS),
          pickTargets: z.array(z.string()).optional(), runtime: z.string().nullable().optional(), agent: z.enum(['claude', 'codex', 'opencode']).optional(), note: z.string().nullable().optional(),
        }).parse(args);
        return this.channels.proposeTask(session, { ...a, repo: a.repo ?? null, agent: (a.agent as any) ?? null, runtime: a.runtime ?? null, note: a.note ?? null });
      }
      case 'ask_clarification': {
        const a = z.object({ channel: z.string(), text: z.string().max(1000), candidates: z.array(z.object({ label: z.string(), value: z.string() })).max(5).optional() }).parse(args);
        return this.channels.askClarification(session, a);
      }
      case 'lookup_jira': {
        const a = z.object({ key: z.string().regex(/^[A-Z]+-\d+$/) }).parse(args);
        const r = await this.intake.runJob('jira-lookup', { key: a.key });
        const existing = await this.db.one<{ key: string }>(`SELECT t.key FROM tasks t JOIN source_items s ON s.task_id=t.id WHERE s.source_type='jira' AND s.external_id=$1`, [a.key]);
        return { ...r, existingTaskKey: existing?.key ?? null };
      }
      default: throw new Error(`工具 ${name} 尚未实现`);
    }
  }
}
