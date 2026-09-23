import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmProviderInputWire, LlmProviderListWire, LlmProviderWire } from '@nexttime/shared';
import { HANDLE_SIGNING_ALG, mintLlmAdminToken } from '@nexttime/shared';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import type { KernelAuditEvent } from './admin-api.js';
import { createAdminApi } from './admin-api.js';
import { ProviderCatalog } from './catalog.js';
import type { ProviderConfig } from './config.js';
import { buildModelsJsonFromCatalog, writeModelsJsonAtomic } from './gen-models-json.js';
import { KeyStore } from './key-store.js';
import { ProviderStore } from './provider-store.js';
import type { StoreTestResult } from './provider-store.js';
import { createProxyServer } from './proxy.js';

/**
 * admin-api.test: the S6-B / S7-A admin endpoints end-to-end through the real proxy listener (the
 * same loopback-server pattern proxy.test.ts uses): auth failures on every route, list / create /
 * update / delete / test / secret set-replace-clear, the models.json rewrite (atomic, no debris,
 * enabled-only), the audit line + kernel audit event per mutation (with the token jti, never a
 * key), and the "live" guarantee — a provider created through the API routes for a Handle on the
 * very next request, and a disabled one 404s.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

interface Reply {
  status: number;
  body: unknown;
}

function request(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const FILE_PROVIDER: ProviderConfig = {
  api: 'openai-completions',
  upstream_base_url: 'https://file.example.invalid',
  api_key_env: 'FILE_KEY',
  auth: { header: 'authorization', scheme: 'Bearer' },
  models: [{ id: 'file-model' }],
};

const NEW_PROVIDER: LlmProviderInputWire = {
  id: 'acme',
  displayName: 'Acme',
  api: 'openai-completions',
  upstreamBaseUrl: 'https://acme.example.invalid',
  authHeader: 'authorization',
  apiKeyEnv: 'ACME_KEY',
  models: [{ id: 'acme-large', displayName: 'Acme Large', cost: null }],
};

interface Harness {
  port: number;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  dir: string;
  modelsJsonFile: string;
  logLines: string[];
  kernelEvents: KernelAuditEvent[];
  testRuns: Array<{ providerApi: string; model: string; realKey: string }>;
  adminHeaders: () => Promise<Record<string, string>>;
  handle: () => Promise<string>;
  store: ProviderStore;
  keyStore: KeyStore;
}

async function harness(
  options: {
    env?: Record<string, string>;
    testResult?: StoreTestResult;
    /** Put models.json under a directory that does not exist (the rewrite must fail). */
    modelsJsonUnwritable?: boolean;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'nexttime-llm-proxy-admin-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
    crv: 'Ed25519',
    extractable: true,
  });
  const store = new ProviderStore(join(dir, 'state', 'providers.json'));
  await store.load();
  const keyStore = new KeyStore(join(dir, 'state', 'keys.json'));
  await keyStore.load();
  const catalog = new ProviderCatalog({ openai: FILE_PROVIDER }, store);
  const modelsJsonFile = options.modelsJsonUnwritable
    ? join(dir, 'missing-config-dir', 'models.json')
    : join(dir, 'models.json');
  const logLines: string[] = [];
  const kernelEvents: KernelAuditEvent[] = [];
  const testRuns: Harness['testRuns'] = [];
  const env = options.env ?? { FILE_KEY: 'sk-file' };
  const resolveApiKey = (name: string) => env[name];

  const adminHandler = createAdminApi({
    catalog,
    store,
    keyStore,
    publicKey,
    resolveApiKey,
    writeModelsJson: () =>
      writeModelsJsonAtomic(
        modelsJsonFile,
        buildModelsJsonFromCatalog(catalog, { llmProxyPort: 8082 }),
      ),
    kernelAudit: async (event) => {
      kernelEvents.push(event);
    },
    runTest: async (provider, model, realKey) => {
      testRuns.push({ providerApi: provider.api, model, realKey });
      return (
        options.testResult ?? {
          model,
          completion: 'ok',
          tool_call: 'ok',
          latency_ms: 42,
          error: null,
          tested_at: '2026-09-19T00:00:00.000Z',
        }
      );
    },
    maxRequestBodyBytes: 1_000_000,
    log: (line) => logLines.push(line),
  });

  const server = createProxyServer({
    providers: (name) => catalog.getRoutable(name),
    publicKey,
    isRevoked: () => false,
    adminHandler,
    reporter: { record: () => {} },
    maxRequestBodyBytes: 1_000_000,
    upstreamConnectTimeoutMs: 2000,
    upstreamIdleTimeoutMs: 2000,
    resolveApiKey,
    resolveConsoleKey: (id) => keyStore.get(id),
    log: (line) => logLines.push(line),
  });
  const port = await listen(server);
  cleanup.push(() => closeServer(server));

  return {
    port,
    publicKey,
    privateKey,
    dir,
    modelsJsonFile,
    logLines,
    kernelEvents,
    testRuns,
    store,
    keyStore,
    adminHeaders: async () => {
      const { token } = await mintLlmAdminToken({
        privateKey,
        subject: 'admin-user',
        jti: randomUUID(),
      });
      return { authorization: `Bearer ${token}`, 'x-requested-with': 'nexttime' };
    },
    handle: async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      return new SignJWT({
        ws: randomUUID(),
        sid: randomUUID(),
        obo: randomUUID(),
        scope: { capabilities: [], resources: {} },
        jti: randomUUID(),
        iat: nowSeconds,
        exp: nowSeconds + 300,
      })
        .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
        .sign(privateKey);
    },
  };
}

