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

  it('carries the wire error.details when the kernel sends one', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        ok: false,
        error: {
          code: 'credentials_review_required',
          message: 'confirm',
          details: { subject: 'action_request', suspectedSecretValues: 2 },
        },
      }),
    );
    const client = apiKeyClient(fetchImpl as typeof fetch);
    const err = await client.call('approve', { actionRequestId: 'ar-1' }).catch((e: unknown) => e);
    expect((err as HttpError).details).toEqual({
      subject: 'action_request',
      suspectedSecretValues: 2,
    });
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

  it('R-16: an `unauthorized` answer calls onUnauthorized, then still rejects; other errors do not', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { ok: false, error: { code: 'unauthorized', message: 'unauthorized' } }),
    );
    const client = new HttpClient({
      auth: { kind: 'apiKey', apiKey: 'sk-test' },
      fetchImpl: fetchImpl as typeof fetch,
      onUnauthorized,
    });

    const err = await client.call('list_tasks').catch((e: unknown) => e);
    expect((err as HttpError).code).toBe('unauthorized');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    fetchImpl.mockImplementationOnce(async () =>
      jsonResponse(403, { ok: false, error: { code: 'forbidden', message: 'nope' } }),
    );
    await client.call('approve').catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
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

describe('HttpClient roleGate (#541 acceptance must-fix 2)', () => {
  function roleClient(role: string | null) {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/api/cap/get_workspace') {
        return role === null
          ? jsonResponse(403, { ok: false, error: { code: 'workspace_required', message: 'x' } })
          : jsonResponse(200, { ok: true, result: { id: 'ws-1', caller: { id: 'p-1', role } } });
      }
      return jsonResponse(200, { ok: true, result: { items: [] } });
    });
    const client = new HttpClient({
      auth: { kind: 'apiKey', apiKey: 'sk-test' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      roleGate: true,
    });
    const sent = () => fetchImpl.mock.calls.map(([url]) => url);
    return { client, sent };
  }

  it('refuses locally, without a request, what the role may not use — the kernel predicate', async () => {
    const { client, sent } = roleClient('auditor');
    const err = await client.call('execution_readiness', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('forbidden');
    expect((err as HttpError).details).toEqual({ checkedLocally: true });
    expect(sent()).toEqual(['/api/cap/get_workspace']);
    // An auditor's own reads still go out; the role was read once.
    await client.call('audit_query', {});
    expect(sent()).toEqual(['/api/cap/get_workspace', '/api/cap/audit_query']);
  });

  it('sends a capability every role may use without reading the role first', async () => {
    const { client, sent } = roleClient('member');
    await client.call('list_gatekeepers', {});
    expect(sent()).toEqual(['/api/cap/list_gatekeepers']);
  });

  it('sends everything when the role cannot be read (no workspace selected)', async () => {
    const { client, sent } = roleClient(null);
    await client.call('list_pending', {});
    expect(sent()).toEqual(['/api/cap/get_workspace', '/api/cap/list_pending']);
  });

  it('a get_workspace made through the client refreshes the role it gates with', async () => {
    const { client, sent } = roleClient('operator');
    await client.call('get_workspace', {});
    await client.call('list_pending', {});
    const err = await client.call('list_connection_requests', {}).catch((e: unknown) => e);
    expect((err as HttpError).code).toBe('forbidden');
    expect(sent()).toEqual(['/api/cap/get_workspace', '/api/cap/list_pending']);
  });
});
