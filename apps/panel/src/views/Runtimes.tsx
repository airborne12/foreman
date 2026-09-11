import { useCallback, useEffect, useState } from 'react';
import { api, fmtTime } from '../api';

/** 状态视图（S05）：runtime、会话、来源健康度、隧道 */
export function Runtimes({ rev }: { rev: number }) {
  const [rts, setRts] = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [tunnels, setTunnels] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [r, s, t] = await Promise.all([api('/api/runtimes'), api('/api/system/sources'), api('/api/system/tunnels').catch(() => ({ items: [] }))]);
      setRts(r.items ?? []); setSources(s.items ?? []); setTunnels(t.items ?? []); setErr('');
    } catch (e) { setErr(String((e as Error).message)); }
  }, []);
  useEffect(() => { void load(); }, [rev, load]);

  return (
    <>
      <main className="main">
        <div className="head"><h1>状态</h1><span className="sub">{rts.filter((r) => r.online).length}/{rts.length} 个 runtime 在线</span></div>
        <div className="scroll">
          {err && <div className="banner">{err}</div>}
          <table>
            <thead><tr><th></th><th>runtime</th><th>transport</th><th>标签</th><th>会话</th><th>磁盘</th><th>版本</th><th>最近心跳</th></tr></thead>
            <tbody>
              {rts.map((r) => (
                <tr key={r.name} onClick={() => api(`/api/runtimes/${r.name}`).then(setDetail).catch(() => {})} style={{ cursor: 'pointer' }}>
                  <td><span className={`dot ${r.online ? 'on' : 'off'}`} /></td>
                  <td className="mono">{r.name}</td><td>{r.transport}</td>
                  <td>{(r.labels ?? []).map((l: string) => <span key={l} className="tag" style={{ marginRight: 4 }}>{l}</span>)}</td>
                  <td>{r.sessions}/{r.maxSessions}</td>
                  <td>{r.diskUsedRatio == null ? '-' : `${Math.round(r.diskUsedRatio * 100)}%`}</td>
                  <td>{r.workerVersion ?? '-'}</td><td className="meta">{fmtTime(r.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rts.length && <div className="empty">还没有 runtime 接入</div>}
          <h4 style={{ marginTop: 20 }}>来源健康度</h4>
          <table><thead><tr><th>来源</th><th>状态</th><th>最近成功</th><th>连续失败</th><th>执行在</th></tr></thead>
            <tbody>{sources.map((s) => <tr key={s.source}><td>{s.source}</td><td><span className={`tag ${s.status === 'ok' ? 'ok' : s.status === 'disabled' ? '' : 'bad'}`}>{s.status}</span></td><td className="meta">{fmtTime(s.lastSuccessAt)}</td><td>{s.consecutiveFailures}</td><td className="mono">{s.executedOn ?? '-'}</td></tr>)}</tbody>
          </table>
          {!!tunnels.length && <>
            <h4 style={{ marginTop: 20 }}>反向隧道</h4>
            <table><thead><tr><th>名称</th><th>状态</th><th>重连</th><th>起始</th><th>最近错误</th></tr></thead>
              <tbody>{tunnels.map((t) => <tr key={t.name}><td className="mono">{t.name}</td><td><span className={`tag ${t.state === 'up' ? 'ok' : 'bad'}`}>{t.state}</span></td><td>{t.reconnects}</td><td className="meta">{fmtTime(t.since)}</td><td className="meta">{t.lastError ?? '-'}</td></tr>)}</tbody>
            </table>
          </>}
        </div>
      </main>
      <aside className="aside">
        {!detail && <div className="meta">点一行看 runtime 详情</div>}
        {detail && (
          <>
            <div className="sec"><h4>{detail.name}</h4>
              <table><tbody>
                <tr><td>在线</td><td>{detail.online ? '是' : '否'}</td></tr>
                <tr><td>agent</td><td>{Object.entries(detail.agents ?? {}).map(([k, v]: any) => `${k} ${v.running}/${v.max}`).join(' · ')}</td></tr>
                <tr><td>可回收 worktree</td><td>{detail.reclaimableWorktrees?.count ?? 0} 个</td></tr>
              </tbody></table>
            </div>
            {!!detail.repos?.length && <div className="sec"><h4>仓库</h4>{detail.repos.map((r: any) => <div key={r.name} className="meta mono">{r.name} → {r.worktreeRoot}</div>)}</div>}
            {!!detail.activeSessions?.length && <div className="sec"><h4>活跃会话</h4>{detail.activeSessions.map((s: any) => <div key={s.id} className="meta mono">{s.taskKey ?? '—'} · {s.agent} · {s.state}</div>)}</div>}
            {!!detail.warnings?.length && <div className="sec"><h4>告警</h4>{detail.warnings.map((w: any) => <div key={w.code} className="banner">{w.code} × {w.count}</div>)}</div>}
          </>
        )}
      </aside>
    </>
  );
}
