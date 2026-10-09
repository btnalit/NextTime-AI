import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { HANDLE_SIGNING_ALG } from '@nexttime/shared';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from './config.js';
import { createLlmProxyMetrics } from './metrics.js';
import { createProxyServer } from './proxy.js';
import { LlmUsageReporter } from './report.js';
import type { LlmUsageRecord } from './report.js';

/**
 * proxy.test: integration tests against real loopback HTTP servers — fake OpenAI/Anthropic
 * upstreams and a fake kernel — no real network, matching this codebase's established pattern
 * (packages/egress-proxy/src/proxy.test.ts). Covers S1.7's acceptance list directly: no Handle
 * 401; expired/revoked 401; model outside whitelist 403; streaming byte-for-byte identity;
 * usage reported for both families; kernel-down-then-up replay.
 */

// -------------------------------------------------------------------------------------------
// Test infrastructure
// -------------------------------------------------------------------------------------------

function addressPort(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  return address.port;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return addressPort(server);
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Polls `predicate` instead of assuming a fixed delay is enough (STATUS.md 遗留 40) — used by the
 *  "kernel down then up" test below to wait for `LlmUsageReporter.record()` to have queued its
 *  entry, rather than a hard-coded sleep that can race under CI runner contention. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

const OPENAI_SSE_BODY = [
  'data: {"id":"c1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
  'data: {"id":"c1","choices":[{"delta":{"content":" world"}}]}\n\n',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n',
  'data: [DONE]\n\n',
].join('');

const ANTHROPIC_SSE_BODY = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

/** A fake upstream that returns a fixed SSE body, and 500s if the auth header doesn't carry the
 *  expected *real* key (proves the proxy swapped the Handle for the real key, never forwarding
 *  the Handle itself upstream). */
function startFakeUpstream(options: {
  sseBody: string;
  expectedHeader: string;
  expectedValue: string;
}): http.Server {
  return http.createServer((req, res) => {
    const seen = req.headers[options.expectedHeader];
    if (seen !== options.expectedValue) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('unexpected auth header reaching upstream');
      return;
    }
    // Also assert the Handle never leaks through the *other* possible header.
    if (req.headers.authorization && options.expectedHeader !== 'authorization') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('authorization header should have been stripped');
      return;
    }
    if (req.headers['x-api-key'] && options.expectedHeader !== 'x-api-key') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('x-api-key header should have been stripped');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(options.sseBody);
  });
}

async function ephemeralKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
    crv: 'Ed25519',
    extractable: true,
  });
  return { privateKey, publicKey };
}

async function signHandle(
  privateKey: CryptoKey,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    ws: randomUUID(),
    sid: randomUUID(),
    obo: randomUUID(),
    scope: { capabilities: [], resources: {} },
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + 300,
    ...overrides,
  };
  return new SignJWT(claims).setProtectedHeader({ alg: HANDLE_SIGNING_ALG }).sign(privateKey);
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function rawRequest(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const openAiProvider = (upstreamPort: number): ProviderConfig => ({
  api: 'openai-completions',
  upstream_base_url: `http://127.0.0.1:${upstreamPort}`,
  api_key_env: 'FAKE_OPENAI_API_KEY',
  auth: { header: 'authorization', scheme: 'Bearer' },
  models: [{ id: 'gpt-example' }],
});

const anthropicProvider = (upstreamPort: number): ProviderConfig => ({
  api: 'anthropic-messages',
  upstream_base_url: `http://127.0.0.1:${upstreamPort}`,
  api_key_env: 'FAKE_ANTHROPIC_API_KEY',
  auth: { header: 'x-api-key' },
  models: [{ id: 'claude-example' }],
});

const REAL_OPENAI_KEY = 'sk-real-openai-key';
const REAL_ANTHROPIC_KEY = 'sk-real-anthropic-key';

function resolveApiKey(name: string): string | undefined {
  return { FAKE_OPENAI_API_KEY: REAL_OPENAI_KEY, FAKE_ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY }[name];
}

// -------------------------------------------------------------------------------------------
// Suite
// -------------------------------------------------------------------------------------------

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('createProxyServer — auth', () => {
  it('401s with no Handle header at all', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${REAL_OPENAI_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(res.status).toBe(401);
  });

  it('401s for an expired Handle', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${REAL_OPENAI_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expired = await signHandle(privateKey, { iat: nowSeconds - 120, exp: nowSeconds - 60 });

    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${expired}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(res.status).toBe(401);
  });

  it('401s for a revoked Handle', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${REAL_OPENAI_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const revokedJti = randomUUID();
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: (jti) => jti === revokedJti,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey, { jti: revokedJti });

    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(res.status).toBe(401);
  });

  it('403s for a model outside the provider whitelist', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${REAL_OPENAI_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey);
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-whitelisted-model', stream: true }),
    });
    expect(res.status).toBe(403);
  });
});

