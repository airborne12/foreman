import type { Context, MiddlewareHandler } from 'hono';
import { ApiError } from '@foreman/shared';
import { z, type ZodTypeAny } from 'zod';

export function bearer(c: Context): string {
  const h = c.req.header('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

export function requirePanel(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (bearer(c) !== token) throw new ApiError(401, 'UNAUTHORIZED');
    await next();
  };
}

export function requireWorker(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (bearer(c) !== token) throw new ApiError(401, 'AUTH_INVALID');
    await next();
  };
}

export async function parseBody<T extends ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  try { raw = await c.req.json(); } catch { raw = {}; }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError(422, 'VALIDATION_FAILED', undefined, { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

export function parseQuery<T extends ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw new ApiError(422, 'VALIDATION_FAILED', undefined, { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}
