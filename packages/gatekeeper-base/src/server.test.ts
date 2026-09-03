import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Operation } from '@nexttime/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectedAccountStore } from './credentials/index.js';
import { GatekeeperBase } from './gatekeeper-base.js';
import { InMemoryIdempotencyStore } from './idempotency-store.js';
import type { Transport } from './kinds/types.js';
import { createGatekeeperServer } from './server.js';

const observeOp: Operation = {
  name: 'stock.get',
  binding: { kind: 'http', method: 'GET', path: '/stock' },
  params_schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

const executeOp: Operation = {
  name: 'stock.adjust',
  binding: { kind: 'http', method: 'POST', path: '/stock/adjust' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'medium',
  reversibility: false,
  auto_approvable: false,
  await_decision: true,
  reads: [],
  writes: [],
};

function buildApp(transport: Transport, connectedAccountStore?: ConnectedAccountStore) {
  const gate = new GatekeeperBase({
    manifest: [observeOp, executeOp],
    transport,
    credentialResolver: { resolve: async () => ({}) },
    idempotencyStore: new InMemoryIdempotencyStore(),
  });
  return createGatekeeperServer({ gate, connectedAccountStore });
}

const fakeTransport: Transport = {
  kind: 'http',
  async invoke(_operation, params) {
    return { data: { echoed: params } };
  },
};

let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('gatekeeper protocol server', () => {
  it('GET /gate/describe_operations returns the manifest', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({ method: 'GET', url: '/gate/describe_operations' });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.operations).toHaveLength(2);
  });

  it('GET /gate/health returns ok', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({ method: 'GET', url: '/gate/health' });
    expect(response.json().result).toEqual({ status: 'ok' });
  });

  it('POST /gate/observe calls through to the transport', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'POST',
      url: '/gate/observe',
      payload: { operation: 'stock.get', params: { sku: 'X1' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.data).toEqual({ echoed: { sku: 'X1' } });
  });

  it('POST /gate/observe returns 400 on a params_schema validation failure', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'POST',
      url: '/gate/observe',
      payload: { operation: 'stock.get', params: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_params');
  });

  it('POST /gate/observe returns 404 for an unknown operation', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'POST',
      url: '/gate/observe',
      payload: { operation: 'does.not.exist', params: {} },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('operation_not_found');
  });

  it('POST /gate/apply requires idempotencyKey and is idempotent on repeat', async () => {
    app = buildApp(fakeTransport);
    const missingKey = await app.inject({
      method: 'POST',
      url: '/gate/apply',
      payload: { operation: 'stock.adjust', params: {} },
    });
    expect(missingKey.statusCode).toBe(400);

    const first = await app.inject({
      method: 'POST',
      url: '/gate/apply',
      payload: { operation: 'stock.adjust', params: { qty: 1 }, idempotencyKey: 'req-1' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().result.replayed).toBe(false);

    const second = await app.inject({
      method: 'POST',
      url: '/gate/apply',
      payload: { operation: 'stock.adjust', params: { qty: 1 }, idempotencyKey: 'req-1' },
    });
    expect(second.json().result.replayed).toBe(true);
  });

  it('POST /gate/simulate returns a description without executing', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'POST',
      url: '/gate/simulate',
      payload: { operation: 'stock.adjust', params: {} },
    });
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().result.description).toBe('string');
  });

  it('POST/DELETE /gate/connected-accounts 501 when no store is configured (shared-credential mode)', async () => {
    app = buildApp(fakeTransport);
    const post = await app.inject({
      method: 'POST',
      url: '/gate/connected-accounts',
      payload: { onBehalfOf: 'user-a', credential: { token: 'x' } },
    });
    expect(post.statusCode).toBe(501);
    expect(post.json().error.code).toBe('connected_account_store_not_configured');

    const del = await app.inject({
      method: 'DELETE',
      url: '/gate/connected-accounts',
      payload: { onBehalfOf: 'user-a' },
    });
    expect(del.statusCode).toBe(501);
  });

  describe('with a ConnectedAccountStore configured', () => {
    let dir: string;
    let store: ConnectedAccountStore;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'gatekeeper-server-connected-account-'));
      const keyFilePath = join(dir, 'store.key');
      await writeFile(keyFilePath, 'a-passphrase-not-32-bytes-long');
      store = new ConnectedAccountStore({ dataDir: dir, keyFilePath });
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('POST stores a credential the store can later resolve, and never echoes it back', async () => {
      app = buildApp(fakeTransport, store);
      const response = await app.inject({
        method: 'POST',
        url: '/gate/connected-accounts',
        payload: { onBehalfOf: 'user-a', credential: { token: 'super-secret-value' } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toEqual({ stored: true });
      expect(JSON.stringify(response.json())).not.toContain('super-secret-value');

      expect(await store.get('user-a')).toEqual({ token: 'super-secret-value' });
    });

    it('has no GET route — a stored credential can never be read back over the wire', async () => {
      app = buildApp(fakeTransport, store);
      await store.set('user-a', { token: 'secret' });
      const response = await app.inject({ method: 'GET', url: '/gate/connected-accounts' });
      expect(response.statusCode).toBe(404);
    });

    it('DELETE removes a stored credential', async () => {
      app = buildApp(fakeTransport, store);
      await store.set('user-a', { token: 'secret' });
      const response = await app.inject({
        method: 'DELETE',
        url: '/gate/connected-accounts',
        payload: { onBehalfOf: 'user-a' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toEqual({ deleted: true });
      expect(await store.get('user-a')).toBeUndefined();
    });
  });
});
