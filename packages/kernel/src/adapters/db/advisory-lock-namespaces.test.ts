import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADVISORY_LOCK_KEYS, ADVISORY_LOCK_NAMESPACES } from './advisory-lock-namespaces.js';

/**
 * adapters/db/advisory-lock-namespaces: the registry is the only place a fixed advisory-lock
 * number is chosen (STATUS legacy 565). A static scan of the kernel's `src/` and `migrations/`
 * fails on a literal key the registry does not list, on two names sharing a number, and on a
 * migration module whose files take more than one bootstrap key.
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REGISTRY = path.join(KERNEL_ROOT, 'src', 'adapters', 'db', 'advisory-lock-namespaces.ts');

const LOCK_CALL = String.raw`pg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?\(\s*`;
const ONE_KEY_LITERAL = new RegExp(`${LOCK_CALL}(\\d+)\\s*\\)`, 'g');
const TWO_KEY_LITERAL = new RegExp(`${LOCK_CALL}(\\d+)\\s*,`, 'g');
const PARAMETER_KEY = new RegExp(`${LOCK_CALL}\\$\\d+\\s*[,)]`);
const KERNEL_NUMBER = /\b72410\d{2,5}\b/g;

async function filesUnder(dir: string, extension: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function sources(): Promise<Array<{ file: string; text: string }>> {
  const files = [
    ...(await filesUnder(path.join(KERNEL_ROOT, 'src'), '.ts')),
    ...(await filesUnder(path.join(KERNEL_ROOT, 'migrations'), '.sql')),
  ];
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(file, 'utf8') })));
}

const keys = new Set<number>(Object.values(ADVISORY_LOCK_KEYS));
const namespaces = new Set<number>(Object.values(ADVISORY_LOCK_NAMESPACES));

function where(file: string): string {
  return path.relative(KERNEL_ROOT, file);
}

describe('advisory lock registry', () => {
  it('gives every name its own number, each in its key space', () => {
    expect(keys.size).toBe(Object.keys(ADVISORY_LOCK_KEYS).length);
    expect(namespaces.size).toBe(Object.keys(ADVISORY_LOCK_NAMESPACES).length);
    for (const key of keys) {
      // Above every `hashtext` value (an int4), inside a bigint.
      expect(key).toBeGreaterThan(2 ** 31);
      expect(Number.isSafeInteger(key)).toBe(true);
    }
    for (const id of namespaces) {
      // The first key of the two-key form is an int4.
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThan(2 ** 31);
      expect(keys.has(id)).toBe(false);
    }
  });

  it('lists every literal one-key and two-key lock the kernel takes', async () => {
    const unregistered: string[] = [];
    for (const { file, text } of await sources()) {
      for (const match of text.matchAll(ONE_KEY_LITERAL)) {
        if (!keys.has(Number(match[1]))) unregistered.push(`${where(file)}: one-key ${match[1]}`);
      }
      for (const match of text.matchAll(TWO_KEY_LITERAL)) {
        if (!namespaces.has(Number(match[1]))) {
          unregistered.push(`${where(file)}: two-key class ${match[1]}`);
        }
      }
    }
    expect(unregistered).toEqual([]);
  });

  it('has no kernel-range lock number outside it, and parameter keys come from it', async () => {
    const strays: string[] = [];
    for (const { file, text } of await sources()) {
      if (file === REGISTRY || !file.endsWith('.ts')) continue;
      for (const match of text.matchAll(KERNEL_NUMBER)) {
        const value = Number(match[0]);
        if (!keys.has(value) && !namespaces.has(value)) strays.push(`${where(file)}: ${match[0]}`);
      }
      if (
        !file.endsWith('.test.ts') &&
        PARAMETER_KEY.test(text) &&
        !text.includes('advisory-lock-namespaces.js')
      ) {
        strays.push(`${where(file)}: lock key passed as a parameter without the registry`);
      }
    }
    expect(strays).toEqual([]);
  });

  it('gives each migration module one bootstrap key, none shared', async () => {
    const migrations = path.join(KERNEL_ROOT, 'migrations');
    const modules = (await readdir(migrations, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
    const owner = new Map<number, string>();
    for (const module of modules) {
      const used = new Set<number>();
      for (const file of await filesUnder(path.join(migrations, module.name), '.sql')) {
        const text = await readFile(file, 'utf8');
        for (const match of text.matchAll(ONE_KEY_LITERAL)) used.add(Number(match[1]));
      }
      expect([...used], module.name).toHaveLength(1);
      const [key] = [...used] as [number];
      expect(keys.has(key), module.name).toBe(true);
      expect(owner.get(key), `${module.name} shares ${key}`).toBeUndefined();
      owner.set(key, module.name);
    }
  });
});
