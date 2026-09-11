import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@foreman/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@foreman/center': resolve(__dirname, 'apps/center/src/app.ts'),
      '@foreman/worker': resolve(__dirname, 'apps/worker/src/worker.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    environment: 'node',
    reporters: ['default'],
  },
});
