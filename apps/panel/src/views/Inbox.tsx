import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errText, ACTION_LABEL, PATH_LABEL, EFFORT_LABEL, RETRY_LABEL, cleanTitle, prioRank } from '../api';
import { navigate, type Shared } from '../app';
import { AutoTextarea, Btn, Empty, Icon, PrioBadge, SourceBadge, Time, useToast, type IconName } from '../ui';

type Kind = 'approval' | 'question' | 'failure' | 'candidate';
type Item = { kind: Kind; id: string; data: any; title: string; priority: string | null; at: string };
const KIND_META: Record<Kind, { icon: IconName; label: string; group: string }> = {
  question: { icon: 'message', label: '需要输入', group: 'agent 在等你回答' },
  failure: { icon: 'alert', label: '需要处理', group: '卡住了，需要你处理' },
  approval: { icon: 'check', label: '待拍板', group: '等你拍板' },
  candidate: { icon: 'sparkles', label: '候选', group: '飞书候选' },
};
const KIND_ORDER: Kind[] = ['question', 'failure', 'approval', 'candidate'];
const FILTERS: Array<{ id: 'all' | Kind; label: string }> = [
  { id: 'all', label: '全部' }, { id: 'approval', label: '拍板' }, { id: 'question', label: '输入' }, { id: 'failure', label: '处理' }, { id: 'candidate', label: '候选' },
];

