/**
 * 整轮测试的全局准备：
 * 1. 确保 Postgres 可用（优先 TEST_DATABASE_URL；否则用 docker 起 postgres:17 容器）
 * 2. 应用迁移（schema.sql）
 * 3. 清空 test-results.jsonl（reporter 清空策略）
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Db, findRepoRoot } from '../apps/center/src/db.js';

const CONTAINER = 'foreman-test-pg';
const PORT = 54329;

export default async function setup() {
  const root = findRepoRoot();
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const running = safe(`docker ps --filter name=^/${CONTAINER}$ --format '{{.Names}}'`).includes(CONTAINER);
    if (!running) {
      safe(`docker rm -f ${CONTAINER}`);
      execSync(`docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=foreman -p ${PORT}:5432 postgres:17`, { stdio: 'ignore' });
    }
    url = `postgres://postgres:pg@127.0.0.1:${PORT}/foreman`;
    for (let i = 0; i < 60; i++) {
      if (safe(`docker exec ${CONTAINER} pg_isready -U postgres -d foreman`).includes('accepting')) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    process.env.TEST_DATABASE_URL = url;
  }
  const db = new Db(url);
  await db.migrate(root);
  await db.close();
  const resultPath = resolve(root, process.env.FOREMAN_RESULT_PATH ?? 'logos/resources/verify/test-results.jsonl');
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, '');
  return async () => { /* 容器保留以加速下次运行；需要时 docker rm -f foreman-test-pg */ };
}

function safe(cmd: string): string { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } }
