import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileHandleBindingReader, createFileHandleBindingSource } from './source-binding.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kernel-source-binding-'));
  file = join(dir, 'bindings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** worker-supervisor's write: a temp file renamed over the real one. */
function replace(content: unknown): void {
  const temp = join(dir, '.bindings.json.tmp');
  writeFileSync(temp, JSON.stringify(content));
  renameSync(temp, file);
}

const binding = (handle: string) => ({ handle, sourceId: 'entry:ws:p', boundAt: 'now' });

describe('createFileHandleBindingSource', () => {
  it('has no version while the file is missing, and a new one after every replace', () => {
    const source = createFileHandleBindingSource(file);
    expect(source.version()).toBeUndefined();
    replace({});
    const first = source.version();
    expect(first).toBeDefined();
    replace({});
    expect(source.version()).not.toBe(first);
  });
});

describe('createFileHandleBindingReader', () => {
  it('follows the file as worker-supervisor replaces it, and refuses everything while it is broken', async () => {
    const errors: string[] = [];
    const reader = createFileHandleBindingReader(file, (err) => errors.push(err.reason));
    expect(await reader.lookup('203.0.113.7')).toBeUndefined();

    replace({ '203.0.113.7': binding('a.b.c') });
    expect((await reader.lookup('203.0.113.7'))?.handle).toBe('a.b.c');

    replace({ '203.0.113.7': binding('d.e.f') });
    expect((await reader.lookup('203.0.113.7'))?.handle).toBe('d.e.f');

    writeFileSync(join(dir, '.tmp'), '{');
    renameSync(join(dir, '.tmp'), file);
    expect(await reader.lookup('203.0.113.7')).toBeUndefined();
    expect(errors).toEqual(['malformed']);
  });
});
