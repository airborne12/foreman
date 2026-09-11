import { loadWorkerConfig } from './config.js';
import { Worker } from './worker.js';

const cfg = loadWorkerConfig(process.env.FOREMAN_WORKER_CONFIG);
const w = new Worker({ config: cfg });
w.start();
process.on('SIGINT', () => { w.stop(); process.exit(0); });
process.on('SIGTERM', () => { w.stop(); process.exit(0); });
