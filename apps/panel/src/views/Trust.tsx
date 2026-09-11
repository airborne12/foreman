import { useCallback, useEffect, useState } from 'react';
import { api, ACTION_LABEL, fmtTime } from '../api';

/** 信任视图（S06 §2.2）：动作类型 × 计数 × 状态 */
export function Trust({ rev }: { rev: number }) {
  const [data, setData] = useState<any>({ counters: [], weeklyConfirmations: [], threshold: 5 });
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { setData(await api('/api/trust')); setErr(''); } catch (e) { setErr(String((e as Error).message)); }
  }, []);
  useEffect(() => { void load(); }, [rev, load]);

  const reset = async (t: string) => {
    try { await api(`/api/trust/${t}/reset`, { method: 'POST' }); await load(); }
    catch (e) { setErr(String((e as Error).message)); }
  };

  return (
    <>
      <main className="main">
        <div className="head"><h1>信任</h1><span className="sub">连续 {data.threshold} 次原样确认后自动执行</span></div>
        <div className="scroll">
          {err && <div className="banner">{err}</div>}
          <table>
            <thead><tr><th>动作类型</th><th>模式</th><th>连续确认</th><th>7 天自动执行</th><th>最近否决</th><th></th></tr></thead>
            <tbody>
              {(data.counters ?? []).map((c: any) => (
                <tr key={c.actionType}>
                  <td>{ACTION_LABEL[c.actionType] ?? c.actionType} <span className="meta mono">{c.actionType}</span></td>
                  <td><span className={`tag ${c.mode === 'auto' ? 'ok' : c.mode === 'locked' ? 'warn' : ''}`}>{c.mode === 'auto' ? '自动' : c.mode === 'locked' ? '锁定人工' : '人工'}</span></td>
                  <td>{c.streak}/{c.threshold}</td>
                  <td>{c.autoExecutions7d}</td>
                  <td className="meta">{fmtTime(c.lastRejectedAt)}</td>
                  <td><button disabled={c.mode === 'locked'} onClick={() => reset(c.actionType)}>重置为人工</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
      <aside className="aside">
        <div className="sec"><h4>近 4 周人工确认数</h4>
          <table><tbody>{(data.weeklyConfirmations ?? []).map((w: any) => <tr key={w.weekStart}><td className="mono">{w.weekStart}</td><td>{w.count}</td></tr>)}</tbody></table>
        </div>
        <div className="sec"><h4>说明</h4><div className="meta">修改后确认不计数；否决清零并回到人工。合入 release 与 Jira 转完成锁定人工，永不自动。</div></div>
      </aside>
    </>
  );
}
