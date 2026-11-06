import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TarPathError, ustarArchive } from './tar.js';

/** lib/tar (S11 AA5d-3): the archive an exported pack downloads as. */

const decoder = new TextDecoder();

function field(block: Uint8Array, offset: number, width: number): string {
  const bytes = block.subarray(offset, offset + width);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** Reads back what `ustarArchive` wrote, checking every header's checksum. */
function entries(archive: Uint8Array): { path: string; content: string; mode: string }[] {
  const out: { path: string; content: string; mode: string }[] = [];
  let offset = 0;
  while (offset < archive.length) {
    const block = archive.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const stored = Number.parseInt(field(block, 148, 8).trim(), 8);
    let sum = 0;
    for (const [index, byte] of block.entries()) sum += index >= 148 && index < 156 ? 32 : byte;
    expect(sum).toBe(stored);
    expect(field(block, 257, 6)).toBe('ustar');
    expect(field(block, 156, 1)).toBe('0');
    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);
    const size = Number.parseInt(field(block, 124, 12), 8);
    const body = archive.subarray(offset + 512, offset + 512 + size);
    out.push({
      path: prefix ? `${prefix}/${name}` : name,
      content: decoder.decode(body),
      mode: field(block, 100, 8),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const LONG = `ticket-desk-${'d'.repeat(50)}/1/skills/${'s'.repeat(60)}.md`;

const FILES = [
  { path: 'ticket-desk/1/pack.yaml', content: 'schema: 1\nname: ticket-desk\n' },
  {
    path: 'ticket-desk/1/skills/ticket-triage.md',
    content: '---\nname: ticket-triage\n---\n工单分诊',
  },
  { path: LONG, content: 'x'.repeat(513) },
  { path: 'ticket-desk/1/workers/empty.yaml', content: '' },
];

describe('ustarArchive', () => {
  it('holds every file as written, a long path in the prefix field, ending in two zero blocks', () => {
    const archive = ustarArchive(FILES);
    expect(archive.length % 512).toBe(0);
    expect(archive.subarray(archive.length - 1024).every((byte) => byte === 0)).toBe(true);
    const read = entries(archive);
    expect(read.map(({ path, content }) => ({ path, content }))).toEqual(FILES);
    expect(read.every((entry) => entry.mode === '0000644')).toBe(true);
    expect(LONG.length).toBeGreaterThan(100);
  });

  it('the same files give the same bytes', () => {
    expect(ustarArchive(FILES)).toEqual(ustarArchive(FILES));
  });

  it('refuses a path that would unpack elsewhere or cannot be held', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a//b', './a', '', 'c'.repeat(101)]) {
      expect(() => ustarArchive([{ path: bad, content: '' }]), bad).toThrow(TarPathError);
    }
  });

  it.runIf(process.platform !== 'win32')('unpacks with tar -xf as written', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ustar-'));
    try {
      writeFileSync(path.join(dir, 'pack.tar'), ustarArchive(FILES));
      execFileSync('tar', ['-xf', 'pack.tar'], { cwd: dir });
      for (const file of FILES) {
        expect(readFileSync(path.join(dir, file.path), 'utf8'), file.path).toBe(file.content);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