/** 收件箱（core-02 §5.3）：左列表右详情；排序 需要输入 > 需要处理 > 待拍板（优先级、时间）> 候选 */
export function Inbox({ shared, loaded }: { shared: Shared; loaded: boolean }) {
  const { inbox, runtimes, reload } = shared;
  const [filter, setFilter] = useState<'all' | Kind>('all');
  const [selId, setSelId] = useState<string | null>(null);
  const [opened, setOpened] = useState(false); // 窄屏：列表与详情二选一
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [
      ...(inbox.approvals ?? []).map((a: any) => ({ kind: 'approval' as const, id: `a:${a.key}`, data: a, title: approvalTitle(a), priority: a.priority ?? null, at: a.createdAt })),
      ...(inbox.questions ?? []).map((q: any) => ({ kind: 'question' as const, id: `q:${q.id}`, data: q, title: q.text, priority: null, at: q.createdAt })),
      ...(inbox.failures ?? []).map((f: any) => ({ kind: 'failure' as const, id: `f:${f.key}`, data: f, title: cleanTitle(f.title, f.source?.ref), priority: f.priority ?? null, at: f.updatedAt })),
      ...(inbox.candidates ?? []).map((c: any) => ({ kind: 'candidate' as const, id: `c:${c.id}`, data: c, title: c.text, priority: null, at: c.createdAt })),
    ];
    const pr = (i: Item) => prioRank(i.priority) ?? 9;
    return all.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || pr(x) - pr(y) || String(x.at).localeCompare(String(y.at)));
  }, [inbox]);
  const counts = useMemo(() => Object.fromEntries(KIND_ORDER.map((k) => [k, items.filter((i) => i.kind === k).length])) as Record<Kind, number>, [items]);
  const visible = filter === 'all' ? items : items.filter((i) => i.kind === filter);
  const current = visible.find((i) => i.id === selId) ?? visible[0] ?? null;
  // 当前项处理掉后自动落到下一项
  useEffect(() => { if (current && current.id !== selId) setSelId(current.id); }, [current, selId]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      const i = visible.findIndex((x) => x.id === current?.id);
      if (e.key === 'j' || e.key === 'ArrowDown') { const n = visible[Math.min(i + 1, visible.length - 1)]; if (n) { setSelId(n.id); e.preventDefault(); } }
      if (e.key === 'k' || e.key === 'ArrowUp') { const n = visible[Math.max(i - 1, 0)]; if (n) { setSelId(n.id); e.preventDefault(); } }
      if (e.key === 'Enter' && current) { const t = taskLink(current); if (t) navigate(t); }
    };
    window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on);
  }, [visible, current]);
  useEffect(() => { listRef.current?.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' }); }, [current?.id]);

  let lastGroup = '';
  return (
    <div className={`content${current && opened ? ' has-detail' : ''}`}>
      <section className="inbox-list" aria-label="待处理列表">
        <div className="pane-head" style={{ minHeight: 56 }}>
          <h1>收件箱</h1>
          <span className="sub">{items.length ? `${items.length} 项待处理` : ''}</span>
          <span className="spacer" />
          <span className="small faint" title="j / k 上下移动，Enter 打开任务线程"><span className="kbd">j</span> <span className="kbd">k</span> <span className="kbd">↵</span></span>
        </div>
        <div className="tabs" role="tablist">
          {FILTERS.filter((f) => f.id === 'all' || counts[f.id as Kind] > 0 || filter === f.id).map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} className={`tab${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>
              {f.label}<span className="count">{f.id === 'all' ? items.length : counts[f.id as Kind]}</span>
            </button>
          ))}
        </div>
        <div className="list" ref={listRef}>
          {visible.map((it) => {
            const g = KIND_META[it.kind].group; const head = g !== lastGroup && filter === 'all'; lastGroup = g;
            return (
              <div key={it.id}>
                {head && <div className="list-group">{g}</div>}
                <button className={`item${current?.id === it.id ? ' active' : ''}`} onClick={() => { setSelId(it.id); setOpened(true); }} aria-current={current?.id === it.id || undefined}>
                  <span className={`ico ${it.kind}`}><Icon name={KIND_META[it.kind].icon} /></span>
                  <span className="t1">{it.title}</span>
                  <span className="t2">
                    <PrioBadge priority={it.priority} />
                    <span className="ellipsis">{subLine(it)}</span>
                    <Time className="time" iso={it.at} />
                  </span>
                </button>
              </div>
            );
          })}
          {loaded && !visible.length && <InboxEmpty runtimes={runtimes} channels={shared.channels} />}
        </div>
      </section>
      <section className="detail" aria-label="事项详情">
        {current && <Detail key={current.id} item={current} runtimes={runtimes} reload={reload} onBack={() => setOpened(false)} />}
      </section>
    </div>
  );
}

function approvalTitle(a: any) {
  const ref = (a.taskSource ?? '').replace(/^\w+:/, '');
  return cleanTitle(a.taskTitle ?? a.title, ref) || a.title;
}
function subLine(it: Item) {
  const d = it.data;
  if (it.kind === 'approval') return `${ACTION_LABEL[d.actionType] ?? d.actionType} · ${d.taskKey ?? ''}${d.taskSource ? ' · ' + d.taskSource.replace(/^\w+:/, '') : ''}`;
  if (it.kind === 'question') return `${d.taskKey} 在等回答`;
  if (it.kind === 'failure') return `${d.key} · ${d.state === 'failed' ? '失败' : '需要处理'}`;
  return d.source?.chatName ?? '飞书';
}
function taskLink(it: Item): string | null {
  const d = it.data;
  const key = it.kind === 'failure' ? d.key : d.taskKey;
  if (!key) return null;
  return `/c/${d.channel ?? d.payload?.channel ?? 'jira'}/t/${key}`;
}

function InboxEmpty({ runtimes, channels }: { runtimes: any[]; channels: any[] }) {
  const online = runtimes.filter((r) => r.online);
  return (
    <Empty icon="checkCircle" title="没有需要你处理的事">
      <div className="small">agent 需要拍板、提问或卡住时会出现在这里。</div>
      <div className="row small" style={{ justifyContent: 'center', marginTop: 6 }}>
        <span className="row" style={{ gap: 6 }}><span className={`dot ${online.length ? 'on' : 'off'}`} />{runtimes.length ? `${online.length}/${runtimes.length} 个 runtime 在线` : '还没有 runtime 接入'}</span>
      </div>
      {channels[0] && <Btn className="sm" icon="hash" onClick={() => navigate(`/c/${channels[0].slug}`)} style={{ marginTop: 8 }}>去 #{channels[0].slug} 派活</Btn>}
    </Empty>
  );
}

// ---------------------------------------------------------------- 详情

function Detail({ item, runtimes, reload, onBack }: { item: Item; runtimes: any[]; reload: () => Promise<void>; onBack: () => void }) {
  const link = taskLink(item);
  const d = item.data;
  const source = item.kind === 'approval' ? d.taskSource : item.kind === 'failure' ? d.source?.ref : null;
  const sourceUrl = item.kind === 'approval' ? d.taskSourceUrl : item.kind === 'failure' ? d.source?.url : null;
  const head = (
    <div className="detail-meta">
      <Btn className="ghost sm mobile-only" icon="chevronLeft" onClick={onBack}>返回</Btn>
      <span className={`badge ${item.kind === 'approval' ? 'warn' : item.kind === 'question' ? 'info' : item.kind === 'failure' ? 'bad' : ''}`}>
        {item.kind === 'approval' ? ACTION_LABEL[d.actionType] ?? d.actionType : KIND_META[item.kind].label}
      </span>
      {item.kind === 'approval' && <span className="badge mono">{d.key}</span>}
      <SourceBadge source={source} url={sourceUrl} />
      <PrioBadge priority={item.priority} />
      <span className="spacer" style={{ flex: 1 }} />
      {link && <Btn className="ghost sm" icon="message" onClick={() => navigate(link)}>打开线程 {item.kind === 'failure' ? d.key : d.taskKey}</Btn>}
    </div>
  );
  if (item.kind === 'approval') return <ApprovalDetail a={d} title={item.title} head={head} runtimes={runtimes} reload={reload} />;
  if (item.kind === 'question') return <QuestionDetail q={d} head={head} reload={reload} />;
  if (item.kind === 'failure') return <FailureDetail t={d} title={item.title} head={head} reload={reload} />;
  return <CandidateDetail c={d} head={head} reload={reload} />;
}

function useAct(reload: () => Promise<void>) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  /** link：成功后提示里带「查看进展」，拍板后卡片会从收件箱消失，得留一个去任务线程的入口 */
  const act = async (label: string, fn: () => Promise<unknown>, ok?: string, link?: string | null) => {
    setBusy(label); setErr('');
    try { await fn(); if (ok) toast('ok', ok, link ? { label: '查看进展', onClick: () => navigate(link) } : undefined); await reload(); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(''); }
  };
  return { busy, err, act, setErr };
}

/** 分流卡与普通审批（S03.1 / S06.1）：先说清是哪个单、要做什么，调整项默认收起 */
function ApprovalDetail({ a, title, head, runtimes, reload }: { a: any; title: string; head: ReactNode; runtimes: any[]; reload: () => Promise<void> }) {
  const p = a.payload ?? {};
  const isTriage = a.actionType === 'triage_confirm';
  const [ov, setOv] = useState<Record<string, string>>({});
  const [body, setBody] = useState<string>(a.body ?? '');
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const { busy, err, act } = useAct(reload);
  useEffect(() => { setOv({}); setBody(a.body ?? ''); }, [a.key, a.bodyHash]);

  const repoName = ov.repo ?? p.repo?.name ?? '';
  const repoCandidates: string[] = [...new Set<string>([p.repo?.name, ...(p.repo?.candidates ?? [])].filter(Boolean))];
  const repoHosts = (r: string) => runtimes.filter((x) => (x.repos ?? []).includes(r)).map((x) => x.name);
  const anyRepos = runtimes.some((x) => (x.repos ?? []).length);
  const repoMissing = isTriage && !repoName;
  const modified = Object.keys(ov).length > 0 || (!isTriage && body !== a.body);
  const set = (k: string, v: string) => setOv((o) => { const n = { ...o }; if (!v || v === dflt(k)) delete n[k]; else n[k] = v; return n; });
  const dflt = (k: string) => ({ path: p.tier, repo: p.repo?.name, baseBranch: p.baseBranch, runtime: p.defaultRuntime, agent: p.defaultAgent } as Record<string, string | undefined>)[k] ?? '';
  const decide = (decision: 'approve' | 'reject') => act(a.key, () => api(`/api/approvals/${a.key}/decide`, {
    method: 'POST',
    body: { decision, bodyHash: a.bodyHash, ...(isTriage ? { overrides: Object.keys(ov).length ? ov : null } : { editedBody: body !== a.body ? body : null }), comment: comment || null },
  }), decision === 'approve' ? (isTriage ? `${a.taskKey} 已${modified ? '按修改' : ''}派出，agent 开始干活` : `${a.key} 已批准`) : `${a.key} 已否决`, a.taskKey ? `/c/${p.channel ?? 'jira'}/t/${a.taskKey}` : null);

  // ⌘/Ctrl+Enter 批准
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !busy && !repoMissing && !rejecting) { e.preventDefault(); void decide('approve'); } };
    window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on);
  });

  const facts: Array<{ k: string; v: string; key?: string; mono?: boolean; missing?: boolean }> = isTriage ? [
    { k: '档位', v: PATH_LABEL[ov.path ?? p.tier] ?? (ov.path ?? p.tier ?? '-'), key: 'path' },
    { k: '工作量', v: EFFORT_LABEL[p.effort] ?? p.effort ?? '-' },
    { k: '仓库', v: repoName || '待确认', key: 'repo', mono: !!repoName, missing: !repoName },
    { k: '基线分支', v: ov.baseBranch ?? p.baseBranch ?? '仓库默认', key: 'baseBranch', mono: true },
    { k: '执行', v: `${ov.runtime ?? p.defaultRuntime ?? '按路由'} · ${ov.agent ?? p.defaultAgent ?? '轮换'}`, key: ov.runtime ? 'runtime' : 'agent' },
  ] : ([
    ['仓库', p.repo], ['源分支', p.head], ['目标分支', p.base], ['推送到', p.pushRemote ?? p.pushUrl],
    ['提交', typeof p.commit === 'string' ? p.commit.slice(0, 12) : null], ['执行方', p.executor === 'agent' ? 'agent 会话内执行' : p.executor === 'center' ? '中心代执行' : p.executor],
  ] as Array<[string, unknown]>).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => ({ k, v: String(v), mono: k !== '执行方' }));

  return (
    <>
      <div className="detail-body">
        <div className="detail-inner">
          {head}
          <h2>{title}</h2>
          <p className="lede">{isTriage ? `${a.taskKey} 的分流卡：确认后按下面的档位和仓库派给 agent。` : a.title}</p>

          {p.degraded && (
            <div className="callout warn" style={{ marginBottom: 14 }}>
              <Icon name="alert" />
              <div className="grow"><div className="callout-title">代码定位不完整</div><div>{p.degradedReason ?? '定位会话没有回写结果'}</div></div>
              <Btn className="sm" icon="refresh" busy={busy === 'relocate'} onClick={() => act('relocate', () => api(`/api/tasks/${a.taskKey}/relocate`, { method: 'POST' }), '已重新发起代码定位')}>重新定位</Btn>
            </div>
          )}
          {a.status === 'failed' && <div className="callout bad" style={{ marginBottom: 14 }}><Icon name="alert" /><div className="grow"><div className="callout-title">上次执行失败，可以重试</div><div>{a.payload?.error ?? ''}</div></div></div>}

          {isTriage && p.suggestedPath && (
            <div className="suggest"><div className="label"><Icon name="sparkles" size="sm" />agent 的建议</div><div className="text">{p.suggestedPath}</div></div>
          )}

          {repoMissing && (
            <div className="callout warn" style={{ marginBottom: 14, flexDirection: 'column', alignItems: 'stretch' }}>
              <div className="row"><Icon name="folder" /><span className="callout-title">先定仓库</span>
                <span>定位没能确定改哪个仓库{p.repo?.confidence != null ? `（把握 ${Math.round(p.repo.confidence * 100)}%）` : ''}，选一个：</span></div>
              <div className="chips">
                {repoCandidates.map((r) => {
                  const hosts = repoHosts(r);
                  return <button key={r} className="chip" onClick={() => set('repo', r)} disabled={anyRepos && !hosts.length} title={anyRepos && !hosts.length ? '没有 runtime 登记这个仓库' : ''}>
                    <span className="mono">{r}</span><small>{anyRepos ? (hosts.length ? `${hosts.join('、')} 可用` : '无 runtime') : ''}</small></button>;
                })}
                {!repoCandidates.length && <span className="small">没有候选，展开「调整」手动选</span>}
              </div>
            </div>
          )}

          {!!facts.length && (
            <div className="facts">
              {facts.map((f) => <div key={f.k} className={`fact${f.key && ov[f.key] ? ' changed' : ''}${f.missing ? ' missing' : ''}`}><div className="k">{f.k}</div><div className={`v${f.mono ? ' mono' : ''}`}>{f.v}</div></div>)}
            </div>
          )}

          {isTriage && editing && (
            <div className="adjust">
              <div className="adjust-grid">
                <div className="field"><label htmlFor="ov-path">档位</label>
                  <select id="ov-path" className="select" value={ov.path ?? p.tier ?? 'fix'} onChange={(e) => set('path', e.target.value)}>
                    {['fix', 'plan', 'proto'].map((x) => <option key={x} value={x}>{PATH_LABEL[x]}</option>)}
                  </select></div>
                <div className="field"><label htmlFor="ov-repo">仓库</label>
                  <select id="ov-repo" className={`select${repoMissing ? ' warn' : ''}`} value={repoName} onChange={(e) => set('repo', e.target.value)}>
                    <option value="">（未选）</option>
                    {[...new Set([...repoCandidates, ...runtimes.flatMap((x) => x.repos ?? [])])].map((r) => {
                      const hosts = repoHosts(r);
                      return <option key={r} value={r} disabled={anyRepos && !hosts.length}>{r}{anyRepos ? (hosts.length ? `（${hosts.join('、')}）` : '（无 runtime 登记）') : ''}</option>;
                    })}
                  </select></div>
                <div className="field"><label htmlFor="ov-base">基线分支</label>
                  <input id="ov-base" className="input mono" value={ov.baseBranch ?? p.baseBranch ?? ''} placeholder="留空用仓库默认" onChange={(e) => set('baseBranch', e.target.value)} /></div>
                <div className="field"><label htmlFor="ov-rt">runtime</label>
                  <select id="ov-rt" className="select" value={ov.runtime ?? p.defaultRuntime ?? ''} onChange={(e) => set('runtime', e.target.value)}>
                    <option value="">按路由规则</option>
                    {runtimes.map((r: any) => <option key={r.name} value={r.name} disabled={!r.online}>{r.name}{r.online ? '' : '（离线）'}</option>)}
                  </select></div>
                <div className="field"><label htmlFor="ov-agent">agent</label>
                  <select id="ov-agent" className="select" value={ov.agent ?? p.defaultAgent ?? ''} onChange={(e) => set('agent', e.target.value)}>
                    <option value="">按轮换</option>{['claude', 'codex'].map((x) => <option key={x} value={x}>{x}</option>)}
                  </select></div>
              </div>
              {modified && <div className="row end" style={{ marginTop: 10 }}><Btn className="ghost sm" icon="refresh" onClick={() => setOv({})}>恢复建议值</Btn></div>}
            </div>
          )}

          {isTriage && !!p.codeLocations?.length && (
            <>
              <div className="section-title"><Icon name="code" size="sm" />代码定位 · {p.codeLocations.length} 处</div>
              <div className="locs">
                {p.codeLocations.map((l: any, i: number) => (
                  <div className="loc" key={i}>
                    <div className="path">{l.file}{l.line ? <span className="ln">:{l.line}</span> : null}</div>
                    {l.symbol && <div className="sym">{l.symbol}</div>}
                    {l.why && <div className="why">{l.why}</div>}
                  </div>
                ))}
              </div>
            </>
          )}

          {!isTriage && (
            <>
              <div className="section-title row between"><span className="row" style={{ gap: 6 }}><Icon name="file" size="sm" />{a.actionType === 'create_pr' ? 'PR 描述' : '正文'}</span>
                <Btn className="ghost sm" icon="pencil" onClick={() => setEditing(!editing)}>{editing ? '收起编辑' : '改写后执行'}</Btn></div>
              {editing
                ? <textarea className="textarea mono" rows={Math.min(18, (a.body ?? '').split('\n').length + 2)} value={body} onChange={(e) => setBody(e.target.value)} aria-label="改写正文" />
                : <pre style={{ maxHeight: 420, overflowY: 'auto' }}>{body}</pre>}
            </>
          )}
        </div>
      </div>
      <div className="detail-foot">
        {rejecting ? (
          <div className="reject-box">
            <input className="input" autoFocus placeholder="否决原因会转给 agent，比如「只修 4.1，别动 master」" value={comment} onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void decide('reject'); if (e.key === 'Escape') setRejecting(false); }} aria-label="否决原因" />
            <Btn onClick={() => setRejecting(false)}>取消</Btn>
            <Btn className="danger solid" busy={busy === a.key} onClick={() => decide('reject')}>确认否决</Btn>
          </div>
        ) : (
          <>
            <span className="small muted row" style={{ gap: 6 }} title="连续原样确认达到阈值后，该类动作自动执行">
              <Icon name="shield" size="sm" />信任 {a.trustStreak}/5{modified ? ' · 修改后确认不计数' : ''}
            </span>
            {err && <span className="err-inline"><Icon name="alert" size="sm" />{err}</span>}
            <span className="spacer" />
            {isTriage && <Btn className="ghost" icon={editing ? 'chevronUp' : 'pencil'} onClick={() => setEditing(!editing)}>{editing ? '收起调整' : '调整'}</Btn>}
            <Btn className="danger" icon="x" disabled={!!busy} onClick={() => setRejecting(true)}>否决</Btn>
            <Btn className="go" icon="check" busy={busy === a.key} disabled={!!busy || repoMissing} onClick={() => decide('approve')} title={repoMissing ? '先选仓库' : '⌘ + Enter'}>
              {repoMissing ? '先选仓库' : modified ? '按修改执行' : '按建议执行'}
            </Btn>
          </>
        )}
      </div>
    </>
  );
}

/** 需要输入（S07）：选项一键送出，自由输入 Enter 发送（§5.1 #7） */
function QuestionDetail({ q, head, reload }: { q: any; head: ReactNode; reload: () => Promise<void> }) {
  const [text, setText] = useState('');
  const { busy, err, act } = useAct(reload);
  const send = (t: string) => t.trim() && act('send', () => api(`/api/tasks/${q.taskKey}/messages`, { method: 'POST', body: { text: t, questionId: q.id } }), `已送入 ${q.taskKey} 的会话`, `/c/${q.channel ?? 'jira'}/t/${q.taskKey}`);
  return (
    <>
      <div className="detail-body">
        <div className="detail-inner">
          {head}
          <h2>{q.taskKey} 的 agent 在问</h2>
          <div className="bubble">{q.text}</div>
          {!!q.options?.length && (
            <>
              <div className="section-title">点一个直接回复</div>
              <div className="chips" style={{ marginBottom: 14 }}>
                {q.options.map((o: string) => <button key={o} className="chip" disabled={!!busy} onClick={() => send(o)}><Icon name="send" size="sm" />{o}</button>)}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="detail-foot">
        <div className="composer-box" style={{ flex: 1 }}>
          <AutoTextarea value={text} onChange={setText} onSubmit={() => { void send(text); setText(''); }} placeholder={q.options?.length ? '或者自己写，Enter 发送' : '回复，Enter 发送，Shift+Enter 换行'} disabled={!!busy} />
          <Btn className="accent sm" icon="send" busy={busy === 'send'} disabled={!text.trim()} onClick={() => { void send(text); setText(''); }}>送入</Btn>
        </div>
        {err && <span className="err-inline" style={{ width: '100%' }}><Icon name="alert" size="sm" />{err}</span>}
      </div>
    </>
  );
}

/** 失败三选一 / 需要人工处理：写清原因和每个选项的后果 */
function FailureDetail({ t, title, head, reload }: { t: any; title: string; head: ReactNode; reload: () => Promise<void> }) {
  const [text, setText] = useState('');
  const { busy, err, act } = useAct(reload);
  const failed = t.state === 'failed';
  const reason: string = (t.failureReason ?? t.queueReason ?? '').replace(/^人工处理：/, '');
  const retry = (mode: string) => act(mode, () => api(`/api/tasks/${t.key}/retry`, { method: 'POST', body: { mode } }), `${t.key}：${RETRY_LABEL[mode]}`, mode === 'abandon' ? null : `/c/${t.channel ?? 'jira'}/t/${t.key}`);
  const reply = () => text.trim() && act('reply', () => api(`/api/tasks/${t.key}/messages`, { method: 'POST', body: { text } }), `已送入 ${t.key} 的会话`, `/c/${t.channel ?? 'jira'}/t/${t.key}`).then(() => setText(''));
  const canReply = !failed && /会话结束|回复/.test(reason);
  return (
    <>
      <div className="detail-body">
        <div className="detail-inner">
          {head}
          <h2>{title}</h2>
          <div className={`callout ${failed ? 'bad' : 'warn'}`} style={{ marginBottom: 14 }}>
            <Icon name="alert" />
            <div className="grow"><div className="callout-title">{failed ? '任务失败' : '需要你处理'}</div><div>{reason || '没有记录原因，打开线程看最近的进展'}</div></div>
          </div>
          {failed && (
            <dl className="kv small" style={{ marginBottom: 8 }}>
              <dt>重试</dt><dd>同一个 agent 在原会话里再来一次</dd>
              <dt>换一个 agent</dt><dd>交给另一家 agent 从头做，适合原 agent 反复卡在同一处</dd>
              <dt>开新会话继续</dt><dd>保留工作区改动，开新会话接着做</dd>
              <dt>放弃</dt><dd>任务暂停，工作区保留 3 天</dd>
            </dl>
          )}
        </div>
      </div>
      <div className="detail-foot">
        {failed ? (
          <>
            {err && <span className="err-inline"><Icon name="alert" size="sm" />{err}</span>}
            <span className="spacer" />
            <Btn className="danger" busy={busy === 'abandon'} disabled={!!busy} onClick={() => retry('abandon')}>放弃</Btn>
            <Btn busy={busy === 'fresh_session'} disabled={!!busy} onClick={() => retry('fresh_session')}>开新会话继续</Btn>
            <Btn busy={busy === 'switch_agent'} disabled={!!busy} onClick={() => retry('switch_agent')}>换一个 agent</Btn>
            <Btn className="go" icon="refresh" busy={busy === 'same_agent'} disabled={!!busy} onClick={() => retry('same_agent')}>重试</Btn>
          </>
        ) : canReply ? (
          <>
            <div className="composer-box" style={{ flex: 1 }}>
              <AutoTextarea value={text} onChange={setText} onSubmit={reply} placeholder="告诉 agent 接下来怎么做，Enter 送入原会话" disabled={!!busy} />
              <Btn className="accent sm" icon="send" busy={busy === 'reply'} disabled={!text.trim()} onClick={reply}>送入</Btn>
            </div>
            {err && <span className="err-inline" style={{ width: '100%' }}><Icon name="alert" size="sm" />{err}</span>}
          </>
        ) : (
          <><span className="small muted">处理完成后这一项会自动消失</span><span className="spacer" />{err && <span className="err-inline">{err}</span>}</>
        )}
      </div>
    </>
  );
}

function CandidateDetail({ c, head, reload }: { c: any; head: ReactNode; reload: () => Promise<void> }) {
  const { busy, err, act } = useAct(reload);
  return (
    <>
      <div className="detail-body">
        <div className="detail-inner">
          {head}
          <h2>飞书里可能要派活的消息</h2>
          <div className="bubble">{c.text}</div>
          <dl className="kv small">
            <dt>来自</dt><dd>{c.source?.chatName ?? c.source?.messageId ?? '-'}</dd>
            <dt>把握</dt><dd>{c.confidence != null ? `${Math.round(Number(c.confidence) * 100)}%` : '-'}</dd>
            {c.reason && <><dt>理由</dt><dd>{c.reason}</dd></>}
          </dl>
        </div>
      </div>
      <div className="detail-foot">
        {err && <span className="err-inline"><Icon name="alert" size="sm" />{err}</span>}
        <span className="spacer" />
        <Btn busy={busy === 'dismiss'} disabled={!!busy} onClick={() => act('dismiss', () => api(`/api/candidates/${c.id}/dismiss`, { method: 'POST' }), '已忽略')}>忽略</Btn>
        <Btn className="go" icon="plus" busy={busy === 'intake'} disabled={!!busy} onClick={() => act('intake', () => api(`/api/candidates/${c.id}/intake`, { method: 'POST' }), '已入库')}>入库</Btn>
      </div>
    </>
  );
}
