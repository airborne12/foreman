/** 任务树只计算展示状态，执行状态与审批仍由原领域管理。 */
import type { Db } from '../db.js';

const failure = (alias: string) => `(${alias}.state='failed' OR ${alias}.queue_reason LIKE '重试%' OR ${alias}.queue_reason LIKE '人工处理%' OR ${alias}.queue_reason LIKE '无进展%')`;
const attention = (alias: string) => `(${failure(alias)} OR EXISTS (SELECT 1 FROM questions q WHERE q.task_id=${alias}.id AND q.status='open') OR EXISTS (SELECT 1 FROM approvals a WHERE a.task_id=${alias}.id AND (a.status='pending' OR (a.status='failed' AND a.payload->>'retryable'='true'))))`;

/** 递归保存访问路径，异常循环不会无限查询。频道分页只截根，不截后代。 */
const channelFamily = `WITH RECURSIVE family AS (
  SELECT t.id, t.id AS root_id, ARRAY[t.id] AS visited FROM tasks t WHERE t.channel_id=$1 AND t.parent_id IS NULL
  UNION ALL
  SELECT t.id, f.root_id, f.visited || t.id FROM tasks t JOIN family f ON t.parent_id=f.id WHERE NOT t.id=ANY(f.visited)
), stats AS (
  SELECT f.root_id, max(GREATEST(t.last_activity_at,t.updated_at)) AS activity,
    bool_or(t.state NOT IN ('done','delivered') OR ${attention('t')}) AS active,
    bool_or($2::text IS NULL OR t.state=$2) AS state_match,
    bool_or($3::text IS NULL OR strpos(lower(t.key || ' ' || t.title || ' ' || coalesce(t.source_ref,'')),lower($3))>0) AS search_match
  FROM family f JOIN tasks t ON t.id=f.id GROUP BY f.root_id
)`;

export type TaskTreeNode = {
  key: string; parentKey: string | null; title: string; state: string; kind: string; path: string | null;
  channel: string; source: { type: string; ref: string; url: string | null };
  repo: { name: string | null; source: string; confidence: number | null; candidates: string[] };
  runtime: string | null; agent: string | null; queueReason: string | null; priority: string | null;
  createdAt: string; updatedAt: string; unreadCount: number;
  children: TaskTreeNode[]; ownAttentionCount: number; attentionCount: number;
  groupState: string; groupLabel: string; active: boolean; latestActivityAt: string;
};
const labels: Record<string, string> = { waiting_input: '等待回答', failed: '需要处理', waiting_approval: '等待审批', running: '执行中', queued: '排队中', pending_decision: '待拍板', triaging: '分流中', paused: '已暂停', draft: '草稿', done: '已完成', delivered: '已交付' };
const order = ['waiting_input', 'failed', 'waiting_approval', 'running', 'queued', 'pending_decision', 'triaging', 'paused', 'draft', 'delivered', 'done'];

export class TaskTrees {
  constructor(private db: Db) {}

  async channel(channelId: string, q: { state?: string; search?: string; activeOnly?: boolean; page?: number; perPage?: number; throughPage?: number }) {
    const params = [channelId, q.state ?? null, q.search?.trim() || null];
    const per = Math.min(Math.max(q.perPage ?? 20, 1), 100); const page = Math.max(q.page ?? 1, 1);
    // 累计窗口用于实时刷新的“加载更多”，一条 SQL 同时决定计数和根顺序，避免跨页排序漂移。
    const limit = q.throughPage ? per * Math.min(q.throughPage, 100) : per;
    const counts = (await this.db.one<any>(`${channelFamily}, matched AS (SELECT * FROM stats WHERE state_match AND search_match),
      root_window AS (SELECT root_id,activity FROM matched WHERE NOT $4::boolean OR active ORDER BY activity DESC,root_id LIMIT $5 OFFSET $6)
      SELECT count(*) AS all_total,count(*) FILTER (WHERE active) AS active_total,count(*) FILTER (WHERE NOT $4::boolean OR active) AS total,
        (SELECT array_agg(root_id ORDER BY activity DESC,root_id) FROM root_window) AS root_ids FROM matched`, [...params, !!q.activeOnly, limit, q.throughPage ? 0 : (page - 1) * per]))!;
    const trees = await this.load(counts.root_ids ?? []);
    return { items: trees, total: Number(counts.total), activeTotal: Number(counts.active_total), allTotal: Number(counts.all_total) };
  }

  async activeCount(channelId: string) {
    const r = await this.db.one<{ n: string }>(`${channelFamily} SELECT count(*) AS n FROM stats WHERE active`, [channelId, null, null]);
    return Number(r?.n ?? 0);
  }

