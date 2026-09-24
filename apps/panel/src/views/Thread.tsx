import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errText, PATH_LABEL, EFFORT_LABEL, SESSION_KIND_LABEL, SESSION_STATE_LABEL, cleanTitle } from '../api';
import { navigate, type Shared } from '../app';
import { AutoTextarea, Btn, Drawer, Empty, Icon, PrioBadge, SourceBadge, StateBadge, Time, useToast } from '../ui';
import { MessageRow } from './Message';

/** 线程视图（S01/S03/S07）：任务消息流 + 右栏任务详情；日志在抽屉里看 */
export function ThreadView({ channel, taskKey, shared }: { channel: string; taskKey: string; shared: Shared }) {
  const [task, setTask] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [logs, setLogs] = useState<{ session: any; lines: string[] } | null>(null);
  const [asideOpen, setAsideOpen] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const toast = useToast();
  const feedRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const load = useCallback(async () => {
    try {
      const [t, m] = await Promise.all([api(`/api/tasks/${taskKey}`), api(`/api/tasks/${taskKey}/messages?limit=200`)]);
      setTask(t); setMessages(m.items ?? []); setErr(''); setNotFound(false);
    } catch (e: any) { if (e?.status === 404) setNotFound(true); else setErr(errText(e)); }
  }, [taskKey]);
  useEffect(() => { stick.current = true; setTask(null); setMessages([]); }, [taskKey]);
  useEffect(() => { void load(); }, [shared.rev, load]);
  // 新消息到达时，若本来就停在底部则跟随滚动
  useEffect(() => { const el = feedRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages.length]);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label); setErr('');
    try { await fn(); if (ok) toast('ok', ok); await load(); await shared.reload(); }
    catch (e) { setErr(errText(e)); toast('bad', errText(e)); }
    finally { setBusy(''); }
  };
  const sendText = (t: string) => t.trim() && run('send', async () => {
    await api(`/api/tasks/${taskKey}/messages`, { method: 'POST', body: { text: t, ...(task?.openQuestion ? { questionId: task.openQuestion.id } : {}) } });
    setText(''); stick.current = true;
  });
  const showLogs = async (s: any) => {
    try { const r = await api(`/api/sessions/${s.id}/logs?limit=400`); setLogs({ session: s, lines: r.lines ?? [] }); }
    catch (e) { toast('bad', errText(e)); }
  };

  if (notFound) return <div className="content"><div className="pane"><Empty icon="help" title={`没有找到 ${taskKey}`}><Btn className="sm" icon="chevronLeft" onClick={() => navigate(`/c/${channel}`)}>回到 #{channel}</Btn></Empty></div></div>;

  const title = cleanTitle(task?.title, task?.source?.ref);
  const q = task?.openQuestion;
  const hasDoc = task?.artifacts?.some((a: any) => a.kind === 'doc');
  const pendingKeys = task ? new Set<string>((task.pendingApprovals ?? []).map((a: any) => a.key)) : undefined;
  const reason: string | null = task?.queueReason ?? (task?.state === 'failed' ? task?.failureReason : null);
  return (
    <div className="content">
      <div className="pane">
        <div className="pane-head">
          <Btn className="ghost sm" icon="chevronLeft" onClick={() => navigate(`/c/${channel}`)}>#{channel}</Btn>
          <h1 style={{ flex: '1 1 320px' }}><span className="mono muted" style={{ fontWeight: 500 }}>{taskKey}</span><span className="ellipsis">{title}</span></h1>
          <StateBadge state={task?.state} />
          {task?.path && <span className="badge">{PATH_LABEL[task.path] ?? task.path}</span>}
          <span className="row" style={{ gap: 6 }}>
            {hasDoc && task?.state !== 'running' && <Btn className="go sm" icon="play" busy={busy === 'impl'} onClick={() => run('impl', () => api(`/api/tasks/${taskKey}/implement`, { method: 'POST' }), '已按方案派出实现')}>按方案实现</Btn>}
            {task?.state === 'paused'
              ? <Btn className="sm" icon="play" busy={busy === 'resume'} onClick={() => run('resume', () => api(`/api/tasks/${taskKey}/resume`, { method: 'POST' }), `${taskKey} 已恢复`)}>恢复</Btn>
              : task && !['done', 'delivered', 'failed'].includes(task.state) && <Btn className="sm ghost" icon="pause" busy={busy === 'pause'} onClick={() => run('pause', () => api(`/api/tasks/${taskKey}/pause`, { method: 'POST' }), `${taskKey} 已暂停`)}>暂停</Btn>}
            <Btn className="ghost icon sm aside-toggle" icon="panel" aria-label="任务详情" onClick={() => setAsideOpen(!asideOpen)} />
          </span>
        </div>
        <div className="pane-body" ref={feedRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          <div className="feed">
            {reason && (
              <div className={`callout ${task?.state === 'failed' ? 'bad' : 'warn'}`} style={{ marginBottom: 12 }}>
                <Icon name={task?.state === 'failed' ? 'alert' : 'clock'} />
                <div className="grow">{reason.replace(/^人工处理：/, '')}</div>
                {(task?.state === 'failed' || /^人工处理|^重试|^无进展/.test(reason)) && <Btn className="sm" icon="inbox" onClick={() => navigate('/inbox')}>去收件箱</Btn>}
              </div>
            )}
            {err && <div className="callout bad" style={{ marginBottom: 12 }}><Icon name="alert" />{err}</div>}
            {messages.map((m) => <MessageRow key={m.id} m={m} pendingApprovals={pendingKeys} onPick={q && m.kind === 'ask' && m.text === q.text ? (o) => void sendText(o) : undefined} busy={!!busy} />)}
            {task && !messages.length && <Empty icon="message" title="还没有消息" />}
          </div>
        </div>
        <div className="composer">
          <div className="composer-inner">
            {q && (
              <div className="hint-row"><Icon name="message" size="sm" /><span>agent 在等你回答：{q.text}</span></div>
            )}
            <div className="composer-box">
              <AutoTextarea value={text} onChange={setText} onSubmit={() => void sendText(text)} disabled={busy === 'send'}
                placeholder={q ? '回答 agent 的问题，Enter 发送' : task?.state === 'paused' ? '发一句话即可在原会话继续' : '追加一句话，送入当前会话'} />
              <Btn className="accent sm" icon="send" busy={busy === 'send'} disabled={!text.trim()} onClick={() => void sendText(text)}>发送</Btn>
            </div>
          </div>
        </div>
      </div>

      <aside className={`aside${asideOpen ? ' open' : ''}`} aria-label="任务详情">
        {asideOpen && <div className="row end" style={{ padding: '8px 10px 0' }}><Btn className="ghost icon sm" icon="x" aria-label="收起" onClick={() => setAsideOpen(false)} /></div>}
        <div className="aside-sec">
          <h4>任务</h4>
          <div className="row" style={{ marginBottom: 10 }}>
            <SourceBadge source={task?.source} url={task?.source?.url} />
            <PrioBadge priority={task?.priority} />
            {task?.prUrl && <a className="badge" href={task.prUrl} target="_blank" rel="noreferrer"><Icon name="pr" size="sm" />PR<Icon name="external" size="sm" /></a>}
          </div>
          <dl className="kv">
            <dt>仓库</dt><dd className="mono">{task?.repo?.name ?? <span className="muted">待确认</span>}</dd>
            {task?.decision?.baseBranch && <><dt>基线</dt><dd className="mono">{task.decision.baseBranch}</dd></>}
            {task?.branchName && <><dt>分支</dt><dd className="mono">{task.branchName}</dd></>}
            <dt>执行</dt><dd>{task?.runtime ?? '-'} · {task?.agent ?? '-'}</dd>
            <dt>更新</dt><dd><Time iso={task?.updatedAt} /></dd>
          </dl>
        </div>

        {task?.triageCard && (
          <div className="aside-sec">
            <h4><Icon name="sparkles" size="sm" />分流卡{task.triageCard.degraded && <span className="badge warn">不完整</span>}</h4>
            <div className="small muted" style={{ marginBottom: 6 }}>{PATH_LABEL[task.triageCard.tier] ?? task.triageCard.tier} · {EFFORT_LABEL[task.triageCard.effort] ?? task.triageCard.effort}</div>
            {task.triageCard.suggestedPath && <div style={{ marginBottom: 8 }}>{task.triageCard.suggestedPath}</div>}
            {!!task.triageCard.codeLocations?.length && (
              <details>
                <summary className="small muted" style={{ cursor: 'pointer' }}>代码定位 {task.triageCard.codeLocations.length} 处</summary>
                <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                  {task.triageCard.codeLocations.map((l: any, i: number) => <div key={i} className="small"><div className="mono">{l.file}{l.line ? `:${l.line}` : ''}</div>{l.why && <div className="muted">{l.why}</div>}</div>)}
                </div>
              </details>
            )}
          </div>
        )}

        <div className="aside-sec">
          <h4><Icon name="terminal" size="sm" />会话</h4>
          {!task?.sessions?.length && <div className="small muted">还没有会话</div>}
          {(task?.sessions ?? []).map((x: any) => (
            <div key={x.id} className="session">
              <div className="row between">
                <span className="row"><span className={`dot ${x.state === 'running' ? 'on pulse' : x.state === 'failed' || x.state === 'lost' ? 'off' : x.state === 'waiting_input' ? 'warn' : ''}`} />
                  <b>{SESSION_KIND_LABEL[x.kind] ?? x.kind}</b><span className="small muted">{x.agent}</span></span>
                <span className="small muted">{SESSION_STATE_LABEL[x.state] ?? x.state}</span>
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>{x.runtime ?? task.runtime} · <Time iso={x.startedAt ?? x.createdAt} />{x.worktreePath ? <> · <span className="mono">{x.worktreePath}</span></> : null}</div>
              {x.failureReason && <div className="small" style={{ color: 'var(--bad-text)', marginTop: 4 }}>{x.failureReason}</div>}
              <div className="row" style={{ marginTop: 8 }}>
                <Btn className="sm" icon="terminal" onClick={() => showLogs(x)}>日志</Btn>
                {['running', 'waiting_input'].includes(x.state) && <Btn className="sm danger" icon="stop" busy={busy === `stop:${x.id}`} onClick={() => run(`stop:${x.id}`, () => api(`/api/sessions/${x.id}/stop`, { method: 'POST' }), '会话已停止，任务暂停')}>停止</Btn>}
              </div>
            </div>
          ))}
        </div>

        {!!task?.children?.length && (
          <div className="aside-sec">
            <h4>子任务</h4>
            {task.children.map((c: any) => (
              <button key={c.key} className="thread-row" onClick={() => navigate(`/c/${c.channel}/t/${c.key}`)}>
                <span className="k">{c.key}</span><span className="ttl">{c.kind === 'review' ? `review（${c.agent}）` : cleanTitle(c.title)}</span><StateBadge state={c.state} />
              </button>
            ))}
          </div>
        )}

        {!!task?.artifacts?.length && (
          <div className="aside-sec">
            <h4>产物</h4>
            <div className="stack" style={{ gap: 6 }}>
              {task.artifacts.map((a: any) => (
                <div key={a.id} className="row small"><Icon name={a.kind === 'pr' ? 'pr' : a.kind === 'branch' ? 'branch' : 'file'} size="sm" />
                  {a.url ? <a href={a.url} target="_blank" rel="noreferrer" className="ellipsis">{a.title ?? a.url}</a> : <span className="mono ellipsis">{a.path ?? a.branch ?? a.kind}</span>}</div>
              ))}
            </div>
          </div>
        )}

        {!!task?.pendingApprovals?.length && (
          <div className="aside-sec">
            <h4>待处理审批</h4>
            {task.pendingApprovals.map((a: any) => <button key={a.key} className="thread-row" onClick={() => navigate('/inbox')}><span className="k">{a.key}</span><span className="ttl">{a.title}</span><Icon name="chevronRight" size="sm" /></button>)}
          </div>
        )}

        {task?.contextPack && (
          <div className="aside-sec">
            <h4>需求原文{task.contextPack.partial && <span className="badge warn">不完整</span>}</h4>
            <details>
              <summary className="small" style={{ cursor: 'pointer' }}>{task.contextPack.summary?.slice(0, 60) || '展开'}</summary>
              <pre style={{ marginTop: 8 }}>{task.contextPack.sourceText}</pre>
              {task.contextPack.planDoc && <><div className="section-title">方案</div><pre>{task.contextPack.planDoc}</pre></>}
            </details>
          </div>
        )}
      </aside>

      {logs && (
        <Drawer title={<><Icon name="terminal" />{SESSION_KIND_LABEL[logs.session.kind] ?? logs.session.kind}会话日志<span className="small muted" style={{ fontWeight: 400 }}>{logs.session.agent} · {logs.lines.length} 行</span></>}
          onClose={() => setLogs(null)} actions={<Btn className="sm" icon="refresh" onClick={() => showLogs(logs.session)}>刷新</Btn>}>
          <pre>{logs.lines.length ? logs.lines.join('\n') : '（还没有日志）'}</pre>
        </Drawer>
      )}
    </div>
  );
}
