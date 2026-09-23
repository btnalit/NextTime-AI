import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Minimal Vite config: no @vitejs/plugin-react dependency, esbuild already strips TS/JSX for
// .tsx sources (see package.json's minimal-deps note). Output lands in dist/, which
// deploy/caddy/Dockerfile builds this package and copies into the caddy image at /srv/web
// (baked at image-build time, not bind-mounted — rebuild the caddy image to deploy a change).
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
  // S8 W1-A0 (docs/development-tasks.md §5e F3): Tailwind v4 for the new components/kit/*
  // primitives only. `src/styles/tailwind.css` imports just the theme + utilities layers (no
  // preflight — base.css already resets) and restricts class scanning to components/kit/ via
  // `source(none)` + `@source`, so no existing page markup can accidentally start matching a
  // generated utility. See that file's own header comment for the full rationale.
  plugins: [tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // S6-A0 / C21: fonts are never inlined as `data:` URIs (Vite's default 4 KB threshold caught
    // a few tiny Noto Sans SC unicode-range slices), so deploy/caddy/Caddyfile can keep
    // `font-src 'self'` without a `data:` escape hatch. Everything else keeps Vite's default.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
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
        // S4.1: the kernel rejects a WebSocket upgrade whose `Origin` host differs from its
        // `Host` (CSRF guard for the console session cookie, interfaces/ws/server.ts). Keeping the
        // browser's own `Host` (localhost:5173) lets that check pass through the dev proxy.
        changeOrigin: false,
      },
    },
  },
});
