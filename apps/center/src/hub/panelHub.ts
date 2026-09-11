/**
 * 面板事件通道（/ws/panel）。来源：panel-events.yaml。
 * 连接需 panelToken（query token= 或 Bearer）；lastEventId 补发；25 秒 ping。
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { EventBus, DomainEvent } from '../events.js';
import type { Clock } from '../clock.js';

export class PanelHub {
  readonly wss = new WebSocketServer({ noServer: true });
  private clients = new Set<WebSocket>();
  private stopPing: () => void;

  constructor(private deps: { events: EventBus; clock: Clock; panelToken: string }) {
    deps.events.on((e) => this.broadcast(e));
    this.stopPing = deps.clock.every(25_000, () => { for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.ping(); });
  }

  handleUpgrade(req: IncomingMessage, socket: any, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://x');
    const auth = req.headers['authorization'] ?? '';
    const token = url.searchParams.get('token') ?? (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (token !== this.deps.panelToken) { ws.close(4001, 'UNAUTHORIZED'); return; }
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    const last = url.searchParams.get('lastEventId');
    if (last) {
      const seqRow = await this.deps.events.since(0).then((all) => all.find((e) => e.id === last));
      const backlog = await this.deps.events.since(seqRow?.seq ?? 0);
      if (backlog.length > 500) ws.send(JSON.stringify({ type: 'resync.required', ts: this.deps.clock.now().toISOString(), payload: {} }));
      else for (const e of backlog) ws.send(JSON.stringify(toWire(e)));
    }
  }

  private broadcast(e: DomainEvent) {
    const msg = JSON.stringify(toWire(e));
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  }

  close() { this.stopPing(); for (const c of this.clients) c.close(1001, 'shutdown'); this.wss.close(); }
}

function toWire(e: DomainEvent) {
  return { id: e.id, type: e.type, ts: e.ts, taskKey: (e.payload as any)?.taskKey ?? (e.payload as any)?.task?.key ?? null, channel: (e.payload as any)?.channel ?? null, payload: e.payload };
}
