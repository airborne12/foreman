import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, errText, getToken, setToken, clearToken, prefs } from './api';
import { Btn, Icon, ToastProvider, useToast, type IconName } from './ui';
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

/** 事件总线：WebSocket 一有推送就 +1，视图据此重新拉取（250ms 合并一次） */
function useLiveRevision(enabled: boolean) {
  const [rev, setRev] = useState(0);
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null; let timer: ReturnType<typeof setTimeout> | undefined; let closed = false; let pending = false;
    const bump = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; setRev((r) => r + 1); }, 250); };
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/panel?token=${encodeURIComponent(getToken())}`);
      ws.onopen = () => { setConnected(true); bump(); };
      ws.onmessage = bump;
      ws.onclose = () => { setConnected(false); if (!closed) timer = setTimeout(connect, 3000); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, [enabled]);
  return { rev, connected };
}

/** 主题：跟随系统 / 浅色 / 深色，选择只存在本机浏览器（§5.2） */
type Theme = 'system' | 'light' | 'dark';
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (prefs.get('foreman.theme') as Theme | null) ?? 'system');
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    prefs.set('foreman.theme', theme);
  }, [theme]);
  const next = () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'));
  return { theme, next };
}

export type Shared = { inbox: any; runtimes: any[]; channels: any[]; rev: number; reload: () => Promise<void> };

export function App() {
  return <ToastProvider><Shell /></ToastProvider>;
}

function Shell() {
  const [token, setTok] = useState(getToken());
  const path = useRoute();
  const { rev, connected } = useLiveRevision(!!token);
  const [channels, setChannels] = useState<any[]>([]);
  const [inbox, setInbox] = useState<any>({ approvals: [], questions: [], failures: [], candidates: [], counts: { actionable: 0, candidates: 0 } });
  const [runtimes, setRuntimes] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [authErr, setAuthErr] = useState('');
  const [sideOpen, setSideOpen] = useState(false);
  const { theme, next: nextTheme } = useTheme();

  // 频道、收件箱、runtime 三份数据由壳统一拉取再下发，避免每个视图各拉一遍
  const reload = useCallback(async () => {
    try {
      const [ch, ib, rt] = await Promise.all([api('/api/channels'), api('/api/inbox'), api('/api/runtimes')]);
      setChannels(ch.items ?? []); setInbox(ib); setRuntimes(rt.items ?? []); setAuthErr(''); setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { clearToken(); setTok(''); setAuthErr('token 无效或已更换'); }
    }
  }, []);
  useEffect(() => { if (token) void reload(); }, [token, rev, reload]);
  useEffect(() => { setSideOpen(false); }, [path]);
  useGlobalKeys();

  if (!token) return <TokenGate onDone={(t) => { setToken(t); setTok(t); }} error={authErr} />;
  const shared: Shared = { inbox, runtimes, channels, rev, reload };
  const actionable = inbox.counts?.actionable ?? 0;
  const online = runtimes.filter((r) => r.online).length;

  return (
    <div className="app">
      {!connected && <div className="conn-bar" role="alert" aria-label="实时推送已断开" />}
      <div className="mobile-top">
        <Btn className="ghost icon" icon="menu" aria-label="打开导航" onClick={() => setSideOpen(true)} />
        <b>foreman</b>
        {actionable > 0 && <span className="count hot">{actionable}</span>}
      </div>
      <aside className={`side${sideOpen ? ' open' : ''}`}>
        <div className="brand"><span className="logo"><Icon name="zap" /></span>foreman</div>
        <nav aria-label="主导航">
          <NavItem to="/inbox" icon="inbox" label="收件箱" active={path === '/' || path.startsWith('/inbox')} count={actionable} hot />
          <div className="nav-group">
            <ChannelNav channels={channels} path={path} onCreated={reload} />
          </div>
          <div className="nav-group">
            <div className="nav-head">平台</div>
            <NavItem to="/runtimes" icon="activity" label="状态" active={path.startsWith('/runtimes')}
              trailing={<span className="row small muted" style={{ gap: 6 }}><span className={`dot ${runtimes.length === 0 ? '' : online === runtimes.length ? 'on' : online ? 'warn' : 'off'}`} />{online}/{runtimes.length}</span>} />
            <NavItem to="/trust" icon="shield" label="信任" active={path.startsWith('/trust')} />
            <NavItem to="/settings" icon="sliders" label="设置" active={path.startsWith('/settings')} />
          </div>
        </nav>
        <div className="side-foot">
          <div className="conn" role="status">
            <span className={`dot ${connected ? 'on' : 'off pulse'}`} />{connected ? '实时推送已连接' : '实时推送断开，正在重连'}
          </div>
          <div className="row">
            <Btn className="ghost sm" icon={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor'} onClick={nextTheme} title="切换主题">
              {theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'}
            </Btn>
            <Btn className="ghost sm" icon="logout" onClick={() => { clearToken(); setTok(''); }}>退出</Btn>
          </div>
        </div>
      </aside>
      {sideOpen && <div className="drawer-mask" style={{ zIndex: 35 }} onClick={() => setSideOpen(false)} />}
      <View path={path} shared={shared} loaded={loaded} />
    </div>
  );
}

function View({ path, shared, loaded }: { path: string; shared: Shared; loaded: boolean }) {
  if (path.startsWith('/c/')) {
    const [, , slug, t, key] = path.split('/');
    if (t === 't' && key) return <ThreadView channel={slug!} taskKey={key} shared={shared} />;
    return <ChannelView slug={slug!} shared={shared} />;
  }
  if (path.startsWith('/runtimes')) return <Runtimes shared={shared} />;
  if (path.startsWith('/trust')) return <Trust shared={shared} />;
  if (path.startsWith('/settings')) return <Settings />;
  return <Inbox shared={shared} loaded={loaded} />;
}

function NavItem({ to, icon, label, active, count, hot, trailing }: { to: string; icon: IconName; label: string; active: boolean; count?: number; hot?: boolean; trailing?: ReactNode }) {
  return (
    <button className={`nav-item${active ? ' active' : ''}`} onClick={() => navigate(to)} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} />
      <span className="label">{label}</span>
      {!!count && <span className={`count${hot ? ' hot' : ''}`}>{count}</span>}
      {trailing}
    </button>
  );
}

/** 频道列表 + 行内新建（§5.1 #12） */
function ChannelNav({ channels, path, onCreated }: { channels: any[]; path: string; onCreated: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [slug, setSlug] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const valid = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 40;
  const create = async () => {
    if (!valid) { setErr('只能用小写字母、数字和连字符'); return; }
    setBusy(true); setErr('');
    try {
      await api('/api/channels', { method: 'POST', body: { slug } });
      await onCreated(); toast('ok', `已创建 #${slug}`);
      setAdding(false); setSlug(''); navigate(`/c/${slug}`);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="nav-head">频道<Btn className="ghost icon sm" icon={adding ? 'x' : 'plus'} aria-label={adding ? '取消新建' : '新建频道'} title="新建频道" onClick={() => { setAdding(!adding); setErr(''); }} /></div>
      {adding && (
        <div>
          <div className="newchan">
            <input className="input" autoFocus placeholder="频道名，如 doris-index" value={slug} aria-label="频道名"
              onChange={(e) => { setSlug(e.target.value.toLowerCase().replace(/[\s_]+/g, '-')); setErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setAdding(false); }} />
            <Btn className="accent sm" busy={busy} disabled={!slug} onClick={create}>建</Btn>
          </div>
          {err && <div className="err-inline" style={{ padding: '0 6px 6px' }}>{err}</div>}
        </div>
      )}
      {channels.map((c) => (
        <NavItem key={c.slug} to={`/c/${c.slug}`} icon="hash" label={c.title && c.title.toLowerCase() !== c.slug ? `${c.slug}` : c.slug} active={path.startsWith(`/c/${c.slug}`)} count={c.pendingApprovals || undefined} />
      ))}
      {!channels.length && !adding && <div className="small faint" style={{ padding: '2px 8px' }}>Jira 入库后自动出现 #jira</div>}
    </>
  );
}

