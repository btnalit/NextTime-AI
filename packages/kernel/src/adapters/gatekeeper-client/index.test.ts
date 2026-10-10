import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runWithCorrelationId } from '../../substrate/correlation/index.js';
import { OutboundTargetRefusedError } from '../outbound-target/index.js';
import {
  GatekeeperClientError,
  GatekeeperTimeoutError,
  HttpGatekeeperClient,
  deriveConnectionSecret,
  platformGateTarget,
} from './index.js';

/**
 * adapters/gatekeeper-client (unit, no network — an injected `fetchImpl`): the protocol port's
 * HTTP implementation, exercised against a fake `fetch` that mirrors gatekeeper-base's own
 * `{ok:true,result}` / `{ok:false,error}` envelope (packages/gatekeeper-base/src/server.ts).
 */

const GATE = platformGateTarget('https://example.test');
/** Legacy K: any digest — this client sends it as given and the gate checks it. */
const DIGEST = `sha256:${'0'.repeat(64)}`;

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
    const result = await client.describeOperations(GATE);
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
        operationDigest: DIGEST,
      });
      return jsonResponse({ ok: true, result: { data: { qty: 3 } } });
    });
    const client = new HttpGatekeeperClient({ fetchImpl });
    const result = await client.observe(GATE, {
      operation: 'stock.get',
      params: { sku: 'X1' },
      onBehalfOf: 'user-a',
      operationDigest: DIGEST,
    });
    expect(result).toEqual({ data: { qty: 3 } });
  });

  it('apply carries actionRequestId through', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.actionRequestId).toBe('req-1');
      expect(body.operationDigest).toBe(DIGEST);
      return jsonResponse({ ok: true, result: { data: {}, observedFacts: [], replayed: false } });
    });
    const client = new HttpGatekeeperClient({ fetchImpl });
    await client.apply(GATE, {
      operation: 'stock.adjust',
      params: {},
      actionRequestId: 'req-1',
      operationDigest: DIGEST,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws GatekeeperClientError with the envelope code/message on ok:false', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: { code: 'operation_not_found', message: 'nope' } }, 404),
    );
    const client = new HttpGatekeeperClient({ fetchImpl });
    await expect(
      client.observe(GATE, { operation: 'x', operationDigest: DIGEST }),
    ).rejects.toMatchObject({
      code: 'operation_not_found',
      status: 404,
    });
    await expect(
      client.observe(GATE, { operation: 'x', operationDigest: DIGEST }),
    ).rejects.toBeInstanceOf(GatekeeperClientError);
  });

  it('throws GatekeeperTimeoutError when the request aborts', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const client = new HttpGatekeeperClient({ fetchImpl, timeoutMs: 5 });
    await expect(client.health(GATE)).rejects.toBeInstanceOf(GatekeeperTimeoutError);
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
    await expect(
      client.observe(GATE, { operation: 'x', operationDigest: DIGEST }),
    ).rejects.toMatchObject({
      name: 'GatekeeperTimeoutError',
      path: 'gate/observe',
    });
    await expect(
      client.apply(GATE, { operation: 'x', actionRequestId: 'ar-1', operationDigest: DIGEST }),
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
    await expect(
      client.observe(GATE, { operation: 'x', operationDigest: DIGEST }),
    ).rejects.toMatchObject({
      name: 'GatekeeperTimeoutError',
      path: 'gate/observe',
    });
    await expect(
      client.apply(GATE, { operation: 'x', actionRequestId: 'ar-1', operationDigest: DIGEST }),
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
    const failure = client.health(GATE);
    await expect(failure).rejects.toBeInstanceOf(GatekeeperClientError);
    await expect(failure).rejects.toMatchObject({ code: 'response_too_large', status: 200 });
    expect(pulls).toBeLessThan(20);
  });

  it('maps a non-JSON body to invalid_response with the HTTP status', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    const client = new HttpGatekeeperClient({ fetchImpl });
    await expect(client.health(GATE)).rejects.toMatchObject({
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
    await client.health(platformGateTarget('https://example.test/'));
    await client.health(GATE);
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
    await client.health(GATE);
  });

  it('sends Authorization: Bearer <token> when an explicit token is given', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(
        'Bearer explicit-test-token-0123456789',
      );
      return jsonResponse({ ok: true, result: { status: 'ok' } });
    });
    const client = new HttpGatekeeperClient({ fetchImpl, token: 'explicit-test-token-0123456789' });
    await client.health(GATE);
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
      await client.health(GATE);
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
    await client.health(GATE);
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
      client.observe(GATE, { operation: 'stock.get', operationDigest: DIGEST }),
    );
    await client.observe(GATE, { operation: 'stock.get', operationDigest: DIGEST });
    expect(seen).toEqual(['turn-5555-6666', null]);
  });
});

