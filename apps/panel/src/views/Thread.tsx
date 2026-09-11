import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, STATE_LABEL, PATH_LABEL, fmtTime } from '../api';
import { navigate } from '../app';
import { MessageRow } from './Message';

/** 线程视图（S01/S03/S07）：任务消息流 + 右栏任务详情 */
export function ThreadView({ channel, taskKey, rev }: { channel: string; taskKey: string; rev: number }) {
  const [task, setTask] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, m] = await Promise.all([api(`/api/tasks/${taskKey}`), api(`/api/tasks/${taskKey}/messages?limit=200`)]);
      setTask(t); setMessages(m.items ?? []); setErr('');
    } catch (e) { setErr(String((e as Error).message)); }
  }, [taskKey]);
  useEffect(() => { void load(); }, [rev, load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); }
    catch (e) { setErr(e instanceof ApiError ? `${e.code}：${e.message}` : String((e as Error).message)); }
    finally { setBusy(false); }
  };
  const send = () => text.trim() && run(async () => { await api(`/api/tasks/${taskKey}/messages`, { method: 'POST', body: { text } }); setText(''); });
  const showLogs = async (sessionId: string) => {
    try { const r = await api(`/api/sessions/${sessionId}/logs?limit=400`); setLogs(r.lines ?? []); }
    catch (e) { setErr(e instanceof ApiError ? `${e.code}：${e.message}` : String((e as Error).message)); }
  };

  const s = task?.currentSession;
  return (
    <>
      <main className="main">
        <div className="head">
          <button className="ghost" style={{ fontSize: 12 }} onClick={() => navigate(`/c/${channel}`)}>← # {channel}</button>
          <h1><span className="mono">{taskKey}</span> · {task?.title ?? ''}</h1>
          <span className="tag">{STATE_LABEL[task?.state] ?? task?.state}</span>
          {task?.path && <span className="tag">{PATH_LABEL[task.path] ?? task.path}</span>}
          {task?.queueReason && <span className="tag warn">{task.queueReason}</span>}
          <div className="row" style={{ marginLeft: 'auto' }}>
            {task?.state === 'paused'
              ? <button disabled={busy} onClick={() => run(() => api(`/api/tasks/${taskKey}/resume`, { method: 'POST' }))}>恢复</button>
              : <button disabled={busy} onClick={() => run(() => api(`/api/tasks/${taskKey}/pause`, { method: 'POST' }))}>暂停</button>}
            {task?.artifacts?.some((a: any) => a.kind === 'doc') && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/tasks/${taskKey}/implement`, { method: 'POST' }))}>按方案实现</button>}
          </div>
        </div>
        <div className="scroll">
          {err && <div className="banner">{err}</div>}
          {messages.map((m) => <MessageRow key={m.id} m={m} />)}
          {!messages.length && <div className="empty">还没有消息</div>}
          {logs && <div className="card"><h3>会话日志 {logs.length} 行 <button className="ghost" style={{ marginLeft: 'auto', fontSize: 12 }} onClick={() => setLogs(null)}>收起</button></h3><pre>{logs.join('\n')}</pre></div>}
        </div>
        <div className="composer">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && send()} placeholder={task?.openQuestion ? '回答 agent 的问题' : '追加消息，会送入会话'} />
          <button className="primary" onClick={send} disabled={busy || !text.trim()}>发送</button>
        </div>
      </main>
      <aside className="aside">
        <div className="sec"><h4>任务</h4>
          <table><tbody>
            <tr><td>状态</td><td>{STATE_LABEL[task?.state] ?? task?.state}</td></tr>
            <tr><td>来源</td><td>{task?.source?.ref}{task?.source?.url ? <> · <a href={task.source.url} target="_blank" rel="noreferrer">打开</a></> : null}</td></tr>
            <tr><td>仓库</td><td>{task?.repo?.name ?? '待确认'} <span className="meta">{task?.repo?.source}</span></td></tr>
            <tr><td>runtime</td><td>{task?.runtime ?? '-'} · {task?.agent ?? '-'}</td></tr>
            {task?.prUrl && <tr><td>PR</td><td><a href={task.prUrl} target="_blank" rel="noreferrer">打开</a></td></tr>}
          </tbody></table>
        </div>
        {task?.triageCard && (
          <div className="sec"><h4>分流卡</h4>
            <div className="meta">{PATH_LABEL[task.triageCard.tier] ?? task.triageCard.tier} · {task.triageCard.effort} · {task.triageCard.degraded ? '降级' : '完整'}</div>
            <div>{task.triageCard.suggestedPath}</div>
            {!!task.triageCard.codeLocations?.length && <details><summary>代码定位 {task.triageCard.codeLocations.length} 处</summary><pre>{task.triageCard.codeLocations.map((l: any) => `${l.file}${l.line ? ':' + l.line : ''}`).join('\n')}</pre></details>}
          </div>
        )}
        {task?.contextPack && (
          <div className="sec"><h4>上下文包</h4>
            <details><summary>{task.contextPack.summary?.slice(0, 60) || '需求原文'}{task.contextPack.partial ? '（不完整）' : ''}</summary>
              <pre>{task.contextPack.sourceText}</pre>
              {task.contextPack.jira && <pre>{JSON.stringify(task.contextPack.jira, null, 2)}</pre>}
              {task.contextPack.planDoc && <pre>{task.contextPack.planDoc}</pre>}
            </details>
          </div>
        )}
        {!!task?.children?.length && (
          <div className="sec"><h4>任务树</h4>
            {task.children.map((c: any) => (
              <button key={c.key} className="navitem" onClick={() => navigate(`/c/${c.channel}/t/${c.key}`)}>
                <span className="mono">{c.key}</span><span>{c.kind}</span>
                <span className="count" style={{ background: 'var(--sub)', color: 'var(--muted)' }}>{STATE_LABEL[c.state] ?? c.state}</span>
              </button>
            ))}
          </div>
        )}
        <div className="sec"><h4>会话与 runtime</h4>
          {!task?.sessions?.length && <div className="meta">还没有会话</div>}
          {(task?.sessions ?? []).map((x: any) => (
            <div key={x.id} className="card" style={{ padding: '8px 10px', marginBottom: 8 }}>
              <div className="row"><span className={`dot ${x.state === 'running' ? 'on' : x.state === 'failed' ? 'off' : ''}`} />
                <span className="mono">{x.runtime ?? task.runtime} · {x.agent} · {String(x.id).slice(0, 6)}</span>
                <span className="tag">{x.kind}</span><span className="tag">{x.state}</span></div>
              {x.worktreePath && <div className="meta mono">{x.worktreePath}</div>}
              <div className="row end" style={{ marginTop: 6 }}>
                <button className="ghost" style={{ fontSize: 12 }} onClick={() => showLogs(x.id)}>展开日志</button>
                {['running', 'waiting_input'].includes(x.state) && <button className="ghost danger" style={{ fontSize: 12 }} onClick={() => run(() => api(`/api/sessions/${x.id}/stop`, { method: 'POST' }))}>停止</button>}
              </div>
            </div>
          ))}
        </div>
        {!!task?.artifacts?.length && (
          <div className="sec"><h4>产物</h4>
            {task.artifacts.map((a: any) => <div key={a.id} className="meta">{a.kind} · {a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.title ?? a.url}</a> : a.path ?? a.branch}</div>)}
          </div>
        )}
        {!!task?.pendingApprovals?.length && (
          <div className="sec"><h4>待处理审批</h4>
            {task.pendingApprovals.map((a: any) => <div key={a.key} className="meta"><span className="tag">{a.key}</span> {a.title}</div>)}
          </div>
        )}
      </aside>
    </>
  );
}
