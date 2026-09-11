import { loadCenterConfig } from './config.js';
import { startApp } from './app.js';

const cfg = loadCenterConfig(process.env.FOREMAN_CENTER_CONFIG);
const app = await startApp(cfg);
const shutdown = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