describe('admin API — authentication on every route', () => {
  it('401s without a token, 401s a Handle, 403s without the CSRF header, on reads and writes alike', async () => {
    const h = await harness();
    const handle = await h.handle();
    const routes: Array<[string, string]> = [
      ['GET', '/admin/providers'],
      ['POST', '/admin/providers'],
      ['PUT', '/admin/providers/openai'],
      ['DELETE', '/admin/providers/openai'],
      ['POST', '/admin/providers/openai/test'],
      ['POST', '/admin/providers/openai/secret'],
    ];
    for (const [method, path] of routes) {
      expect(
        (await request(h.port, method, path, { headers: { 'x-requested-with': 'nexttime' } }))
          .status,
      ).toBe(401);
      expect(
        (
          await request(h.port, method, path, {
            headers: { 'x-requested-with': 'nexttime', authorization: `Bearer ${handle}` },
          })
        ).status,
      ).toBe(401);
      const admin = await h.adminHeaders();
      expect(
        (
          await request(h.port, method, path, {
            headers: { authorization: admin.authorization ?? '' },
          })
        ).status,
      ).toBe(403);
    }
    expect(h.kernelEvents).toEqual([]);
  });

  it('401s an admin token on a provider route (it is not a Handle)', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    const res = await request(h.port, 'GET', '/openai/v1/models', { headers: admin });
    expect(res.status).toBe(401);
  });
});

