/**
 * 审批与信任升级（来源：core-S06、api/approvals.yaml、schema approvals/actions/trust_counters）
 * 本批实现：request（含 auto 直通）、面板/飞书决定（先到先得、bodyHash、overrides、信任计数）、动作执行器、MCP 等待者、30 分钟过期。
 */
import { createHash } from 'node:crypto';
import type { Db, Queryable } from '../db.js';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events.js';
import { ApiError, APPROVAL_WAIT_MINUTES, type ActionType, type CenterConfig } from '@foreman/shared';
import type { Notifications } from './notifications.js';

export type ApprovalDecision = { approved: boolean; via: 'panel' | 'feishu' | 'auto' | null; finalBody: string | null; reason: 'rejected' | 'timeout' | 'superseded' | null; comment: string | null; overrides?: Record<string, unknown> | null; /** 决定时是否有人正阻塞等这个结果；没有的话要另找地方承接 */ hadWaiter?: boolean };

export interface ApprovalRow {
  id: string; key: string; task_id: string; session_id: string | null; action_type: ActionType; status: string; title: string; body: string; body_hash: string;
  payload: Record<string, unknown>; trust_mode_snapshot: string; trust_streak_snapshot: number; feishu_message_id: string | null; feishu_deferred: boolean;
  decided_via: string | null; decided_at: Date | null; modified: boolean; final_body: string | null; comment: string | null; superseded_by: string | null; action_id: string | null; expires_at: Date | null; created_at: Date;
  /** 下面几项由 listInbox / byKey / list 的 JOIN 带出（其他查询没有，故可选）：拍板时要先看清这是哪个单 */
  task_key?: string; task_title?: string; task_source_type?: string; task_source_ref?: string;
}

/** 审批 + 任务上下文：审批卡只有执行细节没法判断，必须带上原始单号与标题 */
const APPROVAL_WITH_TASK = `SELECT a.*, t.key AS task_key, t.title AS task_title, t.source_type AS task_source_type, t.source_ref AS task_source_ref FROM approvals a JOIN tasks t ON t.id=a.task_id`;

export type ActionExecutor = (a: { approval: ApprovalRow; finalBody: string; payload: Record<string, unknown>; taskId: string }) => Promise<Record<string, unknown>>;
/** 补偿器：撤回已执行的动作（S06 Step 32）；返回 false 表示不可撤回 */
export type ActionCompensator = (a: { action: any; approval: ApprovalRow }) => Promise<boolean>;
/** 可撤回的动作类型（EX-32.1：PR 创建等不可逆动作只记录） */
export const REVOCABLE_ACTIONS: ActionType[] = ['rerun_ci', 'reply_review', 'jira_comment', 'feishu_reply', 'jira_transition_in_progress'];

export function sha256(s: string) { return createHash('sha256').update(s).digest('hex'); }

export class Approvals {
  private waiters = new Map<string, { resolve: (d: ApprovalDecision) => void; cancel: () => void }>();
  private executors = new Map<ActionType, ActionExecutor>();
  private compensators = new Map<ActionType, ActionCompensator>();
  /** 决定后的钩子（如 triage_confirm → 派发） */
  private onDecided: Array<(a: ApprovalRow, d: ApprovalDecision) => Promise<void>> = [];

  constructor(private db: Db, private clock: Clock, private events: EventBus, private cfg: CenterConfig, private notifications: Notifications) {}

  registerExecutor(type: ActionType, fn: ActionExecutor) { this.executors.set(type, fn); }
  registerCompensator(type: ActionType, fn: ActionCompensator) { this.compensators.set(type, fn); }
  hasExecutor(type: ActionType) { return this.executors.has(type); }
  afterDecided(fn: (a: ApprovalRow, d: ApprovalDecision) => Promise<void>) { this.onDecided.push(fn); }
  /** 是否有人正阻塞等这个审批结果（MCP request_approval）。没有的话，决定必须另找地方承接，否则任务僵死 */
  hasWaiter(approvalId: string) { return this.waiters.has(approvalId); }

  async byKey(key: string, client?: Queryable): Promise<ApprovalRow | null> { return this.db.one<ApprovalRow>(`${APPROVAL_WITH_TASK} WHERE a.key=$1`, [key], client); }

