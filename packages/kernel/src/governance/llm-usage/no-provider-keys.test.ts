import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * governance/llm-usage/no-provider-keys.test: I9 ("内核进程零外部凭证" — the kernel never holds a
 * provider API key; only `llm-proxy` does, S1.7) as a static grep guard over kernel source,
 * mirroring `scripts/check-kernel-purity.sh`'s own grep-based approach but as a vitest test so it
 * runs in the normal `pnpm -r test` gate, not just CI's separate `guards` job.
 *
 * Placed under this module's own directory (not a new top-level kernel test file) because this
 * task's ownership only covers `packages/kernel/src/governance/llm-usage/**` and
 * `packages/kernel/src/interfaces/http/internal/**` — this is a self-contained test file that
 * happens to scan the whole `packages/kernel/src` tree, not a change to any file outside those
 * directories.
 *
 * Pattern: `\b[A-Z][A-Z0-9_]*_API_KEY\b`, case-sensitive — an uppercase, `_API_KEY`-suffixed
 * identifier, the `*_API_KEY` env-var-naming convention used throughout this repo's own docs
 * (docs/development-tasks.md S1.7, scripts/host-env-init.sh's llm-proxy.env template). Chosen
 * deliberately over a looser case-insensitive `api_key` match: that would also flag
 * `principals.api_key_hash` (a hash, not a key — core/0001_identity.sql) and, once S1.3 lands,
 * the human channel's `X-API-Key` header name — both legitimate kernel-side concepts that are not
 * provider credentials.
 */

const PROVIDER_KEY_PATTERN = /\b[A-Z][A-Z0-9_]*_API_KEY\b/;

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('kernel source never names a provider API key env var (I9)', () => {
  it('contains no `*_API_KEY`-style identifier under packages/kernel/src', async () => {
    const kernelSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    expect(path.basename(kernelSrc)).toBe('src');

    const files = await collectTsFiles(kernelSrc);
    expect(files.length).toBeGreaterThan(0);

    const hits: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      if (PROVIDER_KEY_PATTERN.test(content)) {
        hits.push(path.relative(kernelSrc, file));
      }
    }

    expect(hits, `found provider-key-shaped identifiers in: ${hits.join(', ')}`).toEqual([]);
  });
});
