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

  it('sends the configured Authorization header on the poll (fix/internal-plane-auth)', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ revoked: [], now: '2026-01-01T00:00:00.000Z' }),
    );
    sync = startRevocationSync({
      kernelUrl: 'http://kernel.internal:8080',
      authorizationHeader: 'Bearer test-token',
      intervalMs: 1_000_000,
      overlapMs: 60_000,
      fetchImpl,
      log: () => {},
    });

    await sync.forceSync();

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      'Bearer test-token',
    );
  });

  it('omits the Authorization header when none is configured', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ revoked: [], now: '2026-01-01T00:00:00.000Z' }),
    );
    sync = startRevocationSync({
      kernelUrl: 'http://kernel.internal:8080',
      intervalMs: 1_000_000,
      overlapMs: 60_000,
      fetchImpl,
      log: () => {},
    });

    await sync.forceSync();

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
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

describe('startRevocationSync: paging (R-14)', () => {
  /** A fake kernel serving `pages` in order: page n answers the request whose `cursor` is
   *  `c<n-1>` (none for the first), with `hasMore` until the last. `failAt` makes that page 503. */
  function pagedKernel(
    pages: readonly { readonly rows: readonly string[]; readonly now: string }[],
    options: { readonly failAt?: number } = {},
  ) {
    const requests: { since: string | null; cursor: string | null }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input as string | URL);
      const cursor = url.searchParams.get('cursor');
      requests.push({ since: url.searchParams.get('since'), cursor });
      const index = cursor === null ? 0 : Number(cursor.slice(1)) + 1;
      if (index === options.failAt) return jsonResponse({}, false, 503);
      const page = pages[index];
      if (!page) throw new Error(`no page ${index}`);
      const last = index === pages.length - 1;
      return jsonResponse({
        revoked: page.rows.map((jti, i) => ({
          jti,
          revokedAt: `2026-01-01T00:0${index}:0${i}.000Z`,
        })),
        now: page.now,
        hasMore: !last,
        ...(last ? {} : { nextCursor: `c${index}` }),
      });
    });
    return { fetchImpl, requests };
  }

  function start(fetchImpl: typeof fetch): RevocationSync {
    return startRevocationSync({
      kernelUrl: 'http://kernel.internal:8080',
      intervalMs: 1_000_000,
      overlapMs: 60_000,
      fetchImpl,
      log: () => {},
    });
  }

  it('follows every page with the same `since`, and the next sync starts from the first page’s `now`', async () => {
    const kernel = pagedKernel([
      { rows: ['a', 'b'], now: '2026-01-01T01:00:00.000Z' },
      { rows: ['c', 'd'], now: '2026-01-01T01:00:01.000Z' },
      { rows: ['e'], now: '2026-01-01T01:00:02.000Z' },
    ]);
    sync = start(kernel.fetchImpl as unknown as typeof fetch);

    await sync.forceSync();

    for (const jti of ['a', 'b', 'c', 'd', 'e']) expect(sync.isRevoked(jti)).toBe(true);
    expect(kernel.requests.map((r) => r.cursor)).toEqual([null, 'c0', 'c1']);
    expect(new Set(kernel.requests.map((r) => r.since))).toEqual(
      new Set([new Date(0).toISOString()]),
    );

    await sync.forceSync();
    // 01:00:00 (the first page's clock) - 60s — not the last page's.
    expect(kernel.requests[3]?.since).toBe('2026-01-01T00:59:00.000Z');
  });

  it('a page that fails keeps what was received and advances only to the last row received, never to `now`', async () => {
    const kernel = pagedKernel(
      [
        { rows: ['a', 'b'], now: '2026-01-01T01:00:00.000Z' },
        { rows: ['c'], now: '2026-01-01T01:00:01.000Z' },
      ],
      { failAt: 1 },
    );
    sync = start(kernel.fetchImpl as unknown as typeof fetch);

    await sync.forceSync();

    expect(sync.isRevoked('a')).toBe(true);
    expect(sync.isRevoked('b')).toBe(true);
    expect(sync.isRevoked('c')).toBe(false);

    await sync.forceSync();
    // The next sync starts over from the first page — `since` 60s before row 'b' (page 0, row 1,
    // revoked at 00:00:01), not 60s before the kernel's `now`.
    expect(kernel.requests[2]).toEqual({ since: '2025-12-31T23:59:01.000Z', cursor: null });
  });

  it('stops on a cursor that does not advance instead of looping', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        revoked: [{ jti: 'a', revokedAt: '2026-01-01T00:00:00.000Z' }],
        now: '2026-01-01T01:00:00.000Z',
        hasMore: true,
        nextCursor: 'same',
      }),
    );
    sync = start(fetchImpl as unknown as typeof fetch);

    await sync.forceSync();

    expect(sync.isRevoked('a')).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('a kernel without paging (no hasMore) is one page, as before', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        revoked: [{ jti: 'a', revokedAt: '2026-01-01T00:00:00.000Z' }],
        now: '2026-01-01T01:00:00.000Z',
      }),
    );
    sync = start(fetchImpl as unknown as typeof fetch);

    await sync.forceSync();

    expect(sync.isRevoked('a')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
