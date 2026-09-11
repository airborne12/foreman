import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, STATE_LABEL, fmtTime } from '../api';
import { navigate } from '../app';
import { MessageRow } from './Message';

/** 频道视图（S04）：消息流 + 线程列表 + 口语/斜杠命令输入框 */
export function ChannelView({ slug, rev }: { slug: string; rev: number }) {
  const [channel, setChannel] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [threads, setThreads] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, m, t] = await Promise.all([api(`/api/channels/${slug}`), api(`/api/channels/${slug}/messages?limit=200`), api(`/api/channels/${slug}/threads`)]);
      setChannel(c); setMessages(m.items ?? []); setThreads(t.items ?? []); setErr('');
    } catch (e) { setErr(String((e as Error).message)); }
  }, [slug]);
  useEffect(() => { void load(); }, [rev, load]);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr(''); setHint('');
    try {
      const r = await api(`/api/channels/${slug}/messages`, { method: 'POST', body: { text } });
      setText('');
      if (r.handling === 'unavailable') setHint(`调度员不可用，可用：${r.hint}`);
      if (r.handling === 'dispatcher') setHint('已交给调度员');
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}：${e.message}${e.details?.command ? `（/${e.details.command}）` : ''}` : String((e as Error).message));
    } finally { setBusy(false); }
  };
  const draft = async (id: string, action: 'confirm' | 'cancel') => {
    try { await api(`/api/drafts/${id}/${action}`, { method: 'POST' }); await load(); }
    catch (e) { setErr(e instanceof ApiError ? `${e.code}：${e.message}` : String((e as Error).message)); }
  };

  return (
    <>
      <main className="main">
        <div className="head">
          <h1># {slug}</h1>
          <span className="sub">{channel?.title}</span>
          {channel?.dispatcher && <span className="tag">{`调度员 ${channel.dispatcher.agent} · ${channel.dispatcher.state}`}</span>}
        </div>
        <div className="scroll">
          {err && <div className="banner">{err}</div>}
          {hint && <div className="banner">{hint}</div>}
          {!messages.length && <div className="empty">频道还没有消息。说一句话交给调度员，或用 /task new 直接建草案。</div>}
          {messages.map((m) => <MessageRow key={m.id} m={m} onDraft={draft} />)}
        </div>
        <div className="composer">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && send()} placeholder="口语派活，或 /task new --source CIR-1 --repo a/b --path fix" />
          <button className="primary" onClick={send} disabled={busy || !text.trim()}>发送</button>
        </div>
      </main>
      <aside className="aside">
        <div className="sec"><h4>频道概况</h4>
          <table><tbody>
            <tr><td>进行中任务</td><td>{channel?.activeTasks ?? 0}</td></tr>
            <tr><td>待拍板</td><td>{channel?.pendingApprovals ?? 0}</td></tr>
            <tr><td>调度员</td><td>{channel?.dispatcher ? `${channel.dispatcher.agent} · ${channel.dispatcher.state}` : '未拉起'}</td></tr>
          </tbody></table>
        </div>
        <div className="sec"><h4>线程 {threads.length}</h4>
          {threads.map((t) => (
            <button key={t.key} className="navitem" onClick={() => navigate(`/c/${slug}/t/${t.key}`)}>
              <span className="mono">{t.key}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
              <span className="count" style={{ background: 'var(--sub)', color: 'var(--muted)' }}>{STATE_LABEL[t.state] ?? t.state}</span>
            </button>
          ))}
          {!threads.length && <div className="meta">还没有线程</div>}
        </div>
      </aside>
    </>
  );
}
