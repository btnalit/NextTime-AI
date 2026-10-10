import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Operation } from '@nexttime/shared';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectedAccountStore } from './credentials/index.js';
import { OperationRefusedError, TransportInvokeError, TransportTimeoutError } from './errors.js';
import { GatekeeperBase } from './gatekeeper-base.js';
import { InMemoryIdempotencyStore } from './idempotency-store.js';
import type { Transport } from './kinds/types.js';
import { operationDefinitionDigest } from './operation-digest.js';
import {
  type GateCallLogFields,
  createGatekeeperServer,
  gateRequestId,
  registerGateRoutes,
} from './server.js';

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

const OBSERVE_DIGEST = operationDefinitionDigest(observeOp);
const EXECUTE_DIGEST = operationDefinitionDigest(executeOp);

const TEST_TOKEN = 'test-gate-token-0123456789abcdef0123456789';
const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` };

function buildApp(transport: Transport, connectedAccountStore?: ConnectedAccountStore) {
  const gate = new GatekeeperBase({
    manifest: [observeOp, executeOp],
    transport,
    credentialResolver: { resolve: async () => ({}) },
    idempotencyStore: new InMemoryIdempotencyStore(),
  });
  return createGatekeeperServer({ gate, connectedAccountStore, token: TEST_TOKEN });
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

describe('gate auth (review lane 5, P1-1)', () => {
  it('401s every /gate/* route with no Authorization header, never touching the transport', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({ method: 'GET', url: '/gate/describe_operations' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'unauthorized' },
    });
  });

  it('401s a wrong token without echoing the presented or expected token', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'POST',
      url: '/gate/observe',
      headers: { authorization: 'Bearer wrong-token-entirely-different-value' },
      payload: { operation: 'stock.get', operationDigest: OBSERVE_DIGEST, params: { sku: 'X1' } },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('wrong-token-entirely-different-value');
    expect(response.body).not.toContain(TEST_TOKEN);
  });

  it('401s a malformed Authorization header (not Bearer)', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'GET',
      url: '/gate/health',
      headers: { authorization: `Basic ${TEST_TOKEN}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('200s with the correct token', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'GET',
      url: '/gate/describe_operations',
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('gatekeeper protocol server', () => {
  it('GET /gate/describe_operations returns the manifest', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'GET',
      url: '/gate/describe_operations',
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.operations).toHaveLength(2);
  });

  it('GET /gate/health returns ok', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'GET',
      url: '/gate/health',
      headers: AUTH_HEADERS,
    });
    expect(response.json().result).toEqual({ status: 'ok' });
  });

  it('POST /gate/observe calls through to the transport', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'POST',
      url: '/gate/observe',
      headers: AUTH_HEADERS,
      payload: { operation: 'stock.get', operationDigest: OBSERVE_DIGEST, params: { sku: 'X1' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.data).toEqual({ echoed: { sku: 'X1' } });
  });

  it('POST /gate/observe returns 400 on a params_schema validation failure', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'POST',
      url: '/gate/observe',
      headers: AUTH_HEADERS,
      payload: { operation: 'stock.get', operationDigest: OBSERVE_DIGEST, params: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_params');
  });

  it('POST /gate/observe returns 404 for an unknown operation', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'POST',
      url: '/gate/observe',
      headers: AUTH_HEADERS,
      payload: { operation: 'does.not.exist', params: {} },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('operation_not_found');
  });

  it('POST /gate/apply requires actionRequestId and is idempotent on repeat', async () => {
    app = buildApp(fakeTransport);
    const missingKey = await app.inject({
      method: 'POST',
      url: '/gate/apply',
      headers: AUTH_HEADERS,
      payload: { operation: 'stock.adjust', operationDigest: EXECUTE_DIGEST, params: {} },
    });
    expect(missingKey.statusCode).toBe(400);

    const first = await app.inject({
      method: 'POST',
      url: '/gate/apply',
      headers: AUTH_HEADERS,
      payload: {
        operation: 'stock.adjust',
        operationDigest: EXECUTE_DIGEST,
        params: { qty: 1 },
        actionRequestId: 'req-1',
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().result.replayed).toBe(false);

    const second = await app.inject({
      method: 'POST',
      url: '/gate/apply',
      headers: AUTH_HEADERS,
      payload: {
        operation: 'stock.adjust',
        operationDigest: EXECUTE_DIGEST,
        params: { qty: 1 },
        actionRequestId: 'req-1',
      },
    });
    expect(second.json().result.replayed).toBe(true);
  });

  it('POST /gate/apply returns 409 idempotency_conflict for the same key with different params', async () => {
    app = buildApp(fakeTransport);
    const first = await app.inject({
      method: 'POST',
      url: '/gate/apply',
      headers: AUTH_HEADERS,
      payload: {
        operation: 'stock.adjust',
        operationDigest: EXECUTE_DIGEST,
        params: { qty: 1 },
        actionRequestId: 'req-conflict',
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/gate/apply',
      headers: AUTH_HEADERS,
      payload: {
        operation: 'stock.adjust',
        operationDigest: EXECUTE_DIGEST,
        params: { qty: 2 },
        actionRequestId: 'req-conflict',
      },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('idempotency_conflict');
  });

  it('POST /gate/apply maps a transport refusal to 403 operation_refused, on retry too (R-04)', async () => {
    app = buildApp({
      kind: 'http',
      async invoke() {
        throw new OperationRefusedError('not served by this gate');
      },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/gate/apply',
        headers: AUTH_HEADERS,
        payload: {
          operation: 'stock.adjust',
          operationDigest: EXECUTE_DIGEST,
          params: {},
          actionRequestId: 'req-refused',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toEqual({
        code: 'operation_refused',
        message: 'not served by this gate',
      });
    }
  });

  it('POST /gate/apply answers a stored transport failure again on retry, not 409 (R-51)', async () => {
    app = buildApp({
      kind: 'http',
      async invoke() {
        throw new TransportInvokeError('target responded 500');
      },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/gate/apply',
        headers: AUTH_HEADERS,
        payload: {
          operation: 'stock.adjust',
          operationDigest: EXECUTE_DIGEST,
          params: {},
          actionRequestId: 'req-failed',
        },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json().error).toEqual({
        code: 'transport_error',
        message: 'target responded 500',
      });
    }
  });

  it('POST /gate/apply maps a transport timeout to 409 apply_outcome_unknown, on retry too (R-51)', async () => {
    let invocations = 0;
    app = buildApp({
      kind: 'http',
      async invoke() {
        invocations += 1;
        throw new TransportTimeoutError('command timed out after 50000 ms and was killed');
      },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/gate/apply',
        headers: AUTH_HEADERS,
        payload: {
          operation: 'stock.adjust',
          operationDigest: EXECUTE_DIGEST,
          params: {},
          actionRequestId: 'req-unknown',
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('apply_outcome_unknown');
    }
    expect(invocations).toBe(1);
  });

  it('POST /gate/* refuses a call without the approved definition digest, or with another one (legacy K)', async () => {
    let invoked = 0;
    app = buildApp({
      kind: 'http',
      async invoke() {
        invoked += 1;
        return { data: {} };
      },
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/gate/apply',
      headers: AUTH_HEADERS,
      payload: { operation: 'stock.adjust', params: {}, actionRequestId: 'req-k' },
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error.code).toBe('operation_definition_mismatch');
    expect(missing.json().error.message).toMatch(/no operationDigest/);

    const other = await app.inject({
      method: 'POST',
      url: '/gate/observe',
      headers: AUTH_HEADERS,
      payload: { operation: 'stock.get', operationDigest: EXECUTE_DIGEST, params: { sku: 'X1' } },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('operation_definition_mismatch');
    expect(invoked).toBe(0);
  });

  it('POST /gate/simulate returns a description without executing', async () => {
    app = buildApp(fakeTransport);
    const response = await app.inject({
      method: 'POST',
      url: '/gate/simulate',
      headers: AUTH_HEADERS,
      payload: { operation: 'stock.adjust', operationDigest: EXECUTE_DIGEST, params: {} },
    });
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().result.description).toBe('string');
  });

  it('POST/DELETE /gate/connected-accounts 501 when no store is configured (shared-credential mode)', async () => {
    app = buildApp(fakeTransport);
    const post = await app.inject({
      method: 'POST',
      url: '/gate/connected-accounts',
      headers: AUTH_HEADERS,
      payload: { onBehalfOf: 'user-a', credential: { token: 'x' } },
    });
    expect(post.statusCode).toBe(501);
    expect(post.json().error.code).toBe('connected_account_store_not_configured');

    const del = await app.inject({
      method: 'DELETE',
      url: '/gate/connected-accounts',
      headers: AUTH_HEADERS,
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
        headers: AUTH_HEADERS,
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
      const response = await app.inject({
        method: 'GET',
        url: '/gate/connected-accounts',
        headers: AUTH_HEADERS,
      });
      expect(response.statusCode).toBe(404);
    });

    it('DELETE removes a stored credential', async () => {
      app = buildApp(fakeTransport, store);
      await store.set('user-a', { token: 'secret' });
      const response = await app.inject({
        method: 'DELETE',
        url: '/gate/connected-accounts',
        headers: AUTH_HEADERS,
        payload: { onBehalfOf: 'user-a' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toEqual({ deleted: true });
      expect(await store.get('user-a')).toBeUndefined();
    });
  });
});

// Leftover 87: the kernel's correlation id becomes the gate's request id (logged with each call),
// and every protocol call is counted for the gate-token-guarded /internal/metrics.
describe('correlation id + /internal/metrics (leftover 87)', () => {
  it('GET /internal/metrics is gate-token guarded and counts calls by published operation and status', async () => {
    app = buildApp(fakeTransport);
    expect((await app.inject({ method: 'GET', url: '/internal/metrics' })).statusCode).toBe(401);

    await app.inject({
      method: 'POST',
      url: '/gate/observe',
      headers: AUTH_HEADERS,
      payload: { operation: 'stock.get', operationDigest: OBSERVE_DIGEST, params: { sku: 'X1' } },
    });
    await app.inject({
      method: 'POST',
      url: '/gate/observe',
      headers: AUTH_HEADERS,
      payload: { operation: 'made.up', params: {} },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('version=0.0.4');
    expect(response.body).toContain(
      'nexttime_gate_calls_total{gate="",route="observe",operation="stock.get",status="200"} 1',
    );
    // An operation this gate does not publish is never a label value.
    expect(response.body).toContain(
      'nexttime_gate_calls_total{gate="",route="observe",operation="",status="404"} 1',
    );
    expect(response.body).not.toContain('made.up');
  });

  it('adopts a valid x-correlation-id as the request id, replaces an invalid one, logs each call', async () => {
    const gate = new GatekeeperBase({
      manifest: [observeOp],
      transport: fakeTransport,
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const logged: Array<{ id: string; fields: GateCallLogFields }> = [];
    const bare = Fastify({ genReqId: gateRequestId });
    registerGateRoutes(bare, {
      prefix: '',
      resolve: () => ({ gate }),
      logCall: (request, fields) => logged.push({ id: request.id, fields }),
    });
    await bare.inject({
      method: 'POST',
      url: '/gate/observe',
      headers: { 'x-correlation-id': 'turn-abcd-0001' },
      payload: { operation: 'stock.get', operationDigest: OBSERVE_DIGEST, params: { sku: 'X1' } },
    });
    await bare.inject({
      method: 'POST',
      url: '/gate/observe',
      headers: { 'x-correlation-id': 'bad id!' },
      payload: { operation: 'stock.get', operationDigest: OBSERVE_DIGEST, params: { sku: 'X1' } },
    });
    await bare.close();

    expect(logged[0]?.id).toBe('turn-abcd-0001');
    expect(logged[0]?.fields).toMatchObject({
      gateRoute: 'observe',
      operation: 'stock.get',
      status: 200,
    });
    expect(logged[1]?.id).not.toBe('bad id!');
    expect(logged[1]?.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
