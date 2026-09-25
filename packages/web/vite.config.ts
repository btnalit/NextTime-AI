import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { woff2OnlyFonts } from './vite-plugins/woff2-only-fonts.js';

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
  // S8 W3 F1 (leftover 49): strips the unused `.woff` fallback @fontsource ships alongside every
  // `.woff2` — see the plugin's own doc comment for why this writes `styles/fonts.css` to disk in
  // `buildStart` rather than intercepting it inside Vite's own plugin pipeline.
  plugins: [tailwindcss(), woff2OnlyFonts()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // S6-A0 / C21: fonts are never inlined as `data:` URIs (Vite's default 4 KB threshold caught
    // a few tiny Noto Sans SC unicode-range slices), so deploy/caddy/Caddyfile can keep
    // `font-src 'self'` without a `data:` escape hatch. Everything else keeps Vite's default.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
    rollupOptions: {
      output: {
        // S8 W1-A5 (leftover 49): every routed page (src/routes.tsx) is now a `React.lazy` chunk
        // of its own — this just groups a few of those chunks for a better cache/waterfall shape.
        // - `vendor-react`/`vendor-radix`: react/react-dom and every `@radix-ui/*` package into
        //   their own stable chunks, so a release that only touches page code (or only bumps a
        //   dependency version) does not change the other's content hash. `vendor-react` is
        //   already reachable from the eagerly-loaded shell (needed to boot at all), so it adds
        //   no request the initial load did not already make. Nothing imports `@radix-ui/*` yet
        //   on this branch (`components/kit/button`/`dialog`/`sheet`/`tooltip` are W1-A0
        //   primitives built ahead of their consumers — Rollup tree-shakes the whole module away
        //   with nothing importing it, so `vendor-radix` does not appear in today's build); this
        //   rule is forward-looking, so the next kit component a page wires in (W1-A3 wires
        //   tooltip; more will follow) gets its Radix code split into this chunk instead of
        //   inflating that one page's own chunk, and every later page reusing the same primitive
        //   fetches it once.
        // - `platform`: the nine `components/platform/*Page` modules share one chunk. They are
        //   one admin flow a reader moves through page to page (routes.tsx's own doc comment) —
        //   bundling them together means the *first* `#/platform/*` visit fetches one chunk and
        //   every later platform page in the same session is already in the module cache, instead
        //   of a fresh request per click.
        manualChunks(id) {
          const path = id.replace(/\\/g, '/');
          if (path.includes('/node_modules/')) {
            if (/\/node_modules\/(react|react-dom|scheduler)\//.test(path)) return 'vendor-react';
            if (path.includes('/node_modules/@radix-ui/')) return 'vendor-radix';
            return undefined;
          }
          if (path.includes('/src/components/platform/')) return 'platform';
          return undefined;
        },
      },
    },
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
