import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// GitHub Pages serves the site under /<repo>/; override with KS_BASE for other hosts.
const base = process.env['KS_BASE'] ?? './';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        spike: resolve(import.meta.dirname, 'spike.html'),
      },
    },
  },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
});
