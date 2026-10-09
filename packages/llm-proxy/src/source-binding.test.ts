import { randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HANDLE_SIGNING_ALG,
  type HandleBinding,
  SOURCE_BOUND_CAPABILITY_HANDLE,
  createHandleBindingReader,
} from '@nexttime/shared';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from './config.js';
import { loadConfig } from './config.js';
import { createProxyServer } from './proxy.js';
import type { LlmUsageRecord } from './report.js';
import {
  type ProxySourceBinding,
  createFileHandleBindingReader,
  createProxySourceBinding,
} from './source-binding.js';

/**
 * source-binding.test: llm-proxy's half of the source binding (source-binding.ts), against real
 * loopback HTTP servers. The test client always connects from 127.0.0.1, so "an agent container"
 * is a proxy whose `workers` subnet is `127.0.0.0/8`, and "a peer elsewhere" is one whose subnet
 * leaves 127.0.0.1 out. Every Handle here is synthetic — signed by an ephemeral key pair.
 */

const REAL_OPENAI_KEY = 'sk-real-openai-key';
const REAL_ANTHROPIC_KEY = 'sk-real-anthropic-key';
const SSE_BODY =
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
const LOOPBACK_WORKERS_SUBNET = '127.0.0.0/8';
const ELSEWHERE_WORKERS_SUBNET = '203.0.113.0/24';
const INTERNAL_AUTHORIZATION = 'Bearer internal-token-for-tests';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );
  return address.port;
}

interface Response {
  readonly status: number;
  readonly body: string;
}

function request(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Response> {
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
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const openAiProvider = (port: number): ProviderConfig => ({
  api: 'openai-completions',
  upstream_base_url: `http://127.0.0.1:${port}`,
  api_key_env: 'FAKE_OPENAI_API_KEY',
  auth: { header: 'authorization', scheme: 'Bearer' },
  models: [{ id: 'gpt-example' }],
});

const anthropicProvider = (port: number): ProviderConfig => ({
  api: 'anthropic-messages',
  upstream_base_url: `http://127.0.0.1:${port}`,
  api_key_env: 'FAKE_ANTHROPIC_API_KEY',
  auth: { header: 'x-api-key' },
  models: [{ id: 'claude-example' }],
});

/** A binding store in memory, standing in for worker-supervisor's file. */
function memoryReader(bindings: Map<string, HandleBinding>) {
  return createHandleBindingReader({
    source: {
      version: () => JSON.stringify([...bindings]),
      read: () => JSON.stringify(Object.fromEntries(bindings)),
    },
    registrationWaitMs: 50,
    pollMs: 10,
  });
}

async function setUp(options: { workersSubnet?: string } = {}) {
  const upstreamAuth: Array<{ authorization?: string; apiKey?: string }> = [];
  const upstream = http.createServer((req, res) => {
    upstreamAuth.push({
      authorization: req.headers.authorization,
      apiKey: req.headers['x-api-key'] as string | undefined,
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SSE_BODY);
  });
  const upstreamPort = await listen(upstream);

  const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
    crv: 'Ed25519',
    extractable: true,
  });
  const revoked = new Set<string>();
  const bindings = new Map<string, HandleBinding>();
  const lines: string[] = [];
  const records: LlmUsageRecord[] = [];
  const sourceBinding: ProxySourceBinding | undefined = options.workersSubnet
    ? createProxySourceBinding({
        workersSubnet: options.workersSubnet,
        reader: memoryReader(bindings),
      })
    : undefined;
  const proxy = createProxyServer({
    providers: { openai: openAiProvider(upstreamPort), anthropic: anthropicProvider(upstreamPort) },
    publicKey,
    isRevoked: (jti) => revoked.has(jti),
    ...(sourceBinding ? { sourceBinding } : {}),
    adminHandler: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"admin":true}');
    },
    reporter: { record: (record) => records.push(record) },
    maxRequestBodyBytes: 1_000_000,
    upstreamConnectTimeoutMs: 2000,
    upstreamIdleTimeoutMs: 2000,
    resolveApiKey: (name) =>
      ({ FAKE_OPENAI_API_KEY: REAL_OPENAI_KEY, FAKE_ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY })[name],
    log: (line) => lines.push(line),
    internalAuthorizationHeader: INTERNAL_AUTHORIZATION,
  });
  const port = await listen(proxy);

  /** A synthetic Handle: `container: true` is what the kernel mints for an entry agent or a
   *  WorkerRun (`hld: container`); without it, a bearer one (`issue_handle`, a service). */
  async function handle(opts: { container?: boolean; jti?: string; exp?: number } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      ws: randomUUID(),
      sid: randomUUID(),
      obo: randomUUID(),
      scope: { capabilities: [], resources: {} },
      jti: opts.jti ?? randomUUID(),
      iat: now,
      exp: opts.exp ?? now + 300,
      ...(opts.container ? { hld: 'container' } : {}),
    })
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);
  }

  function bind(token: string): void {
    bindings.set('127.0.0.1', {
      handle: token,
      sourceId: 'entry:ws:p',
      containerId: 'c1',
      boundAt: new Date(0).toISOString(),
    });
  }

  const chat = (headers: Record<string, string>) =>
    request({
      port,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'gpt-example', stream: true }),
    });
  const messages = (headers: Record<string, string>) =>
    request({
      port,
      method: 'POST',
      path: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'claude-example', stream: true }),
    });
  const refusals = () =>
    lines
      .map((line) => JSON.parse(line) as { msg?: string; reason?: string })
      .filter((line) => line.msg === 'llm-proxy: handle auth failed')
      .map((line) => line.reason);

  return {
    port,
    upstreamAuth,
    revoked,
    lines,
    records,
    handle,
    bind,
    chat,
    messages,
    refusals,
  };
}

