/**
 * 以测试模式在随机端口启动 center，注入 FakeClock 与 FakeFeishu。
 */
import { startApp, type StartedApp } from '../../apps/center/src/app.js';
import { FakeClock } from '../../apps/center/src/clock.js';
import { FakeFeishu } from '../../apps/center/src/adapters/feishu.js';
import { CenterConfig } from '@foreman/shared';
import pino from 'pino';

export const TEST_TOKEN = 'test-worker-token';
export const TEST_PANEL_TOKEN = 'test-panel-token';

export interface TestApp extends StartedApp { fakeClock: FakeClock; fakeFeishu: FakeFeishu; ws: string }

export async function bootTestApp(overrides?: Partial<CenterConfig>): Promise<TestApp> {
  const cfg = CenterConfig.parse({
    listen: '127.0.0.1:0',
    database: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:pg@127.0.0.1:54329/foreman',
    token: TEST_TOKEN,
    panel_token: TEST_PANEL_TOKEN,
    ssh_bin: process.env.FOREMAN_SSH_BIN ?? 'ssh',
    test_mode: true,
    feishu: { owner_open_id: 'ou_owner', bot_open_id: 'ou_bot', enabled: true },
    // 候选扫描在测试里只由 scheduler.tick 显式驱动（周期设成 1 天），避免推进时钟时自发扫描
    sources: { feishu: { scan_seconds: 86400 }, jira: { enabled: true, poll_seconds: 300, project_repo_map: { CIR: 'selectdb/selectdb-core' } } },
    tunnels: { dev: { ssh: 'jiangkai@10.26.20.3', remote_port: 7801, local_port: 7801 } },
    ...overrides,
  });
  const fakeClock = new FakeClock();
  const fakeFeishu = new FakeFeishu();
  // 端口取自 listen（默认 0 = 随机）；运行器需要固定端口时通过 overrides.listen 传入
  const app = await startApp(cfg, { clock: fakeClock, feishu: fakeFeishu, host: '127.0.0.1', log: pino({ level: process.env.LOG_LEVEL ?? 'silent' }) });
  await app.db.resetForTest();
  return Object.assign(app, { fakeClock, fakeFeishu, ws: app.url.replace('http', 'ws') });
}

export async function http(app: { url: string }, method: string, path: string, body?: unknown, token: string | null = TEST_PANEL_TOKEN) {
  const r = await fetch(app.url + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