describe('createProxyServer — streaming byte-for-byte forwarding', () => {
  it('the SSE body reaching the client is byte-identical to a direct connection to the fake upstream', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${REAL_OPENAI_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const records: LlmUsageRecord[] = [];
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: (r) => records.push(r) },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey);
    const requestBody = JSON.stringify({ model: 'gpt-example', stream: true });

    const direct = await rawRequest({
      port: upstreamPort,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: `Bearer ${REAL_OPENAI_KEY}`, 'content-type': 'application/json' },
      body: requestBody,
    });

    const viaProxy = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: requestBody,
    });

    expect(viaProxy.status).toBe(200);
    expect(Buffer.compare(viaProxy.body, direct.body)).toBe(0);
    expect(viaProxy.body.toString('utf8')).toBe(OPENAI_SSE_BODY);
  });

  it('parses and reports OpenAI streaming usage (prompt_tokens/completion_tokens) with claims fields', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${REAL_OPENAI_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const records: LlmUsageRecord[] = [];
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: (r) => records.push(r) },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const jti = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    const token = await signHandle(privateKey, { jti, ws: workspaceId, sid: sessionId });

    await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId,
      sessionId,
      jti,
      provider: 'openai',
      model: 'gpt-example',
      inputTokens: 10,
      outputTokens: 3,
      status: 'completed',
    });

    // R-67: every upstream request gets its own usage identity, even under the same Handle —
    // the kernel dedupes on it, so two concurrent requests are never merged into one record.
    await Promise.all(
      [0, 1].map(() =>
        rawRequest({
          port: proxyPort,
          method: 'POST',
          path: '/openai/v1/chat/completions',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-example', stream: true }),
        }),
      ),
    );
    expect(records).toHaveLength(3);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const record of records) expect(record.requestId).toMatch(uuid);
    expect(new Set(records.map((record) => record.requestId)).size).toBe(3);
  });

  it('parses and reports Anthropic streaming usage (message_start + message_delta)', async () => {
    const upstream = startFakeUpstream({
      sseBody: ANTHROPIC_SSE_BODY,
      expectedHeader: 'x-api-key',
      expectedValue: REAL_ANTHROPIC_KEY,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const records: LlmUsageRecord[] = [];
    const proxy = createProxyServer({
      providers: { anthropic: anthropicProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: (r) => records.push(r) },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey);
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/anthropic/v1/messages',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-example', stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe(ANTHROPIC_SSE_BODY);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-example',
      inputTokens: 7,
      outputTokens: 4, // overwritten by message_delta
    });
  });
});

/**
 * R-10: an `openai-responses` provider's usage reaches the usage record (and so the kernel's
 * I18 budget and cost accounting) as real tokens and a cost — streaming via the terminal
 * `response.completed` event, non-streaming via the Response object's own `usage` — and the
 * request goes upstream without an injected `stream_options.include_usage`.
 */
