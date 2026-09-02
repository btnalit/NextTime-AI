import { defineConfig } from 'vite';

// Minimal Vite config: no @vitejs/plugin-react dependency, esbuild already strips TS/JSX for
// .tsx sources (see package.json's minimal-deps note). Output lands in dist/, which
// docker-compose.yml's caddy service mounts read-only at /srv/web (§10.2).
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
