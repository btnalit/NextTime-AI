import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeStaleTempFiles, writeFileAtomic } from './atomic-file.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-file-'));
  dirs.push(dir);
  return dir;
}

describe('writeFileAtomic', () => {
  it('replaces the file whole, with the mode, and leaves no temp file', async () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    await writeFileAtomic(file, '{"a":1}', 0o644);
    await writeFileAtomic(file, '{"a":2}', 0o600);
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('concurrent writers each use their own temp file: the result is one whole write, never a mix', async () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    const bodies = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({ i, pad: 'x'.repeat(i * 1000) }),
    );
    await Promise.all(bodies.map((body) => writeFileAtomic(file, body, 0o644)));
    expect(bodies).toContain(readFileSync(file, 'utf8'));
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('a failed write leaves the old file and no temp file', async () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    await writeFileAtomic(file, 'old', 0o644);
    // Renaming a file over a directory fails after the temp file was written.
    await expect(writeFileAtomic(dir, 'new', 0o644)).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });
});

describe('removeStaleTempFiles (#530 review)', () => {
  it('removes the temp files an interrupted write of this file left, and nothing else', async () => {
    const dir = tempDir();
    const file = join(dir, 'keys.json');
    writeFileSync(file, '{}');
    const ours = ['.keys.json.0b9e4f8a-1c2d-4e5f-8a9b-0c1d2e3f4a5b.tmp', 'keys.json.tmp-4242'];
    const theirs = [
      '.other.json.0b9e4f8a-1c2d-4e5f-8a9b-0c1d2e3f4a5b.tmp',
      'keys.json.bak',
      '.keys.json.not-a-uuid.tmp',
    ];
    for (const name of [...ours, ...theirs]) writeFileSync(join(dir, name), 'leftover');
    mkdirSync(join(dir, '.keys.json.1b9e4f8a-1c2d-4e5f-8a9b-0c1d2e3f4a5b.tmp'));
    const elsewhere = join(dir, 'elsewhere');
    writeFileSync(elsewhere, 'kept');
    const link = '.keys.json.2b9e4f8a-1c2d-4e5f-8a9b-0c1d2e3f4a5b.tmp';
    symlinkSync(elsewhere, join(dir, link));

    const removed = await removeStaleTempFiles(file);
    expect(removed.sort()).toEqual([...ours, link].sort());
    expect(readdirSync(dir).sort()).toEqual(
      [
        'keys.json',
        ...theirs,
        '.keys.json.1b9e4f8a-1c2d-4e5f-8a9b-0c1d2e3f4a5b.tmp',
        'elsewhere',
      ].sort(),
    );
    expect(readFileSync(elsewhere, 'utf8')).toBe('kept');
  });

  it('a missing directory is nothing to remove, not an error', async () => {
    expect(await removeStaleTempFiles(join(tempDir(), 'missing', 'keys.json'))).toEqual([]);
  });
});
