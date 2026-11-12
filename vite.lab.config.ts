// Scene lab: serves ONLY the pixel floor in a plain browser, with stand-in
// agents and a stubbed bridge, so the HIMYM world can be checked without
// launching Electron.   npx vite --config vite.lab.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  define: { __APP_VERSION__: JSON.stringify('lab') },
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@brand': resolve(__dirname, 'docs'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  server: { port: 5199, strictPort: true },
});
