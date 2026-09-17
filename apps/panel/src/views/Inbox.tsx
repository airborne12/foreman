import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, ACTION_LABEL, PATH_LABEL, fmtTime } from '../api';
import { navigate } from '../app';

type Item = { kind: 'approval' | 'question' | 'failure' | 'candidate'; id: string; data: any };

/** 收件箱（core-02 §2.1、S03.1）：待拍板 / 需要输入 / 失败三选一 / 候选 */
export function Inbox({ rev }: { rev: number }) {
  const [data, setData] = useState<any>({ approvals: [], questions: [], failures: [], candidates: [] });
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [runtimes, setRuntimes] = useState<any[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try { const [inbox, rts] = await Promise.all([api('/api/inbox'), api('/api/runtimes')]); setData(inbox); setRuntimes(rts.items ?? []); }
    catch (e) { setErr(String((e as Error).message)); }
  }, []);
  useEffect(() => { void load(); }, [rev, load]);

  const items: Item[] = [
    ...(data.approvals ?? []).map((a: any) => ({ kind: 'approval' as const, id: a.key, data: a })),
    ...(data.questions ?? []).map((q: any) => ({ kind: 'question' as const, id: q.id, data: q })),
    ...(data.failures ?? []).map((f: any) => ({ kind: 'failure' as const, id: f.key, data: f })),
    ...(data.candidates ?? []).map((c: any) => ({ kind: 'candidate' as const, id: c.id, data: c })),
  ];
  const current = items[Math.min(sel, items.length - 1)];

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setErr('');
    try { await fn(); await load(); }
    catch (e) { setErr(e instanceof ApiError ? `${e.code}：${e.message}` : String((e as Error).message)); }
    finally { setBusy(''); }
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'j') setSel((s) => Math.min(s + 1, items.length - 1));
      if (e.key === 'k') setSel((s) => Math.max(s - 1, 0));
      if (e.key === 'Enter' && current) {
        const key = current.kind === 'approval' ? current.data.taskKey : current.kind === 'question' ? current.data.taskKey : current.kind === 'failure' ? current.data.key : null;
        if (key) navigate(`/c/${current.data.channel ?? 'jira'}/t/${key}`);
      }
    };
    window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on);
  }, [items.length, current]);

  return (
    <>
      <main className="main">
        <div className="head">
          <h1>收件箱</h1>
          <span className="sub">{items.length} 项待处理 · <span className="kbd">j</span>/<span className="kbd">k</span> 移动 <span className="kbd">Enter</span> 打开</span>
        </div>
        <div className="scroll" ref={listRef}>
          {err && <div className="banner">{err}</div>}
          {!items.length && <div className="empty">没有待处理的事项</div>}
          {items.map((it, i) => (
            <div key={`${it.kind}-${it.id}`} onClick={() => setSel(i)}>
              {it.kind === 'approval' && <ApprovalCard a={it.data} runtimes={runtimes} selected={i === sel} busy={busy} act={act} />}
              {it.kind === 'question' && <QuestionCard q={it.data} selected={i === sel} busy={busy} act={act} />}
              {it.kind === 'failure' && <FailureCard t={it.data} selected={i === sel} busy={busy} act={act} />}
              {it.kind === 'candidate' && <CandidateCard c={it.data} selected={i === sel} busy={busy} act={act} />}
            </div>
          ))}
        </div>
      </main>
      <aside className="aside">
        <div className="sec"><h4>说明</h4>
          <div className="meta">待拍板与审批可直接在这里处理；飞书上的 ✅ / ❌ 等价，先到先得。</div>
        </div>
        <div className="sec"><h4>计数</h4>
          <table><tbody>
            <tr><td>待拍板 / 审批</td><td>{data.approvals?.length ?? 0}</td></tr>
            <tr><td>需要输入</td><td>{data.questions?.length ?? 0}</td></tr>
            <tr><td>失败</td><td>{data.failures?.length ?? 0}</td></tr>
            <tr><td>候选</td><td>{data.candidates?.length ?? 0}</td></tr>
          </tbody></table>
        </div>
      </aside>
    </>
  );
}

