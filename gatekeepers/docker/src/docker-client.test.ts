import { describe, expect, it } from 'vitest';
import { demuxDockerLogBuffer } from './docker-client.js';

/**
 * Docker's `container.logs()` for a non-TTY container multiplexes stdout/stderr with an 8-byte
 * frame header per chunk (docker-client.ts's own doc comment) — this is a pure function worth
 * testing directly against hand-built frames rather than only indirectly through a fake transport.
 */

function frame(streamType: number, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('demuxDockerLogBuffer', () => {
  it('demultiplexes stdout/stderr frames into concatenated payload text, in order', () => {
    const buf = Buffer.concat([frame(1, 'line one\n'), frame(2, 'line two\n')]);
    expect(demuxDockerLogBuffer(buf)).toBe('line one\nline two\n');
  });

  it('returns raw text unchanged for a non-framed buffer (e.g. a Tty:true container)', () => {
    const raw = Buffer.from('plain tty output\n', 'utf8');
    expect(demuxDockerLogBuffer(raw)).toBe('plain tty output\n');
  });

  it('returns an empty string for an empty buffer', () => {
    expect(demuxDockerLogBuffer(Buffer.alloc(0))).toBe('');
  });

  it('drops a truncated trailing frame rather than throwing', () => {
    // A complete first frame followed by a second frame whose header claims more payload bytes
    // than are actually present (as if the stream were cut mid-frame) — the complete frame is
    // still returned; the truncated one is silently dropped, not partially emitted.
    const complete = frame(1, 'ok\n');
    const truncatedSecond = frame(1, 'partial-payload').subarray(0, 10);
    const buf = Buffer.concat([complete, truncatedSecond]);
    expect(demuxDockerLogBuffer(buf)).toBe('ok\n');
  });
});
