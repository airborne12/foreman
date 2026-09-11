import { PATH_LABEL, fmtTime } from '../api';

/** 线程/频道内的消息渲染（core-02 §2.4 消息类型） */
export function MessageRow({ m, onDraft }: { m: any; onDraft?: (id: string, action: 'confirm' | 'cancel') => void }) {
  const p = m.payload ?? {};
  if (m.kind === 'draft_card') {
    const f = p.fields ?? {};
    return (
      <div className="card draft">
        <h3><span className="tag">草案</span><span className="meta">{m.author}</span></h3>
        <div className="grid2">
          {[['来源', f.source], ['标题', f.sourceTitle], ['仓库', f.repo], ['档位', PATH_LABEL[f.path] ?? f.path], ['pick', (f.pickTargets ?? []).join(', ')], ['runtime', f.runtime], ['agent', f.agent]]
            .filter(([, v]) => v).map(([k, v]) => <div className="field" key={k as string}><label>{k as string}</label><div>{v as string}</div></div>)}
        </div>
        {!!p.highlight?.length && <div className="banner">待补字段：{p.highlight.join('、')}</div>}
        {onDraft && (
          <div className="row end" style={{ marginTop: 8 }}>
            <button onClick={() => onDraft(m.refId, 'cancel')}>取消</button>
            <button className="primary" onClick={() => onDraft(m.refId, 'confirm')}>创建任务</button>
          </div>
        )}
      </div>
    );
  }
  if (m.kind === 'artifact_card') {
    return (
      <div className="card artifact">
        <h3><span className="tag">产物 {p.kind}</span><span className="meta">{m.author}</span></h3>
        {p.url && <div><a href={p.url} target="_blank" rel="noreferrer">{p.title ?? p.url}</a></div>}
        {p.branch && <div className="mono">{p.branch}</div>}
        {p.diffStat && <div className="meta">+{p.diffStat.additions} −{p.diffStat.deletions} · {p.diffStat.files} 个文件</div>}
        {p.content && <details><summary>展开全文</summary><pre>{p.content}</pre></details>}
        <div className="meta">{m.text}</div>
      </div>
    );
  }
  if (m.kind === 'failure_card') {
    return <div className="card failure"><h3><span className="tag bad">失败</span></h3><div>{m.text}</div>{!!p.options?.length && <div className="meta">可选：{p.options.join(' / ')}</div>}</div>;
  }
  if (m.kind === 'approval_card') {
    return <div className="card approval"><h3><span className="tag">{p.approvalKey ?? '审批'}</span><span className="meta">{m.text}</span></h3><div className="meta">在收件箱处理</div></div>;
  }
  if (m.kind === 'ask') {
    return <div className="card ask"><h3><span className="tag warn">需要输入</span><span className="meta">{m.author}</span></h3><div>{m.text}</div></div>;
  }
  if (m.kind === 'clarification') {
    return (
      <div className="card"><h3><span className="tag">澄清</span><span className="meta">{m.author}</span></h3><div>{m.text}</div>
        {!!p.candidates?.length && <div className="row" style={{ marginTop: 6 }}>{p.candidates.map((c: any) => <span key={c.value} className="tag">{c.label}</span>)}</div>}
      </div>
    );
  }
  const cls = m.kind === 'user' || m.kind === 'user_reply' ? 'user' : m.kind === 'progress' ? 'progress' : 'system';
  return (
    <div className={`msg ${cls}`}>
      <div className="who">{m.author} · {fmtTime(m.createdAt)}{m.delivery === 'queued' ? ' · 待送达' : ''}{p.truncated ? ' · 已截断' : ''}</div>
      <div className="text">{m.text}</div>
    </div>
  );
}
