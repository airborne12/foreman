import { useEffect, useState } from 'react';
import { cleanTitle, STATE_TONE } from '../api';
import { navigate } from '../app';
import { Icon, PrioBadge, Time } from '../ui';

export type TreeNode = {
  key: string; parentKey?: string | null; title: string; state: string; kind: string; channel: string;
  source?: { ref?: string }; priority?: string | null; children: TreeNode[];
  groupState: string; groupLabel: string; active: boolean; attentionCount: number; latestActivityAt: string;
};

/** 根据真实树关系导航；编号可以独立于父任务编号。 */
export function taskTrail(node: TreeNode, key: string): TreeNode[] {
  if (node.key === key) return [node];
  for (const child of node.children) {
    const path = taskTrail(child, key);
    if (path.length) return [node, ...path];
  }
  return [];
}

export function GroupBadge({ node }: { node: TreeNode }) {
  return <span className={`badge ${STATE_TONE[node.groupState] ?? ''}`}>{node.groupLabel}</span>;
}

/** 普通嵌套列表保留浏览器按钮的键盘导航，展开与打开详情分别操作。 */
export function TaskTree({ roots, selected, search = '' }: { roots: TreeNode[]; selected?: string; search?: string }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!selected) return;
    const path = roots.flatMap((root) => taskTrail(root, selected)).slice(0, -1);
    setExpanded((prev) => {
      const next = { ...prev }; let changed = false;
      for (const node of path) if (next[node.key] === false) { delete next[node.key]; changed = true; }
      return changed ? next : prev;
    });
  // 只在切换当前任务时展开所属路径，实时刷新保留用户的折叠选择。
  }, [selected]);
  const query = search.trim().toLocaleLowerCase();
  const ownMatch = (n: TreeNode) => `${n.key} ${n.title} ${n.source?.ref ?? ''}`.toLocaleLowerCase().includes(query);
  const matches = (n: TreeNode): boolean => !query || ownMatch(n) || n.children.some(matches);
  const render = (n: TreeNode, depth: number, keepAll = false) => {
    if (!keepAll && !matches(n)) return null;
    const selectedPath = selected ? taskTrail(n, selected).length > 0 : false;
    const expansionKey = query ? `${query}:${n.key}` : n.key;
    const open = expanded[expansionKey] ?? (!!query || selectedPath || n.attentionCount > 0 || depth === 0 && n.children.some((c) => c.active));
    const title = n.kind === 'review' ? '代码审查' : cleanTitle(n.title, n.source?.ref);
    return <li key={n.key}>
      <div className={`task-tree-row${selected === n.key ? ' selected' : ''}`} style={{ paddingLeft: Math.min(depth, 5) * 14 }}>
        {n.children.length ? <button className="tree-toggle" aria-label={`${open ? '折叠' : '展开'} ${n.key} 子任务`} aria-expanded={open} onClick={() => setExpanded((prev) => ({ ...prev, [expansionKey]: !open }))}><Icon name={open ? 'chevronDown' : 'chevronRight'} size="sm" /></button> : <span className="tree-toggle-spacer" />}
        <button className="task-tree-link" aria-current={selected === n.key ? 'page' : undefined} onClick={() => navigate(`/c/${n.channel}/t/${n.key}`)} title={n.title}>
          <span className="tree-heading"><span className="mono small muted">{n.key}</span><GroupBadge node={n} /></span>
          <span className="tree-title">{title}</span>
          <span className="tree-meta">
            {depth === 0 && n.source?.ref && <span className="ellipsis">{n.source.ref}</span>}
            <PrioBadge priority={n.priority} />
            {n.children.length > 0 && <span>{n.children.length} 个子任务</span>}
            {n.attentionCount > 0 && <span className="tree-attention">待处理 {n.attentionCount}</span>}
            <Time iso={n.latestActivityAt} />
          </span>
        </button>
      </div>
      {open && n.children.length > 0 && <ul className="task-tree-children">{n.children.map((child) => render(child, depth + 1, keepAll || !!query && ownMatch(n)))}</ul>}
    </li>;
  };
  return <ul className="task-tree" aria-label="任务树">{roots.map((root) => render(root, 0))}</ul>;
}
