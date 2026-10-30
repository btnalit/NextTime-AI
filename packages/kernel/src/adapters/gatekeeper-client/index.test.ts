import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runWithCorrelationId } from '../../substrate/correlation/index.js';
import { OutboundTargetRefusedError } from '../outbound-target/index.js';
import {
  GatekeeperClientError,
  GatekeeperTimeoutError,
  HttpGatekeeperClient,
  deriveConnectionSecret,
  gateAbsenceOf,
  gateFailureRetry,
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

  it('credentialPresence (legacy 513) POSTs who to ask about and answers the mode and a yes or no', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://example.test/gate/credential-presence');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({ onBehalfOf: 'user-a' });
      return jsonResponse({
        ok: true,
        result: { credentialMode: 'connected_account', present: false },
      });
    });
    const client = new HttpGatekeeperClient({ fetchImpl });
    expect(await client.credentialPresence(GATE, 'user-a')).toEqual({
      credentialMode: 'connected_account',
      present: false,
    });
  });

  it('credentialPresence refuses an answer carrying anything more than the mode and the boolean', async () => {
    for (const result of [
      { credentialMode: 'connected_account', present: true, credential: { token: 'x' } },
      { credentialMode: 'shared', present: true },
      { credentialMode: 'connected_account' },
    ]) {
      const client = new HttpGatekeeperClient({
        fetchImpl: vi.fn(async () => jsonResponse({ ok: true, result })),
      });
      await expect(client.credentialPresence(GATE, 'user-a')).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
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

  it('lookupApply asks gate/apply_lookup with the apply key and no definition (legacy 287)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://example.test/gate/apply_lookup');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        operation: 'stock.adjust',
        params: { qty: 1 },
        onBehalfOf: 'user-a',
        actionRequestId: 'req-1',
      });
      return jsonResponse({
        ok: true,
        result: { data: { ok: 1 }, observedFacts: [], replayed: true },
      });
    });
    const client = new HttpGatekeeperClient({ fetchImpl });
    const result = await client.lookupApply(GATE, {
      operation: 'stock.adjust',
      params: { qty: 1 },
      onBehalfOf: 'user-a',
      actionRequestId: 'req-1',
    });
    expect(result).toEqual({ data: { ok: 1 }, observedFacts: [], replayed: true });
  });

  it("stores U+0000 in a gate's answer and error message as the visible \\u{0} (legacy 320)", async () => {
    const answer = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          data: { out: 'a\u0000b' },
          observedFacts: [{ objectType: 'Host', identity: { hostname: 'h\u0000' } }],
          replayed: false,
        },
      }),
    );
    const applied = await new HttpGatekeeperClient({ fetchImpl: answer }).apply(GATE, {
      operation: 'stock.adjust',
      params: {},
      actionRequestId: 'req-1',
      operationDigest: DIGEST,
    });
    expect(applied).toEqual({
      data: { out: 'a\\u{0}b' },
      observedFacts: [{ objectType: 'Host', identity: { hostname: 'h\\u{0}' } }],
      replayed: false,
    });

    const refusal = vi.fn(async () =>
      jsonResponse(
        { ok: false, error: { code: 'upstream_error', message: 'bad \u0000 byte' } },
        502,
      ),
    );
    await expect(
      new HttpGatekeeperClient({ fetchImpl: refusal }).observe(GATE, {
        operation: 'x',
        operationDigest: DIGEST,
      }),
    ).rejects.toMatchObject({ code: 'upstream_error', message: 'bad \\u{0} byte' });
  });

  it('keeps a describe_operations manifest as sent — importManifest decides it field by field (legacy 320)', async () => {
    const operations = [{ name: 'x\u0000', description: 'd\u0000' }];
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, result: { operations } }));
    const result = await new HttpGatekeeperClient({ fetchImpl }).describeOperations(GATE);
    expect(result).toEqual({ operations });
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

  // UX acceptance of #538: what the kernel records of a refusal — the call it made, and the
  // gate's running digest only when it is digest-shaped (a self-connected gate answers anything).
  it('names the call a gate refused, with its reported running digest when well-formed', async () => {
    const running = `sha256:${'a'.repeat(64)}`;
    const err = await refusal(
      { code: 'operation_definition_mismatch', message: 'x', details: { runningDigest: running } },
      409,
    );
    expect(err.call).toEqual({ operation: 'list', approvedDigest: DIGEST, runningDigest: running });
    for (const runningDigest of [KEY, `sha256:${'A'.repeat(64)}`, 42, `${running}\n`]) {
      const odd = await refusal(
        { code: 'operation_definition_mismatch', message: 'x', details: { runningDigest } },
        409,
      );
      expect(odd.call).toEqual({ operation: 'list', approvedDigest: DIGEST });
    }
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

// Legacy 287: a gate call that failed on the network, against a real gate socket on loopback (the
// errors Node's own `fetch` throws, not a fake's). "Not sent" only when the connection could not be
// set up; once the gate may have the request, never — the kernel must not read it as "nothing ran".
describe('HttpGatekeeperClient — a call that failed on the network (legacy 287)', () => {
  let received = 0;
  /** Reads the whole request (the gate has it), then drops the connection unanswered. */
  const dropsAfterRequest = http.createServer((req) => {
    req.resume();
    req.on('end', () => {
      received += 1;
      req.socket.destroy();
    });
  });
  /** Answers with headers and part of its body, then drops the connection. */
  const dropsMidAnswer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received += 1;
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
      res.write('{"ok":true,"result":');
      setTimeout(() => req.socket.destroy(), 10);
    });
  });
  let refusedPort: number;
  let dropsAfterRequestPort: number;
  let dropsMidAnswerPort: number;

  const listen = (server: net.Server) =>
    new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

  beforeAll(async () => {
    const closed = net.createServer();
    refusedPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    dropsAfterRequestPort = await listen(dropsAfterRequest);
    dropsMidAnswerPort = await listen(dropsMidAnswer);
  });

  afterAll(async () => {
    for (const server of [dropsAfterRequest, dropsMidAnswer]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const applyTo = (port: number) =>
    new HttpGatekeeperClient({ token: 'gate-token-for-tests' }).apply(
      platformGateTarget(`http://127.0.0.1:${port}`),
      {
        operation: 'stock.adjust',
        params: {},
        actionRequestId: 'req-287',
        operationDigest: DIGEST,
      },
    );

  async function failureOf(call: Promise<unknown>): Promise<GatekeeperClientError> {
    const failure = await call.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(GatekeeperClientError);
    return failure as GatekeeperClientError;
  }

  it('a gate that refused the connection never had the request: gate_unreachable', async () => {
    const failure = await failureOf(applyTo(refusedPort));
    expect(failure).toMatchObject({ code: 'gate_unreachable', status: 0 });
    expect(failure.message).toBe(
      'gatekeeper client: gate/apply not sent — could not connect to the gate (ECONNREFUSED); nothing reached it',
    );
  });

  it('a connection dropped after the gate read the request: gate_connection_lost', async () => {
    received = 0;
    const failure = await failureOf(applyTo(dropsAfterRequestPort));
    expect(failure).toMatchObject({ code: 'gate_connection_lost', status: 0 });
    expect(failure.message).toMatch(
      /^gatekeeper client: gate\/apply: the connection to the gate failed after the request may have been sent \(UND_ERR_SOCKET\) — the gate may have received it$/,
    );
    expect(received).toBe(1);
  });

  it('a connection dropped while the answer was read: gate_connection_lost, never a timeout', async () => {
    received = 0;
    const failure = await failureOf(applyTo(dropsMidAnswerPort));
    expect(failure).not.toBeInstanceOf(GatekeeperTimeoutError);
    expect(failure).toMatchObject({ code: 'gate_connection_lost', status: 0 });
    expect(failure.message).toMatch(
      /^gatekeeper client: gate\/apply: the gate answered \(status 200\) but the connection failed while its answer was read( \([A-Z_]+\))? — the gate had the request$/,
    );
    expect(received).toBe(1);
  });

  it('an error the classifier does not recognise is read as "may have been sent"', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const failure = await failureOf(
      new HttpGatekeeperClient({ fetchImpl }).apply(GATE, {
        operation: 'stock.adjust',
        params: {},
        actionRequestId: 'req-287',
        operationDigest: DIGEST,
      }),
    );
    expect(failure.code).toBe('gate_connection_lost');
  });

  it('never repeats the address the error names', async () => {
    for (const port of [refusedPort, dropsAfterRequestPort, dropsMidAnswerPort]) {
      const failure = await failureOf(applyTo(port));
      expect(failure.message).not.toMatch(/127\.0\.0\.1|:\d{2,5}\b/);
    }
  });
});

