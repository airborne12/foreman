/**
 * 假二进制目录：claude / opencode / git 打印版本；用于 CLI 探测与 doctor。
 */
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function writeFakeBins(dir: string, bins: Record<string, { version?: string; fail?: boolean }>): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, spec] of Object.entries(bins)) {
    const p = resolve(dir, name);
    writeFileSync(p, spec.fail
      ? `#!/bin/sh\necho "${name}: native binary missing" 1>&2\nexit 1\n`
      : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${spec.version ?? '1.0.0'} (${name})"; exit 0; fi\necho "${name} fake"\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}
