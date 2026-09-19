import { defineConfig } from 'vitest/config';

const TRACKER = 'http://127.0.0.1:8765';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: TRACKER.replace('http', 'ws'), ws: true },
      '/api': { target: TRACKER },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    // three.js is one large module; this is a local app, no need to code-split.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