describe('gateFailureRetry — whether a failed call is worth making again (S11 GO3d)', () => {
  const failed = (code: string, status: number) =>
    new GatekeeperClientError(code, { code, status });

  it('classes every code the client raises', () => {
    expect(gateFailureRetry(failed('gate_unreachable', 0))).toBe('transient');
    expect(gateFailureRetry(failed('gate_connection_lost', 0))).toBe('transient');
    for (const [code, status] of [
      ['gate_token_unavailable', 0],
      ['connection_secret_missing', 401],
      ['target_refused', 0],
      ['redirect_refused', 307],
      ['response_too_large', 200],
      ['invalid_response', 200],
      ['invalid_response', 502],
    ] as const) {
      expect(gateFailureRetry(failed(code, status)), code).toBe('deterministic');
    }
  });

  it('classes a gate’s answer by its refusal table, then by status', () => {
    for (const [code, status] of [
      ['invalid_params', 400],
      ['operation_refused', 403],
      ['operation_not_found', 404],
      ['operation_definition_mismatch', 409],
      ['credential_unavailable', 424],
      ['unauthorized', 401],
      ['not_found', 404],
    ] as const) {
      expect(gateFailureRetry(failed(code, status)), code).toBe('deterministic');
    }
    for (const [code, status] of [
      ['request_timeout', 408],
      ['too_early', 425],
      ['rate_limited', 429],
      ['internal_error', 500],
      ['upstream_unavailable', 503],
      // A refusal code whose status does not agree is not taken as the refusal (gateRefusalOf).
      ['operation_refused', 503],
      ['odd', 200],
    ] as const) {
      expect(gateFailureRetry(failed(code, status)), code).toBe('transient');
    }
  });

  it('a timeout, and anything that is not a client error, got no answer', () => {
    expect(gateFailureRetry(new GatekeeperTimeoutError('timed out', 'gate/observe'))).toBe(
      'transient',
    );
    expect(gateFailureRetry(new Error('boom'))).toBe('transient');
  });

  it('classes the errors the client actually throws', async () => {
    const answer = async (response: Response) => {
      const client = new HttpGatekeeperClient({
        token: 't'.repeat(32),
        fetchImpl: async () => response,
      });
      try {
        await client.observe(GATE, {
          operation: 'svc.status',
          params: {},
          operationDigest: DIGEST,
        });
      } catch (err) {
        return gateFailureRetry(err);
      }
      throw new Error('expected the call to fail');
    };
    expect(await answer(new Response('not json', { status: 200 }))).toBe('deterministic');
    expect(
      await answer(jsonResponse({ ok: false, error: { code: 'busy', message: 'later' } }, 503)),
    ).toBe('transient');
    expect(
      await answer(
        jsonResponse({ ok: false, error: { code: 'invalid_params', message: 'no' } }, 400),
      ),
    ).toBe('deterministic');
  });
});

