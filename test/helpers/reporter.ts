/**
 * OpenLogos reporter（来源：logos/spec/test-results.md）
 * 结果文件由 test/globalSetup.ts 在整轮开始时清空，这里只追加，避免多文件并行时互相覆盖。
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findRepoRoot } from '../../apps/center/src/db.js';

export const RESULT_PATH = resolve(findRepoRoot(), process.env.FOREMAN_RESULT_PATH ?? 'logos/resources/verify/test-results.jsonl');

export function reportResult(id: string, status: 'pass' | 'fail' | 'skip', error?: string, durationMs?: number, scenario?: string) {
  if (!existsSync(dirname(RESULT_PATH))) mkdirSync(dirname(RESULT_PATH), { recursive: true });
  const record: Record<string, unknown> = { id, status, timestamp: new Date().toISOString() };
  if (durationMs !== undefined) record.duration_ms = durationMs;
  if (error) record.error = error.slice(0, 2000);
  if (scenario) record.scenario = scenario; else { const m = id.match(/-(S\d{2})-/); if (m) record.scenario = m[1]; }
  appendFileSync(RESULT_PATH, JSON.stringify(record) + '\n');
}

/** 包装一个测试体：自动计时、上报、重抛 */
export async function withReport(id: string, fn: () => Promise<void> | void) {
  const start = Date.now();
  try { await fn(); reportResult(id, 'pass', undefined, Date.now() - start); }
  catch (e) { reportResult(id, 'fail', String((e as Error)?.stack ?? e), Date.now() - start); throw e; }
}