// R-01 / maintainer decision D-01: the platform gate token goes only to a gate the kernel
// provisioned; a self-connected gate gets its own derived secret; one with none is not called.
describe('HttpGatekeeperClient — which credential a gate gets (D-01)', () => {
  const GATE_TOKEN = 'platform-gate-token-for-tests-0123456789';
  const SELF = 'https://gate.owner.example';
  const WORKSPACE = '11111111-2222-4333-8444-555555555555';
  const SALT = 'a'.repeat(32);
  const allowAll = vi.fn(async () => {});

  function recordingFetch() {
    const calls: { authorization: string | null; redirect: RequestInit['redirect'] }[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        authorization: new Headers(init?.headers).get('authorization'),
        redirect: init?.redirect,
      });
      return jsonResponse({ ok: true, result: { status: 'ok' } });
    });
    return { fetchImpl, calls };
  }

  it('sends the platform token to a platform target, with the default redirect mode', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const client = new HttpGatekeeperClient({
      fetchImpl,
      token: GATE_TOKEN,
      outboundTargetGuard: allowAll,
    });
    await client.health(GATE);
    expect(calls).toEqual([{ authorization: `Bearer ${GATE_TOKEN}`, redirect: undefined }]);
  });

  it('sends a self-connected gate its derived secret — never the platform token — and refuses redirects', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const guard = vi.fn(async () => {});
    const client = new HttpGatekeeperClient({
      fetchImpl,
      token: GATE_TOKEN,
      outboundTargetGuard: guard,
    });
    await client.health({
      endpoint: SELF,
      credential: { kind: 'connection', workspaceId: WORKSPACE, salt: SALT },
    });
    const secret = deriveConnectionSecret(GATE_TOKEN, WORKSPACE, SALT);
    expect(calls).toEqual([{ authorization: `Bearer ${secret}`, redirect: 'manual' }]);
    expect(calls[0]?.authorization).not.toContain(GATE_TOKEN);
    expect(guard).toHaveBeenCalledWith(SELF, 'gate endpoint');
  });

  it('refuses a self-connected gate’s redirect, saying where it pointed (review of #532, item 4)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('moved', {
          status: 307,
          headers: { location: 'https://elsewhere.example/gate/health?token=t0k3n' },
        }),
    );
    const client = new HttpGatekeeperClient({
      fetchImpl,
      token: GATE_TOKEN,
      outboundTargetGuard: allowAll,
    });
    const thrown = await client
      .health({
        endpoint: SELF,
        credential: { kind: 'connection', workspaceId: WORKSPACE, salt: SALT },
      })
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(GatekeeperClientError);
    expect(thrown).toMatchObject({ code: 'redirect_refused', status: 307 });
    const message = (thrown as Error).message;
    expect(message).toContain(
      'gatekeeper client: gate/health responded 307, a redirect to "https://elsewhere.example/gate/health"',
    );
    expect(message).toContain("set the Gatekeeper's endpoint to the final address");
    expect(message).not.toContain('t0k3n');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never calls a self-connected gate that has no secret on record (connection_secret_missing, 401)', async () => {
    const { fetchImpl } = recordingFetch();
    const client = new HttpGatekeeperClient({
      fetchImpl,
      token: GATE_TOKEN,
      outboundTargetGuard: allowAll,
    });
    await expect(
      client.observe(
        { endpoint: SELF, credential: { kind: 'none' } },
        { operation: 'x', operationDigest: DIGEST },
      ),
    ).rejects.toMatchObject({
      name: 'GatekeeperClientError',
      code: 'connection_secret_missing',
      status: 401,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a self-connected target the outbound-target guard refuses, before any fetch', async () => {
    const { fetchImpl } = recordingFetch();
    const guard = vi.fn(async (url: string) => {
      throw new OutboundTargetRefusedError(
        url,
        'bare-hostname',
        'worker-supervisor',
        'gate endpoint',
      );
    });
    const client = new HttpGatekeeperClient({
      fetchImpl,
      token: GATE_TOKEN,
      outboundTargetGuard: guard,
    });
    await expect(
      client.apply(
        {
          endpoint: 'http://worker-supervisor:8081',
          credential: { kind: 'connection', workspaceId: WORKSPACE, salt: SALT },
        },
        { operation: 'x', actionRequestId: 'ar-1', operationDigest: DIGEST },
      ),
    ).rejects.toMatchObject({ code: 'target_refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not run the guard for a platform target (a provisioned gate is not owner-supplied)', async () => {
    const { fetchImpl } = recordingFetch();
    const guard = vi.fn(async () => {
      throw new Error('must not be called');
    });
    const client = new HttpGatekeeperClient({
      fetchImpl,
      token: GATE_TOKEN,
      outboundTargetGuard: guard,
    });
    await client.health(platformGateTarget('http://gatekeeper-docker:8083'));
    expect(guard).not.toHaveBeenCalled();
  });

  it('cannot authenticate a self-connected gate without a gate token to derive from', async () => {
    const { fetchImpl } = recordingFetch();
    const client = new HttpGatekeeperClient({
      fetchImpl,
      env: { NEXTTIME_GATE_TOKEN_FILE: '/no/such/file/gate.token' },
      outboundTargetGuard: allowAll,
    });
    await expect(
      client.health({
        endpoint: SELF,
        credential: { kind: 'connection', workspaceId: WORKSPACE, salt: SALT },
      }),
    ).rejects.toMatchObject({ code: 'gate_token_unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * Review of #538, item 1: a gate's error text reaches the caller on every surface (and, through an
 * agent's tool result, its model), and a self-connected gate can answer anything — scrubbed and
 * bounded here once, for the pass-through refusals and the 502 alike.
 */
describe('HttpGatekeeperClient — a gate’s error text', () => {
  /** Synthetic, key-shaped — never a real credential. */
  const KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123';

  async function refusal(error: unknown, status = 403): Promise<GatekeeperClientError> {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error }, status));
    const client = new HttpGatekeeperClient({ fetchImpl });
    const failure = await client
      .observe(GATE, { operation: 'list', operationDigest: DIGEST })
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GatekeeperClientError);
    return failure as GatekeeperClientError;
  }

  it('hides a credential in the message, keeping the code and the rest of the text', async () => {
    const err = await refusal({ code: 'operation_refused', message: `bad key ${KEY} for /v1` });
    expect(err).toMatchObject({ code: 'operation_refused', status: 403 });
    expect(err.message).not.toContain(KEY);
    expect(err.message).toBe('bad key [redacted] for /v1');
  });

  it('scrubs an upstream failure (the 502 path) too', async () => {
    const err = await refusal(
      { code: 'transport_error', message: `untrusted: {"error":"Authorization: Bearer ${KEY}"}` },
      502,
    );
    expect(err).toMatchObject({ code: 'transport_error', status: 502 });
    expect(err.message).not.toContain(KEY);
  });

  it('cuts a long message on a UTF-8 boundary and says so, after scrubbing what the cut lands in', async () => {
    // The key straddles the 4 KiB cut: hidden before the cut, so no prefix of it survives.
    const message = `${'é'.repeat(2045)} ${KEY} ${'x'.repeat(10_000)}`;
    const err = await refusal({ code: 'invalid_params', message }, 400);
    expect(err.message).not.toContain('sk-ant-');
    expect(err.message).toMatch(/… \[truncated, \d+ bytes total\]$/);
    const body = err.message.replace(/… \[truncated, \d+ bytes total\]$/, '');
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(4096);
    expect(body).not.toContain('�');
  });

  it.each([
    ['a number', 42],
    ['an object', { text: KEY }],
    ['an empty string', ''],
    ['nothing', undefined],
  ])('reads a message that is %s as one the gate did not give', async (_label, message) => {
    const err = await refusal({ code: 'operation_refused', message });
    expect(err).toMatchObject({ code: 'operation_refused', status: 403 });
    expect(err.message).toBe('gatekeeper client: gate/observe answered an error without a message');
  });

  it.each([
    ['not snake_case', 'Operation Refused'],
    ['too long', `${'a_'.repeat(40)}a`],
    ['key-shaped', KEY],
    ['a 40-character hex token', `a${'0123456789abcdef'.repeat(2)}0123456`],
    ['not a string', 403],
  ])('does not repeat a code that is %s', async (_label, code) => {
    const err = await refusal({ code, message: 'no' });
    expect(err.code).toBe('unrecognized_gate_error');
    expect(err.message).toBe('no');
  });

  it.each([
    ['no error at all', { ok: false }],
    ['a non-object envelope', 'nope'],
    ['null', null],
  ])('maps %s to an error instead of crashing', async (_label, body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body, 500));
    const client = new HttpGatekeeperClient({ fetchImpl });
    await expect(client.health(GATE)).rejects.toBeInstanceOf(GatekeeperClientError);
  });
});