describe('gateAbsenceOf — what the kernel takes of a gate saying the target has no such thing (S11 「门确认不存在」 A)', () => {
  const lookup = {
    name: 'record.get',
    mode: 'observe' as const,
    binding: {
      kind: 'http' as const,
      method: 'GET',
      path: '/records/{id}',
      absent_statuses: [404 as const],
    },
  };
  const show = {
    name: 'unit.show',
    mode: 'observe' as const,
    binding: {
      kind: 'cli' as const,
      command_template: 'unitctl show {name}',
      absent_exit_codes: [4],
    },
  };
  const refused = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err;
    }
    throw new Error('expected a refusal');
  };

  it('takes an absence the published definition declares, from the envelope only', () => {
    expect(
      gateAbsenceOf(lookup, { data: null, observedFacts: [], absent: { status: 404 } }),
    ).toEqual({ status: 404 });
    expect(gateAbsenceOf(show, { data: null, absent: { exitCode: 4 } })).toEqual({ exitCode: 4 });
    // No statement: no absence, whatever the data says.
    expect(gateAbsenceOf(lookup, { data: null })).toBeUndefined();
    expect(
      gateAbsenceOf(lookup, { data: { absent: { status: 404 }, status: 404, found: false } }),
    ).toBeUndefined();
  });

  it('refuses one it does not declare, a malformed one, and one with data or Facts beside it', () => {
    const cases: Array<[Parameters<typeof gateAbsenceOf>[0], unknown, RegExp]> = [
      [
        lookup,
        { data: null, absent: { status: 410 } },
        /status 410, which its published definition does not declare/,
      ],
      [lookup, { data: null, absent: { exitCode: 404 } }, /exit status 404/],
      [show, { data: null, absent: { exitCode: 1 } }, /exit status 1/],
      [
        { ...lookup, mode: 'execute' as const },
        { data: null, absent: { status: 404 } },
        /does not declare/,
      ],
      [
        { ...lookup, binding: { kind: 'http' as const, method: 'GET', path: '/records/{id}' } },
        { data: null, absent: { status: 404 } },
        /does not declare/,
      ],
      [lookup, { data: null, absent: true }, /in a form the platform does not read/],
      [lookup, { data: null, absent: null }, /in a form the platform does not read/],
      [lookup, { data: null, absent: { status: '404' } }, /in a form the platform does not read/],
      [lookup, { data: null, absent: { status: 404, exitCode: 4 } }, /in a form/],
      [lookup, { data: { id: 'r1' }, absent: { status: 404 } }, /also sent data/],
      [
        lookup,
        {
          data: null,
          absent: { status: 404 },
          observedFacts: [{ objectType: 'Record', identity: { id: 'r1' } }],
        },
        /also sent observed Facts/,
      ],
    ];
    for (const [operation, response, message] of cases) {
      const err = refused(() => gateAbsenceOf(operation, response as never));
      expect(err).toBeInstanceOf(GatekeeperClientError);
      expect(err).toMatchObject({ code: 'invalid_response', status: 200 });
      expect((err as Error).message).toMatch(message);
      // The gate would answer the same again: nothing a retry changes.
      expect(gateFailureRetry(err)).toBe('deterministic');
    }
  });
});