  /** 批量查询任意节点的真实根，编号与标题不参与推断关系。 */
  async contexts(keys: string[]) {
    if (!keys.length) return new Map<string, any>();
    const rows = await this.db.query<any>(`WITH RECURSIVE ancestors AS (
      SELECT t.id, t.parent_id, t.key AS requested_key, ARRAY[t.id] AS visited FROM tasks t WHERE t.key=ANY($1::text[])
      UNION ALL
      SELECT p.id,p.parent_id,a.requested_key,a.visited || p.id FROM tasks p JOIN ancestors a ON p.id=a.parent_id WHERE NOT p.id=ANY(a.visited)
    ) SELECT a.requested_key,t.id,t.key,t.title,c.slug AS channel,t.source_type,t.source_ref,t.source_url
      FROM ancestors a JOIN tasks t ON t.id=a.id JOIN channels c ON c.id=t.channel_id WHERE a.parent_id IS NULL`, [keys]);
    return new Map(rows.rows.map((r) => [r.requested_key, { id: r.id, key: r.key, title: r.title, channel: r.channel, source: { type: r.source_type, ref: r.source_ref, url: r.source_url ?? null } }]));
  }

  async forTask(key: string) {
    const root = (await this.contexts([key])).get(key);
    return root ? (await this.load([root.id]))[0] ?? null : null;
  }

  private async load(ids: string[]): Promise<TaskTreeNode[]> {
    if (!ids.length) return [];
    const rows = await this.db.query<any>(`WITH RECURSIVE subtree AS (
      SELECT t.id,ARRAY[t.id] AS visited FROM tasks t WHERE t.id=ANY($1::uuid[])
      UNION ALL
      SELECT t.id,s.visited || t.id FROM tasks t JOIN subtree s ON t.parent_id=s.id WHERE NOT t.id=ANY(s.visited)
    ) SELECT t.*,p.key AS parent_key,c.slug AS channel_slug,cp.jira->>'priority' AS priority,
      (SELECT count(*) FROM questions q WHERE q.task_id=t.id AND q.status='open') AS question_count,
      (SELECT count(*) FROM approvals a WHERE a.task_id=t.id AND a.status='pending') AS approval_count,
      (SELECT count(*) FROM approvals a WHERE a.task_id=t.id AND a.status='failed' AND a.payload->>'retryable'='true') AS failed_approval_count,
      coalesce(${failure('t')},false) AS needs_handling
      FROM subtree s JOIN tasks t ON t.id=s.id JOIN channels c ON c.id=t.channel_id
      LEFT JOIN tasks p ON p.id=t.parent_id LEFT JOIN context_packs cp ON cp.task_id=t.id`, [ids]);
    const nodes = new Map<string, TaskTreeNode>();
    for (const t of rows.rows) {
      const questions = Number(t.question_count); const approvals = Number(t.approval_count);
      const ownAttentionCount = questions + approvals + Number(t.failed_approval_count) + Number(t.needs_handling);
      const groupState = questions ? 'waiting_input' : t.needs_handling || Number(t.failed_approval_count) ? 'failed' : approvals ? 'waiting_approval' : t.state;
      nodes.set(t.id, {
        key: t.key, parentKey: t.parent_key ?? null, title: t.title, state: t.state, kind: t.kind, path: t.path,
        channel: t.channel_slug, source: { type: t.source_type, ref: t.source_ref, url: t.source_url ?? null },
        repo: { name: t.repo_name, source: t.repo_source, confidence: t.repo_confidence == null ? null : Number(t.repo_confidence), candidates: t.repo_candidates ?? [] },
        runtime: t.runtime_name, agent: t.agent, queueReason: t.queue_reason, priority: t.priority ?? null,
        createdAt: new Date(t.created_at).toISOString(), updatedAt: new Date(t.updated_at).toISOString(), unreadCount: 0,
        children: [], ownAttentionCount, attentionCount: ownAttentionCount, groupState, groupLabel: labels[groupState] ?? groupState,
        active: ownAttentionCount > 0 || !['done', 'delivered'].includes(t.state),
        latestActivityAt: new Date(Math.max(new Date(t.last_activity_at).getTime(), new Date(t.updated_at).getTime())).toISOString(),
      });
    }
    for (const t of rows.rows) if (t.parent_id && nodes.has(t.parent_id)) nodes.get(t.parent_id)!.children.push(nodes.get(t.id)!);
    const finish = (n: TaskTreeNode): TaskTreeNode => {
      n.children.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key, 'en', { numeric: true }));
      for (const child of n.children) {
        finish(child); n.attentionCount += child.attentionCount; n.active ||= child.active;
        if (child.latestActivityAt > n.latestActivityAt) n.latestActivityAt = child.latestActivityAt;
        if (order.indexOf(child.groupState) < order.indexOf(n.groupState)) n.groupState = child.groupState;
      }
      n.groupLabel = labels[n.groupState] ?? n.groupState;
      const reviewRunning = (node: TaskTreeNode): boolean => node.kind === 'review' && node.state === 'running' || node.children.some(reviewRunning);
      if (n.groupState === 'running' && reviewRunning(n)) n.groupLabel = '审查中';
      return n;
    };
    return ids.flatMap((id) => nodes.has(id) ? [finish(nodes.get(id)!)] : []);
  }
}
