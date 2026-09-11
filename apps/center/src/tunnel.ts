/**
 * 反向隧道管理（来源：S05 Step 6–7、EX-7.1；core-03 §4 S05.2）
 * 为 transport=reverse-tunnel 的 runtime 维持 `ssh -N -R <remote>:127.0.0.1:<local> <target>`，
 * 断线按 5s/10s/30s 退避重连；非临时错误（如免密未配置）不重试。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Clock } from './clock.js';
import type { Db } from './db.js';
import type { Logger } from 'pino';
import type { Notifications } from './domain/notifications.js';

export interface TunnelStatus { name: string; state: 'up' | 'down' | 'reconnecting'; reconnects: number; lastError: string | null; since: string | null; downSince: string | null }

const BACKOFF = [5_000, 10_000, 30_000];

export class TunnelManager {
  private tunnels = new Map<string, { proc: ChildProcess | null; status: TunnelStatus; wanted: boolean; attempt: number; cancelRetry?: () => void; alerted: boolean }>();

  constructor(private deps: { db: Db; clock: Clock; log: Logger; sshBin: string; tunnels: Record<string, { ssh: string; remote_port: number; local_port: number }>; notifications: Notifications }) {}

  list() { return [...this.tunnels.values()].map((t) => t.status); }
  status(name: string) { return this.tunnels.get(name)?.status ?? null; }

  async up(name: string): Promise<TunnelStatus> {
    const cfg = this.deps.tunnels[name];
    if (!cfg) throw new Error(`tunnel ${name} 未在 center.yaml tunnels 中配置`);
    let t = this.tunnels.get(name);
    if (!t) {
      t = { proc: null, status: { name, state: 'down', reconnects: 0, lastError: null, since: null, downSince: null }, wanted: true, attempt: 0, alerted: false };
      this.tunnels.set(name, t);
    }
    t.wanted = true;
    if (t.proc) return t.status;
    await this.spawnOnce(name);
    return t.status;
  }

  async down(name: string) {
    const t = this.tunnels.get(name); if (!t) return;
    t.wanted = false; t.cancelRetry?.();
    t.proc?.kill(); t.proc = null;
    t.status.state = 'down';
    await this.persist(name);
  }

  private async spawnOnce(name: string) {
    const t = this.tunnels.get(name)!; const cfg = this.deps.tunnels[name]!;
    const args = ['-N', '-R', `${cfg.remote_port}:127.0.0.1:${cfg.local_port}`, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', cfg.ssh];
    const proc = spawn(this.deps.sshBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    t.proc = proc;
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += String(d)));
    // 认为启动即 up；真实断线由 exit 事件反映
    t.status.state = 'up'; t.status.since = this.deps.clock.now().toISOString(); t.status.downSince = null;
    await this.persist(name);
    proc.on('exit', (code) => { void this.onExit(name, code, stderr); });
    proc.on('error', (err) => { void this.onExit(name, -1, String(err)); });
  }

  private async onExit(name: string, code: number | null, stderr: string) {
    const t = this.tunnels.get(name); if (!t) return;
    t.proc = null;
    t.status.lastError = (stderr || `exit ${code}`).trim().slice(0, 500);
    t.status.downSince = t.status.downSince ?? this.deps.clock.now().toISOString();
    if (!t.wanted) { t.status.state = 'down'; await this.persist(name); return; }
    const permanent = /Permission denied|Host key verification failed|Could not resolve hostname/i.test(stderr);
    if (permanent) { t.status.state = 'down'; this.deps.log.error({ tunnel: name, stderr }, 'tunnel permanent failure'); await this.persist(name); return; }
    t.status.state = 'reconnecting';
    const delay = BACKOFF[Math.min(t.attempt, BACKOFF.length - 1)]!;
    t.attempt += 1;
    await this.persist(name);
    t.cancelRetry = this.deps.clock.after(delay, async () => {
      if (!t.wanted) return;
      t.status.reconnects += 1;
      await this.spawnOnce(name);
    });
    // 5 分钟仍未恢复：告警一次
    this.deps.clock.after(5 * 60_000, async () => {
      if (t.wanted && t.status.state !== 'up' && !t.alerted) {
        t.alerted = true;
        await this.deps.notifications.alertOnce(`${name} 离线`, `${name} 离线 5 分钟（隧道无法重建）`);
      }
    });
  }

  private async persist(name: string) {
    const s = this.tunnels.get(name)!.status;
    await this.deps.db.query(`UPDATE runtimes SET tunnel_state=$2, tunnel_reconnects=$3, tunnel_last_error=$4 WHERE name=$1`, [name, s.state, s.reconnects, s.lastError]);
  }

  /** 测试用：模拟 ssh 进程意外退出（不改变 wanted），等待 exit 处理完成 */
  killForTest(name: string): Promise<void> {
    const t = this.tunnels.get(name);
    const proc = t?.proc;
    if (!proc) return Promise.resolve();
    return new Promise((res) => { proc.once('exit', () => setTimeout(res, 50)); proc.kill('SIGTERM'); });
  }

  closeAll() { for (const [n] of this.tunnels) void this.down(n); }

  /** 测试用：关掉所有隧道并清空状态（计数归零） */
  async resetForTest() {
    for (const [n, t] of this.tunnels) { t.wanted = false; t.cancelRetry?.(); if (t.proc) { const p = t.proc; await new Promise<void>((res) => { p.once('exit', () => res()); p.kill('SIGTERM'); setTimeout(res, 500); }); } await this.persist(n).catch(() => undefined); }
    this.tunnels.clear();
  }
}
