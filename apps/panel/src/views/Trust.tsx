import { useCallback, useEffect, useState } from 'react';
import { api, errText, ACTION_LABEL } from '../api';
import type { Shared } from '../app';
import { Btn, Icon, Time, useToast } from '../ui';

/** 信任视图（S06 §2.2）：动作类型 × 连续确认进度 × 模式 */
export function Trust({ shared }: { shared: Shared }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const toast = useToast();
  const load = useCallback(async () => {
    try { setData(await api('/api/trust')); setErr(''); } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [shared.rev, load]);

  const reset = async (t: string) => {
    setBusy(t);
    try { await api(`/api/trust/${t}/reset`, { method: 'POST' }); toast('ok', `${ACTION_LABEL[t] ?? t} 已回到人工确认`); await load(); }
    catch (e) { toast('bad', errText(e)); } finally { setBusy(''); }
  };

  const counters: any[] = [...(data?.counters ?? [])].sort((a, b) => (b.mode === 'auto' ? 1 : 0) - (a.mode === 'auto' ? 1 : 0) || b.streak - a.streak);
  const weeks: any[] = data?.weeklyConfirmations ?? [];
  const maxWeek = Math.max(1, ...weeks.map((w) => w.count));
  return (
    <div className="content">
      <div className="pane">
        <div className="pane-head">
          <h1><Icon name="shield" />信任</h1>
          <span className="sub">同一类动作连续 {data?.threshold ?? 5} 次原样确认后自动执行；修改后确认不计数，否决清零</span>
        </div>
        <div className="pane-body">
          {err && <div className="callout bad" style={{ marginBottom: 14 }}><Icon name="alert" />{err}</div>}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>动作</th><th>模式</th><th style={{ width: '28%' }}>连续原样确认</th><th>7 天自动执行</th><th>最近否决</th><th /></tr></thead>
              <tbody>
                {counters.map((c) => (
                  <tr key={c.actionType}>
                    <td><div style={{ fontWeight: 550 }}>{ACTION_LABEL[c.actionType] ?? c.actionType}</div></td>
                    <td><span className={`badge ${c.mode === 'auto' ? 'go' : c.mode === 'locked' ? 'warn' : ''}`}>{c.mode === 'auto' ? '自动执行' : c.mode === 'locked' ? '锁定人工' : '人工确认'}</span></td>
                    <td>
                      {c.mode === 'locked' ? <span className="small muted">永不自动</span> : (
                        <div className="row" style={{ flexWrap: 'nowrap' }}>
                          <div className={`meter ${c.mode === 'auto' ? 'go' : ''}`} style={{ flex: 1 }}><span style={{ width: `${Math.min(100, (c.streak / c.threshold) * 100)}%` }} /></div>
                          <span className="small muted" style={{ width: 36, textAlign: 'right' }}>{c.streak}/{c.threshold}</span>
                        </div>
                      )}
                    </td>
                    <td>{c.autoExecutions7d || <span className="muted">0</span>}</td>
                    <td className="small muted">{c.lastRejectedAt ? <Time iso={c.lastRejectedAt} /> : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{c.mode === 'auto' && <Btn className="sm" busy={busy === c.actionType} onClick={() => reset(c.actionType)}>回到人工</Btn>}</td>
                  </tr>
                ))}
                {data && !counters.length && <tr><td colSpan={6} className="muted">还没有记录</td></tr>}
              </tbody>
            </table>
          </div>
          {!!weeks.length && (
            <>
              <div className="section-title" style={{ marginTop: 24 }}>近 4 周人工确认次数</div>
              <div className="card row" style={{ alignItems: 'flex-end', gap: 18, height: 140 }}>
                {weeks.map((w) => (
                  <div key={w.weekStart} className="stack" style={{ alignItems: 'center', gap: 6, flex: 1, height: '100%', justifyContent: 'flex-end' }}>
                    <span className="small">{w.count}</span>
                    <div style={{ width: '60%', maxWidth: 48, height: `${(w.count / maxWeek) * 70}%`, minHeight: 3, background: 'var(--accent)', borderRadius: 4 }} />
                    <span className="small muted mono">{String(w.weekStart).slice(5)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
