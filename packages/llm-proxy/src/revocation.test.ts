import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RevocationSync, startRevocationSync } from './revocation.js';

/**
 * revocation.test: `intervalMs` set huge (never fires on its own during a test) and every sync
 * driven explicitly via `forceSync()` — deterministic, no reliance on real timers.
 */

let sync: RevocationSync | undefined;

afterEach(() => {
  sync?.close();
  sync = undefined;
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('startRevocationSync', () => {
  it('isRevoked is false for everything before any sync has completed', () => {
    const fetchImpl = vi.fn();
    sync = startRevocationSync({
      kernelUrl: 'http://kernel.internal:8080',
      intervalMs: 1_000_000,
      overlapMs: 60_000,
      fetchImpl,
      log: () => {},
    });
    expect(sync.isRevoked('jti-1')).toBe(false);
  });

  it('a successful sync adds every returned jti to the revoked set', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        revoked: [{ jti: 'jti-1', revokedAt: '2026-01-01T00:00:00.000Z' }],
        now: '2026-01-01T00:00:05.000Z',
      }),
    );
    sync = startRevocationSync({
      kernelUrl: 'http://kernel.internal:8080',
      intervalMs: 1_000_000,
      overlapMs: 60_000,
      fetchImpl,
      log: () => {},
    });

    await sync.forceSync();
    expect(sync.isRevoked('jti-1')).toBe(true);
    expect(sync.isRevoked('jti-2')).toBe(false);
  });

  it('does nothing (no-op, never throws) when kernelUrl is unset', async () => {
    const fetchImpl = vi.fn();
    sync = startRevocationSync({
      kernelUrl: undefined,
      intervalMs: 1_000_000,
      overlapMs: 60_000,
      fetchImpl,
      log: () => {},
    });
    await sync.forceSync();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sync.isRevoked('jti-1')).toBe(false);
  });

  it('fails open: a failed sync logs a warning and keeps the previously known revoked set', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          revoked: [{ jti: 'jti-1', revokedAt: '2026-01-01T00:00:00.000Z' }],
          now: '2026-01-01T00:00:05.000Z',
        });
      }
      throw new Error('connection refused');
    });
    const log = vi.fn();
    sync = startRevocationSync({
      kernelUrl: 'http://kernel.internal:8080',
      intervalMs: 1_000_000,
      overlapMs: 60_000,
      fetchImpl,
      log,
    });

    await sync.forceSync();
    expect(sync.isRevoked('jti-1')).toBe(true);

    await sync.forceSync();
    expect(sync.isRevoked('jti-1')).toBe(true); // still known-revoked, not cleared
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('also fails open (keeps the set) on a non-ok HTTP response', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          revoked: [{ jti: 'jti-1', revokedAt: '2026-01-01T00:00:00.000Z' }],
          now: '2026-01-01T00:00:05.000Z',
        });
      }
      return jsonResponse({}, false, 503);
    });
    sync = startRevocationSync({
      kernelUrl: 'http://kernel.internal:8080',
      intervalMs: 1_000_000,
      overlapMs: 60_000,
      fetchImpl,
      log: () => {},
    });

    await sync.forceSync();
    await sync.forceSync();
    expect(sync.isRevoked('jti-1')).toBe(true);
  });

  it("requests `since` = previous sync's server `now` minus overlapMs on the next poll", async () => {
    const seenSince: string[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      call += 1;
      const url = new URL(input as string | URL);
      seenSince.push(url.searchParams.get('since') ?? '');
      if (call === 1) {
        return jsonResponse({ revoked: [], now: '2026-01-01T00:10:00.000Z' });
      }
      return jsonResponse({ revoked: [], now: '2026-01-01T00:20:00.000Z' });
    });
    sync = startRevocationSync({
      kernelUrl: 'http://kernel.internal:8080',
      intervalMs: 1_000_000,
      overlapMs: 60_000, // 60s
      fetchImpl,
      log: () => {},
    });

    await sync.forceSync();
    expect(seenSince[0]).toBe(new Date(0).toISOString());

    await sync.forceSync();
    expect(seenSince[1]).toBe('2026-01-01T00:09:00.000Z'); // 00:10:00 - 60s
  });
});
