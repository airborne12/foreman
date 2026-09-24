import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 开发时代理到哪个中心：默认本机 7801；实验环境用 FOREMAN_CENTER=http://127.0.0.1:7899
const center = process.env.FOREMAN_CENTER ?? 'http://127.0.0.1:7801';

// 产物直接进 center 的静态目录（部署方案 §4.1：apps/panel → apps/center/public）
export default defineConfig({
  plugins: [react()],
  build: { outDir: resolve(__dirname, '../center/public'), emptyOutDir: true },
  server: { proxy: { '/api': center, '/ws': { target: center.replace(/^http/, 'ws'), ws: true } } },
});
