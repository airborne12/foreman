/**
 * S05 编排测试：执行 logos/resources/scenario/core-S05-runtime-onboarding.json，按 ST 编号上报。
 * 本批延后：ST-S05-12（依赖审批决定与会话续接，随 S03/S06/S07 批次交付）→ 上报 skip。
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { Runner, loadScenario } from './runner.js';
import { reportResult } from '../helpers/reporter.js';

const DEFERRED: Record<string, string> = {};

const file = loadScenario('core-S05-runtime-onboarding.json');
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
