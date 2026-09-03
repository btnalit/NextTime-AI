import { describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError } from './http-client.js';

/**
 * http-client.test.ts: exercises `HttpClient` (lib/http-client.ts) against an injected `fetch`
 * fake — deterministic, no kernel required. Mirrors `platform-extension/src/kernel-client.test.ts`'s
 * coverage shape for the same envelope contract (packages/shared/src/http.ts).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpClient', () => {
  it('POSTs to /api/cap/<name> with Authorization: Bearer <apiKey> and the params as JSON', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, result: { hello: 'world' } }),
    );
    const client = new HttpClient({ apiKey: 'sk-test', fetchImpl: fetchImpl as typeof fetch });

    const result = await client.call('list_pending', { foo: 'bar' });

    expect(result).toEqual({ hello: 'world' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/cap/list_pending');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toEqual({ foo: 'bar' });
  });

  it('defaults params to {} when omitted', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: null }));
    const client = new HttpClient({ apiKey: 'sk-test', fetchImpl: fetchImpl as typeof fetch });

    await client.call('list_pending');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('throws a capability_error HttpError carrying the wire code on {ok:false}', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { ok: false, error: { code: 'forbidden', message: 'nope' } }),
    );
    const client = new HttpClient({ apiKey: 'sk-test', fetchImpl: fetchImpl as typeof fetch });

    const err = await client.call('approve', { actionRequestId: 'ar-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).kind).toBe('capability_error');
    expect((err as HttpError).code).toBe('forbidden');
    expect((err as HttpError).message).toBe('nope');
  });

  it('throws an invalid_response HttpError on a non-JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
    const client = new HttpClient({ apiKey: 'sk-test', fetchImpl: fetchImpl as typeof fetch });

    const err = await client.call('get_task', { taskId: 't1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).kind).toBe('invalid_response');
  });

  it('throws a network HttpError when fetch itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    const client = new HttpClient({ apiKey: 'sk-test', fetchImpl: fetchImpl as typeof fetch });

    const err = await client.call('get_task', { taskId: 't1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).kind).toBe('network');
  });
});