const marker = `Bearer ${SOURCE_BOUND_CAPABILITY_HANDLE}`;

describe('llm-proxy source binding — an agent container (workers-network peer)', () => {
  it('is authenticated by the Handle bound to its address; the marker header is all it sends', async () => {
    const t = await setUp({ workersSubnet: LOOPBACK_WORKERS_SUBNET });
    const bound = await t.handle({ container: true });
    t.bind(bound);

    expect((await t.chat({ authorization: marker })).status).toBe(200);
    expect((await t.messages({ 'x-api-key': SOURCE_BOUND_CAPABILITY_HANDLE })).status).toBe(200);
    // No header at all works too — the address is the credential.
    expect((await t.chat({})).status).toBe(200);

    // Upstream saw only the real keys — never the bound Handle, never the marker.
    expect(t.upstreamAuth).toEqual([
      { authorization: `Bearer ${REAL_OPENAI_KEY}`, apiKey: undefined },
      { authorization: undefined, apiKey: REAL_ANTHROPIC_KEY },
      { authorization: `Bearer ${REAL_OPENAI_KEY}`, apiKey: undefined },
    ]);
    expect(t.records).toHaveLength(3);
    expect(t.lines.join('\n')).not.toContain(bound);
  });

  it('refuses a request that carries a Handle of its own — even a valid one — instead of the marker', async () => {
    const t = await setUp({ workersSubnet: LOOPBACK_WORKERS_SUBNET });
    t.bind(await t.handle({ container: true }));
    const found = await t.handle(); // e.g. a member's issue_handle token the model found in a file
    expect((await t.chat({ authorization: `Bearer ${found}` })).status).toBe(401);
    expect((await t.messages({ 'x-api-key': found })).status).toBe(401);
    expect(t.upstreamAuth).toEqual([]);
    expect(t.refusals()).toEqual(['credential_from_bound_source', 'credential_from_bound_source']);
    expect(t.lines.join('\n')).not.toContain(found);
  });

  it('refuses an address with no binding (after waiting for one), and a binding that is not container-held', async () => {
    const t = await setUp({ workersSubnet: LOOPBACK_WORKERS_SUBNET });
    expect((await t.chat({ authorization: marker })).status).toBe(401);
    t.bind(await t.handle());
    expect((await t.chat({ authorization: marker })).status).toBe(401);
    expect(t.upstreamAuth).toEqual([]);
    expect(t.refusals()).toEqual(['unbound_source', 'presentation_refused']);
  });

  it('refuses a bound Handle once it is revoked or expired', async () => {
    const t = await setUp({ workersSubnet: LOOPBACK_WORKERS_SUBNET });
    const jti = randomUUID();
    t.bind(await t.handle({ container: true, jti }));
    expect((await t.chat({ authorization: marker })).status).toBe(200);
    t.revoked.add(jti);
    expect((await t.chat({ authorization: marker })).status).toBe(401);
    t.bind(await t.handle({ container: true, exp: Math.floor(Date.now() / 1000) - 5 }));
    expect((await t.chat({ authorization: marker })).status).toBe(401);
    expect(t.refusals()).toEqual(['revoked', 'expired']);
  });

  it('reaches only the model routes and /healthz: /admin/* and /internal/* answer 403 whatever it presents', async () => {
    const t = await setUp({ workersSubnet: LOOPBACK_WORKERS_SUBNET });
    t.bind(await t.handle({ container: true }));
    const get = (path: string, headers: Record<string, string> = {}) =>
      request({ port: t.port, method: 'GET', path, headers });

    expect((await get('/healthz')).status).toBe(200);
    expect((await get('/openai/v1/models', { authorization: marker })).status).toBe(200);
    expect((await get('/admin/providers')).status).toBe(403);
    expect((await get('/internal/metrics', { authorization: INTERNAL_AUTHORIZATION })).status).toBe(
      403,
    );
    expect((await get('/internal/anything')).status).toBe(403);
  });
});