describe('admin API — catalog lifecycle', () => {
  it('lists the merged catalog with the honest credential state and no key values', async () => {
    const h = await harness({ env: { FILE_KEY: 'sk-file-secret' } });
    const res = await request(h.port, 'GET', '/admin/providers', {
      headers: await h.adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.body as LlmProviderListWire;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 'openai',
      source: 'file',
      enabled: true,
      credentialPresent: true,
      credentialSource: 'env',
      apiKeyEnv: 'FILE_KEY',
      overridesFile: false,
      lastTest: null,
    });
    expect(body.storeWritable).toBe(true);
    expect(body.modelsJsonWrittenAt).toBeNull();
    expect(JSON.stringify(body)).not.toContain('sk-file-secret');
  });

  it('create → routable immediately, models.json rewritten atomically, audit line + kernel event with the jti', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    const created = await request(h.port, 'POST', '/admin/providers', {
      headers: admin,
      body: NEW_PROVIDER,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: 'acme',
      displayName: 'Acme',
      source: 'store',
      enabled: true,
      credentialPresent: false,
      credentialSource: 'none',
      authScheme: 'Bearer',
      models: [{ id: 'acme-large', displayName: 'Acme Large', cost: null }],
    });
    expect((created.body as LlmProviderWire).createdAt).not.toBeNull();

    // Live: a Handle can list the new provider's models right away (no restart).
    const handle = await h.handle();
    const models = await request(h.port, 'GET', '/acme/v1/models', {
      headers: { authorization: `Bearer ${handle}` },
    });
    expect(models.status).toBe(200);
    expect((models.body as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual([
      'acme-large',
    ]);

    // models.json: merged, atomic (no .tmp left behind), with pi's `name`.
    const modelsJson = JSON.parse(readFileSync(h.modelsJsonFile, 'utf8'));
    expect(Object.keys(modelsJson.providers)).toEqual(['openai', 'acme']);
    expect(modelsJson.providers.acme.models).toEqual([{ id: 'acme-large', name: 'Acme Large' }]);
    expect(readdirSync(h.dir).filter((f) => f.startsWith('models.json'))).toEqual(['models.json']);

    // Audit: the proxy's own line and the kernel event share the token's jti; no key anywhere.
    const auditLine = h.logLines.find((line) => line.includes('"level":"audit"'));
    expect(auditLine).toBeDefined();
    const parsed = JSON.parse(auditLine as string);
    expect(parsed).toMatchObject({
      action: 'provider_created',
      providerId: 'acme',
      sub: 'admin-user',
    });
    expect(h.kernelEvents).toHaveLength(1);
    expect(h.kernelEvents[0]).toMatchObject({
      action: 'provider_created',
      providerId: 'acme',
      actorUserId: 'admin-user',
      tokenJti: parsed.jti,
    });

    const list = await request(h.port, 'GET', '/admin/providers', { headers: admin });
    expect((list.body as LlmProviderListWire).modelsJsonWrittenAt).not.toBeNull();
    expect((list.body as LlmProviderListWire).modelsJsonError).toBeNull();
  });

  it('refuses a duplicate id (409), a reserved id (409) and an invalid body (400) — never a key field', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    expect(
      (
        await request(h.port, 'POST', '/admin/providers', {
          headers: admin,
          body: { ...NEW_PROVIDER, id: 'openai' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(h.port, 'POST', '/admin/providers', {
          headers: admin,
          body: { ...NEW_PROVIDER, id: 'admin' },
        })
      ).status,
    ).toBe(409);
    const withKey = await request(h.port, 'POST', '/admin/providers', {
      headers: admin,
      body: { ...NEW_PROVIDER, apiKey: 'sk-should-never-be-accepted' },
    });
    expect(withKey.status).toBe(400);
    expect((withKey.body as { error: { code: string } }).error.code).toBe('invalid_body');
    expect(existsSync(h.store.path)).toBe(false);
    expect(h.kernelEvents).toEqual([]);
  });

  it('PUT on a file provider creates an override (disable → 404 for Handles, gone from models.json); DELETE restores it', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    const handle = await h.handle();
    expect(
      (
        await request(h.port, 'GET', '/openai/v1/models', {
          headers: { authorization: `Bearer ${handle}` },
        })
      ).status,
    ).toBe(200);

    const disabled = await request(h.port, 'PUT', '/admin/providers/openai', {
      headers: admin,
      body: {
        id: 'openai',
        api: 'openai-completions',
        upstreamBaseUrl: 'https://file.example.invalid',
        authHeader: 'authorization',
        apiKeyEnv: 'FILE_KEY',
        models: [{ id: 'file-model', displayName: null, cost: null }],
        enabled: false,
      },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ source: 'store', overridesFile: true, enabled: false });
    expect(
      (
        await request(h.port, 'GET', '/openai/v1/models', {
          headers: { authorization: `Bearer ${handle}` },
        })
      ).status,
    ).toBe(404);
    expect(Object.keys(JSON.parse(readFileSync(h.modelsJsonFile, 'utf8')).providers)).toEqual([]);
    expect(h.kernelEvents.at(-1)).toMatchObject({
      action: 'provider_updated',
      providerId: 'openai',
      details: { changed: ['enabled'], overridesFile: true },
    });

    const restored = await request(h.port, 'DELETE', '/admin/providers/openai', { headers: admin });
    expect(restored.status).toBe(200);
    expect(restored.body).toEqual({
      id: 'openai',
      deleted: true,
      restoredFileEntry: true,
      secretCleared: false,
    });
    expect(
      (
        await request(h.port, 'GET', '/openai/v1/models', {
          headers: { authorization: `Bearer ${handle}` },
        })
      ).status,
    ).toBe(200);
    expect(Object.keys(JSON.parse(readFileSync(h.modelsJsonFile, 'utf8')).providers)).toEqual([
      'openai',
    ]);

    // A pure file provider cannot be deleted here.
    const refused = await request(h.port, 'DELETE', '/admin/providers/openai', { headers: admin });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: { code: string } }).error.code).toBe('provider_from_file');
  });

  it('DELETE also clears the console key (P2 hotfix, post-v0.16.0 review) — recreating the id later must never silently reuse it', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    expect(
      (await request(h.port, 'POST', '/admin/providers', { headers: admin, body: NEW_PROVIDER }))
        .status,
    ).toBe(201);
    expect(
      (
        await request(h.port, 'PUT', '/admin/providers/acme/secret', {
          headers: admin,
          body: { key: 'sk-console-acme' },
        })
      ).status,
    ).toBe(200);
    expect(h.keyStore.get('acme')).toBe('sk-console-acme');

    const deleted = await request(h.port, 'DELETE', '/admin/providers/acme', { headers: admin });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({
      id: 'acme',
      deleted: true,
      restoredFileEntry: false,
      secretCleared: true,
    });
    expect(h.keyStore.get('acme')).toBeUndefined();
    expect(h.kernelEvents.at(-1)).toMatchObject({ action: 'provider_secret_cleared', providerId: 'acme' });
    expect(h.kernelEvents.some((e) => e.action === 'provider_deleted')).toBe(true);

    // Recreating the same id afterward must start with no console key — the whole point of P2.
    expect(
      (await request(h.port, 'POST', '/admin/providers', { headers: admin, body: NEW_PROVIDER }))
        .status,
    ).toBe(201);
    expect(h.keyStore.get('acme')).toBeUndefined();
  });

  it('DELETE with no console key set reports secretCleared: false and never emits provider_secret_cleared', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    expect(
      (await request(h.port, 'POST', '/admin/providers', { headers: admin, body: NEW_PROVIDER }))
        .status,
    ).toBe(201);

    const deleted = await request(h.port, 'DELETE', '/admin/providers/acme', { headers: admin });
    expect(deleted.status).toBe(200);
    expect((deleted.body as { secretCleared: boolean }).secretCleared).toBe(false);
    expect(h.kernelEvents.some((e) => e.action === 'provider_secret_cleared')).toBe(false);
  });

  it('PUT on a store row audits only the fields that changed (never the store timestamps)', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    expect(
      (await request(h.port, 'POST', '/admin/providers', { headers: admin, body: NEW_PROVIDER }))
        .status,
    ).toBe(201);
    const updated = await request(h.port, 'PUT', '/admin/providers/acme', {
      headers: admin,
      body: { ...NEW_PROVIDER, upstreamBaseUrl: 'https://acme-2.example.invalid' },
    });
    expect(updated.status).toBe(200);
    expect(h.kernelEvents.at(-1)).toMatchObject({
      action: 'provider_updated',
      providerId: 'acme',
      details: { changed: ['upstream_base_url'], overridesFile: false },
    });
  });

  it('PUT with a mismatched id is 400; unknown ids are 404', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    expect(
      (
        await request(h.port, 'PUT', '/admin/providers/openai', {
          headers: admin,
          body: NEW_PROVIDER,
        })
      ).status,
    ).toBe(400);
    expect((await request(h.port, 'GET', '/admin/providers/nope', { headers: admin })).status).toBe(
      404,
    );
    expect(
      (await request(h.port, 'DELETE', '/admin/providers/nope', { headers: admin })).status,
    ).toBe(404);
    expect(
      (await request(h.port, 'POST', '/admin/providers/nope/test', { headers: admin })).status,
    ).toBe(404);
  });

  it('test: runs the injected round trips with the real key, records the outcome, audits without the key', async () => {
    const h = await harness({ env: { FILE_KEY: 'sk-file-secret' } });
    const admin = await h.adminHeaders();
    const res = await request(h.port, 'POST', '/admin/providers/openai/test', {
      headers: admin,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      providerId: 'openai',
      model: 'file-model',
      completion: 'ok',
      toolCall: 'ok',
      latencyMs: 42,
      error: null,
      testedAt: '2026-09-19T00:00:00.000Z',
    });
    expect(h.testRuns).toEqual([
      { providerApi: 'openai-completions', model: 'file-model', realKey: 'sk-file-secret' },
    ]);
    const list = await request(h.port, 'GET', '/admin/providers', { headers: admin });
    expect((list.body as LlmProviderListWire).items[0]?.lastTest?.toolCall).toBe('ok');
    expect(h.kernelEvents.at(-1)).toMatchObject({
      action: 'provider_tested',
      details: { completion: 'ok', toolCall: 'ok' },
    });
    expect(h.logLines.join('\n')).not.toContain('sk-file-secret');

    expect(
      (
        await request(h.port, 'POST', '/admin/providers/openai/test', {
          headers: admin,
          body: { model: 'other' },
        })
      ).status,
    ).toBe(400);
  });

  it('test without a configured credential is 409 credential_missing and never calls upstream', async () => {
    const h = await harness({ env: {} });
    const res = await request(h.port, 'POST', '/admin/providers/openai/test', {
      headers: await h.adminHeaders(),
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'credential_missing',
    });
    expect((res.body as { error: { message: string } }).error.message).toContain('FILE_KEY');
    expect(h.testRuns).toEqual([]);
  });

  it('a failed models.json rewrite does not fail the mutation; the list reports the error', async () => {
    const h = await harness({ modelsJsonUnwritable: true });
    const admin = await h.adminHeaders();
    const created = await request(h.port, 'POST', '/admin/providers', {
      headers: admin,
      body: NEW_PROVIDER,
    });
    expect(created.status).toBe(201);
    const list = await request(h.port, 'GET', '/admin/providers', { headers: admin });
    expect((list.body as LlmProviderListWire).modelsJsonError).toBe('ENOENT');
    expect((list.body as LlmProviderListWire).items.map((p) => p.id)).toEqual(['openai', 'acme']);
    expect(h.logLines.some((line) => line.includes('models.json rewrite failed'))).toBe(true);
  });
});

