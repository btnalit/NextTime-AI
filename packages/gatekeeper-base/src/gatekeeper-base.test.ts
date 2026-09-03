import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import { CredentialResolutionError } from './errors.js';
import { GatekeeperBase } from './gatekeeper-base.js';
import { InMemoryIdempotencyStore } from './idempotency-store.js';
import type { Transport } from './kinds/types.js';

function observeOp(overrides: Partial<Operation> = {}): Operation {
  return {
    name: 'stock.get',
    binding: { kind: 'http', method: 'GET', path: '/stock' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
    ...overrides,
  };
}

function executeOp(overrides: Partial<Operation> = {}): Operation {
  return {
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
    ...overrides,
  };
}

function fakeTransport(invoke?: Transport['invoke']): Transport {
  return { kind: 'http', invoke: invoke ?? (async () => ({ data: { ok: true } })) };
}

describe('GatekeeperBase', () => {
  it('routes observe only to mode:observe operations', async () => {
    const transport = fakeTransport();
    const gate = new GatekeeperBase({
      manifest: [observeOp(), executeOp()],
      transport,
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    await expect(gate.observe('stock.adjust', {})).rejects.toThrow(
      /mode "execute", expected "observe"/,
    );
    const result = await gate.observe('stock.get', {});
    expect(result.data).toEqual({ ok: true });
  });

  it('routes apply only to mode:execute operations and requires an idempotencyKey', async () => {
    const transport = fakeTransport();
    const gate = new GatekeeperBase({
      manifest: [observeOp(), executeOp()],
      transport,
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    await expect(gate.apply('stock.get', {}, 'k1')).rejects.toThrow(
      /mode "observe", expected "execute"/,
    );
    await expect(gate.apply('stock.adjust', {}, '')).rejects.toThrow(/requires idempotencyKey/);
  });

  it('apply is idempotent: a repeat call with the same key returns the stored result without re-invoking', async () => {
    const invoke = vi.fn(async () => ({ data: { applied: true } }));
    const gate = new GatekeeperBase({
      manifest: [executeOp()],
      transport: fakeTransport(invoke),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    const first = await gate.apply('stock.adjust', { qty: 5 }, 'req-1');
    const second = await gate.apply('stock.adjust', { qty: 5 }, 'req-1');

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('validates params against the operation params_schema and rejects invalid input', async () => {
    const gate = new GatekeeperBase({
      manifest: [
        observeOp({
          params_schema: {
            type: 'object',
            properties: { sku: { type: 'string' } },
            required: ['sku'],
          },
        }),
      ],
      transport: fakeTransport(),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    await expect(gate.observe('stock.get', {})).rejects.toThrow(/failed validation/);
    await expect(gate.observe('stock.get', { sku: 'X1' })).resolves.toBeDefined();
  });

  it('maps a response into observed fact candidates when result_mapping is declared', async () => {
    const invoke = vi.fn(async () => ({
      data: {
        items: [
          { sku: 'X1', qty: 5 },
          { sku: 'X2', qty: 0 },
        ],
      },
    }));
    const gate = new GatekeeperBase({
      manifest: [
        observeOp({
          result_mapping: {
            jmes_path: 'items[]',
            object_type: 'Stock',
            identity_keys: ['sku'],
            attributes: { quantity: 'qty' },
          },
        }),
      ],
      transport: fakeTransport(invoke),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    const result = await gate.observe('stock.get', {});
    expect(result.observedFacts).toEqual([
      { objectType: 'Stock', identity: { sku: 'X1' }, properties: { quantity: 5 } },
      { objectType: 'Stock', identity: { sku: 'X2' }, properties: { quantity: 0 } },
    ]);
  });

  it('surfaces credential resolution failures', async () => {
    const gate = new GatekeeperBase({
      manifest: [observeOp()],
      transport: fakeTransport(),
      credentialResolver: {
        resolve: async () => {
          throw new CredentialResolutionError('no credential');
        },
      },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    await expect(gate.observe('stock.get', {})).rejects.toBeInstanceOf(CredentialResolutionError);
  });

  it('simulate falls back to a generic description when the transport has none', async () => {
    const gate = new GatekeeperBase({
      manifest: [executeOp()],
      transport: fakeTransport(),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const result = await gate.simulate('stock.adjust', { qty: 1 });
    expect(result.description).toContain('stock.adjust');
  });

  it('revert throws RevertNotSupportedError when the operation is not reversible', async () => {
    const gate = new GatekeeperBase({
      manifest: [executeOp({ reversibility: false })],
      transport: fakeTransport(),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    await expect(gate.revert('stock.adjust', {})).rejects.toThrow(/does not support revert/);
  });

  it('health defaults to ok when the transport has no health check', async () => {
    const gate = new GatekeeperBase({
      manifest: [],
      transport: fakeTransport(),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    await expect(gate.health()).resolves.toEqual({ status: 'ok' });
  });
});