/** 分流卡与普通审批卡（S03.1）：可改档位 / 仓库 / runtime / agent */
function ApprovalCard({ a, runtimes, selected, busy, act }: any) {
  const p = a.payload ?? {};
  const isTriage = a.actionType === 'triage_confirm';
  const [ov, setOv] = useState<Record<string, string>>({});
  const [body, setBody] = useState<string>(a.body ?? '');
  const [comment, setComment] = useState('');
  const [rejecting, setRejecting] = useState(false);
  useEffect(() => { setOv({}); setBody(a.body ?? ''); }, [a.key, a.bodyHash]);

  const repoCandidates: string[] = [p.repo?.name, ...(p.repo?.candidates ?? [])].filter(Boolean);
  const modified = Object.keys(ov).length > 0 || (!isTriage && body !== a.body);
  const repoMissing = isTriage && !p.repo?.name && !ov.repo;
  const decide = (decision: 'approve' | 'reject') => act(a.key, () => api(`/api/approvals/${a.key}/decide`, {
    method: 'POST',
    body: { decision, bodyHash: a.bodyHash, ...(isTriage ? { overrides: Object.keys(ov).length ? ov : null } : { editedBody: body !== a.body ? body : null }), comment: comment || null },
  }));

  return (
    <div className={`card approval${selected ? ' selected' : ''}`}>
      <h3>
        <span className="tag">{a.key}</span>
        <span>{ACTION_LABEL[a.actionType] ?? a.actionType}</span>
        {a.taskKey && <button className="ghost" style={{ fontSize: 12 }} onClick={() => navigate(`/c/${p.channel ?? 'jira'}/t/${a.taskKey}`)}>查看任务线程 {a.taskKey}</button>}
        <span className="meta" style={{ marginLeft: 'auto' }}>信任 {a.trustStreak}/5</span>
      </h3>
      {/* 先说清「这是哪个单、原始问题是什么」，再说「要做什么」——否则卡片上全是执行细节，没法判断 */}
      {(a.taskTitle || a.taskSource) && (
        <div style={{ marginTop: 2 }}>
          {a.taskSource && <span className="tag">{a.taskSource}</span>}
          <span style={{ marginLeft: a.taskSource ? 6 : 0 }}>{a.taskTitle}</span>
        </div>
      )}
      <div className="meta" style={{ marginTop: 4 }}>{a.title}</div>
      {p.degraded && <div className="banner" style={{ marginTop: 8 }}>{p.degradedReason ?? '代码定位待补'}</div>}
      {a.status === 'failed' && <div className="banner" style={{ marginTop: 8 }}>执行失败，可重试：{a.payload?.error ?? ''}</div>}

      {isTriage ? (
        <>
          <div className="grid2">
            <div className="field"><label>档位</label>
              <select value={ov.path ?? p.tier ?? 'fix'} onChange={(e) => setOv({ ...ov, path: e.target.value })}>
                {['fix', 'plan', 'proto'].map((x) => <option key={x} value={x}>{PATH_LABEL[x]}</option>)}
              </select>
            </div>
            <div className="field"><label>工作量</label><input readOnly value={{ small: '小（<2h）', medium: '中（半天）', large: '大（>1 天）' }[p.effort as string] ?? p.effort ?? '-'} /></div>
            <div className="field"><label>目标仓库{repoMissing ? '（待确认）' : ''}</label>
              <select value={ov.repo ?? p.repo?.name ?? ''} onChange={(e) => setOv({ ...ov, repo: e.target.value })} style={repoMissing ? { borderColor: 'var(--warn)' } : undefined}>
                <option value="">（未选）</option>
                {repoCandidates.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            {/* 基线分支：仓库级默认常常不是任务要改的那条线，拍板时必须能看见并改 */}
            <div className="field"><label>基线分支</label>
              <input
                value={ov.baseBranch ?? p.baseBranch ?? ''}
                placeholder="留空＝用仓库默认基线"
                onChange={(e) => setOv({ ...ov, baseBranch: e.target.value })}
              />
            </div>
            <div className="field"><label>runtime</label>
              <select value={ov.runtime ?? p.defaultRuntime ?? ''} onChange={(e) => setOv({ ...ov, runtime: e.target.value })}>
                <option value="">（按路由规则）</option>
                {runtimes.map((r: any) => <option key={r.name} value={r.name} disabled={!r.online}>{r.name}{r.online ? '' : '（离线）'}</option>)}
              </select>
            </div>
            <div className="field"><label>agent</label>
              <select value={ov.agent ?? p.defaultAgent ?? ''} onChange={(e) => setOv({ ...ov, agent: e.target.value })}>
                <option value="">（按轮换）</option>{['claude', 'codex'].map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
          </div>
          {p.suggestedPath && <div className="meta">建议：{p.suggestedPath}</div>}
          {!!p.codeLocations?.length && (
            <details style={{ marginTop: 6 }}>
              <summary>代码定位 {p.codeLocations.length} 处</summary>
              <pre>{p.codeLocations.map((l: any) => `${l.file}${l.line ? ':' + l.line : ''}${l.why ? '  // ' + l.why : ''}`).join('\n')}</pre>
            </details>
          )}
        </>
      ) : (
        <>
          {/* 执行摘要：拍板前要看的是「到底会对什么东西做什么」，这些字段原来只在 payload 里，面板不显示 */}
          {(() => {
            const rows: Array<[string, string]> = ([
              ['仓库', p.repo], ['推送到', p.pushRemote ?? p.pushUrl], ['源分支', p.head], ['目标分支', p.base],
              ['提交', typeof p.commit === 'string' ? p.commit.slice(0, 12) : p.commit], ['执行方式', p.executor],
            ] as Array<[string, unknown]>).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => [k, String(v)]);
            return rows.length ? (
              <div className="grid2" style={{ marginTop: 8 }}>
                {rows.map(([k, v]) => <div className="field" key={k}><label>{k}</label><input readOnly value={v} /></div>)}
              </div>
            ) : null;
          })()}
          {/* 正文默认就能读完，不要塞进输入框让人以为是待填项 */}
          <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 360, overflowY: 'auto' }}>{body}</pre>
          <details style={{ marginTop: 6 }}>
            <summary>改写正文后执行</summary>
            <textarea rows={Math.min(16, (a.body ?? '').split('\n').length + 1)} value={body} onChange={(e) => setBody(e.target.value)} style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 12 }} />
          </details>
        </>
      )}

      {rejecting && <input placeholder="否决原因（可空）" value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginTop: 8 }} />}
      <div className="row end" style={{ marginTop: 10 }}>
        <span className="meta" style={{ marginRight: 'auto' }}>{fmtTime(a.createdAt)}{modified ? ' · 已修改' : ''}</span>
        {!rejecting && <button className="danger" onClick={() => setRejecting(true)} disabled={!!busy}>否决</button>}
        {rejecting && <button onClick={() => setRejecting(false)}>取消</button>}
        {rejecting && <button className="danger" onClick={() => decide('reject')} disabled={busy === a.key}>确认否决</button>}
        <button className="primary" onClick={() => decide('approve')} disabled={!!busy || repoMissing}>
          {busy === a.key ? '执行中…' : repoMissing ? '先选仓库' : modified ? '按修改执行' : '按建议执行'}
        </button>
      </div>
    </div>
  );
}

