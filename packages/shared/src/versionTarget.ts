/**
 * Jira「影响版本」→ 仓库与基线分支（2026-09-30）。
 *
 * 之前平台只取修复版本（几乎没人填），代码定位 agent 看不到版本，照提示词里的示例把基线猜成
 * branch-selectdb-doris-4.1。版本命名是确定的规则，由平台直接算，不交给 agent 猜：
 * - 纯数字 X.Y.Z / doris-X.Y.Z：Apache Doris 开源版 → apache/doris，基线 master，pick 到 branch-X.Y（社区惯例先合 master）
 * - enter-X.Y.Z / selectdb-X.Y.Z：SelectDB 企业版 → selectdb-core 的 branch-selectdb-doris-X.Y
 * - cloud-*：SelectDB Cloud，按内核版本走 selectdb-core：cloud-4.0 = doris 3.0（selectdb-cloud-4.0 线），
 *   cloud-4.1 = doris 3.1，cloud-26.1 = doris 4.1；26.1.x 不带前缀的也按 cloud 算
 * 规则可在 center.yaml 的 sources.jira.version_rules 覆盖；都匹配不上时交回 agent 判断。
 */
export interface VersionRule {
  /** 正则（不区分大小写），捕获组可在 base / pick 里用 $1、$2 引用 */
  match: string;
  repo: string;
  base: string;
  pick?: string[];
}

export interface VersionTarget {
  repo: string;
  baseBranch: string;
  pickTargets: string[];
  /** 参与计算的影响版本（匹配上规则的） */
  versions: string[];
  /** 没有匹配规则的版本，留给人看 */
  unmatched: string[];
}

const CORE = 'selectdb/selectdb-core';
const DORIS = 'apache/doris';

export const DEFAULT_VERSION_RULES: VersionRule[] = [
  { match: '^cloud-4\\.0(\\.|$)', repo: CORE, base: 'selectdb-cloud-4.0' },
  { match: '^cloud-4\\.1(\\.|$)', repo: CORE, base: 'branch-selectdb-doris-3.1' },
  { match: '^(cloud-)?26\\.1(\\.|$)', repo: CORE, base: 'branch-selectdb-doris-4.1' },
  { match: '^(?:enter|emter|selectdb)-(\\d+\\.\\d+)(\\.|$)', repo: CORE, base: 'branch-selectdb-doris-$1' },
  // Doris 5.0 还没拉发布分支：只修 master
  { match: '^(doris-)?5\\.0(\\.|$)', repo: DORIS, base: 'master' },
  { match: '^(?:doris-)?([1-9]\\.\\d+)(\\.|$)', repo: DORIS, base: 'master', pick: ['branch-$1'] },
];

function fill(tpl: string, m: RegExpMatchArray) { return tpl.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? ''); }

/** 版本号数字部分，用于挑最高版本（cloud-26.1.3 → [26,1,3]） */
function numeric(v: string): number[] { return (v.match(/\d+/g) ?? []).map(Number); }
function cmpDesc(a: string, b: string) {
  const x = numeric(a); const y = numeric(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] ?? -1) - (x[i] ?? -1); if (d) return d; }
  return 0;
}

/**
 * 多个影响版本：取匹配数最多的仓库（相同时取版本最高者所在仓库）；基线用该仓库里最高版本对应的分支，
 * 其余版本的基线与 pick 合并为 pick 目标。一个都匹配不上返回 null。
 */
export function resolveVersionTarget(versions: string[], rules: VersionRule[] = DEFAULT_VERSION_RULES): VersionTarget | null {
  const hits: Array<{ version: string; repo: string; base: string; pick: string[] }> = [];
  const unmatched: string[] = [];
  for (const raw of versions) {
    const v = raw.trim();
    if (!v) continue;
    let hit = false;
    for (const r of rules) {
      const m = v.match(new RegExp(r.match, 'i'));
      if (!m) continue;
      hits.push({ version: v, repo: r.repo, base: fill(r.base, m), pick: (r.pick ?? []).map((p) => fill(p, m)) });
      hit = true;
      break;
    }
    if (!hit) unmatched.push(v);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => cmpDesc(a.version, b.version));
  const count = new Map<string, number>();
  for (const h of hits) count.set(h.repo, (count.get(h.repo) ?? 0) + 1);
  const repo = [...count.entries()].sort((a, b) => b[1] - a[1] || hits.findIndex((h) => h.repo === a[0]) - hits.findIndex((h) => h.repo === b[0]))[0]![0];
  const mine = hits.filter((h) => h.repo === repo);
  const baseBranch = mine[0]!.base;
  const pickTargets = [...new Set(mine.flatMap((h) => [h.base, ...h.pick]))].filter((b) => b !== baseBranch);
  return { repo, baseBranch, pickTargets, versions: mine.map((h) => h.version), unmatched: [...unmatched, ...hits.filter((h) => h.repo !== repo).map((h) => h.version)] };
}

/**
 * 公开仓库 PR 文案检查：不能有中文（含全角标点），不能带内部 Jira 单号。返回问题清单，空数组表示通过。
 * internalProjects：内部 Jira 项目前缀（如 CIR、CORE、DORIS）。
 */
export function publicPrProblems(text: string, internalProjects: string[]): string[] {
  const out: string[] = [];
  const cjk = text.match(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+/g);
  if (cjk) out.push(`含中文：${[...new Set(cjk)].slice(0, 3).join('、')}`);
  const projects = [...new Set(internalProjects.filter((p) => /^[A-Z][A-Z0-9_]*$/.test(p)))];
  if (projects.length) {
    const keys = text.match(new RegExp(`\\b(?:${projects.join('|')})-\\d+\\b`, 'g'));
    if (keys) out.push(`含内部 Jira 单号：${[...new Set(keys)].slice(0, 3).join('、')}`);
  }
  return out;
}
