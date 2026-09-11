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

function apiKeyClient(fetchImpl: typeof fetch): HttpClient {
  return new HttpClient({ auth: { kind: 'apiKey', apiKey: 'sk-test' }, fetchImpl });
}

describe('HttpClient (apiKey auth)', () => {
  it('POSTs to /api/cap/<name> with Authorization: Bearer <apiKey>, X-Requested-With, and the params as JSON', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, result: { hello: 'world' } }),
    );
    const client = apiKeyClient(fetchImpl as typeof fetch);

    const result = await client.call('list_pending', { foo: 'bar' });

    expect(result).toEqual({ hello: 'world' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/cap/list_pending');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['x-requested-with']).toBe('nexttime');
    expect(headers['x-workspace-id']).toBeUndefined();
    expect(init.credentials).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ foo: 'bar' });
  });

  it('defaults params to {} when omitted', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: null }));
    const client = apiKeyClient(fetchImpl as typeof fetch);

    await client.call('list_pending');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('throws a capability_error HttpError carrying the wire code on {ok:false}', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { ok: false, error: { code: 'forbidden', message: 'nope' } }),
    );
    const client = apiKeyClient(fetchImpl as typeof fetch);

    const err = await client.call('approve', { actionRequestId: 'ar-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).kind).toBe('capability_error');
    expect((err as HttpError).code).toBe('forbidden');
    expect((err as HttpError).message).toBe('nope');
  });

  it('throws an invalid_response HttpError on a non-JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
    const client = apiKeyClient(fetchImpl as typeof fetch);

    const err = await client.call('get_task', { taskId: 't1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).kind).toBe('invalid_response');
  });

  it('throws a network HttpError when fetch itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    const client = apiKeyClient(fetchImpl as typeof fetch);

    const err = await client.call('get_task', { taskId: 't1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).kind).toBe('network');
  });
});

describe('HttpClient (cookie auth, S4.1)', () => {
  it('sends X-Workspace-Id + X-Requested-With + credentials:same-origin, never Authorization', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: null }));
    const client = new HttpClient({
      auth: { kind: 'cookie', workspaceId: 'ws-1' },
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.call('list_chats');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-workspace-id']).toBe('ws-1');
    expect(headers['x-requested-with']).toBe('nexttime');
    expect(headers.authorization).toBeUndefined();
    expect(init.credentials).toBe('same-origin');
  });

  it('omits X-Workspace-Id when workspaceId is null', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: null }));
    const client = new HttpClient({
      auth: { kind: 'cookie', workspaceId: null },
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.call('get_workspace');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-workspace-id']).toBeUndefined();
    expect(init.credentials).toBe('same-origin');
  });
});
