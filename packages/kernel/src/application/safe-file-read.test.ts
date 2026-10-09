import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSmallRegularFile } from './safe-file-read.js';

/** safe-file-read.test.ts (#530 review): the one way the kernel reads another process's file. */

describe('readSmallRegularFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'safe-read-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the text and the mtime of the handle it read', async () => {
    const file = path.join(dir, 'f');
    await writeFile(file, 'hello');
    const at = new Date('2026-10-01T00:00:00Z');
    await utimes(file, at, at);
    const read = await readSmallRegularFile(file, 16);
    expect(read.text).toBe('hello');
    expect(read.mtime.toISOString()).toBe(at.toISOString());
  });

  it('a file of exactly the cap is read; one byte more is too large, with its size and mtime', async () => {
    const file = path.join(dir, 'f');
    await writeFile(file, 'x'.repeat(16));
    expect((await readSmallRegularFile(file, 16)).text).toHaveLength(16);
    await writeFile(file, 'x'.repeat(17));
    await expect(readSmallRegularFile(file, 16)).rejects.toMatchObject({
      reason: 'too_large',
      code: 'EFBIG',
      size: 17,
      mtime: expect.any(Date),
    });
  });

  it('missing, symlink, directory and FIFO each have their own reason and errno-style code', async () => {
    await expect(readSmallRegularFile(path.join(dir, 'none'), 16)).rejects.toMatchObject({
      reason: 'missing',
      code: 'ENOENT',
    });
    await writeFile(path.join(dir, 'real'), 'x');
    await symlink(path.join(dir, 'real'), path.join(dir, 'link'));
    await expect(readSmallRegularFile(path.join(dir, 'link'), 16)).rejects.toMatchObject({
      reason: 'symlink',
      code: 'ELOOP',
    });
    await mkdir(path.join(dir, 'd'));
    await expect(readSmallRegularFile(path.join(dir, 'd'), 16)).rejects.toMatchObject({
      reason: 'not_regular',
      code: 'EISDIR',
    });
    execFileSync('mkfifo', [path.join(dir, 'fifo')]);
    await expect(readSmallRegularFile(path.join(dir, 'fifo'), 16)).rejects.toMatchObject({
      reason: 'not_regular',
      code: 'ENOTREG',
    });
  });
});
