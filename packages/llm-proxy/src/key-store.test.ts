import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyStore, KeyStoreError } from './key-store.js';

/**
 * key-store.test: filesystem-level unit tests of the S7-A console-key store — empty on a missing
 * file, atomic `.tmp` + rename writes with no debris, mode 0600 (unlike `providers.json`'s 0644 —
 * this file holds secret values), hot in-memory reads with no reload needed, a corrupt file fails
 * loudly, an unwritable directory is reported rather than silently losing the write, and
 * concurrent writers never lose one of the two writes (the in-process `Mutex`).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexttime-llm-proxy-keys-'));
  dirs.push(dir);
  return dir;
}

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

describe('KeyStore', () => {
  it('loads an empty store when the file does not exist', async () => {
    const store = new KeyStore(join(tempDir(), 'keys.json'));
    await store.load();
    expect(store.get('acme')).toBeUndefined();
    expect(store.has('acme')).toBe(false);
  });

  it('never reads through the prototype chain for a prototype-shaped id (P3 hotfix, post-v0.16.0 review)', async () => {
    const store = new KeyStore(join(tempDir(), 'keys.json'));
    await store.load();
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(store.has(id)).toBe(false);
      expect(store.get(id)).toBeUndefined();
      expect(await store.remove(id)).toBe(false);
    }
    // Setting one of these ids for real must still work — an own property with that literal
    // name, not a prototype mutation (object-literal computed keys never trigger the special
    // `__proto__` setter).
    await store.set('__proto__', 'sk-proto-shaped-id');
    expect(store.has('__proto__')).toBe(true);
    expect(store.get('__proto__')).toBe('sk-proto-shaped-id');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype); // no pollution leaked globally
  });

  it('set persists atomically (tmp + rename, no debris), mode 0600, and is readable back hot', async () => {
    const dir = tempDir();
    const file = join(dir, 'keys.json');
    const store = new KeyStore(file);
    await store.load();

    await store.set('acme', 'sk-acme-secret');

    // Hot: no reload needed, the in-memory state already reflects the write.
    expect(store.get('acme')).toBe('sk-acme-secret');
    expect(store.has('acme')).toBe(true);

    expect(readdirSync(dir)).toEqual(['keys.json']);
    expect(mode(file)).toBe('600');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk).toEqual({ version: 1, keys: { acme: 'sk-acme-secret' } });

    // A fresh instance reads back exactly what was written.
    const reread = new KeyStore(file);
    await reread.load();
    expect(reread.get('acme')).toBe('sk-acme-secret');
  });

  it('set replaces an existing key for the same id', async () => {
    const store = new KeyStore(join(tempDir(), 'keys.json'));
    await store.load();
    await store.set('acme', 'sk-first');
    await store.set('acme', 'sk-second');
    expect(store.get('acme')).toBe('sk-second');
  });

  it('remove drops the entry and reports false for an unknown id', async () => {
    const store = new KeyStore(join(tempDir(), 'keys.json'));
    await store.load();
    await store.set('acme', 'sk-acme-secret');
    expect(await store.remove('acme')).toBe(true);
    expect(store.get('acme')).toBeUndefined();
    expect(await store.remove('acme')).toBe(false);
  });

  it('fails loudly on a corrupt or mis-shaped file', async () => {
    const dir = tempDir();
    const file = join(dir, 'keys.json');
    writeFileSync(file, '{not json');
    await expect(new KeyStore(file).load()).rejects.toBeInstanceOf(KeyStoreError);
    writeFileSync(file, JSON.stringify({ version: 1, keys: { acme: 42 } }));
    await expect(new KeyStore(file).load()).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports an unwritable directory and turns a write into an unwritable error', async () => {
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const dir = tempDir();
    const locked = join(dir, 'locked');
    const store = new KeyStore(join(locked, 'keys.json'));
    await store.load();
    await store.writable();
    chmodSync(locked, 0o500);
    const fresh = new KeyStore(join(locked, 'keys.json'));
    await fresh.load();
    expect(await fresh.writable()).toBe(false);
    await expect(fresh.set('acme', 'sk-x')).rejects.toMatchObject({ code: 'unwritable' });
    chmodSync(locked, 0o700);
  });

  it('never leaks a key value into a thrown error message', async () => {
    if (process.getuid?.() === 0) return;
    const dir = tempDir();
    const locked = join(dir, 'locked');
    const store = new KeyStore(join(locked, 'keys.json'));
    await store.load();
    await store.writable();
    chmodSync(locked, 0o500);
    try {
      await store.set('acme', 'sk-must-not-leak');
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('sk-must-not-leak');
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('concurrent set calls on different ids never lose a write (Mutex serializes them)', async () => {
    const dir = tempDir();
    const store = new KeyStore(join(dir, 'keys.json'));
    await store.load();

    await Promise.all([
      store.set('acme', 'sk-acme'),
      store.set('other', 'sk-other'),
      store.set('third', 'sk-third'),
    ]);

    expect(store.get('acme')).toBe('sk-acme');
    expect(store.get('other')).toBe('sk-other');
    expect(store.get('third')).toBe('sk-third');

    const onDisk = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8'));
    expect(onDisk.keys).toEqual({ acme: 'sk-acme', other: 'sk-other', third: 'sk-third' });
    expect(existsSync(join(dir, `keys.json.tmp-${process.pid}`))).toBe(false);
  });
});
