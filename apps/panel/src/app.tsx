import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken, setToken, clearToken } from './api';
import { Inbox } from './views/Inbox';
import { ChannelView } from './views/Channel';
import { ThreadView } from './views/Thread';
import { Runtimes } from './views/Runtimes';
import { Trust } from './views/Trust';
import { Settings } from './views/Settings';

/** 路由（core-02 §2.1）：/inbox、/c/:channel、/c/:channel/t/:taskKey、/runtimes、/trust、/settings */
export function useRoute() {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    window.addEventListener('foreman:navigate', on as EventListener);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('foreman:navigate', on as EventListener); };
  }, []);
  return path;
}
export function navigate(to: string) {
  if (location.pathname === to) return;
  history.pushState(null, '', to);
  window.dispatchEvent(new Event('foreman:navigate'));
}

/** 事件总线：WebSocket 一有推送就 +1，视图据此重新拉取 */
function useLiveRevision(enabled: boolean) {
  const [rev, setRev] = useState(0);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null; let timer: any; let closed = false; let pending = false;
    const bump = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; setRev((r) => r + 1); }, 250); };
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/panel?token=${encodeURIComponent(getToken())}`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = bump;
      ws.onclose = () => { setConnected(false); if (!closed) timer = setTimeout(connect, 3000); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, [enabled]);
  return { rev, connected };
}

export function App() {
  const [token, setTok] = useState(getToken());
  const path = useRoute();
  const { rev, connected } = useLiveRevision(!!token);
  const [channels, setChannels] = useState<any[]>([]);
  const [counts, setCounts] = useState<{ actionable: number; candidates: number }>({ actionable: 0, candidates: 0 });
  const [authErr, setAuthErr] = useState('');

  const reload = useCallback(async () => {
    try {
      const [ch, inbox] = await Promise.all([api('/api/channels'), api('/api/inbox')]);
      setChannels(ch.items ?? []); setCounts(inbox.counts ?? { actionable: 0, candidates: 0 }); setAuthErr('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { clearToken(); setTok(''); setAuthErr('token 无效'); }
    }
  }, []);
  useEffect(() => { if (token) void reload(); }, [token, rev, reload]);

  // 所有 hook 必须在分支之前调用完
  if (!token) return <TokenGate onDone={(t) => { setToken(t); setTok(t); }} error={authErr} />;
  const view = renderView(path, rev);

  return (
    <div className="app">
      <nav className="rail">
        <div className="brand">foreman</div>
        <Nav to="/inbox" active={path === '/' || path.startsWith('/inbox')} label="收件箱" count={counts.actionable} />
        <div className="railhead">频道</div>
        {channels.map((c) => (
          <Nav key={c.slug} to={`/c/${c.slug}`} active={path.startsWith(`/c/${c.slug}`)} label={`# ${c.slug}`} count={c.pendingApprovals || undefined} />
        ))}
        {!channels.length && <div className="meta" style={{ padding: '4px 8px' }}>还没有频道</div>}
        <div className="railhead">平台</div>
        <Nav to="/runtimes" active={path.startsWith('/runtimes')} label="状态" dot={connected} />
        <Nav to="/trust" active={path.startsWith('/trust')} label="信任" />
        <Nav to="/settings" active={path.startsWith('/settings')} label="设置" />
        <div style={{ marginTop: 18, padding: '0 8px' }}>
          <button className="ghost" style={{ fontSize: 12 }} onClick={() => { clearToken(); setTok(''); }}>退出</button>
        </div>
        {!connected && <div className="banner" style={{ marginTop: 10 }}>实时推送已断开，正在重连</div>}
      </nav>
      {view}
    </div>
  );
}

function renderView(path: string, rev: number) {
  if (path.startsWith('/c/')) {
    const [, , slug, t, key] = path.split('/');
    if (t === 't' && key) return <ThreadView channel={slug!} taskKey={key} rev={rev} />;
    return <ChannelView slug={slug!} rev={rev} />;
  }
  if (path.startsWith('/runtimes')) return <Runtimes rev={rev} />;
  if (path.startsWith('/trust')) return <Trust rev={rev} />;
  if (path.startsWith('/settings')) return <Settings />;
  return <Inbox rev={rev} />;
}

function Nav({ to, label, active, count, dot }: { to: string; label: string; active: boolean; count?: number; dot?: boolean }) {
  return (
    <button className={`navitem${active ? ' active' : ''}`} onClick={() => navigate(to)}>
      {dot !== undefined && <span className={`dot ${dot ? 'on' : 'off'}`} />}
      <span>{label}</span>
      {!!count && <span className="count">{count}</span>}
    </button>
  );
}

function TokenGate({ onDone, error }: { onDone: (t: string) => void; error?: string }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState(error ?? '');
  const submit = async () => {
    setToken(v);
    try { await api('/api/inbox'); onDone(v); } catch { clearToken(); setErr('token 无效，看中心机 ~/.foreman/env 的 FOREMAN_PANEL_TOKEN'); }
  };
  return (
    <div className="gate">
      <div className="brand" style={{ fontSize: 22 }}>foreman</div>
      <div className="card">
        <h3>面板 token</h3>
        <div className="meta" style={{ marginBottom: 8 }}>中心机 <code>~/.foreman/env</code> 里的 FOREMAN_PANEL_TOKEN</div>
        <input autoFocus type="password" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {err && <div className="err">{err}</div>}
        <div className="row end" style={{ marginTop: 10 }}><button className="primary" onClick={submit} disabled={!v.trim()}>进入</button></div>
      </div>
    </div>
  );
}
