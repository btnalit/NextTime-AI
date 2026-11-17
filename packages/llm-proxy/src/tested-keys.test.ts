import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TESTED_KEYS_FILE_NAME, TestedKeys, testedKeysFile } from './tested-keys.js';

/**
 * tested-keys.test: legacy 202 / 203 — which key each provider's last test ran with, kept as a
 * salted digest beside keys.json, never the key itself.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexttime-llm-proxy-tested-keys-'));
  dirs.push(dir);
  return dir;
}

async function open(file: string): Promise<{ tested: TestedKeys; logs: string[] }> {
  const logs: string[] = [];
  const tested = new TestedKeys(file, (line) => logs.push(line));
  await tested.load();
  return { tested, logs };
}

const AT = '2026-11-17T00:00:00.000Z';

describe('TestedKeys (legacy 202, 203)', () => {
  it('sits next to keys.json', () => {
    expect(testedKeysFile('/data/state/keys.json')).toBe(`/data/state/${TESTED_KEYS_FILE_NAME}`);
  });

  it('a missing file is empty: every recorded result reads as of unknown key, nothing is logged', async () => {
    const { tested, logs } = await open(join(freshDir(), 'tested-keys.json'));
    expect(tested.tracks('acme')).toBe(false);
    expect(tested.match('acme', AT, 'sk-any')).toBe('unknown');
    expect(logs).toEqual([]);
  });

  it('matches only the result it was recorded for and only the key it ran with, across a restart', async () => {
    const file = join(freshDir(), 'tested-keys.json');
    const key = `sk-${randomUUID()}`;
    const { tested } = await open(file);
    await tested.record('acme', AT, key);

    const { tested: reread } = await open(file);
    expect(reread.match('acme', AT, key)).toBe('same');
    expect(reread.match('acme', AT, `sk-${randomUUID()}`)).toBe('other');
    expect(reread.match('acme', '2026-11-17T00:00:01.000Z', key)).toBe('other');
    expect(reread.match('acme', AT, undefined)).toBe('other');
    expect(reread.match('other-provider', AT, key)).toBe('unknown');
  });

  it('keeps a salted digest at mode 0600 — never the key', async () => {
    const file = join(freshDir(), 'tested-keys.json');
    const key = `sk-${randomUUID()}`;
    const { tested } = await open(file);
    await tested.record('acme', AT, key);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(key);
    expect(raw).not.toContain(key.slice(3, 15));
    const stored = JSON.parse(raw) as {
      salt: string;
      providers: Record<string, { key: string }>;
    };
    // A different file has a different salt: the same key gets a different digest.
    const other = join(freshDir(), 'tested-keys.json');
    const { tested: elsewhere } = await open(other);
    await elsewhere.record('acme', AT, key);
    const otherStored = JSON.parse(readFileSync(other, 'utf8')) as typeof stored;
    expect(otherStored.salt).not.toBe(stored.salt);
    expect(otherStored.providers.acme?.key).not.toBe(stored.providers.acme?.key);
  });

  it('a tracked provider with no recorded key matches nothing', async () => {
    const file = join(freshDir(), 'tested-keys.json');
    const { tested } = await open(file);
    await tested.track('acme');
    expect(tested.tracks('acme')).toBe(true);
    expect(tested.match('acme', AT, 'sk-any')).toBe('other');
    const { tested: reread } = await open(file);
    expect(reread.match('acme', AT, 'sk-any')).toBe('other');
  });

  it('an invalid file is logged without its content, read as empty and replaced by the next write', async () => {
    const file = join(freshDir(), 'tested-keys.json');
    const marker = `marker-${randomUUID()}`;
    for (const [content, reason] of [
      [`{"not json ${marker}`, 'invalid_json'],
      [JSON.stringify({ version: 1, salt: marker, providers: { acme: marker } }), 'invalid_shape'],
    ] as const) {
      writeFileSync(file, content);
      const { tested, logs } = await open(file);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0] as string)).toMatchObject({ level: 'warn', reason });
      expect(logs[0]).not.toContain(marker);
      expect(tested.match('acme', AT, 'sk-any')).toBe('unknown');

      await tested.record('acme', AT, 'sk-any');
      const { tested: reread, logs: rereadLogs } = await open(file);
      expect(rereadLogs).toEqual([]);
      expect(reread.match('acme', AT, 'sk-any')).toBe('same');
    }
  });

  it('a write that fails is logged and never thrown; this process still knows the key', async () => {
    // A state directory that is not there: every write fails, whoever the process runs as.
    const file = join(freshDir(), 'missing', 'tested-keys.json');
    const { tested, logs } = await open(file);
    const key = `sk-${randomUUID()}`;
    await expect(tested.record('acme', AT, key)).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] as string)).toMatchObject({
      level: 'warn',
      providerId: 'acme',
      reason: 'ENOENT',
    });
    expect(logs[0]).not.toContain(key);
    expect(tested.match('acme', AT, key)).toBe('same');
  });
});
