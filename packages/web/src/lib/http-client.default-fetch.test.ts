// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http-client.js';

/**
 * http-client.default-fetch.test.ts: the regression test for the "Illegal invocation" bug found
 * on the deployed console (see http-client.ts's module doc comment). `http-client.test.ts` always
 * injects `fetchImpl`, so it could never observe how the *default* path invokes the global `fetch`
 * — this file exercises that path in jsdom against a stubbed `globalThis.fetch` that records its
 * receiver. A native `fetch` invoked with `this === HttpClient instance` throws in every browser;
 * here the stub makes the same condition an explicit assertion instead of a platform-specific
 * TypeError.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpClient default fetch binding', () => {
  it('calls the global fetch with the global receiver, never with the client instance as `this`', async () => {
    const receivers: unknown[] = [];
    const stub = vi.fn(function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
      receivers.push(this);
      return Promise.resolve(jsonResponse({ ok: true, result: [] }));
    });
    vi.stubGlobal('fetch', stub);

    const client = new HttpClient({ apiKey: 'sk-test' });
    await expect(client.call('list_pending')).resolves.toEqual([]);

    expect(stub).toHaveBeenCalledTimes(1);
    expect(receivers).toHaveLength(1);
    // Strict-mode functions called unbound see `undefined`; a bound-to-global wrapper sees
    // `globalThis`. Either is what a native `fetch` accepts — the client instance is what it
    // rejects with "Illegal invocation".
    expect(receivers[0]).not.toBe(client);
    expect(receivers[0] === undefined || receivers[0] === globalThis).toBe(true);
  });

  it('resolves the global fetch at call time, so a fetch stubbed after construction is honored', async () => {
    const client = new HttpClient({ apiKey: 'sk-test' });
    const stub = vi.fn(() => Promise.resolve(jsonResponse({ ok: true, result: { late: true } })));
    vi.stubGlobal('fetch', stub);

    await expect(client.call('list_tasks')).resolves.toEqual({ late: true });
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/cap/list_tasks');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  it('would have failed with the pre-fix behavior (bare global assigned as a method)', async () => {
    // Documents the failure mode the fix guards against: a native-like fetch that rejects a
    // foreign receiver, assigned as an own property and called as a method.
    const nativeLike = function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(jsonResponse({ ok: true, result: null }));
    } as unknown as typeof fetch;
    vi.stubGlobal('fetch', nativeLike);

    const buggy = { fetchImpl: fetch };
    expect(() => buggy.fetchImpl('/api/cap/x')).toThrow(/Illegal invocation/);

    const client = new HttpClient({ apiKey: 'sk-test' });
    await expect(client.call('get_task', { taskId: 't1' })).resolves.toBeNull();
  });
});
