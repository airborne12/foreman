/**
 * {{fixture:name(args)}} 实现（来源：scenario/core-00-format.schema.json x-fixtures）。本批实现 S05 所需。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { Db } from '../../apps/center/src/db.js';
import { seedTask, seedWorktree, seedSession, runtimeId } from '../helpers/seed.js';
import { sha256 } from '../../apps/center/src/domain/approvals.js';
import { Intake } from '../../apps/center/src/domain/intake.js';

export interface FixtureCtx { db: Db; now: () => Date; vars: Record<string, unknown>; env: Record<string, string> }

/** 解析 name(args)：args 形如 key='v', key=[1,2], key=3 */
export function parseFixtureCall(expr: string): { name: string; args: Record<string, unknown> } {
  const m = expr.match(/^([\w.]+)\((.*)\)$/s);
  if (!m) return { name: expr, args: {} };
  const args: Record<string, unknown> = {};
  const body = m[2]!.trim();
  // 单个位置参数：lark.messageText('om_target')
  if (body && !/[A-Za-z_]\w*\s*=/.test(body)) { args._0 = body.replace(/^'|'$/g, ''); return { name: m[1]!, args }; }
  if (body) {
    const re = /(\w+)\s*=\s*('[^']*'|\[[^\]]*\]|[^,]+)/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(body))) {
      const raw = mm[2]!.trim();
      let val: unknown;
      if (raw.startsWith("'")) val = raw.slice(1, -1);
      else if (raw.startsWith('[')) val = JSON.parse(raw.replace(/'/g, '"'));
      else if (raw === 'null') val = null;
      else if (raw === 'true' || raw === 'false') val = raw === 'true';
      else val = Number.isFinite(Number(raw)) ? Number(raw) : raw;
      args[mm[1]!] = val;
    }
  }
  return { name: m[1]!, args };
}

export const fixtures: Record<string, (ctx: FixtureCtx, args: Record<string, unknown>) => Promise<unknown> | unknown> = {
  /** 生成临时 worker.yaml，返回路径 */
  workerYaml(ctx, a) {
    const dir = mkdtempSync(resolve(tmpdir(), 'wy-'));
    const cfg = {
      name: a.name ?? 'laptop',
      center: { url: a.center ?? ctx.env.CENTER_WS ?? 'ws://127.0.0.1:7801', token: a.token ?? ctx.env.FOREMAN_TOKEN },
      transport: a.transport ?? 'direct',
      labels: a.labels ?? ['agent:claude'],
      agents: Object.fromEntries(((a.labels as string[] | undefined) ?? ['agent:claude']).filter((l) => l.startsWith('agent:')).map((l) => [l.slice(6), { bin: `fake-${l.slice(6)}`, maxConcurrent: 3 }])),
      repos: (a.labels as string[] | undefined)?.includes('build:doris') ? { 'selectdb/selectdb-core': { main: '/tmp/fx/selectdb-core', worktreeRoot: '/tmp/fx/wt' } } : {},
      capabilities: (a.labels as string[] | undefined)?.includes('vpn:jira') ? ['jira-poll', 'jira-lookup'] : [],
      state_file: resolve(dir, 'worker-state.json'),
    };
    const p = resolve(dir, 'worker.yaml');
    writeFileSync(p, YAML.stringify(cfg), { mode: 0o600 });
    return p;
  },

  /** worktrees(runtime, done_days=[...], running=N)：写任务 + worktree 行并在磁盘建目录 */
  async worktrees(ctx, a) {
    const rt = String(a.runtime ?? 'dev');
    const base = mkdtempSync(resolve(tmpdir(), 'fxwt-'));
    const rows: Array<{ taskKey: string; path: string; days: number | null }> = [];
    let i = 0;
    for (const d of (a.done_days as number[] | undefined) ?? []) {
      const key = `T-8${String(i++).padStart(2, '0')}`;
      const p = resolve(base, key); mkdirSync(p); writeFileSync(resolve(p, 'f'), 'x');
      const t = await seedTask(ctx.db, { key, state: 'done', terminalAt: new Date(ctx.now().getTime() - d * 86400_000), runtime: rt });
      await seedWorktree(ctx.db, { taskId: t, runtime: rt, path: p, sizeBytes: 4_000_000_000 });
      rows.push({ taskKey: key, path: p, days: d });
    }
    for (let r = 0; r < Number(a.running ?? 0); r++) {
      const key = `T-8${String(i++).padStart(2, '0')}`;
      const p = resolve(base, key); mkdirSync(p);
      const t = await seedTask(ctx.db, { key, state: 'running', runtime: rt });
      await seedWorktree(ctx.db, { taskId: t, runtime: rt, path: p });
      await seedSession(ctx.db, { taskId: t, runtime: rt, agent: 'claude' });
      rows.push({ taskKey: key, path: p, days: null });
    }
    ctx.vars.__worktrees = rows;
    return rows;
  },

  /** gc.removed(done_days_gte=N)：按上面 seed 的 worktrees 计算应删列表 */
  'gc.removed'(ctx, a) {
    const rows = (ctx.vars.__worktrees as Array<{ taskKey: string; path: string; days: number | null }> | undefined) ?? [];
    const min = Number(a.done_days_gte ?? 0);
    return rows.filter((r) => r.days != null && r.days >= min).map((r) => ({ taskKey: r.taskKey, path: r.path, terminalAt: new Date(ctx.now().getTime() - r.days! * 86400_000).toISOString(), bytes: 4_000_000_000 }));
  },

  /** sessions.running(runtime, agent, count) */
  async 'sessions.running'(ctx, a) {
    const rows = [];
    for (let i = 0; i < Number(a.count ?? 1); i++) rows.push(await seedSession(ctx.db, { runtime: String(a.runtime), agent: String(a.agent), kind: 'implement', state: 'running', taskId: await seedTask(ctx.db, { key: `T-7${String(Math.floor(Math.random() * 900) + 100)}`, state: 'running', runtime: String(a.runtime) }) }));
    return rows;
  },

  /** task.pendingDecision(key, repo, tier, kind?, channel, source)：根任务 + 上下文包 + 分流卡 + pending 的 triage_confirm 审批（key 取 approval_key_seq，重置后首个为 A-87） */
  async 'task.pendingDecision'(ctx, a) {
    const [st, ref] = String(a.source ?? 'jira:CIR-1').split(':');
    const key = String(a.key); const tier = String(a.tier ?? 'fix'); const repo = (a.repo as string | null) ?? null;
    const taskId = await seedTask(ctx.db, { key, state: 'pending_decision', kind: String(a.kind ?? 'code'), path: tier, repo, channel: String(a.channel ?? 'jira'), sourceType: st, source: ref });
    const summaryLine = `档位 ${tier} · 预估 small · 仓库 ${repo ?? '待确认'} · runtime dev · agent claude`;
    const payload = { taskKey: key, tier, effort: 'small', repo: { name: repo, source: repo ? 'mapping' : 'unresolved', confidence: repo ? 0.9 : 0.5, candidates: repo ? [] : ['apache/doris', 'selectdb/selectdb-core'] }, suggestedPath: '按分流卡执行', codeLocations: [{ file: 'be/src/x.cpp', line: 1, why: 'fixture' }], defaultRuntime: 'dev', defaultAgent: 'claude', degraded: false, degradedReason: null, summaryLine };
    const body = `分流卡：${summaryLine}\n建议：按分流卡执行`;
    const ap = await ctx.db.one<{ id: string; key: string }>(`INSERT INTO approvals (key, task_id, action_type, status, title, body, body_hash, payload, trust_mode_snapshot, trust_streak_snapshot, expires_at, created_at, updated_at)
      VALUES ('A-' || nextval('approval_key_seq'), $1, 'triage_confirm', 'pending', $2, $3, $4, $5, 'manual', 0, $6, $7, $7) RETURNING id, key`, [taskId, `${key} · ${ref}`, body, sha256(body), JSON.stringify(payload), new Date(ctx.now().getTime() + 30 * 60_000), ctx.now()]);
    await ctx.db.query(`INSERT INTO triage_cards (task_id, tier, effort, repo_name, repo_confidence, repo_candidates, suggested_path, code_locations, default_runtime, default_agent, degraded, approval_id) VALUES ($1,$2,'small',$3,$4,$5,'按分流卡执行',$6,'dev','claude',false,$7) ON CONFLICT (task_id) DO NOTHING`,
      [taskId, tier, repo, repo ? 0.9 : 0.5, payload.repo.candidates, JSON.stringify(payload.codeLocations), ap!.id]);
    const ch = await ctx.db.one<{ channel_id: string }>('SELECT channel_id FROM tasks WHERE id=$1', [taskId]);
    // 时间戳用假时钟（早于后续线程事件 1 秒），保证 items[-1] 是最新事件
    await ctx.db.query(`INSERT INTO messages (channel_id, task_id, kind, author, text, ref_type, ref_id, payload, created_at) VALUES ($1,$2,'approval_card','system',$3,'approval',$4,$5,$6)`, [ch!.channel_id, taskId, `${key} 分流卡`, ap!.id, JSON.stringify({ approvalKey: ap!.key }), new Date(ctx.now().getTime() - 1000)]);
    await ctx.db.query(`UPDATE tasks SET created_at=$2, updated_at=$2, last_activity_at=$2 WHERE id=$1`, [taskId, new Date(ctx.now().getTime() - 1000)]);
    ctx.vars[`__approval.${key}`] = ap!.key;
    return taskId;
  },

  /** approval.setFeishuMessage(key, message_id)：模拟已推送到飞书的审批 */
  async 'approval.setFeishuMessage'(ctx, a) {
    await ctx.db.query(`UPDATE approvals SET feishu_message_id=$2 WHERE key=$1`, [String(a.key), String(a.message_id)]);
    return { key: a.key, message_id: a.message_id };
  },

  /** notifications.sent_today(kind, count)：当日已发送的通知 */
  async 'notifications.sent_today'(ctx, a) {
    const n = Number(a.count ?? 30); const rows = [];
    for (let i = 0; i < n; i++) rows.push(await ctx.db.one<{ id: string }>(`INSERT INTO notifications (channel, kind, target, text, status, attempts, external_message_id, sent_at, created_at) VALUES ('feishu',$1,'ou_owner',$2,'sent',1,$3,$4,$4) RETURNING id`, [String(a.kind ?? 'approval'), `[待拍板] 历史推送 ${i + 1}`, `om_hist_${i + 1}`, new Date(ctx.now().getTime() - (n - i) * 60_000)]));
    return rows.map((r) => r!.id);
  },

  /** task.running(key, channel, runtime)：运行中的根任务（无会话） */
  async 'task.running'(ctx, a) {
    return seedTask(ctx.db, { key: String(a.key), state: 'running', channel: String(a.channel ?? 'jira'), runtime: (a.runtime as string) ?? 'dev' });
  },

  /** task.runningOn(key, runtime, agent, session_state, agent_session_id)：任务 + worktree + 会话（含 MCP token，明文放 vars.__token.<sessionId>） */
  async 'task.runningOn'(ctx, a) {
    const t = await seedTask(ctx.db, { key: String(a.key), state: a.session_state === 'done' ? 'delivered' : 'running', runtime: String(a.runtime), agent: String(a.agent), authorAgent: String(a.agent) });
    const wt = await seedWorktree(ctx.db, { taskId: t, runtime: String(a.runtime), path: `/tmp/fx/wt/${a.key}` });
    const sid = await seedSession(ctx.db, { taskId: t, runtime: String(a.runtime), agent: String(a.agent), state: String(a.session_state ?? 'running'), agentSessionId: (a.agent_session_id as string) ?? null, cwd: `/tmp/fx/wt/${a.key}`, startedAt: ctx.now(), lastProgressAt: null });
    const token = Intake.newToken();
    await ctx.db.query(`UPDATE sessions SET worktree_id=$2, mcp_token_hash=$3, created_at=$4, updated_at=$4 WHERE id=$1`, [sid, wt, Intake.hash(token), ctx.now()]);
    await ctx.db.query(`UPDATE tasks SET created_at=$2, updated_at=$2, last_activity_at=$2 WHERE id=$1`, [t, ctx.now()]);
    ctx.vars[`__token.${sid}`] = token;
    return t;
  },

  /** approval.pending(key?, taskKey, actionType, feishu_message_id)：pending 审批（key 由序列生成） */
  async 'approval.pending'(ctx, a) {
    const t = await ctx.db.one<{ id: string; key: string; channel_id: string }>('SELECT id, key, channel_id FROM tasks WHERE key=$1', [String(a.taskKey)]);
    if (!t) throw new Error(`approval.pending：任务 ${a.taskKey} 不存在`);
    const body = String(a.body ?? '审批正文');
    const ap = await ctx.db.one<{ id: string; key: string }>(`INSERT INTO approvals (key, task_id, action_type, status, title, body, body_hash, payload, trust_mode_snapshot, trust_streak_snapshot, feishu_message_id, expires_at, created_at, updated_at)
      VALUES ('A-' || nextval('approval_key_seq'), $1, $2, 'pending', $3, $4, $5, $6, 'manual', 0, $7, $8, $9, $9) RETURNING id, key`,
      [t.id, String(a.actionType ?? 'triage_confirm'), String(a.title ?? `${t.key} 审批`), body, sha256(body), JSON.stringify({ taskKey: t.key }), (a.feishu_message_id as string) ?? null, new Date(ctx.now().getTime() + 30 * 60_000), ctx.now()]);
    return { key: ap!.key, id: ap!.id };
  },

  async 'task.done'(ctx, a) { return seedTask(ctx.db, { key: String(a.key), state: 'done', authorAgent: (a.author_agent as string) ?? null, terminalAt: ctx.now() }); },

  /** lark.messages(chat, count, target?)：生成群消息并写入假 lark 消息库 */
  'lark.messages'(ctx, a) {
    const chat = String(a.chat ?? 'oc_index');
    const count = Number(a.count ?? 10);
    const targetId = a.target ? String(a.target) : null;
    const mid = Math.floor(count / 2);
    const base = ctx.now().getTime() - count * 60_000;
    const messages = Array.from({ length: count }, (_, i) => ({
      messageId: targetId && i === mid ? targetId : `om_${chat}_${i}`,
      chatId: chat,
      senderOpenId: i % 3 === 0 ? 'ou_owner' : `ou_user${i % 5}`,
      text: targetId && i === mid ? '客户那边 ngram 索引 LIKE 查询偶发超时' : `${chat} 第 ${i} 条消息`,
      createdAt: new Date(base + i * 60_000).toISOString(),
    }));
    const store = (ctx.vars.__larkMessages as Record<string, string> | undefined) ?? {};
    for (const m of messages) store[m.messageId] = m.text;
    ctx.vars.__larkMessages = store;
    return messages;
  },

  /** lark.messageText('om_target')：取某条消息的正文 */
  'lark.messageText'(ctx, a) {
    const id = String(a._0 ?? a.messageId ?? '');
    return ((ctx.vars.__larkMessages as Record<string, string> | undefined) ?? {})[id] ?? '';
  },

  /** tasks.recent(count, channel)：最近任务，供 list_tasks 候选 */
  async 'tasks.recent'(ctx, a) {
    const n = Number(a.count ?? 5); const keys: string[] = [];
    for (let i = 0; i < n; i++) {
      const key = `T-2000${i + 1}`;
      await seedTask(ctx.db, { key, state: 'done', channel: String(a.channel ?? 'jira'), source: `CIR-2000${i + 1}`, terminalAt: ctx.now() });
      await ctx.db.query(`UPDATE tasks SET title=$2, last_activity_at=$3 WHERE key=$1`, [key, `索引相关任务 ${i + 1}`, new Date(ctx.now().getTime() - i * 1000)]);
      keys.push(key);
    }
    return keys;
  },

  'logs'(_ctx, a) { return Array.from({ length: Number(a.lines ?? 100) }, (_, i) => `[line ${i + 1}] fake log`); },
  'text'(_ctx, a) { return 'x'.repeat(Number(a.len ?? 100)); },
};

export async function resolveFixture(expr: string, ctx: FixtureCtx) {
  const { name, args } = parseFixtureCall(expr);
  const f = fixtures[name];
  if (!f) throw new Error(`fixture 未实现：${name}`);
  return f(ctx, args);
}

export { runtimeId };