function QuestionCard({ q, selected, busy, act }: any) {
  const [text, setText] = useState('');
  return (
    <div className={`card ask${selected ? ' selected' : ''}`}>
      <h3><span className="tag warn">需要输入</span><button className="ghost" style={{ fontSize: 12 }} onClick={() => navigate(`/c/jira/t/${q.taskKey}`)}>{q.taskKey}</button></h3>
      <div>{q.text}</div>
      {!!q.options?.length && <div className="row" style={{ marginTop: 6 }}>{q.options.map((o: string) => <button key={o} onClick={() => setText(o)}>{o}</button>)}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="回复即送入会话" />
        <button className="primary" disabled={!text.trim() || !!busy} onClick={() => act(q.id, () => api(`/api/tasks/${q.taskKey}/messages`, { method: 'POST', body: { text, questionId: q.id } }))}>送入</button>
      </div>
    </div>
  );
}

function FailureCard({ t, selected, busy, act }: any) {
  const retry = (mode: string) => act(t.key, () => api(`/api/tasks/${t.key}/retry`, { method: 'POST', body: { mode } }));
  const isRetryHint = t.state !== 'failed';
  return (
    <div className={`card failure${selected ? ' selected' : ''}`}>
      <h3><span className="tag bad">{isRetryHint ? '需要处理' : '失败'}</span><button className="ghost" style={{ fontSize: 12 }} onClick={() => navigate(`/c/${t.channel}/t/${t.key}`)}>{t.key}</button><span className="meta">{t.title}</span></h3>
      <div className="meta">{t.queueReason ?? t.failureReason ?? ''}</div>
      {!isRetryHint && (
        <div className="row end" style={{ marginTop: 10 }}>
          <button disabled={!!busy} onClick={() => retry('same_agent')}>重试</button>
          <button disabled={!!busy} onClick={() => retry('switch_agent')}>换 agent</button>
          <button disabled={!!busy} onClick={() => retry('fresh_session')}>新会话继续</button>
          <button className="danger" disabled={!!busy} onClick={() => retry('abandon')}>放弃</button>
        </div>
      )}
    </div>
  );
}

function CandidateCard({ c, selected, busy, act }: any) {
  return (
    <div className={`card${selected ? ' selected' : ''}`}>
      <h3><span className="tag">候选</span><span className="meta">{c.source?.chatName ?? c.source?.messageId} · 置信度 {c.confidence}</span></h3>
      <div>{c.text}</div>
      <div className="meta">{c.reason}</div>
      <div className="row end" style={{ marginTop: 10 }}>
        <button disabled={!!busy} onClick={() => act(c.id, () => api(`/api/candidates/${c.id}/dismiss`, { method: 'POST' }))}>忽略</button>
        <button className="primary" disabled={!!busy} onClick={() => act(c.id, () => api(`/api/candidates/${c.id}/intake`, { method: 'POST' }))}>入库</button>
      </div>
    </div>
  );
}
