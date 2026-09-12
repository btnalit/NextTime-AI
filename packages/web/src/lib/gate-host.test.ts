import type { GateHostTokenWire } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import { GateHostError, postGateCredential } from './gate-host.js';

/**
 * gate-host.test.ts: exercises `postGateCredential` (lib/gate-host.ts) against an injected
 * `fetch` fake — no gate host or kernel required. Mirrors `lib/http-client.test.ts`'s shape.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function token(overrides: Partial<GateHostTokenWire> = {}): GateHostTokenWire {
  return {
    gateId: 'gate-1',
    token: 'jwt-token',
    url: '/gate-host/i/gate-1/gate/connected-accounts',
    onBehalfOf: '__shared__',
    credentialMode: 'shared',
    expiresAt: '2026-09-12T00:05:00.000Z',
    ...overrides,
  };
}

describe('postGateCredential', () => {
  it('POSTs the credential to tokenResult.url with a bearer token and onBehalfOf, and resolves on {ok:true,result:{stored:true}}', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: { stored: true } }));

    await postGateCredential(token(), { token: 'sk-secret' }, fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/gate-host/i/gate-1/gate/connected-accounts');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer jwt-token');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      onBehalfOf: '__shared__',
      credential: { token: 'sk-secret' },
    });
  });

  it('throws GateHostError with the expired-token message on 401', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { ok: false, error: 'unauthorized' }));

    const err = await postGateCredential(token(), { token: 'x' }, fetchImpl as typeof fetch).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GateHostError);
    expect((err as Error).message).toContain('令牌已过期或无效');
  });

  it('throws GateHostError on a non-2xx status other than 401', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { ok: false, error: 'boom' }));

    const err = await postGateCredential(token(), { token: 'x' }, fetchImpl as typeof fetch).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GateHostError);
    expect((err as Error).message).toContain('500');
  });

  it('throws GateHostError when the response body is not JSON', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );

    const err = await postGateCredential(token(), { token: 'x' }, fetchImpl as typeof fetch).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GateHostError);
  });

  it('throws GateHostError when the JSON body is not the expected {ok,result:{stored}} shape', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: { stored: false } }));

    const err = await postGateCredential(token(), { token: 'x' }, fetchImpl as typeof fetch).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GateHostError);
  });
});
