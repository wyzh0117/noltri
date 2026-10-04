import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Four webview entry points, matching tauri.conf.json: the Setup Manager window ("main"), the
// knowledge workbench ("workbench"), the selection pill ("overlay") and the paste fallback ("paste").
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'main.html'),
        workbench: resolve(__dirname, 'workbench.html'),
        overlay: resolve(__dirname, 'overlay.html'),
        paste: resolve(__dirname, 'paste.html'),
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
