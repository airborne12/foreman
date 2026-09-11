import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';
import { WorkerConfig, expandEnv } from '@foreman/shared';

export function foremanHome(): string {
  return process.env.FOREMAN_HOME ?? resolve(homedir(), '.foreman');
}

/** 读取 ~/.foreman/env（KEY=VALUE，0600）注入环境 */
export function loadEnvFile(home = foremanHome()) {
  const p = resolve(home, 'env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
  }
}

export function workerConfigPath(explicit?: string) {
  return explicit ?? resolve(foremanHome(), 'worker.yaml');
}

export function loadWorkerConfig(path?: string): WorkerConfig {
  loadEnvFile();
  const p = workerConfigPath(path);
  if (!existsSync(p)) throw new Error(`worker 配置不存在：${p}（先运行 foreman worker init）`);
  const raw = YAML.parse(expandEnv(readFileSync(p, 'utf8'))) ?? {};
  return WorkerConfig.parse(raw);
}

export function writeWorkerConfig(cfg: WorkerConfig, path?: string, opts?: { tokenLiteral?: string }) {
  const p = workerConfigPath(path);
  mkdirSync(dirname(p), { recursive: true });
  const out = { ...cfg, center: { ...cfg.center, token: '${FOREMAN_TOKEN}' } };
  writeFileSync(p, YAML.stringify(out), { mode: 0o600 });
  if (opts?.tokenLiteral) {
    const envPath = resolve(dirname(p), 'env');
    writeFileSync(envPath, `FOREMAN_TOKEN=${opts.tokenLiteral}\n`, { mode: 0o600 });
  }
  return p;
}
