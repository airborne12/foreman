/**
 * S01 编排测试：执行 logos/resources/scenario/core-S01-jira-intake.json，按 ST 编号上报。
 * 人工用例（[manual]）不在 JSON 中，由 openlogos verify 排除。
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { Runner, loadScenario } from './runner.js';
import { reportResult } from '../helpers/reporter.js';

const DEFERRED: Record<string, string> = {};

const file = loadScenario('core-S01-jira-intake.json');
const all = new Map(file.cases.map((c) => [c.id, c]));
const runner = new Runner();

describe(`${file.scenario}: ${file.name}（编排）`, () => {
  beforeAll(async () => { await runner.boot(); });
  afterAll(async () => { await runner.shutdown(); });

  for (const c of file.cases) {
    it(`${c.id}: ${c.title}`, async () => {
      if (DEFERRED[c.id]) { reportResult(c.id, 'skip', DEFERRED[c.id], undefined, file.scenario); return; }
      const start = Date.now();
      try { await runner.runCase(file, c, all); reportResult(c.id, 'pass', undefined, Date.now() - start, file.scenario); }
      catch (e) { reportResult(c.id, 'fail', String((e as Error).message), Date.now() - start, file.scenario); throw e; }
    }, c.timeoutMs ?? 60_000);
  }
});
