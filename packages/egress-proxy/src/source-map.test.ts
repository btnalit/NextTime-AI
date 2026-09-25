import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourceMap } from './source-map.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'egress-proxy-source-map-'));
  file = join(dir, 'sources.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createSourceMap', () => {
  it('resolves an entry by client IP', () => {
    writeFileSync(
      file,
      JSON.stringify({
        '198.51.100.10': { sourceId: 'worker-1', allow: ['example.com'] },
      }),
    );
    const map = createSourceMap(file);
    expect(map.resolveSource('198.51.100.10')).toEqual({
      sourceId: 'worker-1',
      allow: ['example.com'],
    });
    expect(map.resolveSource('198.51.100.11')).toBeUndefined();
    map.close();
  });

  it('returns undefined for every client IP when no file is configured', () => {
    const map = createSourceMap(undefined);
    expect(map.resolveSource('198.51.100.10')).toBeUndefined();
    map.close();
  });

  it('reports a parse error (after one retry) and keeps an empty map instead of throwing', async () => {
    // leftover 61: a failed read/parse is retried once (RETRY_DELAY_MS) before being reported —
    // this file stays bad across the retry, so onError still fires, just not synchronously.
    writeFileSync(file, 'not json');
    const onError = vi.fn();
    const map = createSourceMap(file, { onError });
    expect(onError).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(map.resolveSource('198.51.100.10')).toBeUndefined();
    map.close();
  });

  it('reports a schema violation (after one retry) instead of throwing', async () => {
    writeFileSync(file, JSON.stringify({ '198.51.100.10': { sourceId: 42 } }));
    const onError = vi.fn();
    const map = createSourceMap(file, { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 1000 });
    map.close();
  });

  it('reports a missing file instead of throwing', async () => {
    // The fs.watch() setup failure for a nonexistent path reports synchronously (unchanged); the
    // initial read's own failure now reports after the retry — each independently, so this only
    // asserts "reported, not thrown", not an exact count.
    const onError = vi.fn();
    const map = createSourceMap(join(dir, 'does-not-exist.json'), { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 1000 });
    expect(map.resolveSource('198.51.100.10')).toBeUndefined();
    map.close();
  });

  it('a torn read that clears within the retry window never reports an error (leftover 61)', async () => {
    // Simulates fs.watch firing mid-write on egress-map.ts's own non-atomic writer: the file is
    // briefly invalid, then becomes valid again well inside RETRY_DELAY_MS — the retry should see
    // the finished write and never call onError at all.
    writeFileSync(file, JSON.stringify({ '198.51.100.10': { sourceId: 'worker-1' } }));
    const onError = vi.fn();
    const map = createSourceMap(file, { onError });
    expect(map.resolveSource('198.51.100.10')?.sourceId).toBe('worker-1');

    writeFileSync(file, 'not json — torn write in progress');
    writeFileSync(file, JSON.stringify({ '198.51.100.10': { sourceId: 'worker-2' } }));

    await vi.waitFor(() => expect(map.resolveSource('198.51.100.10')?.sourceId).toBe('worker-2'), {
      timeout: 5000,
      interval: 50,
    });
    expect(onError).not.toHaveBeenCalled();
    map.close();
  });

  it('logs a persisting parse error once per burst, not once per fs.watch event (leftover 61)', async () => {
    writeFileSync(file, JSON.stringify({ '198.51.100.10': { sourceId: 'worker-1' } }));
    const onError = vi.fn();
    const map = createSourceMap(file, { onError });
    expect(map.resolveSource('198.51.100.10')?.sourceId).toBe('worker-1');

    // Several fs.watch events in a row while the file stays broken — same underlying failure,
    // must not produce one log line each.
    writeFileSync(file, 'still not json (1)');
    writeFileSync(file, 'still not json (2)');
    writeFileSync(file, 'still not json (3)');

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 1000 });
    // The previously-loaded map is kept, not cleared, across the failures.
    expect(map.resolveSource('198.51.100.10')?.sourceId).toBe('worker-1');

    // Recovery: a valid write clears `erroring`, so a *new*, later failure gets its own line again.
    writeFileSync(file, JSON.stringify({ '198.51.100.10': { sourceId: 'worker-2' } }));
    await vi.waitFor(() => expect(map.resolveSource('198.51.100.10')?.sourceId).toBe('worker-2'), {
      timeout: 5000,
      interval: 50,
    });
    writeFileSync(file, 'broken again');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2), { timeout: 1000 });
    map.close();
  });

  it('hot-reloads on an in-place edit', async () => {
    writeFileSync(file, JSON.stringify({ '198.51.100.10': { sourceId: 'worker-1' } }));
    const map = createSourceMap(file);
    expect(map.resolveSource('198.51.100.10')?.sourceId).toBe('worker-1');

    writeFileSync(file, JSON.stringify({ '198.51.100.10': { sourceId: 'worker-2' } }));

    await vi.waitFor(
      () => {
        expect(map.resolveSource('198.51.100.10')?.sourceId).toBe('worker-2');
      },
      { timeout: 5000, interval: 50 },
    );
    map.close();
  });
});
