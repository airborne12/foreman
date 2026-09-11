import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 产物直接进 center 的静态目录（部署方案 §4.1：apps/panel → apps/center/public）
export default defineConfig({
  plugins: [react()],
  build: { outDir: resolve(__dirname, '../center/public'), emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:7801', '/ws': { target: 'ws://127.0.0.1:7801', ws: true } } },
});
