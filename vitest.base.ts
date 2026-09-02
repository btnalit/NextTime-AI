import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest defaults for every `@nexttime/*` package. Each package has its own
 * `vitest.config.ts` that merges this with any package-local overrides — see
 * packages/kernel/vitest.config.ts for the pattern.
 *
 * No explicit `resolve.conditions` is set here. Every workspace `@nexttime/<pkg>` package.json
 * carries a `"development"` export condition pointing at `src/index.ts`, and Vite's own default
 * resolution (non-production mode) already selects that condition — verified directly: with
 * every package's `dist/` output deleted, `packages/egress-proxy/src/report.test.ts` does a
 * value import (`PLATFORM_EVENT_NAMES`, not just `import type`) of `@nexttime/shared` and
 * passes. Deliberately not overriding `resolve.conditions` to force this: Vite 6 made
 * `resolve.conditions` replace its built-in default set rather than extend it, so setting it
 * explicitly here would be a footgun on the next Vitest/Vite major that risks dropping a
 * condition Vite otherwise handles for us.
 */
export const baseConfig = defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    reporters: ['default'],
    clearMocks: true,
  },
});

export default baseConfig;
