import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runWithCorrelationId } from '../../substrate/correlation/index.js';
import { GatekeeperClientError, GatekeeperTimeoutError, HttpGatekeeperClient } from './index.js';

/**
 * adapters/gatekeeper-client (unit, no network — an injected `fetchImpl`): the protocol port's
 * HTTP implementation, exercised against a fake `fetch` that mirrors gatekeeper-base's own
 * `{ok:true,result}` / `{ok:false,error}` envelope (packages/gatekeeper-base/src/server.ts).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpGatekeeperClient', () => {
  it('describeOperations issues a GET and unwraps the envelope', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://example.test/gate/describe_operations');
      return jsonResponse({ ok: true, result: { operations: [] } });
    });
    const client = new HttpGatekeeperClient({ fetchImpl });
    const result = await client.describeOperations('https://example.test');
    expect(result).toEqual({ operations: [] });
  });

  it('observe POSTs the call input as JSON', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://example.test/gate/observe');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        operation: 'stock.get',
        params: { sku: 'X1' },
        onBehalfOf: 'user-a',
      });
      return jsonResponse({ ok: true, result: { data: { qty: 3 } } });
    });
    const client = new HttpGatekeeperClient({ fetchImpl });
    const result = await client.observe('https://example.test', {
      operation: 'stock.get',
      params: { sku: 'X1' },
      onBehalfOf: 'user-a',
    });
    expect(result).toEqual({ data: { qty: 3 } });
  });

  it('apply carries actionRequestId through', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.actionRequestId).toBe('req-1');
      return jsonResponse({ ok: true, result: { data: {}, observedFacts: [], replayed: false } });
    });
    const client = new HttpGatekeeperClient({ fetchImpl });
    await client.apply('https://example.test', {
      operation: 'stock.adjust',
      params: {},
      actionRequestId: 'req-1',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws GatekeeperClientError with the envelope code/message on ok:false', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: { code: 'operation_not_found', message: 'nope' } }, 404),
    );
    const client = new HttpGatekeeperClient({ fetchImpl });
    await expect(client.observe('https://example.test', { operation: 'x' })).rejects.toMatchObject({
      code: 'operation_not_found',
      status: 404,
    });
    await expect(client.observe('https://example.test', { operation: 'x' })).rejects.toBeInstanceOf(
      GatekeeperClientError,
    );
  });

  it('throws GatekeeperTimeoutError when the request aborts', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const client = new HttpGatekeeperClient({ fetchImpl, timeoutMs: 5 });
    await expect(client.health('https://example.test')).rejects.toBeInstanceOf(
      GatekeeperTimeoutError,
    );
  });

  it('gives gate/apply its own, longer budget than the read-side calls', async () => {
    // Every call answers after 30 ms unless its signal aborts first.
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(jsonResponse({ ok: true, result: { data: 1, replayed: false } })),
            30,
          );
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const client = new HttpGatekeeperClient({ fetchImpl, timeoutMs: 5, applyTimeoutMs: 1_000 });
    await expect(client.observe('https://example.test', { operation: 'x' })).rejects.toMatchObject({
      name: 'GatekeeperTimeoutError',
      path: 'gate/observe',
    });
    await expect(
      client.apply('https://example.test', { operation: 'x', actionRequestId: 'ar-1' }),
    ).resolves.toMatchObject({ data: 1 });
  });

  // R-49: the budget covers the response body, not just the headers — an endpoint that answers
  // its headers and then trickles (or stalls) the body is a timeout, and for `gate/apply` that is
  // "outcome unknown" (GatekeeperTimeoutError), never a plain failure.
  it('times out a body that stalls after the headers, for reads and for apply', async () => {
    let cancelled = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":true,'));
              // …and never another byte, never closed.
            },
            cancel() {
              cancelled += 1;
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = new HttpGatekeeperClient({ fetchImpl, timeoutMs: 20, applyTimeoutMs: 30 });
    await expect(client.observe('https://example.test', { operation: 'x' })).rejects.toMatchObject({
      name: 'GatekeeperTimeoutError',
      path: 'gate/observe',
    });
    await expect(
      client.apply('https://example.test', { operation: 'x', actionRequestId: 'ar-1' }),
    ).rejects.toMatchObject({ name: 'GatekeeperTimeoutError', path: 'gate/apply' });
    expect(cancelled).toBe(2);
  });

  it('refuses a body larger than the cap instead of buffering it', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let pulls = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              controller.enqueue(chunk); // an endless body
            },
          }),
          { status: 200 },
        ),
    );
    const client = new HttpGatekeeperClient({ fetchImpl });
    const failure = client.health('https://example.test');
    await expect(failure).rejects.toBeInstanceOf(GatekeeperClientError);
    await expect(failure).rejects.toMatchObject({ code: 'response_too_large', status: 200 });
    expect(pulls).toBeLessThan(20);
  });

  it('maps a non-JSON body to invalid_response with the HTTP status', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    const client = new HttpGatekeeperClient({ fetchImpl });
    await expect(client.health('https://example.test')).rejects.toMatchObject({
      name: 'GatekeeperClientError',
      code: 'invalid_response',
      status: 502,
    });
  });

  it('normalizes the endpoint whether or not it has a trailing slash', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://example.test/gate/health');
      return jsonResponse({ ok: true, result: { status: 'ok' } });
    });
    const client = new HttpGatekeeperClient({ fetchImpl });
    await client.health('https://example.test/');
    await client.health('https://example.test');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends no Authorization header when no token file is readable', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
      return jsonResponse({ ok: true, result: { status: 'ok' } });
    });
    const client = new HttpGatekeeperClient({
      fetchImpl,
      env: { NEXTTIME_GATE_TOKEN_FILE: '/definitely/does/not/exist/gate_token' },
    });
    await client.health('https://example.test');
  });

  it('sends Authorization: Bearer <token> when an explicit token is given', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(
        'Bearer explicit-test-token-0123456789',
      );
      return jsonResponse({ ok: true, result: { status: 'ok' } });
    });
    const client = new HttpGatekeeperClient({ fetchImpl, token: 'explicit-test-token-0123456789' });
    await client.health('https://example.test');
  });

  it('reads the token from NEXTTIME_GATE_TOKEN_FILE when no explicit token is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gatekeeper-client-'));
    try {
      const tokenFile = join(dir, 'gate.token');
      writeFileSync(tokenFile, `${'c'.repeat(40)}\n`);
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          `Bearer ${'c'.repeat(40)}`,
        );
        return jsonResponse({ ok: true, result: { status: 'ok' } });
      });
      const client = new HttpGatekeeperClient({
        fetchImpl,
        env: { NEXTTIME_GATE_TOKEN_FILE: tokenFile },
      });
      await client.health('https://example.test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw and sends no header when NEXTTIME_GATE_TOKEN_FILE points nowhere', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
      return jsonResponse({ ok: true, result: { status: 'ok' } });
    });
    const client = new HttpGatekeeperClient({
      fetchImpl,
      env: { NEXTTIME_GATE_TOKEN_FILE: '/no/such/file/gate.token' },
    });
    await client.health('https://example.test');
  });
});

// Leftover 87: a gate call made while serving a correlated kernel call carries its id.
describe('HttpGatekeeperClient — x-correlation-id', () => {
  it('forwards the current call id, and sends none outside a call', async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-correlation-id'));
      return jsonResponse({ ok: true, result: { data: {} } });
    });
    const client = new HttpGatekeeperClient({ fetchImpl, token: 'gate-token-for-tests' });
    await runWithCorrelationId('turn-5555-6666', () =>
      client.observe('https://example.test', { operation: 'stock.get' }),
    );
    await client.observe('https://example.test', { operation: 'stock.get' });
    expect(seen).toEqual(['turn-5555-6666', null]);
  });
});
