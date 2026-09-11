/**
 * Jira Server REST 客户端（job.run：jira-poll / jira-lookup / jira-comment）。
 * 来源：S01 Step 5–8；S04 Step 20；S03 Step 34。只在带 vpn:jira 标签的 runtime 上执行。
 * 凭据：环境变量 JIRA_URL、JIRA_USER + JIRA_PASSWORD（Basic）或 JIRA_TOKEN（Bearer）；也可从 ~/.jira.conf（KEY=VALUE）读取。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export interface JiraConfig { url: string; user?: string; password?: string; token?: string }

export function loadJiraConfig(env: NodeJS.ProcessEnv = process.env): JiraConfig | null {
  const conf: Record<string, string> = {};
  const p = resolve(homedir(), '.jira.conf');
  if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) conf[m[1]!.toUpperCase()] = m[2]!.replace(/^['"]|['"]$/g, '').trim(); }
  const url = env.JIRA_URL ?? conf.JIRA_URL ?? conf.URL;
  if (!url) return null;
  return { url: url.replace(/\/$/, ''), user: env.JIRA_USER ?? conf.JIRA_USER ?? conf.USER, password: env.JIRA_PASSWORD ?? conf.JIRA_PASSWORD ?? conf.PASSWORD, token: env.JIRA_TOKEN ?? conf.JIRA_TOKEN ?? conf.TOKEN };
}

export class JiraClient {
  constructor(private cfg: JiraConfig, private fetchImpl: typeof fetch = fetch) {}

  private headers() {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.cfg.token) h.authorization = `Bearer ${this.cfg.token}`;
    else if (this.cfg.user) h.authorization = `Basic ${Buffer.from(`${this.cfg.user}:${this.cfg.password ?? ''}`).toString('base64')}`;
    return h;
  }

  private async req(method: string, path: string, body?: unknown, timeoutMs = 30_000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await this.fetchImpl(`${this.cfg.url}${path}`, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error(`Jira ${r.status}: ${text.slice(0, 200)}`), { code: r.status === 404 ? 'NOT_FOUND' : r.status >= 500 ? 'SOURCE_UNREACHABLE' : 'INTERNAL' });
      return text ? JSON.parse(text) : {};
    } catch (e) {
      if ((e as any)?.name === 'AbortError') throw Object.assign(new Error('Jira 超时'), { code: 'TIMEOUT' });
      if (!(e as any).code) throw Object.assign(new Error(`Jira 不可达：${(e as Error).message}`), { code: 'SOURCE_UNREACHABLE' });
      throw e;
    } finally { clearTimeout(t); }
  }

  async search(jql: string, maxResults = 50) {
    const r = await this.req('POST', '/rest/api/2/search', { jql, maxResults, fields: ['summary', 'description', 'project', 'components', 'fixVersions', 'priority', 'assignee', 'status', 'updated', 'comment', 'attachment'] });
    return { issues: (r.issues ?? []).map((i: any) => normalizeIssue(i, this.cfg.url)), total: r.total ?? 0 };
  }
  async getIssue(key: string) { return normalizeIssue(await this.req('GET', `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,project,components,fixVersions,priority,assignee,status,updated,comment,attachment`), this.cfg.url); }
  async addComment(key: string, body: string) { const r = await this.req('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body }); return { commentId: String(r.id ?? ''), url: `${this.cfg.url}/browse/${key}?focusedCommentId=${r.id ?? ''}` }; }
}

export function normalizeIssue(i: any, base: string) {
  const f = i.fields ?? {};
  return {
    key: i.key, summary: f.summary ?? '', description: f.description ?? '', project: f.project?.key ?? String(i.key ?? '').split('-')[0],
    component: f.components?.[0]?.name ?? null, version: f.fixVersions?.[0]?.name ?? null, priority: f.priority?.name ?? null,
    assignee: f.assignee?.name ?? f.assignee?.key ?? null, status: f.status?.name ?? null, updated: f.updated ?? null,
    comments: (f.comment?.comments ?? []).slice(-5).map((c: any) => ({ author: c.author?.displayName ?? c.author?.name ?? '', body: c.body ?? '' })),
    attachments: (f.attachment ?? []).map((a: any) => ({ name: a.filename, url: a.content })),
    url: `${base}/browse/${i.key}`,
  };
}

/** job.run 分派（worker 侧） */
export async function runJiraJob(kind: string, args: Record<string, unknown>, client: JiraClient | null): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: { code: 'SOURCE_UNREACHABLE' | 'NOT_FOUND' | 'TIMEOUT' | 'INTERNAL'; message: string } }> {
  if (!client) return { ok: false, error: { code: 'INTERNAL', message: '本 runtime 未配置 Jira 凭据（JIRA_URL）' } };
  try {
    if (kind === 'jira-poll') { const r = await client.search(String(args.jql ?? '')); return { ok: true, result: { issues: r.issues, total: r.total, fetchedAt: new Date().toISOString() } }; }
    if (kind === 'jira-lookup') return { ok: true, result: await client.getIssue(String(args.key)) };
    if (kind === 'jira-comment') return { ok: true, result: await client.addComment(String(args.key), String(args.body ?? '')) };
    return { ok: false, error: { code: 'INTERNAL', message: `未知作业 ${kind}` } };
  } catch (e) {
    const code = (['SOURCE_UNREACHABLE', 'NOT_FOUND', 'TIMEOUT', 'INTERNAL'] as const).find((c) => c === (e as any).code) ?? 'INTERNAL';
    return { ok: false, error: { code, message: String((e as Error).message ?? e) } };
  }
}
