/**
 * 直接写库的测试数据构造（fixtures 的底层）。列名与 schema.sql 一致。
 */
import type { Db } from '../../apps/center/src/db.js';

export async function seedChannel(db: Db, slug: string, kind: 'user' | 'source_default' = 'user') {
  const r = await db.one<{ id: string }>(`INSERT INTO channels (slug, title, kind) VALUES ($1,$1,$2) ON CONFLICT (slug) DO UPDATE SET title=EXCLUDED.title RETURNING id`, [slug, kind]);
  return r!.id;
}

export async function seedTask(db: Db, t: { key: string; channel?: string; state?: string; kind?: string; path?: string | null; repo?: string | null; runtime?: string | null; agent?: string | null; authorAgent?: string | null; terminalAt?: Date | null; source?: string; sourceType?: string; parentKey?: string | null }) {
  const channelId = await seedChannel(db, t.channel ?? 'jira', 'source_default');
  const parent = t.parentKey ? await db.one<{ id: string }>('SELECT id FROM tasks WHERE key=$1', [t.parentKey]) : null;
  // repo 显式传 null = 仓库待确认（unresolved）；未传 = 默认 selectdb-core
  const repo = t.repo === undefined ? 'selectdb/selectdb-core' : t.repo;
  const r = await db.one<{ id: string }>(
    `INSERT INTO tasks (key, parent_id, channel_id, title, state, kind, path, source_type, source_ref, repo_name, repo_source, runtime_name, agent, author_agent, terminal_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [t.key, parent?.id ?? null, channelId, t.key, t.state ?? 'running', t.kind ?? 'code', t.path ?? 'fix', t.sourceType ?? 'jira', t.source ?? 'CIR-1', repo, repo ? 'mapping' : 'unresolved', t.runtime ?? null, t.agent ?? null, t.authorAgent ?? null, t.terminalAt ?? null]);
  await db.query(`INSERT INTO context_packs (task_id, summary, source_text) VALUES ($1,$2,$2) ON CONFLICT (task_id) DO NOTHING`, [r!.id, t.key]);
  return r!.id;
}

/** runtime 行 id；不存在时创建一条离线行（fixture 引用尚未注册的 runtime，如 S05 EX-23.1） */
export async function runtimeId(db: Db, name: string) {
  const r = await db.one<{ id: string }>('SELECT id FROM runtimes WHERE name=$1', [name]);
  if (r) return r.id;
  return seedRuntime(db, { name, online: false, labels: ['agent:claude', 'agent:codex', 'build:doris'], lastSeenAt: null, agents: { claude: { bin: 'claude', maxConcurrent: 3 }, codex: { bin: 'codex', maxConcurrent: 3 } } });
}

export async function seedSession(db: Db, s: { taskId?: string | null; channelId?: string | null; runtime: string; agent: string; kind?: string; state?: string; agentSessionId?: string | null; cwd?: string | null; startedAt?: Date | null; lastProgressAt?: Date | null }) {
  const rid = await runtimeId(db, s.runtime);
  const r = await db.one<{ id: string }>(
    `INSERT INTO sessions (task_id, channel_id, runtime_id, agent, kind, state, agent_session_id, cwd, prompt, started_at, last_progress_at, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'seed',$9,$10,$10) RETURNING id`,
    [s.taskId ?? null, s.channelId ?? null, rid, s.agent, s.kind ?? (s.channelId ? 'dispatcher' : s.taskId ? 'implement' : 'candidate_scan'), s.state ?? 'running', s.agentSessionId ?? null, s.cwd ?? null, s.startedAt ?? new Date(), s.lastProgressAt ?? null]);
  return r!.id;
}

export async function seedWorktree(db: Db, w: { taskId: string; runtime: string; path: string; state?: string; sizeBytes?: number; repo?: string }) {
  const rid = await runtimeId(db, w.runtime);
  const r = await db.one<{ id: string }>(
    `INSERT INTO worktrees (task_id, runtime_id, repo_name, base_branch, branch_name, path, state, size_bytes) VALUES ($1,$2,$3,'main',$4,$5,$6,$7) RETURNING id`,
    [w.taskId, rid, w.repo ?? 'selectdb/selectdb-core', `foreman/${w.path.split('/').pop()}`, w.path, w.state ?? 'ready', w.sizeBytes ?? 4_000_000_000]);
  return r!.id;
}

/** 直接插入 runtime 行（不经 hub），用于纯路由/离线判定测试 */
export async function seedRuntime(db: Db, r: { name: string; online?: boolean; labels?: string[]; transport?: string; lastSeenAt?: Date | null; agents?: Record<string, { bin: string; maxConcurrent: number }> }) {
  const row = await db.one<{ id: string }>(
    `INSERT INTO runtimes (name, online, transport, labels, agents, last_seen_at, registered_at) VALUES ($1,$2,$3,$4,$5,$6,$6)
     ON CONFLICT (name) DO UPDATE SET online=EXCLUDED.online, labels=EXCLUDED.labels, agents=EXCLUDED.agents, last_seen_at=EXCLUDED.last_seen_at RETURNING id`,
    [r.name, r.online ?? true, r.transport ?? 'direct', r.labels ?? [], JSON.stringify(r.agents ?? { claude: { bin: 'claude', maxConcurrent: 3 } }), r.lastSeenAt === undefined ? new Date() : r.lastSeenAt]);
  return row!.id;
}
