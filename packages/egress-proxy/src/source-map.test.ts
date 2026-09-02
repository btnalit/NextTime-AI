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

  it('reports a parse error and keeps an empty map instead of throwing', () => {
    writeFileSync(file, 'not json');
    const onError = vi.fn();
    const map = createSourceMap(file, { onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(map.resolveSource('198.51.100.10')).toBeUndefined();
    map.close();
  });

  it('reports a schema violation instead of throwing', () => {
    writeFileSync(file, JSON.stringify({ '198.51.100.10': { sourceId: 42 } }));
    const onError = vi.fn();
    const map = createSourceMap(file, { onError });
    expect(onError).toHaveBeenCalledTimes(1);
    map.close();
  });

  it('reports a missing file instead of throwing', () => {
    // Both the initial read and the fs.watch() setup fail for a nonexistent path — each is
    // reported independently, so this only asserts "reported, not thrown", not an exact count.
    const onError = vi.fn();
    const map = createSourceMap(join(dir, 'does-not-exist.json'), { onError });
    expect(onError).toHaveBeenCalled();
    expect(map.resolveSource('198.51.100.10')).toBeUndefined();
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
