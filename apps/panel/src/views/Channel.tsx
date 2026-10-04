import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errText } from '../api';
import { navigate, type Shared } from '../app';
import { AutoTextarea, Btn, Empty, Icon, useToast } from '../ui';
import { MessageRow, type DraftAction } from './Message';
import { TaskTree } from './TaskTree';

const EXAMPLES = ['帮我看下 CIR-123，出个方案', '/task new --source CIR-123 --path fix', '/runtime'];

/** 频道视图（S04）：对话流 + 线程列表 + 口语/斜杠命令输入框 */
export function ChannelView({ slug, shared }: { slug: string; shared: Shared }) {
  const [channel, setChannel] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [threads, setThreads] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [search, setSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [pages, setPages] = useState(1);
  const [totals, setTotals] = useState({ total: 0, activeTotal: 0, allTotal: 0 });
  const [asideOpen, setAsideOpen] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const toast = useToast();
  const feedRef = useRef<HTMLDivElement>(null);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const [c, m, result] = await Promise.all([api(`/api/channels/${slug}`), api(`/api/channels/${slug}/messages?limit=200`), api(`/api/channels/${slug}/threads?activeOnly=${!showDone}&throughPage=${pages}&search=${encodeURIComponent(searchQuery)}`)]);
      if (version !== loadVersion.current) return;
      setChannel(c); setMessages(m.items ?? []); setThreads(result.items ?? []); setTotals(result); setErr(''); setNotFound(false);
    } catch (e) { if (version !== loadVersion.current) return; if (e instanceof ApiError && e.status === 404) setNotFound(true); else setErr(errText(e)); }
  }, [slug, pages, showDone, searchQuery]);
  useEffect(() => { setChannel(null); setMessages([]); setThreads([]); setPages(1); setSearch(''); setSearchQuery(''); }, [slug]);
  useEffect(() => { const timer = setTimeout(() => { setPages(1); setSearchQuery(search); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { void load(); }, [shared.rev, load]);
  useEffect(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages.length]);

  const send = async (t = text) => {
    if (!t.trim()) return;
    setBusy('send'); setErr('');
    try {
      const r = await api(`/api/channels/${slug}/messages`, { method: 'POST', body: { text: t } });
      setText('');
      if (r.handling === 'unavailable') setErr(`调度员暂时不可用，可以改用命令：${r.hint}`);
      await load();
    } catch (e) {
      setErr(errText(e) + (e instanceof ApiError && e.details?.command ? `（/${e.details.command}）` : ''));
    } finally { setBusy(''); }
  };
  const draft = async ({ id, action, force }: DraftAction) => {
    setBusy(`draft:${id}`);
    try {
      const r = await api(`/api/drafts/${id}/${action}`, { method: 'POST', body: action === 'confirm' && force ? { force: true } : undefined });
      toast('ok', action === 'confirm' ? `已创建 ${r.key ?? '任务'}` : '草案已取消');
      await load(); await shared.reload();
    } catch (e) { toast('bad', errText(e)); } finally { setBusy(''); }
  };

  if (notFound) return <div className="content"><div className="pane"><Empty icon="hash" title={`没有 #${slug} 这个频道`}><div className="small">左栏「频道」旁的 + 可以新建</div></Empty></div></div>;

  const d = channel?.dispatcher;
  return (
    <div className="content">
      <div className="pane">
        <div className="pane-head">
          <h1><Icon name="hash" />{slug}</h1>
          {channel?.title && channel.title.toLowerCase() !== slug && <span className="sub">{channel.title}</span>}
          <span className="spacer" />
          <span className="badge" title="调度员负责把口语变成任务草案">
            <span className={`dot ${d?.state === 'running' ? 'on' : d ? 'warn' : ''}`} />{d ? `调度员 ${d.agent}${d.state === 'running' ? ' 在线' : ' 空闲'}` : '调度员未拉起'}
          </span>
          <Btn className="ghost icon sm aside-toggle" icon="list" aria-label="线程列表" onClick={() => setAsideOpen(!asideOpen)} />
        </div>
        <div className="pane-body" ref={feedRef}>
          <div className="feed">
            {!messages.length && channel && (
              <Empty icon="message" title="用一句话派活">
                <div className="small">说清楚要处理哪个单、要什么结果，调度员会起草任务给你确认。也可以用斜杠命令直接建。</div>
                <div className="chips" style={{ justifyContent: 'center', marginTop: 8 }}>
                  {EXAMPLES.map((x) => <button key={x} className="chip" onClick={() => setText(x)}><span className={x.startsWith('/') ? 'mono' : ''}>{x}</span></button>)}
                </div>
              </Empty>
            )}
            {messages.map((m) => <MessageRow key={m.id} m={m} onDraft={draft} onPick={(v) => void send(v)} busy={busy.startsWith('draft:') || busy === 'send'} />)}
          </div>
        </div>
        <div className="composer">
          <div className="composer-inner">
            {err && <div className="err-inline"><Icon name="alert" size="sm" />{err}</div>}
            <div className="composer-box">
              <AutoTextarea value={text} onChange={setText} onSubmit={() => void send()} disabled={busy === 'send'} ariaLabel="派活"
                placeholder="说一句话派活，比如「帮我看下 CIR-123，出个方案」；也可以输入 / 开头的命令" />
              <Btn className="accent sm" icon="send" busy={busy === 'send'} disabled={!text.trim()} onClick={() => void send()}>发送</Btn>
            </div>
            <div className="hint-row"><span className="kbd">Enter</span>发送<span className="kbd">Shift</span>+<span className="kbd">Enter</span>换行<span className="mono">/task new</span>直接建草案</div>
          </div>
        </div>
      </div>
      <aside className={`aside${asideOpen ? ' open' : ''}`} aria-label="线程">
        <div className="aside-sec">
          <div className="row between" style={{ marginBottom: 8 }}>
            <h4 style={{ margin: 0 }}>任务树 · 进行中 {totals.activeTotal}</h4>
            <span className="row" style={{ gap: 4 }}>
              {(showDone || totals.allTotal > totals.activeTotal) && <Btn className="ghost sm" onClick={() => { setPages(1); setShowDone(!showDone); }}>{showDone ? '只看进行中' : `含已交付 ${totals.allTotal - totals.activeTotal}`}</Btn>}
              {asideOpen && <Btn className="ghost icon sm" icon="x" aria-label="收起" onClick={() => setAsideOpen(false)} />}
            </span>
          </div>
          <input className="tree-search" aria-label="搜索任务树" placeholder="搜索任务号、标题或来源单号" value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} />
          <TaskTree key={slug} roots={threads} search={searchQuery} />
          {threads.length < totals.total && pages < 100 && <Btn className="ghost sm" onClick={() => setPages((n) => n + 1)}>加载更多（{threads.length}/{totals.total}）</Btn>}
          {!threads.length && <div className="small muted">{searchQuery ? '没有匹配的任务' : showDone ? '还没有任务' : '没有进行中的任务'}</div>}
        </div>
        <div className="aside-sec">
          <h4>频道概况</h4>
          <dl className="kv">
            <dt>进行中</dt><dd>{channel?.activeTasks ?? 0} 个任务</dd>
            <dt>待拍板</dt><dd>{channel?.pendingApprovals ? <a href="/inbox" onClick={(e) => { e.preventDefault(); navigate('/inbox'); }}>{channel.pendingApprovals} 项 →</a> : '0'}</dd>
          </dl>
        </div>
      </aside>
    </div>
  );
}
