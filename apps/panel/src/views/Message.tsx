import { PATH_LABEL, RETRY_LABEL, STATE_LABEL, humanize } from '../api';
import { navigate } from '../app';
import { Btn, Icon, Time } from '../ui';

export type DraftAction = { id: string; action: 'confirm' | 'cancel'; force?: boolean };

/** 线程/频道内的消息渲染（core-02 §2.4；§5.1 #8 系统事件转人话） */
export function MessageRow({ m, onDraft, onPick, busy, pendingApprovals }: { m: any; onDraft?: (a: DraftAction) => void; onPick?: (text: string) => void; busy?: boolean; pendingApprovals?: Set<string> }) {
  const p = m.payload ?? {};
  const time = <Time className="time" iso={m.createdAt} />;

  if (m.kind === 'draft_card') {
    const f = p.fields ?? {};
    const status: string = p.status ?? 'open';
    const rows: Array<[string, unknown]> = [['来源', f.source], ['标题', f.sourceTitle], ['仓库', f.repo], ['档位', PATH_LABEL[f.path] ?? f.path], ['pick', (f.pickTargets ?? []).join(', ')], ['runtime', f.runtime], ['agent', f.agent]];
    return (
      <div className={`mcard ${status === 'confirmed' ? 'go' : status === 'open' ? 'info' : ''}`}>
        <div className="mhead"><Icon name="file" size="sm" />任务草案<span className="badge">{m.author === 'system' ? '命令' : `调度员 ${m.author}`}</span>{time}</div>
        <dl className="kv">{rows.filter(([, v]) => v).map(([k, v]) => <FragmentKV key={k} k={k} v={String(v)} />)}</dl>
        {!!p.highlight?.length && status === 'open' && <div className="callout warn" style={{ marginTop: 10 }}><Icon name="alert" size="sm" />还缺：{p.highlight.map((h: string) => ({ source: '来源', repo: '仓库', path: '档位' } as Record<string, string>)[h] ?? h).join('、')}</div>}
        {p.existing && status === 'open' && (
          <div className="callout warn" style={{ marginTop: 10 }}>
            <Icon name="alert" size="sm" />
            <div className="grow">{f.source} 已有任务 <b>{p.existing.key}</b>（{STATE_LABEL[p.existing.state] ?? p.existing.state}），多半不用再建</div>
            <Btn className="sm" onClick={() => navigate(`/c/${p.existing.channel}/t/${p.existing.key}`)}>打开 {p.existing.key}</Btn>
          </div>
        )}
        {status === 'open' && onDraft && m.refId && (
          <div className="row end" style={{ marginTop: 10 }}>
            <Btn disabled={busy} onClick={() => onDraft({ id: m.refId, action: 'cancel' })}>取消</Btn>
            {p.existing
              ? <Btn busy={busy} onClick={() => onDraft({ id: m.refId, action: 'confirm', force: true })}>仍要新建</Btn>
              : <Btn className="go" icon="check" busy={busy} onClick={() => onDraft({ id: m.refId, action: 'confirm' })}>创建任务</Btn>}
          </div>
        )}
        {status === 'confirmed' && p.taskKey && <div className="row" style={{ marginTop: 10 }}><span className="badge go"><Icon name="check" size="sm" />已创建</span><a href={`/c/${m.channel}/t/${p.taskKey}`} onClick={(e) => { e.preventDefault(); navigate(`/c/${m.channel}/t/${p.taskKey}`); }}>{p.taskKey} →</a></div>}
        {status === 'cancelled' && <div className="small muted" style={{ marginTop: 8 }}>已取消</div>}
      </div>
    );
  }
  if (m.kind === 'artifact_card') {
    const icon = p.kind === 'pr' ? 'pr' : p.kind === 'branch' ? 'branch' : p.kind === 'review' ? 'checkCircle' : 'file';
    const verdict = p.kind === 'review' ? ({ approve: ['可以合', 'go'], request_changes: ['需要修改', 'bad'], comment: ['只有建议', 'warn'] } as Record<string, [string, string]>)[p.verdict] : null;
    return (
      <div className={`mcard ${verdict?.[1] === 'bad' ? 'bad' : 'go'}`}>
        <div className="mhead"><Icon name={icon} size="sm" />{p.kind === 'pr' ? 'PR 已创建' : p.kind === 'doc' ? '方案已产出' : p.kind === 'branch' ? '分支已推送' : p.kind === 'review' ? 'Review 结论' : `产物 ${p.kind}`}
          {verdict && <span className={`badge ${verdict[1]}`}>{verdict[0]}</span>}<span className="badge">{m.author}</span>{time}</div>
        {p.kind === 'review' && (
          <div className="stack small" style={{ gap: 4, marginBottom: 6 }}>
            {!!p.mustFix?.length && <div><b>必须修</b><ul style={{ margin: '2px 0 0 18px', padding: 0 }}>{p.mustFix.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>}
            {!!p.suggestions?.length && <div><b>建议</b><ul style={{ margin: '2px 0 0 18px', padding: 0 }}>{p.suggestions.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>}
            {!p.mustFix?.length && !p.suggestions?.length && <div className="muted">没有问题</div>}
          </div>
        )}
        {p.url && <div><a href={p.url} target="_blank" rel="noreferrer">{p.title ?? p.url} <Icon name="external" size="sm" /></a></div>}
        {p.branch && <div className="mono small">{p.branch}</div>}
        {p.diffStat && <div className="small muted">+{p.diffStat.additions} −{p.diffStat.deletions} · {p.diffStat.files} 个文件</div>}
        {m.text && !/^产物：/.test(m.text) && <div className="small muted" style={{ marginTop: 4 }}>{m.text}</div>}
        {p.content && <details style={{ marginTop: 8 }}><summary className="small muted" style={{ cursor: 'pointer' }}>展开全文</summary><pre style={{ marginTop: 6 }}>{p.content}</pre></details>}
      </div>
    );
  }
  if (m.kind === 'failure_card') {
    return (
      <div className="mcard bad">
        <div className="mhead"><Icon name="alert" size="sm" />失败{time}</div>
        <div>{humanize(m.text)}</div>
        {!!p.options?.length && <div className="small muted" style={{ marginTop: 4 }}>可选：{p.options.map((o: string) => RETRY_LABEL[o] ?? o).join(' / ')}（在收件箱处理）</div>}
      </div>
    );
  }
  if (m.kind === 'approval_card') {
    // 线程里的审批卡是入库时的快照：已处理的收起成一行，不再引导去收件箱
    if (pendingApprovals && p.approvalKey && !pendingApprovals.has(p.approvalKey)) {
      return (
        <div className="ev"><span className="rail"><span className="dot" /></span>
          <span className="txt"><span className="badge mono" style={{ marginRight: 6 }}>{p.approvalKey}</span>{m.text}</span>{time}</div>
      );
    }
    return (
      <div className="mcard warn">
        <div className="mhead"><Icon name="check" size="sm" />待拍板{p.approvalKey && <span className="badge mono">{p.approvalKey}</span>}{time}</div>
        <div>{m.text}</div>
        <div className="row" style={{ marginTop: 8 }}><Btn className="sm" icon="inbox" onClick={() => navigate(p.approvalKey ? `/inbox?sel=a:${p.approvalKey}` : '/inbox')}>去收件箱处理</Btn></div>
      </div>
    );
  }
  if (m.kind === 'ask') {
    return (
      <div className="mcard info">
        <div className="mhead"><Icon name="message" size="sm" />{m.author} 在问{time}</div>
        <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
        {!!p.options?.length && onPick && <div className="chips" style={{ marginTop: 8 }}>{p.options.map((o: string) => <button key={o} className="chip" disabled={busy} onClick={() => onPick(o)}>{o}</button>)}</div>}
      </div>
    );
  }
  if (m.kind === 'clarification') {
    return (
      <div className="msg">
        <Avatar who={m.author} />
        <div className="body">
          <div className="who"><b>{m.author === 'system' ? '系统' : `调度员 ${m.author}`}</b>{time}</div>
          <div className="text">{m.text}</div>
          {!!p.candidates?.length && <div className="chips" style={{ marginTop: 8 }}>{p.candidates.map((c: any) => <button key={c.value} className="chip" disabled={busy || !onPick} onClick={() => onPick?.(c.value)}>{c.label}</button>)}</div>}
        </div>
      </div>
    );
  }
  if (m.kind === 'user' || m.kind === 'user_reply') {
    return (
      <div className="msg user">
        <Avatar who="user" />
        <div className="body">
          <div className="who"><b>我</b>{time}{m.delivery === 'queued' && <span className="badge warn">待送达</span>}</div>
          <div className="text">{m.text}</div>
        </div>
      </div>
    );
  }
  if (m.kind === 'progress' || m.kind === 'dispatcher') {
    return (
      <div className="msg">
        <Avatar who={m.author} />
        <div className="body">
          <div className="who"><b>{m.author}</b>{time}{p.truncated && <span className="badge">已截断</span>}</div>
          <div className="text">{m.text}</div>
        </div>
      </div>
    );
  }
  // 系统事件：时间线上的一行小字；原串留在悬停提示里
  const text = humanize(m.text ?? '');
  const tone = p.level === 'error' ? 'off' : p.level === 'warn' ? 'warn' : '';
  return (
    <div className="ev" title={text !== m.text ? m.text : undefined}>
      <span className="rail"><span className={`dot ${tone}`} /></span>
      <span className="txt">{text}</span>
      {time}
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return <><dt>{k}</dt><dd className={k === '来源' || k === '仓库' ? 'mono' : undefined}>{v}</dd></>;
}

export function Avatar({ who }: { who?: string | null }) {
  const w = (who ?? '').toLowerCase();
  const cls = w.includes('codex') ? 'codex' : w === 'user' ? 'user' : '';
  const label = w === 'user' ? '我' : w.includes('codex') ? 'Cx' : <Icon name="bot" size="sm" />;
  return <span className={`avatar ${cls}`} aria-hidden="true">{label}</span>;
}
