import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest defaults for every `@nexttime/*` package. Each package has its own
 * `vitest.config.ts` that merges this with any package-local overrides — see
 * packages/kernel/vitest.config.ts for the pattern.
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
