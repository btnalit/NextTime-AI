import { randomUUID, scryptSync } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_DIGEST, TESTED_KEYS_FILE_NAME, TestedKeys, testedKeysFile } from './tested-keys.js';

/**
 * tested-keys.test: legacy 202 / 203 — which key each provider's last test ran with, kept as a
 * salted scrypt digest beside keys.json, never the key itself.
 */

/** The file's mode and text, read through one descriptor. */
function readStored(file: string): { mode: number; raw: string } {
  const fd = openSync(file, 'r');
  try {
    return { mode: fstatSync(fd).mode & 0o777, raw: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

/** Every scryptSync call, the module's included (vi.mock wraps the real one). */
const digests = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    scryptSync: (...args: Parameters<typeof actual.scryptSync>) => {
      digests.count++;
      return actual.scryptSync(...args);
    },
  };
});

type StoredFile = {
  providers: Record<string, { key: { salt: string; digest: string } | null; testedAt: string }>;
};

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

  it('keeps a salted scrypt digest at mode 0600 — never the key', async () => {
    const file = join(freshDir(), 'tested-keys.json');
    const key = `sk-${randomUUID()}`;
    const { tested } = await open(file);
    await tested.record('acme', AT, key);
    await tested.record('beta', AT, key);

    const { mode, raw } = readStored(file);
    expect(mode).toBe(0o600);
    expect(raw).not.toContain(key);
    expect(raw).not.toContain(key.slice(3, 15));
    const stored = JSON.parse(raw) as StoredFile;
    const acme = stored.providers.acme?.key;
    const beta = stored.providers.beta?.key;
    // The digest is scrypt at KEY_DIGEST's cost (pinned: lowering it makes a guess cheaper),
    // under the entry's own salt.
    expect(KEY_DIGEST).toMatchObject({ N: 2 ** 15, r: 8, p: 1, keyLength: 32, saltBytes: 16 });
    expect(acme?.digest).toBe(
      scryptSync(key, Buffer.from(acme?.salt as string, 'base64url'), KEY_DIGEST.keyLength, {
        N: KEY_DIGEST.N,
        r: KEY_DIGEST.r,
        p: KEY_DIGEST.p,
        maxmem: KEY_DIGEST.maxmem,
      }).toString('hex'),
    );
    // Each entry has a salt of its own: the same key gets another digest, so every entry is a
    // separate search.
    expect(beta?.salt).not.toBe(acme?.salt);
    expect(beta?.digest).not.toBe(acme?.digest);
  });

  it('works out a verdict once per key and result, not on every read', async () => {
    const file = join(freshDir(), 'tested-keys.json');
    const key = `sk-${randomUUID()}`;
    const other = `sk-${randomUUID()}`;
    const { tested } = await open(file);
    await tested.record('acme', AT, key);
    const { tested: reread } = await open(file);
    const before = digests.count;
    for (let i = 0; i < 3; i++) expect(reread.match('acme', AT, key)).toBe('same');
    expect(digests.count - before).toBe(1);
    // Another key after a `same` verdict is not the entry's key: no digest needed.
    expect(reread.match('acme', AT, other)).toBe('other');
    expect(digests.count - before).toBe(1);
    expect(reread.match('acme', AT, key)).toBe('same');
    expect(digests.count - before).toBe(1);

    // A process that first meets another key works that verdict out, then the tested key's: an
    // `other` verdict says nothing about a third key.
    const { tested: rotated } = await open(file);
    const start = digests.count;
    expect(rotated.match('acme', AT, other)).toBe('other');
    expect(rotated.match('acme', AT, other)).toBe('other');
    expect(digests.count - start).toBe(1);
    expect(rotated.match('acme', AT, key)).toBe('same');
    expect(digests.count - start).toBe(2);
    // The process that recorded the result never needs a digest to read it.
    const recorded = digests.count;
    expect(tested.match('acme', AT, key)).toBe('same');
    expect(tested.match('acme', AT, other)).toBe('other');
    expect(digests.count).toBe(recorded);
  });

  it('a reload drops the verdicts it had: they described the entries it replaced', async () => {
    const file = join(freshDir(), 'tested-keys.json');
    const first = `sk-${randomUUID()}`;
    const second = `sk-${randomUUID()}`;
    const { tested } = await open(file);
    await tested.record('acme', AT, first);
    // Another writer records the same result's stamp with another key.
    const { tested: other } = await open(file);
    await other.record('acme', AT, second);
    await tested.load();
    expect(tested.match('acme', AT, first)).toBe('other');
    expect(tested.match('acme', AT, second)).toBe('same');
  });

  it('a verdict for one result says nothing about the next', async () => {
    const file = join(freshDir(), 'tested-keys.json');
    const first = `sk-${randomUUID()}`;
    const second = `sk-${randomUUID()}`;
    const { tested } = await open(file);
    await tested.record('acme', AT, first);
    expect(tested.match('acme', AT, first)).toBe('same');
    const LATER = '2026-11-17T00:00:01.000Z';
    await tested.record('acme', LATER, second);
    expect(tested.match('acme', LATER, first)).toBe('other');
    expect(tested.match('acme', LATER, second)).toBe('same');
    const { tested: reread } = await open(file);
    expect(reread.match('acme', LATER, first)).toBe('other');
    expect(reread.match('acme', LATER, second)).toBe('same');
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
      [JSON.stringify({ version: 1, providers: { acme: marker } }), 'invalid_shape'],
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