describe('createProxyServer — openai-responses usage (R-10)', () => {
  const RESPONSES_USAGE = {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
    output_tokens: 300,
    output_tokens_details: { reasoning_tokens: 100 },
    total_tokens: 1500,
  };
  const RESPONSES_SSE_BODY = [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: 'resp_1', status: 'in_progress', usage: null } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', sequence_number: 1, delta: 'Hello' })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', status: 'completed', output: [], usage: RESPONSES_USAGE } })}\n\n`,
  ].join('');
  const RESPONSES_JSON_BODY = JSON.stringify({
    id: 'resp_2',
    object: 'response',
    status: 'completed',
    output: [],
    usage: RESPONSES_USAGE,
  });

  async function setup(): Promise<{
    proxyPort: number;
    token: string;
    records: LlmUsageRecord[];
    upstreamBodies: Array<Record<string, unknown>>;
  }> {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        upstreamBodies.push(body);
        if (
          req.url !== '/v1/responses' ||
          req.headers.authorization !== `Bearer ${REAL_OPENAI_KEY}`
        ) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('unexpected path or auth header reaching upstream');
          return;
        }
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(RESPONSES_SSE_BODY);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(RESPONSES_JSON_BODY);
        }
      });
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const records: LlmUsageRecord[] = [];
    const proxy = createProxyServer({
      providers: {
        openai: {
          api: 'openai-responses',
          upstream_base_url: `http://127.0.0.1:${upstreamPort}`,
          api_key_env: 'FAKE_OPENAI_API_KEY',
          auth: { header: 'authorization', scheme: 'Bearer' },
          // USD per million tokens.
          models: [
            { id: 'gpt-example', cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } },
          ],
        },
      },
      publicKey,
      isRevoked: () => false,
      reporter: { record: (r) => records.push(r) },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));
    return { proxyPort, token: await signHandle(privateKey), records, upstreamBodies };
  }

  // input 1000 net × $2 + output 300 × $8 + cacheRead 200 × $0.5, per million tokens.
  const EXPECTED_COST_USD = (1000 * 2 + 300 * 8 + 200 * 0.5) / 1_000_000;

  it('streaming: reports response.completed usage and a cost; no include_usage injected', async () => {
    const { proxyPort, token, records, upstreamBodies } = await setup();
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/responses',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', input: 'hi', stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe(RESPONSES_SSE_BODY);
    expect(upstreamBodies).toEqual([{ model: 'gpt-example', input: 'hi', stream: true }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-example',
      inputTokens: 1000,
      outputTokens: 300,
      cacheReadTokens: 200,
      status: 'completed',
    });
    expect(records[0]?.costUsd).toBeCloseTo(EXPECTED_COST_USD, 12);
  });

  it('non-streaming: reports the Response object’s usage and a cost', async () => {
    const { proxyPort, token, records, upstreamBodies } = await setup();
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/responses',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', input: 'hi' }),
    });

    expect(res.status).toBe(200);
    expect(upstreamBodies).toEqual([{ model: 'gpt-example', input: 'hi' }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 300,
      cacheReadTokens: 200,
    });
    expect(records[0]?.costUsd).toBeCloseTo(EXPECTED_COST_USD, 12);
  });
});

describe('createProxyServer — per-api (method, path) allowlist', () => {
  async function makeProxy(upstreamPort: number): Promise<{ port: number; privateKey: CryptoKey }> {
    // No upstream is ever listened on `upstreamPort` in this suite — every case here must be
    // rejected before the proxy would dial out, so an accidental forward fails loudly (connection
    // refused) rather than silently succeeding.
    const { privateKey, publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 500,
      upstreamIdleTimeoutMs: 500,
      resolveApiKey,
      log: () => {},
    });
    const port = await listen(proxy);
    cleanup.push(() => closeServer(proxy));
    return { port, privateKey };
  }

  it('404s a path outside the provider api kind’s single forwardable action (e.g. /v1/files) without contacting upstream', async () => {
    // Deliberately no upstream listening on this port — a 404 must be returned without the proxy
    // ever attempting to dial out.
    const { port, privateKey } = await makeProxy(1);
    const token = await signHandle(privateKey);

    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/openai/v1/files',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example' }),
    });
    expect(res.status).toBe(404);
  });

  it('405s a non-POST method on the allowed action path (e.g. DELETE) without contacting upstream', async () => {
    const { port, privateKey } = await makeProxy(1);
    const token = await signHandle(privateKey);

    const res = await rawRequest({
      port,
      method: 'DELETE',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(405);
  });

  it('400s a non-JSON body on the allowed action path', async () => {
    const { port, privateKey } = await makeProxy(1);
    const token = await signHandle(privateKey);

    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('400s a JSON body missing "model" on the allowed action path', async () => {
    const { port, privateKey } = await makeProxy(1);
    const token = await signHandle(privateKey);

    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a multipart-style path (e.g. /v1/audio/transcriptions) with 404 even with a valid Handle', async () => {
    const { port, privateKey } = await makeProxy(1);
    const token = await signHandle(privateKey);

    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/openai/v1/audio/transcriptions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data' },
      body: 'irrelevant',
    });
    expect(res.status).toBe(404);
  });
});

describe('createProxyServer — GET /<provider>/v1/models', () => {
  it('synthesizes the model list from the whitelist without calling upstream', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${REAL_OPENAI_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    // Sabotage the upstream so any accidental forward would fail loudly (no cleanup.push — it's
    // deliberately closed already and closing it again in afterEach would itself throw).
    await closeServer(upstream);

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 500,
      upstreamIdleTimeoutMs: 500,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey);
    const res = await rawRequest({
      port: proxyPort,
      method: 'GET',
      path: '/openai/v1/models',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString('utf8')) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(['gpt-example']);
  });
});

