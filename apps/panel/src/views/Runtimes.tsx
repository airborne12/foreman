import { useCallback, useEffect, useState } from 'react';
import { api, errText, SESSION_KIND_LABEL, SESSION_STATE_LABEL } from '../api';
import { navigate, type Shared } from '../app';
import { Btn, Empty, Icon, Time } from '../ui';

const SOURCE_LABEL: Record<string, string> = { jira: 'Jira 轮询', feishu: '飞书', github: 'GitHub' };
const SOURCE_STATUS: Record<string, [string, string]> = { ok: ['正常', 'go'], disabled: ['未启用', ''], unreachable: ['不可达', 'bad'], degraded: ['降级', 'warn'] };

/** 状态视图（S05）：runtime 卡片、来源健康度、隧道 */
export function Runtimes({ shared }: { shared: Shared }) {
  const rts = shared.runtimes;
  const [sources, setSources] = useState<any[]>([]);
  const [detail, setDetail] = useState<Record<string, any>>({});
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await api('/api/system/sources');
      setSources(s.items ?? []); setErr('');
      const ds = await Promise.all(shared.runtimes.map((r) => api(`/api/runtimes/${r.name}`).catch(() => null)));
      setDetail(Object.fromEntries(ds.filter(Boolean).map((d: any) => [d.name, d])));
    } catch (e) { setErr(errText(e)); }
  }, [shared.runtimes]);
  useEffect(() => { void load(); }, [shared.rev, load]);

  const online = rts.filter((r) => r.online).length;
  return (
    <div className="content">
      <div className="pane">
        <div className="pane-head">
          <h1><Icon name="activity" />状态</h1>
          <span className="sub">{rts.length ? `${online}/${rts.length} 个 runtime 在线` : ''}</span>
        </div>
        <div className="pane-body">
          {err && <div className="callout bad" style={{ marginBottom: 14 }}><Icon name="alert" />{err}</div>}
          <div className="section-title"><Icon name="server" size="sm" />runtime</div>
          {!rts.length && <Empty icon="server" title="还没有 runtime 接入"><div className="small">在开发机上装 worker 并执行 <span className="mono">foreman worker start</span></div></Empty>}
          <div className="grid-cards">
            {rts.map((r) => {
              const d = detail[r.name];
              const disk = r.diskUsedRatio == null ? null : Math.round(r.diskUsedRatio * 100);
              return (
                <div key={r.name} className="card stack" style={{ gap: 12 }}>
                  <div className="row between">
                    <span className="row"><span className={`dot ${r.online ? 'on' : 'off'}`} /><b className="mono" style={{ fontSize: 15 }}>{r.name}</b></span>
                    <span className={`badge ${r.online ? 'go' : 'bad'}`}>{r.online ? '在线' : '离线'}</span>
                  </div>
                  <dl className="kv small">
                    <dt>接入</dt><dd>{r.transport === 'reverse-tunnel' ? '反向隧道' : r.transport === 'local' ? '中心机本地' : '直连'}{r.tunnel && r.online ? '' : r.tunnel ? `（隧道 ${r.tunnel.state}）` : ''}</dd>
                    <dt>心跳</dt><dd><Time iso={r.lastSeenAt} /></dd>
                    <dt>版本</dt><dd className="mono">{r.workerVersion ?? '-'}</dd>
                    <dt>仓库</dt><dd>{(r.repos ?? []).length ? (r.repos as string[]).map((x) => <div key={x} className="mono">{x}</div>) : <span className="muted">没有登记仓库（只接文本任务）</span>}</dd>
                  </dl>
                  <div className="stack" style={{ gap: 8 }}>
                    {Object.entries(r.agents ?? {}).map(([a, v]: [string, any]) => (
                      <div key={a} className="row" style={{ flexWrap: 'nowrap' }}>
                        <span className="small" style={{ width: 64 }}>{a}</span>
                        <div className={`meter ${v.running >= v.max ? 'warn' : ''}`} style={{ flex: 1 }}><span style={{ width: `${v.max ? Math.min(100, (v.running / v.max) * 100) : 0}%` }} /></div>
                        <span className="small muted" style={{ width: 44, textAlign: 'right' }}>{v.running}/{v.max}</span>
                      </div>
                    ))}
                    {disk != null && (
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <span className="small" style={{ width: 64 }}>磁盘</span>
                        <div className={`meter ${disk >= 85 ? 'bad' : disk >= 70 ? 'warn' : 'go'}`} style={{ flex: 1 }}><span style={{ width: `${disk}%` }} /></div>
                        <span className="small muted" style={{ width: 44, textAlign: 'right' }}>{disk}%</span>
                      </div>
                    )}
                  </div>
                  <div className="chips">{(r.labels ?? []).map((l: string) => <span key={l} className="chip static mono" style={{ minHeight: 24, fontSize: 11.5 }}>{l}</span>)}</div>
                  {!!d?.activeSessions?.length && (
                    <div>
                      <div className="small muted" style={{ marginBottom: 4 }}>活跃会话</div>
                      {d.activeSessions.map((s: any) => (
                        <button key={s.id} className="thread-row" onClick={() => s.taskKey && navigate(`/c/${s.channel ?? 'jira'}/t/${s.taskKey}`)} disabled={!s.taskKey}>
                          <span className="k">{s.taskKey ?? '频道'}</span><span className="ttl small">{s.kind ? `${SESSION_KIND_LABEL[s.kind] ?? s.kind} · ` : s.taskKey ? '' : '调度员 · '}{s.agent}</span><span className="small muted">{SESSION_STATE_LABEL[s.state] ?? s.state}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {!!d?.warnings?.length && d.warnings.map((w: any) => <div key={w.code} className="callout warn small"><Icon name="alert" size="sm" />{w.code} × {w.count}</div>)}
                  {d?.reclaimableWorktrees?.count > 0 && <div className="small muted">{d.reclaimableWorktrees.count} 个 worktree 可回收</div>}
                </div>
              );
            })}
          </div>

          <div className="section-title" style={{ marginTop: 26 }}><Icon name="refresh" size="sm" />来源</div>
          <div className="grid-cards">
            {sources.map((s) => {
              const [label, tone] = SOURCE_STATUS[s.status] ?? [s.status, 'warn'];
              return (
                <div key={s.source} className="card">
                  <div className="row between" style={{ marginBottom: 8 }}><b>{SOURCE_LABEL[s.source] ?? s.source}</b><span className={`badge ${tone}`}>{label}</span></div>
                  <dl className="kv small">
                    <dt>最近成功</dt><dd>{s.lastSuccessAt ? <Time iso={s.lastSuccessAt} /> : '-'}</dd>
                    <dt>执行在</dt><dd className="mono">{s.executedOn ?? '-'}</dd>
                    {s.consecutiveFailures > 0 && <><dt>连续失败</dt><dd style={{ color: 'var(--bad-text)' }}>{s.consecutiveFailures} 次</dd></>}
                    {s.lastError && <><dt>最近错误</dt><dd className="small">{s.lastError}</dd></>}
                  </dl>
                </div>
              );
            })}
          </div>
          <div className="row end" style={{ marginTop: 16 }}><Btn className="ghost sm" icon="refresh" onClick={() => void shared.reload()}>刷新</Btn></div>
        </div>
      </div>
    </div>
  );
}
