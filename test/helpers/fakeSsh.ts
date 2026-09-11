/**
 * 假 ssh：把 `ssh -N -R <rp>:127.0.0.1:<lp> target` 变成本地端口转发（监听 FAKE_SSH_LISTEN，转发到 lp）。
 * 模式由环境文件 $FAKE_SSH_MODE_FILE 控制：forward-local | fail-forever
 */
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function writeFakeSsh(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const script = resolve(dir, 'ssh');
  writeFileSync(script, `#!/usr/bin/env node
const net = require('node:net');
const fs = require('node:fs');
const modeFile = process.env.FAKE_SSH_MODE_FILE;
const mode = modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'forward-local';
if (mode === 'fail-forever') { process.stderr.write('ssh: connect to host 10.26.20.3 port 22: Connection refused\\n'); process.exit(255); }
if (mode === 'permission-denied') { process.stderr.write('jiangkai@10.26.20.3: Permission denied (publickey).\\n'); process.exit(255); }
const args = process.argv.slice(2);
const ri = args.indexOf('-R');
const spec = ri >= 0 ? args[ri + 1] : '7801:127.0.0.1:7801';
const [, host, lp] = spec.split(':');
const listen = Number(process.env.FAKE_SSH_LISTEN || 17801);
const server = net.createServer((c) => {
  const up = net.connect(Number(lp), host || '127.0.0.1');
  c.pipe(up); up.pipe(c);
  c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
});
server.listen(listen, '127.0.0.1');
process.on('SIGTERM', () => { server.close(); process.exit(0); });
setInterval(() => {}, 1 << 30);
`);
  chmodSync(script, 0o755);
  return script;
}
