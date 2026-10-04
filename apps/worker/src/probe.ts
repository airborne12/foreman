/**
 * 本机能力探测（S05 Step 2；core-03 §4 S05.1）
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ProbeResult {
  agents: Record<string, { bin: string; version: string | null; ok: boolean; note?: string }>;
  tools: Record<string, { bin: string | null; ok: boolean }>;
  repos: Record<string, { main: string; worktreeRoot: string; buildEnvOk: boolean }>;
  labels: string[];
  capabilities: Array<'jira-poll' | 'jira-lookup' | 'gh' | 'merge-tree' | 'rg'>;
  warnings: string[];
}

export function which(bin: string, env = process.env): string | null {
  const paths = (env.PATH ?? '').split(':').filter(Boolean);
  for (const p of paths) {
    const f = resolve(p, bin);
    try { if (existsSync(f) && (statSync(f).mode & 0o111)) return f; } catch { /* ignore */ }
  }
  return null;
}

function version(bin: string): { ok: boolean; version: string | null; note?: string } {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000 });
  if (r.error || r.status !== 0) return { ok: false, version: null, note: (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0] };
  return { ok: true, version: (r.stdout || r.stderr).trim().split('\n')[0] ?? null };
}

export function probe(opts: { repos?: Record<string, string>; env?: NodeJS.ProcessEnv; homeDir?: string }): ProbeResult {
  const env = opts.env ?? process.env;
  const out: ProbeResult = { agents: {}, tools: {}, repos: {}, labels: [], capabilities: [], warnings: [] };
  for (const a of ['codex']) {
    const bin = which(a, env);
    if (!bin) { out.agents[a] = { bin: a, version: null, ok: false, note: '未找到' }; continue; }
    const v = version(bin);
    out.agents[a] = { bin, version: v.version, ok: v.ok, note: v.note };
    if (v.ok) out.labels.push(`agent:${a}`); else out.warnings.push(`${a} 不可用：${v.note}`);
  }
  for (const t of ['gh', 'git', 'rg']) out.tools[t] = { bin: which(t, env), ok: which(t, env) !== null };
  if (out.tools.gh?.ok) out.capabilities.push('gh');
  if (out.tools.git?.ok) out.capabilities.push('merge-tree');
  if (out.tools.rg?.ok) out.capabilities.push('rg');
  let anyBuild = false;
  for (const [name, main] of Object.entries(opts.repos ?? {})) {
    if (!existsSync(main)) { out.warnings.push(`仓库路径不存在：${main}`); continue; }
    const buildEnvOk = existsSync(resolve(main, 'thirdparty', 'installed'));
    out.repos[name] = { main, worktreeRoot: resolve(main, '..', `${name.split('/').pop()}-worktrees`), buildEnvOk };
    out.labels.push(`repo:${name}`);
    if (buildEnvOk) anyBuild = true;
  }
  if (anyBuild) out.labels.push('build:doris');
  const jiraConf = resolve(opts.homeDir ?? env.HOME ?? '', '.jira.conf');
  if (existsSync(jiraConf)) { out.labels.push('vpn:jira'); out.capabilities.push('jira-poll', 'jira-lookup'); }
  return out;
}

export function formatProbe(p: ProbeResult): string {
  const lines: string[] = ['探测本机能力…'];
  for (const [a, r] of Object.entries(p.agents)) lines.push(`  ${a.padEnd(9)}${r.ok ? '✓' : '✗'} ${r.ok ? r.version ?? '' : r.note ?? ''}`);
  for (const [t, r] of Object.entries(p.tools)) lines.push(`  ${t.padEnd(9)}${r.ok ? '✓' : '✗'} ${r.bin ?? '未安装'}`);
  for (const [n, r] of Object.entries(p.repos)) lines.push(`  仓库     ✓ ${n} → ${r.main}${r.buildEnvOk ? '' : '（无 thirdparty/installed）'}`);
  lines.push(`  构建环境 ${p.labels.includes('build:doris') ? 'build:doris ✓' : 'build:doris ✗ 未发现 thirdparty/installed（不会打标签）'}`);
  lines.push(`  标签     agent:codex ${p.labels.includes('agent:codex') ? '✓' : '✗'}`);
  return lines.join('\n');
}
