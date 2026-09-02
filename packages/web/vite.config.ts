import { defineConfig } from 'vite';

// Minimal Vite config: no @vitejs/plugin-react dependency, esbuild already strips TS/JSX for
// .tsx sources (see package.json's minimal-deps note). Output lands in dist/, which
// docker-compose.yml's caddy service mounts read-only at /srv/web (§10.2).
//
// Dev server proxy (S1.8 deliverable 2): in production caddy reverse-proxies `/api` and `/ws` to
// the kernel on the *same origin* (deploy/caddy/Caddyfile) — the app never hard-codes a kernel
// URL (see src/lib/ws-client.ts's `wsUrl()`). `pnpm --filter @nexttime/web dev` reproduces that
// same-origin shape against a kernel running standalone (no caddy) by proxying both paths to
// `KERNEL_DEV_URL` (default matches the kernel's own default `KERNEL_PORT`, packages/kernel/src/
// index.ts). `ws: true` on the `/ws` entry is what makes Vite's dev proxy forward the WebSocket
// upgrade instead of only plain HTTP.
const KERNEL_DEV_URL = process.env.KERNEL_DEV_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: KERNEL_DEV_URL,
        changeOrigin: true,
      },
      '/ws': {
        target: KERNEL_DEV_URL,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
