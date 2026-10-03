import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProviderKeyResolver, loadProviderKeyFiles } from './provider-keys.js';

/** R-24: provider keys come from files (one per `api_key_env` name), the env var only as a
 *  deprecated fallback that keeps an un-migrated host working. */
describe('provider key files (R-24)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('loads one key per env-var-named file, trimming the trailing newline and skipping other names', async () => {
    dir = mkdtempSync(join(tmpdir(), 'llm-provider-keys-'));
    writeFileSync(join(dir, 'OPENAI_API_KEY'), 'sk-from-file\n');
    writeFileSync(join(dir, 'EMPTY_KEY'), '\n');
    writeFileSync(join(dir, 'not-an-env-name.txt'), 'ignored');
    const files = await loadProviderKeyFiles(dir, () => undefined);
    expect([...files.entries()]).toEqual([['OPENAI_API_KEY', 'sk-from-file']]);
  });

  it('a missing directory is no keys from files, not an error', async () => {
    const files = await loadProviderKeyFiles(join(tmpdir(), 'no-such-provider-keys-dir-r24'));
    expect(files.size).toBe(0);
  });

  it('a path that is not a readable directory is reported, not silently treated as absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'llm-provider-keys-'));
    const notADir = join(dir, 'file-not-dir');
    writeFileSync(notADir, 'x');
    const lines: string[] = [];
    const files = await loadProviderKeyFiles(notADir, (line) => lines.push(line));
    expect(files.size).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not be read');
  });

  it('the file wins over the env var, with no warning', () => {
    const lines: string[] = [];
    const resolve = createProviderKeyResolver({
      files: new Map([['OPENAI_API_KEY', 'sk-from-file']]),
      env: { OPENAI_API_KEY: 'sk-from-env' },
      log: (line) => lines.push(line),
    });
    expect(resolve('OPENAI_API_KEY')).toBe('sk-from-file');
    expect(lines).toEqual([]);
  });

  it('falls back to the env var (an un-migrated host keeps working) with one deprecation warning per name, never the value', () => {
    const lines: string[] = [];
    const resolve = createProviderKeyResolver({
      files: new Map(),
      env: { OPENAI_API_KEY: 'sk-from-env' },
      log: (line) => lines.push(line),
    });
    expect(resolve('OPENAI_API_KEY')).toBe('sk-from-env');
    expect(resolve('OPENAI_API_KEY')).toBe('sk-from-env');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      level: 'warn',
      name: 'OPENAI_API_KEY',
    });
    expect(lines[0]).not.toContain('sk-from-env');
  });

  it('neither file nor env: undefined, no warning', () => {
    const lines: string[] = [];
    const resolve = createProviderKeyResolver({
      files: new Map(),
      env: {},
      log: (line) => lines.push(line),
    });
    expect(resolve('MISSING_API_KEY')).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('never follows a <NAME>_FILE indirection (api_key_env must not be able to name any readable file)', () => {
    const resolve = createProviderKeyResolver({
      files: new Map(),
      env: { LLM_KEY_STORE_FILE: '/data/state/keys.json' },
      log: () => undefined,
    });
    expect(resolve('LLM_KEY_STORE')).toBeUndefined();
  });
});
