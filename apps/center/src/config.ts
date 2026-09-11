import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';
import { CenterConfig, expandEnv } from '@foreman/shared';

export function foremanHome(): string {
  return process.env.FOREMAN_HOME ?? resolve(homedir(), '.foreman');
}

/** 从 ~/.foreman/center.yaml 读取；不存在时用环境变量构造最小配置 */
export function loadCenterConfig(path?: string): CenterConfig {
  const p = path ?? resolve(foremanHome(), 'center.yaml');
  let raw: Record<string, unknown> = {};
  if (existsSync(p)) raw = YAML.parse(expandEnv(readFileSync(p, 'utf8'))) ?? {};
  const merged = {
    listen: process.env.FOREMAN_LISTEN,
    database: process.env.DATABASE_URL,
    token: process.env.FOREMAN_TOKEN,
    panel_token: process.env.FOREMAN_PANEL_TOKEN,
    ssh_bin: process.env.FOREMAN_SSH_BIN,
    test_mode: process.env.FOREMAN_TEST_MODE === '1' ? true : undefined,
    ...stripUndefined(raw),
  };
  return CenterConfig.parse(stripUndefined(merged));
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
