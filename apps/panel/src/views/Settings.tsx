import { useEffect, useState, type ReactNode } from 'react';
import { api, errText, ACTION_LABEL } from '../api';
import { Icon } from '../ui';

const ROUTE_LABEL: Record<string, string> = { code: '代码任务', analysis: '分析任务', text: '文本任务' };

/** 设置（只读展示中心配置，§5.1 #15：按语义渲染而不是 JSON 原文） */
export function Settings() {
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/api/system/settings').then(setS).catch((e) => setErr(errText(e))); }, []);
  return (
    <div className="content">
      <div className="pane">
        <div className="pane-head">
          <h1><Icon name="sliders" />设置</h1>
          <span className="sub">只读。要改就编辑中心机 <span className="mono">~/.foreman/center.yaml</span> 后重启中心服务</span>
        </div>
        <div className="pane-body">
          {err && <div className="callout bad" style={{ marginBottom: 14 }}><Icon name="alert" />{err}</div>}
          {s && (
            <div className="grid-cards">
              <Section icon="activity" title="任务路由">
                {Object.entries(s.routing ?? {}).map(([k, r]: [string, any]) => (
                  <Row key={k} k={ROUTE_LABEL[k] ?? k}>
                    {r.require?.length ? <>需要 {r.require.map((x: string) => <span key={x} className="badge mono" style={{ marginRight: 4 }}>{x}</span>)}</> : '任意 runtime'}
                    {r.prefer && <>，优先 <b className="mono">{r.prefer}</b></>}
                  </Row>
                ))}
              </Section>
              <Section icon="bot" title="agent 并发上限（每个 runtime）">
                {Object.entries(s.agentConcurrency ?? {}).map(([k, v]) => <Row key={k} k={k}>{String(v)} 个会话</Row>)}
              </Section>
              <Section icon="ticket" title="Jira">
                <Row k="轮询间隔">{s.jira?.pollSeconds ? `${s.jira.pollSeconds} 秒` : '未启用'}</Row>
                {Object.entries(s.jira?.projectRepoMap ?? {}).map(([p, r]) => <Row key={p} k={`项目 ${p}`}><span className="mono">{String(r)}</span></Row>)}
                {!Object.keys(s.jira?.projectRepoMap ?? {}).length && <Row k="项目映射"><span className="muted">没有配置，入库后要在分流卡上选仓库</span></Row>}
              </Section>
              <Section icon="hash" title="来源默认频道">
                {Object.entries(s.sourceChannels ?? {}).map(([k, v]) => <Row key={k} k={({ jira: 'Jira', feishu: '飞书', cli: '命令行', channel: '频道' } as Record<string, string>)[k] ?? k}><span className="mono">#{String(v)}</span></Row>)}
              </Section>
              <Section icon="shield" title="信任">
                <Row k="升级阈值">连续 {s.trust?.threshold} 次原样确认</Row>
                <Row k="永远人工">{(s.trust?.lockedManual ?? []).map((a: string) => ACTION_LABEL[a] ?? a).join('、') || '无'}</Row>
              </Section>
              <Section icon="folder" title="worktree">
                <Row k="保留">{s.worktree?.retainDays} 天</Row>
                <Row k="磁盘告警">使用率超过 {Math.round((s.worktree?.diskHighWatermark ?? 0) * 100)}%</Row>
              </Section>
              <Section icon="message" title="飞书">
                <Row k="应用">{s.feishu?.appId ? <span className="mono">{s.feishu.appId}</span> : <span className="muted">未配置</span>}</Row>
                <Row k="每日推送上限">{s.feishu?.dailyPushLimit ?? '-'} 条</Row>
                <Row k="表情">入库 {s.feishu?.intakeEmoji} · 批准 {s.feishu?.approveEmoji} · 否决 {s.feishu?.rejectEmoji}</Row>
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: Parameters<typeof Icon>[0]['name']; title: string; children: ReactNode }) {
  return <div className="card"><div className="row" style={{ marginBottom: 12, fontWeight: 600 }}><Icon name={icon} size="sm" />{title}</div><dl className="kv">{children}</dl></div>;
}
function Row({ k, children }: { k: string; children: ReactNode }) {
  return <><dt>{k}</dt><dd>{children}</dd></>;
}