describe('createProxyServer — GET /healthz', () => {
  it('200s without requiring a Handle', async () => {
    const { publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: {},
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const res = await rawRequest({ port: proxyPort, method: 'GET', path: '/healthz' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ status: 'ok' });
  });
});

describe('createProxyServer + LlmUsageReporter — kernel down then up', () => {
  // Own testTimeout (STATUS.md 遗留 40): flaky under runner contention at vitest's 5s default.
  it('keeps forwarding while the kernel is unreachable, then delivers the queued usage once it is back', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${REAL_OPENAI_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    // One fake kernel, listening at a fixed address the whole time — "down" is simulated by
    // resetting the connection (never a URL change), matching how a real kernel container
    // restart looks to a client holding the same KERNEL_URL throughout.
    const receivedBatches: LlmUsageRecord[][] = [];
    let kernelUp = false;
    const kernel = http.createServer((req, res) => {
      if (!kernelUp) {
        req.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBatches.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as LlmUsageRecord[],
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { inserted: 1 } }));
      });
    });
    const kernelPort = await listen(kernel);
    cleanup.push(() => closeServer(kernel));

    const reporter = new LlmUsageReporter({
      kernelUrl: `http://127.0.0.1:${kernelPort}`,
      flushIntervalMs: 30,
      maxFlushIntervalMs: 200,
      log: () => {},
    });
    cleanup.push(() => reporter.close());

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter,
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey);
    // Kernel is "down" (kernelUp = false) — the proxy must still forward successfully.
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe(OPENAI_SSE_BODY);

    // Poll for the record to land in the reporter's queue (STATUS.md 遗留 40: a fixed sleep here
    // raced record()/the first failed-flush cycle under CI runner contention) instead of assuming
    // a fixed delay is enough — `record()` only enqueues and schedules a flush, it does not itself
    // resolve `rawRequest()`.
    await waitUntil(() => reporter.pending > 0);
    expect(receivedBatches).toHaveLength(0);

    // "Kernel comes back" at the same URL — force one more flush attempt (rather than waiting on
    // the backoff timer) and it should now succeed.
    kernelUp = true;
    await reporter.flush();

    expect(receivedBatches).toHaveLength(1);
    expect(receivedBatches[0]?.[0]).toMatchObject({ provider: 'openai', model: 'gpt-example' });
  }, 15000);
});

