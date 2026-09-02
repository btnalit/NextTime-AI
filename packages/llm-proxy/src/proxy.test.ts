import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { HANDLE_SIGNING_ALG } from '@nexttime/shared';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from './config.js';
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

    // Give the reporter a couple of failed-flush cycles against the down kernel.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(receivedBatches).toHaveLength(0);
    expect(reporter.pending).toBeGreaterThan(0);

    // "Kernel comes back" at the same URL — force one more flush attempt (rather than waiting on
    // the backoff timer) and it should now succeed.
    kernelUp = true;
    await reporter.flush();

    expect(receivedBatches).toHaveLength(1);
    expect(receivedBatches[0]?.[0]).toMatchObject({ provider: 'openai', model: 'gpt-example' });
  });
});
