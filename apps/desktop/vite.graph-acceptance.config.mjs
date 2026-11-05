import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: desktopRoot,
  plugins: [react()],
  build: {
    outDir: '/tmp/noltri-graph-acceptance-dist',
    emptyOutDir: true,
    rollupOptions: { input: { graphAcceptance: resolve(desktopRoot, 'graph-acceptance.html') } },
  },
});