/** 全局快捷键：g i 收件箱、g r 状态、g t 信任（§四） */
function useGlobalKeys() {
  const last = useRef(0);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable)) return;
      if (e.key === 'g') { last.current = Date.now(); return; }
      if (Date.now() - last.current > 800) return;
      const to = { i: '/inbox', r: '/runtimes', t: '/trust', s: '/settings' }[e.key];
      if (to) { navigate(to); last.current = 0; }
    };
    window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on);
  }, []);
}

function TokenGate({ onDone, error }: { onDone: (t: string) => void; error?: string }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState(error ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setToken(v);
    try { await api('/api/inbox'); onDone(v); } catch { clearToken(); setErr('token 无效。看中心机 ~/.foreman/env 里的 FOREMAN_PANEL_TOKEN'); } finally { setBusy(false); }
  };
  return (
    <div className="gate">
      <div className="card stack">
        <div className="row" style={{ gap: 10 }}><span className="logo" style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, var(--accent), #B26BFF)', color: '#fff' }}><Icon name="zap" /></span><b style={{ fontSize: 17 }}>foreman</b></div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>输入面板 token</div>
          <div className="small muted">在中心机 <code>~/.foreman/env</code> 的 FOREMAN_PANEL_TOKEN 里</div>
        </div>
        <input className="input" autoFocus type="password" aria-label="面板 token" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && v.trim() && submit()} />
        {err && <div className="err-inline"><Icon name="alert" size="sm" />{err}</div>}
        <div className="row end"><Btn className="accent" busy={busy} onClick={submit} disabled={!v.trim()}>进入</Btn></div>
      </div>
    </div>
  );
}
