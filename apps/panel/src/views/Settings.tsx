import { useEffect, useState } from 'react';
import { api } from '../api';

/** 设置（只读展示中心配置） */
export function Settings() {
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/api/system/settings').then(setS).catch((e) => setErr(String(e.message))); }, []);
  return (
    <>
      <main className="main">
        <div className="head"><h1>设置</h1><span className="sub">改动请编辑中心机 ~/.foreman/center.yaml 后重启</span></div>
        <div className="scroll">
          {err && <div className="banner">{err}</div>}
          {s && (
            <>
              <div className="card"><h3>来源默认频道</h3><pre>{JSON.stringify(s.sourceChannels, null, 2)}</pre></div>
              <div className="card"><h3>路由规则</h3><pre>{JSON.stringify(s.routing, null, 2)}</pre></div>
              <div className="card"><h3>agent 并发</h3><pre>{JSON.stringify(s.agentConcurrency, null, 2)}</pre></div>
              <div className="card"><h3>飞书</h3><pre>{JSON.stringify(s.feishu, null, 2)}</pre></div>
              <div className="card"><h3>Jira</h3><pre>{JSON.stringify(s.jira, null, 2)}</pre></div>
              <div className="card"><h3>信任与 worktree</h3><pre>{JSON.stringify({ trust: s.trust, worktree: s.worktree }, null, 2)}</pre></div>
            </>
          )}
        </div>
      </main>
      <aside className="aside"><div className="meta">M1 的设置是只读的，改配置要在中心机改 center.yaml 并重启。</div></aside>
    </>
  );
}
