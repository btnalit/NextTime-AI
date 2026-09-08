import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
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
