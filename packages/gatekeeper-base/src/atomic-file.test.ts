import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic-file.js';

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
    await writeFileAtomic(file, '{"a":2}', 0o640);
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}');
    expect(statSync(file).mode & 0o777).toBe(0o640);
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