describe('admin API — provider secrets (S7-A)', () => {
  it('PUT sets a console key: credentialSource flips to console, overriding env; DELETE clears back to env', async () => {
    const h = await harness({ env: { FILE_KEY: 'sk-file-secret' } });
    const admin = await h.adminHeaders();

    const set = await request(h.port, 'PUT', '/admin/providers/openai/secret', {
      headers: admin,
      body: { key: 'sk-console-secret' },
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      id: 'openai',
      credentialPresent: true,
      credentialSource: 'console',
    });
    expect(h.keyStore.get('openai')).toBe('sk-console-secret');

    // The test route now uses the console key, not the env var.
    const tested = await request(h.port, 'POST', '/admin/providers/openai/test', {
      headers: admin,
      body: {},
    });
    expect(tested.status).toBe(200);
    expect(h.testRuns.at(-1)).toMatchObject({ realKey: 'sk-console-secret' });

    const cleared = await request(h.port, 'DELETE', '/admin/providers/openai/secret', {
      headers: admin,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      id: 'openai',
      credentialPresent: true,
      credentialSource: 'env',
    });
    expect(h.keyStore.get('openai')).toBeUndefined();

    // Audit: two rows, never the key value.
    const setEvent = h.kernelEvents.find((e) => e.action === 'provider_secret_set');
    const clearedEvent = h.kernelEvents.find((e) => e.action === 'provider_secret_cleared');
    expect(setEvent).toMatchObject({ providerId: 'openai', actorUserId: 'admin-user' });
    expect(clearedEvent).toMatchObject({ providerId: 'openai', actorUserId: 'admin-user' });
    expect(h.logLines.join('\n')).not.toContain('sk-console-secret');
    expect(JSON.stringify(h.kernelEvents)).not.toContain('sk-console-secret');
  });

  it('POST is accepted as an alias for PUT (the original design route)', async () => {
    const h = await harness();
    const res = await request(h.port, 'POST', '/admin/providers/openai/secret', {
      headers: await h.adminHeaders(),
      body: { key: 'sk-via-post' },
    });
    expect(res.status).toBe(200);
    expect(h.keyStore.get('openai')).toBe('sk-via-post');
  });

  it('a provider with no apiKeyEnv at all can still get a console-only key', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    const created = await request(h.port, 'POST', '/admin/providers', {
      headers: admin,
      body: { ...NEW_PROVIDER, apiKeyEnv: undefined },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ apiKeyEnv: null, credentialSource: 'none' });

    const set = await request(h.port, 'PUT', '/admin/providers/acme/secret', {
      headers: admin,
      body: { key: 'sk-console-only' },
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ credentialSource: 'console', credentialPresent: true });

    const tested = await request(h.port, 'POST', '/admin/providers/acme/test', {
      headers: admin,
      body: {},
    });
    expect(tested.status).toBe(200);
    expect(h.testRuns.at(-1)).toMatchObject({ realKey: 'sk-console-only' });
  });

  it('refuses an empty, oversized, or control-character key (400) and never touches the store', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();

    const empty = await request(h.port, 'PUT', '/admin/providers/openai/secret', {
      headers: admin,
      body: { key: '   ' },
    });
    expect(empty.status).toBe(400);
    expect((empty.body as { error: { code: string } }).error.code).toBe('invalid_body');

    const tooLong = await request(h.port, 'PUT', '/admin/providers/openai/secret', {
      headers: admin,
      body: { key: 'x'.repeat(5000) },
    });
    expect(tooLong.status).toBe(400);

    const withNewline = await request(h.port, 'PUT', '/admin/providers/openai/secret', {
      headers: admin,
      body: { key: 'sk-line1\nsk-line2' },
    });
    expect(withNewline.status).toBe(400);

    expect(h.keyStore.get('openai')).toBeUndefined();
    expect(h.kernelEvents).toEqual([]);
  });

  it('trims surrounding whitespace before storing', async () => {
    const h = await harness();
    const res = await request(h.port, 'PUT', '/admin/providers/openai/secret', {
      headers: await h.adminHeaders(),
      body: { key: '  sk-needs-trim  ' },
    });
    expect(res.status).toBe(200);
    expect(h.keyStore.get('openai')).toBe('sk-needs-trim');
  });

  it('PUT and DELETE 404 for an unknown provider id', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    expect(
      (
        await request(h.port, 'PUT', '/admin/providers/nope/secret', {
          headers: admin,
          body: { key: 'sk-x' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await request(h.port, 'DELETE', '/admin/providers/nope/secret', { headers: admin })).status,
    ).toBe(404);
  });

  it('DELETE with no console key set is a no-op 200 (the end state — no console key — already holds)', async () => {
    const h = await harness();
    const res = await request(h.port, 'DELETE', '/admin/providers/openai/secret', {
      headers: await h.adminHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'openai', credentialSource: 'env' });
  });

  it('GET/list never returns the key value, whatever the source', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    await request(h.port, 'PUT', '/admin/providers/openai/secret', {
      headers: admin,
      body: { key: 'sk-must-not-leak' },
    });
    const list = await request(h.port, 'GET', '/admin/providers', { headers: admin });
    expect(JSON.stringify(list.body)).not.toContain('sk-must-not-leak');
    const detail = await request(h.port, 'GET', '/admin/providers/openai', { headers: admin });
    expect(JSON.stringify(detail.body)).not.toContain('sk-must-not-leak');
  });

  it('a secret mutation does not rewrite models.json', async () => {
    const h = await harness();
    const admin = await h.adminHeaders();
    await request(h.port, 'PUT', '/admin/providers/openai/secret', {
      headers: admin,
      body: { key: 'sk-x' },
    });
    const list = await request(h.port, 'GET', '/admin/providers', { headers: admin });
    expect((list.body as LlmProviderListWire).modelsJsonWrittenAt).toBeNull();
  });

  it('unsupported methods on /secret are 405', async () => {
    const h = await harness();
    const res = await request(h.port, 'GET', '/admin/providers/openai/secret', {
      headers: await h.adminHeaders(),
    });
    expect(res.status).toBe(405);
  });
});
