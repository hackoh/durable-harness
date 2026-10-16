import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API routes (model proxy, server World) live in the Next demo app.
const api = process.env.HARNESS_API_ORIGIN ?? 'http://localhost:3100';

export default defineConfig({
  // Built into apps/demo/public/browser; Next serves index.html at `/`.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  // `/eve` is the eve agent's API, which the Next app (withEve) proxies to its eve dev server.
  server: { port: 5173, proxy: { '/api': { target: api, changeOrigin: true }, '/eve': { target: api, changeOrigin: true } } },
  // libfx resolves its .wasm next to its own module; keep it out of prebundling.
  optimizeDeps: { exclude: ['libfx'] },
  build: {
    target: 'es2023',
    outDir: process.env.BROWSER_OUT_DIR ?? 'dist',
    emptyOutDir: true,
  },
});
