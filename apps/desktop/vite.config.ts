import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// One library window is the desktop app's only entry point.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { main: resolve(__dirname, 'main.html') },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
