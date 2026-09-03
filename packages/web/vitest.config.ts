import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.ts';

// S2.10 addition: component tests (`src/components/*.test.tsx`) render into jsdom via
// `@testing-library/react`; `baseConfig`'s `include` only matches `*.test.ts`, so `.test.tsx` is
// added here rather than overridden package-wide. `environment` stays the shared default (`node`)
// — each `.test.tsx` file opts into jsdom itself with a `// @vitest-environment jsdom` pragma
// comment, keeping the plain-`.test.ts` suites (ws-client, action-card, ...) on the faster `node`
// environment they never needed jsdom for.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  }),
);
