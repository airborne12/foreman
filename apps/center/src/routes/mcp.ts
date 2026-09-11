/**
 * MCP 端点（api/mcp.yaml）：POST /mcp，Streamable HTTP 的 JSON-RPC 请求/响应子集；Bearer 为任务级 token。
 */
import { Hono } from 'hono';
import type { AppContext } from '../app.js';

export function mcpRoutes(app: AppContext) {
  const r = new Hono();
  r.post('/mcp', async (c) => {
    const h = c.req.header('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const session = await app.mcp.authenticate(token);
    if (!session) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'UNAUTHORIZED: 任务 token 无效或已过期' } }, 401);
    let req: any;
    try { req = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    if (Array.isArray(req)) return c.json(await Promise.all(req.map((x) => app.mcp.handle(session, x))));
    if (req?.method && req.id === undefined) { void app.mcp.handle(session, req); return c.body(null, 202); }
    return c.json(await app.mcp.handle(session, req));
  });
  return r;
}
