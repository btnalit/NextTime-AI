import { dirname, join } from 'node:path';
import { type Plugin, defineConfig } from 'vitest/config';

/**
 * The redaction acceptance run (design doc `docs/redaction-boundary-design-2026-11-27.md` §7 stage
 * 1a): not part of the kernel's `vitest run` — it needs a release's sources, which `run.mjs` puts
 * under `.baseline/<tag>/` — and run by `run.mjs` (CI's `test` job, and the seats for the full set).
 *
 * A release's kernel modules import `@nexttime/shared`: they get that release's, from its sources
 * beside them, not this checkout's.
 */
const BASELINE = `${join(import.meta.dirname, '.baseline')}/`;

const releasedShared: Plugin = {
  name: 'redaction-fuzz:released-shared',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source !== '@nexttime/shared' || importer === undefined) return null;
    if (!importer.startsWith(BASELINE)) return null;
    const tag = importer.slice(BASELINE.length).split('/')[0] as string;
    return join(BASELINE, tag, 'packages/shared/src/index.ts');
  },
};

export default defineConfig({
  plugins: [releasedShared],
  root: dirname(dirname(import.meta.dirname)),
  test: {
    environment: 'node',
    globals: false,
    include: ['test/redaction-fuzz/*.test.ts'],
    passWithNoTests: false,
    reporters: ['default'],
    testTimeout: 15 * 60_000,
  },
});
