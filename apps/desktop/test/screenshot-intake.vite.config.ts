import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export default defineConfig({
  root: desktopRoot,
  envDir: false,
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: '/tmp/noltri-screenshot-intake-frontend-ipc-binary-2026-11-01',
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(desktopRoot, 'main.html') } },
  },
});