  /** S06 Step 1–10：创建审批；auto 模式直接执行 */
  async request(input: { taskId: string; sessionId?: string | null; actionType: ActionType; title: string; body: string; payload?: Record<string, unknown>; executor?: 'agent' | 'center'; notify?: boolean }): Promise<ApprovalRow> {
    const now = this.clock.now();
    const trust = await this.db.one<{ mode: string; streak: number }>('SELECT mode, streak FROM trust_counters WHERE action_type=$1', [input.actionType]);
    if (!trust) throw new ApiError(422, 'VALIDATION_FAILED', `未知动作类型 ${input.actionType}`);
    const auto = trust.mode === 'auto';
    const row = await this.db.tx(async (c) => {
      const key = (await this.db.one<{ k: string }>(`SELECT 'A-' || nextval('approval_key_seq') AS k`, [], c))!.k;
      const r = await this.db.one<ApprovalRow>(
        `INSERT INTO approvals (key, task_id, session_id, action_type, status, title, body, body_hash, payload, trust_mode_snapshot, trust_streak_snapshot, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
        [key, input.taskId, input.sessionId ?? null, input.actionType, auto ? 'auto_approved' : 'pending', input.title, input.body, sha256(input.body), JSON.stringify({ ...(input.payload ?? {}), ...(input.executor ? { executor: input.executor } : {}) }), trust.mode, trust.streak, new Date(now.getTime() + APPROVAL_WAIT_MINUTES * 60_000), now], c);
      const task = await this.db.one<{ channel_id: string; key: string }>('SELECT channel_id, key FROM tasks WHERE id=$1', [input.taskId], c);
      if (auto) {
        await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, ref_type, ref_id, payload, created_at) VALUES ($1,$2,'system','system',$3,'approval',$4,$5,$6)`,
          [task!.channel_id, input.taskId, `自动执行（${input.actionType}，信任 ${trust.streak}/${this.cfg.trust.threshold}）`, r!.id, JSON.stringify({ auto: true, approvalKey: key }), now]);
        await this.events.record(c, { type: 'thread.event', taskId: input.taskId, payload: { taskKey: task!.key, text: `自动执行（${input.actionType}，信任 ${trust.streak}/${this.cfg.trust.threshold}）`, approvalKey: key } });
      } else {
        await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, ref_type, ref_id, payload, created_at) VALUES ($1,$2,'approval_card','system',$3,'approval',$4,$5,$6)`,
          [task!.channel_id, input.taskId, input.title, r!.id, JSON.stringify({ approvalKey: key, actionType: input.actionType, trustStreak: trust.streak, threshold: this.cfg.trust.threshold }), now]);
        await this.events.record(c, { type: 'inbox.new', taskId: input.taskId, payload: { itemType: 'approval', item: this.serialize(r!) } });
      }
      return r!;
    });
    this.events.flush();
    if (auto) {
      await this.execute(row, row.body, true);
      const fresh = (await this.byKey(row.key))!;
      // 线程事件带"否决并回滚"入口（S06 EX-4.1）
      if (fresh.action_id) await this.db.query(`UPDATE messages SET payload = payload || $2::jsonb WHERE ref_type='approval' AND ref_id=$1 AND kind='system'`, [row.id, JSON.stringify({ actionId: fresh.action_id })]);
      const decision: ApprovalDecision = { approved: true, via: 'auto', finalBody: row.body, reason: null, comment: null, overrides: null };
      for (const h of this.onDecided) await h(fresh, decision);
      return (await this.byKey(row.key))!;
    }
    if (input.notify !== false) await this.pushFeishu(row);
    return (await this.byKey(row.key))!;
  }

  /** S01 Step 27–31 / EX-28.2：推飞书；当日超限则延后 */
  private async pushFeishu(a: ApprovalRow) {
    const target = this.cfg.feishu.owner_open_id ?? 'owner';
    const sent = await this.notifications.sentTodayCount('approval');
    const defer = sent >= this.cfg.feishu.daily_push_limit;
    const text = a.action_type === 'triage_confirm'
      ? `[待拍板] ${a.key} · 分流卡 · ${(a.payload as any).taskKey ?? ''} · ${a.title}\n${(a.payload as any).summaryLine ?? ''}\n✅ 按建议执行   ❌ 否决   面板修改：/inbox#${a.key}`
      : `[审批] ${a.key} · ${a.action_type} · ${(a.payload as any).taskKey ?? ''} · 信任 ${a.trust_streak_snapshot}/${this.cfg.trust.threshold}\n> ${a.body.slice(0, 800)}\n✅ 确认   ❌ 否决   修改后确认请到面板`;
    const n = await this.notifications.send({ kind: 'approval', target, text, refType: 'approval', refId: a.id, defer });
    await this.db.query(`UPDATE approvals SET feishu_message_id=$2, feishu_deferred=$3 WHERE id=$1`, [a.id, n.externalMessageId, defer]);
  }

  /** 等待决定（MCP request_approval 用）；超时返回 timeout */
  waitFor(approvalId: string, timeoutMs: number): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const cancel = this.clock.after(timeoutMs, () => { this.waiters.delete(approvalId); resolve({ approved: false, via: null, finalBody: null, reason: 'timeout', comment: null }); });
      this.waiters.set(approvalId, { resolve, cancel });
    });
  }

  /** S06 Step 14–24：面板/飞书决定（先到先得、hash 校验、信任计数、执行） */
  async decide(key: string, input: { decision: 'approve' | 'reject'; bodyHash?: string; editedBody?: string | null; overrides?: Record<string, unknown> | null; comment?: string | null; via: 'panel' | 'feishu' }) {
    const a = await this.byKey(key);
    if (!a) throw new ApiError(404, 'NOT_FOUND', `审批 ${key} 不存在`);
    if (a.status !== 'pending') throw new ApiError(409, a.status === 'superseded' ? 'APPROVAL_BODY_CHANGED' : 'APPROVAL_ALREADY_DECIDED', undefined, { decidedVia: a.decided_via, decidedAt: a.decided_at, status: a.status });
    if (input.bodyHash && input.bodyHash !== a.body_hash) throw new ApiError(409, 'APPROVAL_BODY_CHANGED');
    // 分流卡：仓库待确认且未覆盖 → 422（S03 EX-6.1）
    if (a.action_type === 'triage_confirm' && input.decision === 'approve') {
      const t = await this.db.one<{ repo_name: string | null }>('SELECT repo_name FROM tasks WHERE id=$1', [a.task_id]);
      if (!t?.repo_name && !input.overrides?.repo) throw new ApiError(422, 'REPO_REQUIRED');
    }
    const modified = !!input.editedBody || !!(input.overrides && Object.keys(input.overrides).length);
    const finalBody = input.editedBody ?? a.body;
    const now = this.clock.now();
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const updated = await this.db.tx(async (c) => {
      const r = await c.query(`UPDATE approvals SET status=$2, decided_via=$3, decided_at=$4, modified=$5, final_body=$6, comment=$7, payload = payload || $8::jsonb, updated_at=$4 WHERE id=$1 AND status='pending' AND body_hash=$9`,
        [a.id, status, input.via, now, modified, finalBody, input.comment ?? null, JSON.stringify(input.overrides ? { overrides: input.overrides } : {}), a.body_hash]);
      if (r.rowCount === 0) {
        const cur = await this.byKey(key, c);
        throw new ApiError(409, cur?.status === 'superseded' ? 'APPROVAL_BODY_CHANGED' : 'APPROVAL_ALREADY_DECIDED', undefined, { decidedVia: cur?.decided_via, decidedAt: cur?.decided_at });
      }
      const trust = await this.applyTrust(c, a.action_type, input.decision, modified);
      const task = await this.db.one<{ key: string; channel_id: string }>('SELECT key, channel_id FROM tasks WHERE id=$1', [a.task_id], c);
      const text = input.decision === 'approve'
        ? `${a.key} 已确认（${input.via === 'feishu' ? '飞书' : '面板'}${modified ? '，修改，不计数' : '，原样'}）· ${a.action_type} 信任 ${trust.streak}/${this.cfg.trust.threshold}`
        : `${a.key} 已否决（${input.via === 'feishu' ? '飞书' : '面板'}）${input.comment ? `：${input.comment}` : ''} · ${a.action_type} 信任计数已清零`;
      await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, ref_type, ref_id, created_at) VALUES ($1,$2,'system','user',$3,'approval',$4,$5)`, [task!.channel_id, a.task_id, text, a.id, now]);
      const fresh = (await this.byKey(key, c))!;
      await this.events.record(c, { type: 'approval.decided', taskId: a.task_id, payload: { key: a.key, approval: this.serialize(fresh), taskKey: task!.key } });
      await this.events.record(c, { type: 'inbox.removed', taskId: a.task_id, payload: { itemType: 'approval', key: a.key, reason: input.via === 'feishu' ? 'decided_feishu' : 'decided_panel' } });
      await this.events.record(c, { type: 'trust.updated', payload: { counter: trust, change: input.decision === 'reject' ? 'reset' : trust.promoted ? 'promoted' : modified ? 'none' : 'increment' } });
      return { fresh, trust };
    });
    this.events.flush();
    // 飞书回帖同步（S06 Step 23）
    if (updated.fresh.feishu_message_id) {
      const t = input.decision === 'approve' ? (input.via === 'feishu' ? `${a.key} 已确认（信任 ${updated.trust.streak}/${this.cfg.trust.threshold}），正在执行` : `${a.key} 已在面板确认`) : `${a.key} 已否决，该类型信任计数已清零`;
      await this.notifications.send({ kind: 'reply', target: this.cfg.feishu.owner_open_id ?? 'owner', text: t, replyTo: updated.fresh.feishu_message_id, refType: 'approval', refId: a.id });
    }
    // hadWaiter 必须在唤醒前取：唤醒会把等待者从表里删掉，钩子再查就永远是 false
    const decision: ApprovalDecision = { approved: input.decision === 'approve', via: input.via, finalBody, reason: input.decision === 'approve' ? null : 'rejected', comment: input.comment ?? null, overrides: input.overrides ?? null, hadWaiter: this.waiters.has(a.id) };
    // 唤醒 MCP 等待者
    const w = this.waiters.get(a.id); if (w) { this.waiters.delete(a.id); w.cancel(); w.resolve(decision); }
    if (decision.approved) await this.execute(updated.fresh, finalBody, false);
    for (const h of this.onDecided) await h(updated.fresh, decision);
    return { approval: this.serialize((await this.byKey(key))!), trust: updated.trust };
  }

  /** 飞书 reaction → 决定（S06 Step 11–13；EX-12.1/12.2） */
  async decideByFeishu(ev: { messageId: string; operatorOpenId: string; operatorType: string; emoji: string }): Promise<{ handled: string; reason?: string }> {
    if (ev.operatorType !== 'user' || ev.operatorOpenId !== (this.cfg.feishu.owner_open_id ?? 'owner')) {
      await this.db.query(`INSERT INTO events (type, actor, payload, broadcast, created_at) VALUES ('approval.reaction_ignored','feishu',$1,false,$2)`, [JSON.stringify({ reason: 'not_owner', ...ev }), this.clock.now()]);
      return { handled: 'ignored', reason: 'not_owner' };
    }
    const decision = ev.emoji === this.cfg.feishu.approve_emoji ? 'approve' : ev.emoji === this.cfg.feishu.reject_emoji ? 'reject' : null;
    if (!decision) return { handled: 'ignored', reason: 'emoji' };
    const a = await this.db.one<ApprovalRow>('SELECT * FROM approvals WHERE feishu_message_id=$1', [ev.messageId]);
    if (!a) return { handled: 'ignored', reason: 'no_approval' };
    if (a.status !== 'pending') {
      const text = a.status === 'superseded' ? `${a.key} 本条已作废，请对新消息操作` : `${a.key} 已于 ${a.decided_at ? new Date(a.decided_at).toISOString().slice(11, 16) : ''} ${a.decided_via === 'panel' ? '在面板' : ''}确认，如需撤销请到面板`;
      await this.notifications.send({ kind: 'reply', target: this.cfg.feishu.owner_open_id ?? 'owner', text, replyTo: ev.messageId, refType: 'approval', refId: a.id });
      return { handled: 'ignored', reason: 'not_pending' };
    }
    try { await this.decide(a.key, { decision, via: 'feishu' }); return { handled: 'decided' }; }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) { await this.notifications.send({ kind: 'reply', target: this.cfg.feishu.owner_open_id ?? 'owner', text: `${a.key} 已在面板处理，本次操作忽略`, replyTo: ev.messageId, refType: 'approval', refId: a.id }); return { handled: 'ignored', reason: 'race' }; }
      throw e;
    }
  }

  private async applyTrust(c: Queryable, type: ActionType, decision: 'approve' | 'reject', modified: boolean) {
    const now = this.clock.now();
    const cur = await this.db.one<any>('SELECT * FROM trust_counters WHERE action_type=$1', [type], c);
    let streak = Number(cur.streak); let mode = cur.mode as string; let promoted = false;
    if (decision === 'reject') { streak = 0; if (mode !== 'locked') mode = 'manual'; await c.query(`UPDATE trust_counters SET streak=0, mode=$2, total_rejected=total_rejected+1, last_rejected_at=$3, updated_at=$3 WHERE action_type=$1`, [type, mode, now]); }
    else if (!modified) {
      streak += 1;
      if (mode === 'manual' && streak >= Number(cur.threshold)) { mode = 'auto'; promoted = true; }
      await c.query(`UPDATE trust_counters SET streak=$2, mode=$3, total_confirmed=total_confirmed+1, last_confirmed_at=$4, promoted_at=CASE WHEN $5 THEN $4 ELSE promoted_at END, updated_at=$4 WHERE action_type=$1`, [type, streak, mode, now, promoted]);
    } else await c.query(`UPDATE trust_counters SET total_confirmed=total_confirmed+1, last_confirmed_at=$2, updated_at=$2 WHERE action_type=$1`, [type, now]);
    return { actionType: type, mode, streak, threshold: Number(cur.threshold), promoted, lastRejectedAt: decision === 'reject' ? now.toISOString() : cur.last_rejected_at, updatedAt: now.toISOString() };
  }

  /** S06 Step 20：执行动作（center 执行器）；agent 执行的动作只记 actions */
  private async execute(a: ApprovalRow, finalBody: string, auto: boolean) {
    const now = this.clock.now();
    const executor = (a.payload as any)?.executor === 'agent' || ((a.payload as any)?.executor !== 'center' && a.session_id) ? 'agent' : 'center';
    const action = await this.db.one<{ id: string }>(`INSERT INTO actions (approval_id, task_id, action_type, executor, status, auto, revocable_until, created_at, updated_at) VALUES ($1,$2,$3,$4,'executing',$5,$6,$7,$7) RETURNING id`,
      [a.id, a.task_id, a.action_type, executor, auto, new Date(now.getTime() + 7 * 86400_000), now]);
    await this.db.query(`UPDATE approvals SET action_id=$2 WHERE id=$1`, [a.id, action!.id]);
    const fn = this.executors.get(a.action_type);
    if (executor === 'agent' || !fn) { await this.db.query(`UPDATE actions SET status='succeeded', result='{}'::jsonb, updated_at=$2 WHERE id=$1`, [action!.id, now]); return; }
    try {
      const result = await fn({ approval: a, finalBody, payload: a.payload, taskId: a.task_id });
      await this.db.query(`UPDATE actions SET status='succeeded', result=$2, updated_at=$3 WHERE id=$1`, [action!.id, JSON.stringify(result), this.clock.now()]);
    } catch (e) {
      // EX-20.1 / S03 EX-34.1：执行失败 → approval failed，信任不回退，收件箱重试项
      await this.db.tx(async (c) => {
        await c.query(`UPDATE actions SET status='failed', error=$2, updated_at=$3 WHERE id=$1`, [action!.id, String(e), this.clock.now()]);
        await c.query(`UPDATE approvals SET status='failed', payload = payload || '{"retryable":true}'::jsonb, updated_at=$2 WHERE id=$1`, [a.id, this.clock.now()]);
        const task = await this.db.one<{ key: string; channel_id: string }>('SELECT key, channel_id FROM tasks WHERE id=$1', [a.task_id], c);
        await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, ref_type, ref_id, created_at) VALUES ($1,$2,'system','system',$3,'approval',$4,$5)`, [task!.channel_id, a.task_id, `回写失败：${String((e as Error).message ?? e).slice(0, 200)}`, a.id, this.clock.now()]);
        await this.events.record(c, { type: 'inbox.new', taskId: a.task_id, payload: { itemType: 'approval', item: this.serialize((await this.byKey(a.key, c))!), retry: true } });
      });
      this.events.flush();
    }
  }

  /** EX-20.1：执行失败后的重试（信任不再变化） */
  async retryAction(key: string) {
    const a = await this.byKey(key);
    if (!a) throw new ApiError(404, 'NOT_FOUND', `审批 ${key} 不存在`);
    if (a.status !== 'failed') throw new ApiError(409, 'APPROVAL_NOT_PENDING', '审批不是失败状态，无需重试');
    await this.db.query(`UPDATE approvals SET status='approved', payload = payload - 'retryable', updated_at=$2 WHERE id=$1`, [a.id, this.clock.now()]);
    const fresh = (await this.byKey(key))!;
    await this.execute(fresh, fresh.final_body ?? fresh.body, false);
    const done = (await this.byKey(key))!;
    if (done.status !== 'failed') { await this.events.record(this.db.pool, { type: 'inbox.removed', taskId: a.task_id, payload: { itemType: 'approval', key: a.key, reason: 'retried' } }); this.events.flush(); }
    const action = await this.db.one<any>('SELECT * FROM actions WHERE id=$1', [done.action_id]);
    return this.serializeAction(action);
  }

  /** S06 Step 25–27：正文变更 → 旧审批作废、新审批重建、旧飞书消息回帖 */
  async supersede(key: string, newBody: string) {
    const a = await this.byKey(key);
    if (!a) throw new ApiError(404, 'NOT_FOUND', `审批 ${key} 不存在`);
    if (a.status !== 'pending') throw new ApiError(409, 'APPROVAL_NOT_PENDING');
    const fresh = await this.request({ taskId: a.task_id, sessionId: a.session_id, actionType: a.action_type, title: a.title, body: newBody, payload: { ...a.payload, supersedes: a.key }, executor: (a.payload as any)?.executor });
    const now = this.clock.now();
    await this.db.tx(async (c) => {
      await c.query(`UPDATE approvals SET status='superseded', superseded_by=$2, payload = payload || $4::jsonb, updated_at=$3 WHERE id=$1 AND status='pending'`, [a.id, fresh.id, now, JSON.stringify({ supersededByKey: fresh.key })]);
      const task = await this.db.one<{ key: string; channel_id: string }>('SELECT key, channel_id FROM tasks WHERE id=$1', [a.task_id], c);
      await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, ref_type, ref_id, created_at) VALUES ($1,$2,'system','system',$3,'approval',$4,$5)`, [task!.channel_id, a.task_id, `${a.key} 正文已变更，本条作废，改为 ${fresh.key}`, a.id, now]);
      await this.events.record(c, { type: 'inbox.removed', taskId: a.task_id, payload: { itemType: 'approval', key: a.key, reason: 'superseded' } });
    });
    this.events.flush();
    const w = this.waiters.get(a.id); if (w) { this.waiters.delete(a.id); w.cancel(); w.resolve({ approved: false, via: null, finalBody: null, reason: 'superseded', comment: null }); }
    if (a.feishu_message_id) await this.notifications.send({ kind: 'reply', target: this.cfg.feishu.owner_open_id ?? 'owner', text: `${a.key} 内容已变更，本条已作废；请对新消息 ${fresh.key} 操作`, replyTo: a.feishu_message_id, refType: 'approval', refId: a.id });
    return { old: this.serialize((await this.byKey(a.key))!), new: this.serialize((await this.byKey(fresh.key))!) };
  }

  /** S06 Step 28–32：事后否决自动执行的动作 → 降级为人工并补偿 */
  async revoke(actionId: string, reason?: string | null) {
    const action = await this.db.one<any>('SELECT * FROM actions WHERE id=$1', [actionId]);
    if (!action) throw new ApiError(404, 'NOT_FOUND', '动作不存在');
    const now = this.clock.now();
    if (action.revoked_at) throw new ApiError(409, 'ACTION_NOT_REVOCABLE', '动作已撤回');
    if (!action.revocable_until || new Date(action.revocable_until) < now) throw new ApiError(409, 'ACTION_NOT_REVOCABLE', '已超过 7 天回滚期');
    const approval = (await this.db.one<ApprovalRow>('SELECT * FROM approvals WHERE id=$1', [action.approval_id]))!;
    const type = action.action_type as ActionType;
    // 降级（Step 31）
    const cur = await this.db.one<any>('SELECT * FROM trust_counters WHERE action_type=$1', [type]);
    const mode = cur.mode === 'locked' ? 'locked' : 'manual';
    await this.db.query(`UPDATE trust_counters SET streak=0, mode=$2, total_rejected=total_rejected+1, last_rejected_at=$3, updated_at=$3 WHERE action_type=$1`, [type, mode, now]);
    const trust = { actionType: type, mode, streak: 0, threshold: Number(cur.threshold), promoted: false, lastRejectedAt: now.toISOString(), updatedAt: now.toISOString() };
    // 补偿（Step 32 / EX-32.1）
    let compensation: { status: 'reverted' | 'not_revocable' | 'failed'; detail: string };
    const comp = this.compensators.get(type);
    if (!REVOCABLE_ACTIONS.includes(type)) compensation = { status: 'not_revocable', detail: `${type} 不可逆（如 PR 已创建），已降级但需人工处理` };
    else {
      try { const ok = comp ? await comp({ action, approval }) : true; compensation = ok ? { status: 'reverted', detail: '已撤回' } : { status: 'not_revocable', detail: '目标系统不支持撤回' }; }
      catch (e) { compensation = { status: 'failed', detail: String((e as Error).message ?? e) }; }
    }
    const task = await this.db.one<any>('SELECT t.*, c.slug AS channel_slug FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1', [action.task_id]);
    await this.db.tx(async (c) => {
      await c.query(`UPDATE actions SET status=$2, revoked_at=$3, revoke_reason=$4, updated_at=$3 WHERE id=$1`, [actionId, compensation.status === 'reverted' ? 'reverted' : 'not_revocable', now, reason ?? null]);
      await c.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, ref_type, ref_id, created_at) VALUES ($1,$2,'system','user',$3,'action',$4,$5)`,
        [task.channel_id, action.task_id, compensation.status === 'reverted' ? `已否决并回滚 ${approval.key}（${type}）：${reason ?? ''} · 信任降级为人工` : `已否决 ${approval.key}（${type}）但无法自动撤回：${compensation.detail} · 信任降级为人工，请人工处理`, actionId, now]);
      await this.events.record(c, { type: 'trust.updated', payload: { counter: trust, change: 'downgraded' } });
      await this.events.record(c, { type: 'trust.downgraded', taskId: action.task_id, broadcast: false, payload: { actionType: type, actionId, reason: reason ?? null } });
      if (compensation.status !== 'reverted') {
        await c.query(`UPDATE tasks SET queue_reason=$2, updated_at=$3 WHERE id=$1`, [action.task_id, `人工处理：${type} 无法自动撤回（${compensation.detail.slice(0, 80)}）`, now]);
        await this.events.record(c, { type: 'inbox.new', taskId: action.task_id, payload: { itemType: 'failure', item: { key: task.key, title: task.title, queueReason: `人工处理：${type} 无法自动撤回` } } });
      }
    });
    this.events.flush();
    return { trust, compensation };
  }

  /** GET /api/trust（S06 Step 22；Phase 2 信任视图） */
  async listTrust() {
    const now = this.clock.now();
    const rows = await this.db.query<any>('SELECT * FROM trust_counters ORDER BY action_type');
    const auto7 = await this.db.query<{ action_type: string; n: string }>(`SELECT action_type, count(*) AS n FROM actions WHERE auto AND created_at > $1 GROUP BY action_type`, [new Date(now.getTime() - 7 * 86400_000)]);
    const autoMap = Object.fromEntries(auto7.rows.map((r) => [r.action_type, Number(r.n)]));
    const counters = rows.rows.map((r) => ({ actionType: r.action_type, mode: r.mode, streak: Number(r.streak), threshold: Number(r.threshold), lastRejectedAt: r.last_rejected_at ? new Date(r.last_rejected_at).toISOString() : null, autoExecutions7d: autoMap[r.action_type] ?? 0, updatedAt: new Date(r.updated_at).toISOString() }));
    // 近 4 周每周人工确认数（周一为周起点）
    const weekly: Array<{ weekStart: string; count: number }> = [];
    const day = (now.getUTCDay() + 6) % 7;
    const thisMonday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day);
    for (let i = 3; i >= 0; i--) {
      const start = new Date(thisMonday - i * 7 * 86400_000); const end = new Date(start.getTime() + 7 * 86400_000);
      const r = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM approvals WHERE decided_via IN ('panel','feishu') AND decided_at >= $1 AND decided_at < $2`, [start, end]);
      weekly.push({ weekStart: start.toISOString().slice(0, 10), count: Number(r?.n ?? 0) });
    }
    return { threshold: this.cfg.trust.threshold, counters, weeklyConfirmations: weekly };
  }

  /** POST /api/trust/{type}/reset */
  async resetTrust(type: ActionType) {
    const cur = await this.db.one<any>('SELECT * FROM trust_counters WHERE action_type=$1', [type]);
    if (!cur) throw new ApiError(404, 'NOT_FOUND');
    if (cur.mode === 'locked') throw new ApiError(409, 'TRUST_LOCKED');
    const now = this.clock.now();
    await this.db.query(`UPDATE trust_counters SET mode='manual', streak=0, updated_at=$2 WHERE action_type=$1`, [type, now]);
    const counter = { actionType: type, mode: 'manual', streak: 0, threshold: Number(cur.threshold), lastRejectedAt: cur.last_rejected_at ? new Date(cur.last_rejected_at).toISOString() : null, autoExecutions7d: 0, updatedAt: now.toISOString() };
    await this.events.record(this.db.pool, { type: 'trust.updated', payload: { counter, change: 'reset' } }); this.events.flush();
    return counter;
  }

  serializeAction(a: any) {
    return a ? { id: a.id, approvalId: a.approval_id, actionType: a.action_type, executor: a.executor, status: a.status, auto: a.auto, result: a.result ?? {}, revocableUntil: a.revocable_until ? new Date(a.revocable_until).toISOString() : null, revokedAt: a.revoked_at ? new Date(a.revoked_at).toISOString() : null, error: a.error ?? null, createdAt: new Date(a.created_at).toISOString() } : null;
  }

  /** 调度器：过期的 pending 审批（等待者已超时返回，审批保留 pending，仅标记 expires_at 已过） */
  async listInbox() {
    const rows = await this.db.query<ApprovalRow>(`${APPROVAL_WITH_TASK} WHERE a.status IN ('pending','failed') AND (a.status='pending' OR a.payload->>'retryable'='true') ORDER BY a.created_at`);
    return rows.rows.map((r) => this.serialize(r));
  }

  async list(q: { status?: string; taskKey?: string; actionType?: string; page?: number; perPage?: number }) {
    const where: string[] = []; const params: unknown[] = [];
    if (q.status) { params.push(q.status); where.push(`a.status=$${params.length}`); }
    if (q.taskKey) { params.push(q.taskKey); where.push(`t.key=$${params.length}`); }
    if (q.actionType) { params.push(q.actionType); where.push(`a.action_type=$${params.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const per = Math.min(Math.max(q.perPage ?? 20, 1), 100); const page = Math.max(q.page ?? 1, 1);
    const total = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM approvals a JOIN tasks t ON t.id=a.task_id ${w}`, params);
    const rows = await this.db.query<ApprovalRow>(`${APPROVAL_WITH_TASK} ${w} ORDER BY a.created_at DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, params);
    return { items: rows.rows.map((r) => this.serialize(r)), total: Number(total?.n ?? 0) };
  }

  serialize(a: ApprovalRow) {
    return {
      key: a.key, taskKey: a.task_key ?? (a.payload as any)?.taskKey ?? null, taskTitle: a.task_title ?? null,
      taskSource: a.task_source_ref ? `${a.task_source_type ?? 'src'}:${a.task_source_ref}` : null, actionType: a.action_type, status: a.status, title: a.title, body: a.body, bodyHash: a.body_hash,
      payload: a.payload, trustMode: a.trust_mode_snapshot, trustStreak: a.trust_streak_snapshot, feishuMessageId: a.feishu_message_id, feishuDeferred: a.feishu_deferred,
      decidedVia: a.decided_via, decidedAt: a.decided_at ? new Date(a.decided_at).toISOString() : null, modified: a.modified, finalBody: a.final_body, comment: a.comment,
      supersededBy: (a.payload as any)?.supersededByKey ?? a.superseded_by, actionId: a.action_id, sessionId: a.session_id, createdAt: new Date(a.created_at).toISOString(),
    };
  }
}