describe('createProxyServer — S6-B budget-exhausted refusal (leftover 19) and live providers', () => {
  it('402s a completion for an exhausted workspace before contacting upstream; the model list still answers', async () => {
    let upstreamHits = 0;
    const upstream = http.createServer((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(OPENAI_SSE_BODY);
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const exhaustedWorkspace = randomUUID();
    const logLines: string[] = [];
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      isBudgetExhausted: (workspaceId) =>
        workspaceId === exhaustedWorkspace
          ? {
              workspaceId,
              scope: 'workspace_daily_cost',
              budget: 5,
              spent: 5.25,
              until: '2099-01-01T00:00:00.000Z',
            }
          : undefined,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: (line) => logLines.push(line),
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const blocked = await signHandle(privateKey, { ws: exhaustedWorkspace });
    const refused = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${blocked}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(refused.status).toBe(402);
    const body = JSON.parse(refused.body.toString('utf8'));
    expect(body.error.code).toBe('budget_exhausted');
    expect(body.error.scope).toBe('workspace_daily_cost');
    expect(body.error.resetsAt).toBe('2099-01-01T00:00:00.000Z');
    expect(upstreamHits).toBe(0);
    expect(logLines.some((line) => line.includes('workspace budget exhausted'))).toBe(true);

    // The synthesized model list is free and stays answerable for the blocked workspace.
    const models = await rawRequest({
      port: proxyPort,
      method: 'GET',
      path: '/openai/v1/models',
      headers: { authorization: `Bearer ${blocked}` },
    });
    expect(models.status).toBe(200);

    // Another workspace is unaffected.
    const other = await signHandle(privateKey);
    const allowed = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${other}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(allowed.status).toBe(200);
    expect(upstreamHits).toBe(1);
  });

  it('a function-shaped providers option is consulted per request (a provider added later routes without restart)', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${REAL_OPENAI_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const live: Record<string, ProviderConfig | undefined> = {};
    const proxy = createProxyServer({
      providers: (name) => live[name],
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey);
    const before = await rawRequest({
      port: proxyPort,
      method: 'GET',
      path: '/openai/v1/models',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.status).toBe(404);

    live.openai = openAiProvider(upstreamPort);
    const after = await rawRequest({
      port: proxyPort,
      method: 'GET',
      path: '/openai/v1/models',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(200);

    live.openai = undefined;
    const gone = await rawRequest({
      port: proxyPort,
      method: 'GET',
      path: '/openai/v1/models',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(gone.status).toBe(404);
  });
});

describe('createProxyServer — S7-A console-key resolution order', () => {
  const CONSOLE_KEY = 'sk-console-key';

  it('a console key takes precedence over api_key_env for the same provider id', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${CONSOLE_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey, // would resolve to REAL_OPENAI_KEY — must not win over the console key
      resolveConsoleKey: (id) => (id === 'openai' ? CONSOLE_KEY : undefined),
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey);
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(res.status).toBe(200);
  });

  it('a provider with no api_key_env at all still forwards using only the console key', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${CONSOLE_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const noEnvProvider: ProviderConfig = {
      api: 'openai-completions',
      upstream_base_url: `http://127.0.0.1:${upstreamPort}`,
      auth: { header: 'authorization', scheme: 'Bearer' },
      models: [{ id: 'gpt-example' }],
    };
    const proxy = createProxyServer({
      providers: { openai: noEnvProvider },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveConsoleKey: (id) => (id === 'openai' ? CONSOLE_KEY : undefined),
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey);
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(res.status).toBe(200);
  });

  it('502s upstream_not_configured with neither a console key nor api_key_env resolving', async () => {
    const { privateKey, publicKey } = await ephemeralKeyPair();
    const noEnvProvider: ProviderConfig = {
      api: 'openai-completions',
      upstream_base_url: 'http://127.0.0.1:1',
      auth: { header: 'authorization', scheme: 'Bearer' },
      models: [{ id: 'gpt-example' }],
    };
    const logLines: string[] = [];
    const proxy = createProxyServer({
      providers: { openai: noEnvProvider },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      log: (line) => logLines.push(line),
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey);
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(res.status).toBe(502);
    const body = JSON.parse(res.body.toString('utf8'));
    expect(body.error.code).toBe('upstream_not_configured');
    expect(logLines.some((line) => line.includes('no provider key resolved'))).toBe(true);
  });

  // Review of #521: a key an HTTP header cannot carry (stored before the console checked it, or
  // an env / file key) used to throw inside `new Headers` — a 500 whose unhandled-error log line
  // quoted the header value, i.e. the key.
  it.each([
    ['console', { resolveConsoleKey: () => 'sk-console\u3000key-0123456789' }],
    ['env', { resolveApiKey: () => 'sk-env\nkey-0123456789' }],
  ] as const)(
    '502s upstream_key_invalid for an unusable %s key, without logging it',
    async (source, keyOptions) => {
      const { privateKey, publicKey } = await ephemeralKeyPair();
      const provider: ProviderConfig = {
        api: 'openai-completions',
        upstream_base_url: 'http://127.0.0.1:1',
        api_key_env: 'OPENAI_KEY',
        auth: { header: 'authorization', scheme: 'Bearer' },
        models: [{ id: 'gpt-example' }],
      };
      const logLines: string[] = [];
      const proxy = createProxyServer({
        providers: { openai: provider },
        publicKey,
        isRevoked: () => false,
        reporter: { record: () => {} },
        maxRequestBodyBytes: 1_000_000,
        upstreamConnectTimeoutMs: 2000,
        upstreamIdleTimeoutMs: 2000,
        ...keyOptions,
        log: (line) => logLines.push(line),
      });
      const proxyPort = await listen(proxy);
      cleanup.push(() => closeServer(proxy));

      const token = await signHandle(privateKey);
      const res = await rawRequest({
        port: proxyPort,
        method: 'POST',
        path: '/openai/v1/chat/completions',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-example', stream: true }),
      });
      expect(res.status).toBe(502);
      expect(JSON.parse(res.body.toString('utf8')).error.code).toBe('upstream_key_invalid');
      const keyLine = logLines.find((line) => line.includes('cannot carry'));
      expect(keyLine && JSON.parse(keyLine)).toMatchObject({ provider: 'openai', source });
      expect(logLines.join('\n')).not.toMatch(/0123456789/);
      expect(logLines.some((line) => line.includes('unhandled request error'))).toBe(false);
    },
  );

  it('sends an env key with a trailing line break trimmed, as the console trims a typed one', async () => {
    const upstream = startFakeUpstream({
      sseBody: OPENAI_SSE_BODY,
      expectedHeader: 'authorization',
      expectedValue: `Bearer ${CONSOLE_KEY}`,
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: {
        openai: {
          api: 'openai-completions',
          upstream_base_url: `http://127.0.0.1:${upstreamPort}`,
          api_key_env: 'OPENAI_KEY',
          auth: { header: 'authorization', scheme: 'Bearer' },
          models: [{ id: 'gpt-example' }],
        },
      },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey: () => `${CONSOLE_KEY}\r\n`,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));

    const token = await signHandle(privateKey);
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(res.status).toBe(200);
  });
});

// -------------------------------------------------------------------------------------------
// Leftover 87: correlation id + /internal/metrics
// -------------------------------------------------------------------------------------------

describe('createProxyServer — correlation id and metrics (leftover 87)', () => {
  async function setUp() {
    const upstreamSaw: Array<string | undefined> = [];
    const upstream = http.createServer((req, res) => {
      upstreamSaw.push(req.headers['x-correlation-id'] as string | undefined);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(OPENAI_SSE_BODY);
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const lines: string[] = [];
    const records: Array<{ record: LlmUsageRecord; correlationId?: string }> = [];
    const proxy = createProxyServer({
      providers: { openai: openAiProvider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: {
        record: (record, context) =>
          records.push({ record, correlationId: context?.correlationId }),
      },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: (line) => lines.push(line),
      metrics: createLlmProxyMetrics(),
      internalAuthorizationHeader: 'Bearer internal-token-for-tests',
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));
    const handle = await signHandle(privateKey);
    const chat = (headers: Record<string, string> = {}) =>
      rawRequest({
        port: proxyPort,
        method: 'POST',
        path: '/openai/v1/chat/completions',
        headers: {
          authorization: `Bearer ${handle}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ model: 'gpt-example', stream: true }),
      });
    return { proxyPort, upstreamSaw, lines, records, chat };
  }

  it('adopts a valid inbound id: echoed, in the usage record context — and never forwarded upstream', async () => {
    const { upstreamSaw, records, chat } = await setUp();
    const res = await chat({ 'x-correlation-id': 'turn-abcd-0001' });
    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe('turn-abcd-0001');
    expect(upstreamSaw).toEqual([undefined]);
    expect(records[0]?.correlationId).toBe('turn-abcd-0001');
    expect(records[0]?.record).not.toHaveProperty('correlationId');
  });

  it('replaces an invalid inbound id with a minted one, logged on refusals too', async () => {
    const { proxyPort, lines } = await setUp();
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { 'x-correlation-id': 'bad id', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
    expect(res.status).toBe(401);
    const minted = res.headers['x-correlation-id'] as string;
    expect(minted).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(lines.map((l) => JSON.parse(l).correlationId)).toContain(minted);
  });

  it('GET /internal/metrics: 401 without the internal token; counters after real traffic', async () => {
    const { proxyPort, chat } = await setUp();
    await chat();
    await rawRequest({ port: proxyPort, method: 'POST', path: '/nope/v1/chat/completions' });

    const denied = await rawRequest({ port: proxyPort, method: 'GET', path: '/internal/metrics' });
    expect(denied.status).toBe(401);

    const res = await rawRequest({
      port: proxyPort,
      method: 'GET',
      path: '/internal/metrics',
      headers: { authorization: 'Bearer internal-token-for-tests' },
    });
    expect(res.status).toBe(200);
    const text = res.body.toString('utf8');
    expect(text).toContain(
      'nexttime_llm_proxy_requests_total{provider="openai",model="gpt-example",status="200"} 1',
    );
    expect(text).toContain(
      'nexttime_llm_proxy_requests_total{provider="unknown",model="",status="404"} 1',
    );
    expect(text).toContain(
      'nexttime_llm_proxy_upstream_duration_seconds_count{provider="openai",model="gpt-example",outcome="completed"} 1',
    );
    expect(text).toContain(
      'nexttime_llm_proxy_tokens_total{provider="openai",model="gpt-example",direction="input"} 10',
    );
    expect(text).toContain(
      'nexttime_llm_proxy_tokens_total{provider="openai",model="gpt-example",direction="output"} 3',
    );
  });

  it('GET /internal/metrics fails closed when no internal token is configured', async () => {
    const { publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: {},
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      log: () => {},
    });
    const port = await listen(proxy);
    cleanup.push(() => closeServer(proxy));
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/internal/metrics',
      headers: { authorization: 'Bearer anything' },
    });
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------------------------
// R-30 (D-29): what reaches the provider; R-23 (L6-19): no redirects with the real key
// -------------------------------------------------------------------------------------------

interface SeenUpstreamRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A fake upstream that records exactly what it receives and answers a small JSON body. */
function startCapturingUpstream(seen: SeenUpstreamRequest[]): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"r1"}');
    });
  });
}

/** Everything an agent could add on top of what pi's SDK clients send. */
const AGENT_CHOSEN_HEADERS = {
  'openai-organization': 'org-other',
  'openai-project': 'proj-other',
  'x-stainless-os': 'Linux',
  'x-exfil': 'data',
  'user-agent': 'OpenAI/JS 7.19.0',
  cookie: 'a=b',
};

describe('createProxyServer — R-30 outbound narrowing per provider kind', () => {
  async function setup(provider: (port: number) => ProviderConfig) {
    const seen: SeenUpstreamRequest[] = [];
    const upstream = startCapturingUpstream(seen);
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));
    const { privateKey, publicKey } = await ephemeralKeyPair();
    const logLines: string[] = [];
    const proxy = createProxyServer({
      providers: { p: provider(upstreamPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: (line) => logLines.push(line),
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));
    const token = await signHandle(privateKey);
    return { seen, logLines, proxyPort, token };
  }

  const narrowedLines = (logLines: string[]) =>
    logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => String(line.msg).includes('provider-side tools stripped'));

  it('openai-completions: only allow-listed headers, no query, server tools and search switches stripped, and the attempt logged', async () => {
    const { seen, logLines, proxyPort, token } = await setup(openAiProvider);
    const functionTool = { type: 'function', function: { name: 'read', parameters: {} } };
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/p/v1/chat/completions?api-version=1',
      headers: {
        ...AGENT_CHOSEN_HEADERS,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-example',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [functionTool, { type: 'web_search', web_search: {} }],
        web_search_options: {},
      }),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/v1/chat/completions');
    const headers = seen[0]?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${REAL_OPENAI_KEY}`);
    expect(headers.accept).toBe('application/json');
    expect(headers['content-type']).toBe('application/json');
    for (const name of Object.keys(AGENT_CHOSEN_HEADERS)) {
      if (name === 'user-agent') continue; // fetch sets its own
      expect(headers[name]).toBeUndefined();
    }
    expect(headers['user-agent']).not.toBe('OpenAI/JS 7.19.0');
    expect(JSON.parse(seen[0]?.body.toString('utf8') ?? '{}')).toEqual({
      model: 'gpt-example',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [functionTool],
    });
    const [line] = narrowedLines(logLines);
    expect(line).toMatchObject({
      level: 'warn',
      provider: 'p',
      model: 'gpt-example',
      strippedTools: ['web_search'],
      strippedParams: ['web_search_options'],
      droppedBetas: [],
    });
    expect(JSON.stringify(logLines)).not.toContain(REAL_OPENAI_KEY);
  });

  it('openai-responses: an MCP tool pointing at an attacker host never reaches the provider; function tools do', async () => {
    const { seen, logLines, proxyPort, token } = await setup((port) => ({
      ...openAiProvider(port),
      api: 'openai-responses',
    }));
    const functionTool = { type: 'function', name: 'read', parameters: {} };
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/p/v1/responses',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-example',
        input: 'hi',
        tools: [
          functionTool,
          { type: 'mcp', server_label: 'x', server_url: 'https://attacker.example/mcp' },
          { type: 'code_interpreter', container: { type: 'auto' } },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const forwarded = seen[0]?.body.toString('utf8') ?? '';
    expect(forwarded).not.toContain('attacker.example');
    expect(JSON.parse(forwarded)).toEqual({
      model: 'gpt-example',
      input: 'hi',
      tools: [functionTool],
    });
    expect(narrowedLines(logLines)[0]).toMatchObject({
      strippedTools: ['mcp', 'code_interpreter'],
    });
  });

  it('anthropic-messages: anthropic-version, the allow-listed betas and ?beta=true pass; the MCP connector, server tools and their betas do not', async () => {
    const { seen, logLines, proxyPort, token } = await setup(anthropicProvider);
    const clientTool = { name: 'read', input_schema: { type: 'object' } };
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/p/v1/messages?beta=true&evil=1',
      headers: {
        ...AGENT_CHOSEN_HEADERS,
        'x-api-key': token,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14,mcp-client-2025-04-04',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-example',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [clientTool, { type: 'web_fetch_20250910', name: 'web_fetch' }],
        mcp_servers: [{ type: 'url', url: 'https://attacker.example/mcp', name: 'x' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(seen[0]?.url).toBe('/v1/messages?beta=true');
    const headers = seen[0]?.headers ?? {};
    expect(headers['x-api-key']).toBe(REAL_ANTHROPIC_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-beta']).toBe('fine-grained-tool-streaming-2025-05-14');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers['openai-organization']).toBeUndefined();
    expect(JSON.parse(seen[0]?.body.toString('utf8') ?? '{}')).toEqual({
      model: 'claude-example',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [clientTool],
    });
    expect(narrowedLines(logLines)[0]).toMatchObject({
      strippedTools: ['web_fetch_20250910'],
      strippedParams: ['mcp_servers'],
      droppedBetas: ['mcp-client-2025-04-04'],
    });
  });

  it('a normal request with client-side tools only is forwarded byte-for-byte, and nothing is logged as stripped', async () => {
    const cases: Array<{
      provider: (port: number) => ProviderConfig;
      path: string;
      headers: Record<string, string>;
      body: string;
    }> = [
      {
        provider: (port) => ({ ...openAiProvider(port), api: 'openai-responses' }),
        path: '/p/v1/responses',
        headers: {},
        // Odd spacing on purpose: re-serializing would change these bytes.
        body: '{ "model":"gpt-example",  "input":"hi", "tools":[{"type":"function","name":"read","parameters":{}}] }',
      },
      {
        provider: anthropicProvider,
        path: '/p/v1/messages',
        headers: { 'anthropic-version': '2023-06-01' },
        body: '{ "model":"claude-example", "max_tokens":8, "messages":[{"role":"user","content":"hi"}], "tools":[{"name":"read","input_schema":{"type":"object"}}] }',
      },
      {
        provider: openAiProvider,
        path: '/p/v1/chat/completions',
        headers: {},
        body: '{ "model":"gpt-example", "messages":[], "tools":[] }',
      },
    ];
    for (const testCase of cases) {
      const { seen, logLines, proxyPort, token } = await setup(testCase.provider);
      const authHeader: Record<string, string> =
        testCase.path === '/p/v1/messages'
          ? { 'x-api-key': token }
          : { authorization: `Bearer ${token}` };
      const res = await rawRequest({
        port: proxyPort,
        method: 'POST',
        path: testCase.path,
        headers: { ...authHeader, ...testCase.headers, 'content-type': 'application/json' },
        body: testCase.body,
      });
      expect(res.status).toBe(200);
      expect(seen[0]?.body.toString('utf8')).toBe(testCase.body);
      expect(narrowedLines(logLines)).toEqual([]);
    }
  });

  it('refuses an upstream redirect (502) instead of resending the real key to the named host', async () => {
    const elsewhere: SeenUpstreamRequest[] = [];
    const target = startCapturingUpstream(elsewhere);
    const targetPort = await listen(target);
    cleanup.push(() => closeServer(target));
    const redirecting = http.createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/v1/messages` });
      res.end();
    });
    const redirectPort = await listen(redirecting);
    cleanup.push(() => closeServer(redirecting));

    const { privateKey, publicKey } = await ephemeralKeyPair();
    const proxy = createProxyServer({
      providers: { p: anthropicProvider(redirectPort) },
      publicKey,
      isRevoked: () => false,
      reporter: { record: () => {} },
      maxRequestBodyBytes: 1_000_000,
      upstreamConnectTimeoutMs: 2000,
      upstreamIdleTimeoutMs: 2000,
      resolveApiKey,
      log: () => {},
    });
    const proxyPort = await listen(proxy);
    cleanup.push(() => closeServer(proxy));
    const res = await rawRequest({
      port: proxyPort,
      method: 'POST',
      path: '/p/v1/messages',
      headers: {
        'x-api-key': await signHandle(privateKey),
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-example', max_tokens: 8, messages: [] }),
    });
    expect(res.status).toBe(502);
    expect(elsewhere).toEqual([]);
  });
});