describe('llm-proxy source binding — every other peer', () => {
  it('refuses a container-held Handle presented in a header; a bearer Handle works as before', async () => {
    const t = await setUp({ workersSubnet: ELSEWHERE_WORKERS_SUBNET });
    // Even one that is bound somewhere: the binding is for its container's address, not this one.
    const leaked = await t.handle({ container: true });
    t.bind(leaked);
    expect((await t.chat({ authorization: `Bearer ${leaked}` })).status).toBe(401);
    expect((await t.messages({ 'x-api-key': leaked })).status).toBe(401);
    expect((await t.chat({ authorization: marker })).status).toBe(401);

    expect((await t.chat({ authorization: `Bearer ${await t.handle()}` })).status).toBe(200);
    expect(t.refusals()).toEqual(['presentation_refused', 'presentation_refused', 'invalid']);
    expect(t.lines.join('\n')).not.toContain(leaked);
  });

  it('keeps /admin/* and /internal/metrics on their own credentials', async () => {
    const t = await setUp({ workersSubnet: ELSEWHERE_WORKERS_SUBNET });
    const get = (path: string, headers: Record<string, string> = {}) =>
      request({ port: t.port, method: 'GET', path, headers });
    expect((await get('/admin/providers')).status).toBe(200);
    expect((await get('/internal/metrics', { authorization: INTERNAL_AUTHORIZATION })).status).toBe(
      200,
    );
  });

  it('with no source binding configured, refuses a container-held Handle from everyone', async () => {
    const t = await setUp();
    expect(
      (await t.chat({ authorization: `Bearer ${await t.handle({ container: true })}` })).status,
    ).toBe(401);
    expect((await t.chat({ authorization: `Bearer ${await t.handle()}` })).status).toBe(200);
    expect(t.refusals()).toEqual(['presentation_refused']);
  });
});

describe('createProxySourceBinding / loadConfig', () => {
  it('matches the workers subnet (IPv4-mapped peers are normalized by the caller), and refuses a malformed one', () => {
    const binding = createProxySourceBinding({
      workersSubnet: ' 203.0.113.0/24 ',
      reader: memoryReader(new Map()),
    });
    expect(binding.isFromWorkersNetwork('203.0.113.7')).toBe(true);
    expect(binding.isFromWorkersNetwork('198.51.100.20')).toBe(false);
    expect(binding.isFromWorkersNetwork('not-an-address')).toBe(false);
    expect(() =>
      createProxySourceBinding({ workersSubnet: '203.0.113.0', reader: memoryReader(new Map()) }),
    ).toThrow();
  });

  it('reads NEXTTIME_SUBNET_WORKERS and HANDLE_BINDINGS_FILE (both optional)', () => {
    expect(loadConfig({})).toMatchObject({
      workersSubnet: undefined,
      handleBindingsFile: undefined,
    });
    expect(
      loadConfig({
        NEXTTIME_SUBNET_WORKERS: '203.0.113.0/24',
        HANDLE_BINDINGS_FILE: '/run/handle-bindings/bindings.json',
      }),
    ).toMatchObject({
      workersSubnet: '203.0.113.0/24',
      handleBindingsFile: '/run/handle-bindings/bindings.json',
    });
  });
});

describe('createFileHandleBindingReader', () => {
  it('follows the file as worker-supervisor replaces it, and refuses everything while it is broken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-source-binding-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'bindings.json');
    const replace = (content: string) => {
      writeFileSync(join(dir, '.tmp'), content);
      renameSync(join(dir, '.tmp'), file);
    };
    const binding = (handle: string) => ({ handle, sourceId: 'entry:ws:p', boundAt: 'now' });
    const errors: string[] = [];
    const reader = createFileHandleBindingReader(file, (err) => errors.push(err.reason));

    expect(await reader.lookup('203.0.113.7')).toBeUndefined();
    replace(JSON.stringify({ '203.0.113.7': binding('a.b.c') }));
    expect((await reader.lookup('203.0.113.7'))?.handle).toBe('a.b.c');
    replace(JSON.stringify({ '203.0.113.7': binding('d.e.f') }));
    expect((await reader.lookup('203.0.113.7'))?.handle).toBe('d.e.f');
    replace('{');
    expect(await reader.lookup('203.0.113.7')).toBeUndefined();
    expect(errors).toEqual(['malformed']);
  });
});
