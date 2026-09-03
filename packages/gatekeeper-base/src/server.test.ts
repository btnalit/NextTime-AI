import type { Operation } from '@nexttime/shared';
import { afterEach, describe, expect, it } from 'vitest';
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

function buildApp(transport: Transport) {
  const gate = new GatekeeperBase({
    manifest: [observeOp, executeOp],
    transport,
    credentialResolver: { resolve: async () => ({}) },
    idempotencyStore: new InMemoryIdempotencyStore(),
  });
  return createGatekeeperServer({ gate });
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
});
