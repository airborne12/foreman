/**
 * 路由规则（来源：core-S05 Step 20；core-03 §4 S05.3）
 * 1. require 标签全部命中才是候选；2. 多候选取 prefer；3. 否则取运行中会话最少者；手动覆盖优先于规则。
 * 4. 代码类任务给了仓库时，只考虑登记了该仓库的 runtime（repos 未上报的 runtime 视为不限仓库）。
 */
export interface RuntimeCandidate {
  name: string;
  online: boolean;
  labels: string[];
  runningSessions: number;
  /** runtime 注册时上报的仓库；undefined 表示未上报，不做仓库过滤 */
  repos?: string[];
}
export interface RoutingRule { require: string[]; prefer?: string }
export interface RoutingDecision {
  runtime: string | null;
  reason: string;
  missingLabels?: string[];
}

export function routeTask(params: {
  kind: string;
  rules: Record<string, RoutingRule>;
  runtimes: RuntimeCandidate[];
  override?: string | null;
  repo?: string | null;
}): RoutingDecision {
  const { kind, rules, runtimes, override, repo } = params;
  const hasRepo = (r: RuntimeCandidate) => !repo || kind !== 'code' || r.repos === undefined || r.repos.includes(repo);
  if (override) {
    const rt = runtimes.find((r) => r.name === override);
    if (rt && !hasRepo(rt)) return { runtime: null, reason: `手动指定的 ${override} 没有登记仓库 ${repo}`, missingLabels: [`repo:${repo}`] };
    if (rt && rt.online) return { runtime: override, reason: `手动覆盖 runtime=${override}` };
    return { runtime: override, reason: `手动覆盖 runtime=${override}（当前离线，排队等待）` };
  }
  const rule = rules[kind] ?? { require: [] };
  const online = runtimes.filter((r) => r.online);
  const labeled = online.filter((r) => rule.require.every((l) => r.labels.includes(l)));
  const candidates = labeled.filter(hasRepo);
  if (labeled.length > 0 && candidates.length === 0) {
    return { runtime: null, reason: `routing: ${kind} → 在线 runtime 都没有登记仓库 ${repo}`, missingLabels: [`repo:${repo}`] };
  }
  if (candidates.length === 0) {
    const need = rule.require.length ? ` require ${rule.require.join(',')}` : '';
    return { runtime: null, reason: `routing: ${kind} →${need} → 无在线候选`, missingLabels: rule.require };
  }
  if (rule.prefer) {
    const p = candidates.find((r) => r.name === rule.prefer);
    if (p) return { runtime: p.name, reason: `routing: ${kind} → require ${rule.require.join(',') || '-'} → prefer ${p.name}` };
  }
  const sorted = [...candidates].sort((a, b) => a.runningSessions - b.runningSessions || a.name.localeCompare(b.name));
  const pick = sorted[0]!;
  return { runtime: pick.name, reason: `routing: ${kind} → require ${rule.require.join(',') || '-'} → 会话最少 ${pick.name}` };
}

/** 任务类型 → 路由类别（analysis 与 code 共用 code 规则以外的默认） */
export function routingCategory(kind: string): string {
  if (kind === 'code' || kind === 'review' || kind === 'pr' || kind === 'branch') return 'code';
  if (kind === 'analysis') return 'analysis';
  return 'text';
}
