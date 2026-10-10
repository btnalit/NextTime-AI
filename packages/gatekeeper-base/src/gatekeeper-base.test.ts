import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  ApplyOutcomeUnknownError,
  CredentialResolutionError,
  IdempotencyConflictError,
  OperationDefinitionMismatchError,
  OperationRefusedError,
  TransportInvokeError,
  TransportTimeoutError,
} from './errors.js';
import { GatekeeperBase } from './gatekeeper-base.js';
import {
  InMemoryIdempotencyStore,
  JsonFileIdempotencyStore,
  hashIdempotencyParams,
} from './idempotency-store.js';
import type { Transport } from './kinds/types.js';
import { operationDefinitionDigest } from './operation-digest.js';

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

  it('routes apply only to mode:execute operations and requires an actionRequestId', async () => {
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
    await expect(gate.apply('stock.adjust', {}, '')).rejects.toThrow(/requires actionRequestId/);
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

  it('a concurrent apply with the same key invokes the transport only once (review lane 5, P2-1)', async () => {
    let resolveInvoke: ((value: { data: unknown }) => void) | undefined;
    const invoke = vi.fn(
      () =>
        new Promise<{ data: unknown }>((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    const gate = new GatekeeperBase({
      manifest: [executeOp()],
      transport: fakeTransport(invoke),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    const first = gate.apply('stock.adjust', { qty: 5 }, 'req-race');
    // The first call has reserved the key but not yet resolved its transport invoke — a second,
    // genuinely concurrent apply for the same key must not invoke the transport again.
    await expect(gate.apply('stock.adjust', { qty: 5 }, 'req-race')).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(invoke).toHaveBeenCalledTimes(1);

    resolveInvoke?.({ data: { applied: true } });
    await expect(first).resolves.toMatchObject({ replayed: false, data: { applied: true } });
  });

  it('apply returns IdempotencyConflictError for the same key with a different params tuple', async () => {
    const gate = new GatekeeperBase({
      manifest: [executeOp()],
      transport: fakeTransport(),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    await gate.apply('stock.adjust', { qty: 1 }, 'req-2');
    await expect(gate.apply('stock.adjust', { qty: 2 }, 'req-2')).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('a transport refusal releases the reservation; any other transport failure is stored and answered again, never re-run (R-04, R-51)', async () => {
    let refuse = true;
    const invoke = vi.fn(async () => {
      if (refuse) throw new OperationRefusedError('not served by this gate');
      throw new TransportInvokeError('target failed mid-call');
    });
    const gate = new GatekeeperBase({
      manifest: [executeOp()],
      transport: fakeTransport(invoke),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    await expect(gate.apply('stock.adjust', {}, 'req-1')).rejects.toBeInstanceOf(
      OperationRefusedError,
    );
    await expect(gate.apply('stock.adjust', {}, 'req-1')).rejects.toBeInstanceOf(
      OperationRefusedError,
    );
    refuse = false;
    await expect(gate.apply('stock.adjust', {}, 'req-1')).rejects.toBeInstanceOf(
      TransportInvokeError,
    );
    // R-51: the retry gets the same stored failure — not 409 forever, and not a second run.
    await expect(gate.apply('stock.adjust', {}, 'req-1')).rejects.toThrow('target failed mid-call');
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('a credential that cannot be resolved frees the key: a retry once it is fixed runs (R-51)', async () => {
    let credentialMissing = true;
    const invoke = vi.fn(async () => ({ data: { applied: true } }));
    const gate = new GatekeeperBase({
      manifest: [executeOp()],
      transport: fakeTransport(invoke),
      credentialResolver: {
        resolve: async () => {
          if (credentialMissing) throw new CredentialResolutionError('no credential');
          return {};
        },
      },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    await expect(gate.apply('stock.adjust', {}, 'req-cred')).rejects.toBeInstanceOf(
      CredentialResolutionError,
    );
    expect(invoke).not.toHaveBeenCalled();
    credentialMissing = false;
    await expect(gate.apply('stock.adjust', {}, 'req-cred')).resolves.toMatchObject({
      replayed: false,
      data: { applied: true },
    });
  });

  it('a transport timeout records the key as outcome unknown: every call for it answers unknown, never re-runs (R-51)', async () => {
    const invoke = vi.fn(async () => {
      throw new TransportTimeoutError('cli transport: command timed out after 50000 ms');
    });
    const gate = new GatekeeperBase({
      manifest: [executeOp()],
      transport: fakeTransport(invoke),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(gate.apply('stock.adjust', {}, 'req-timeout')).rejects.toSatisfy(
        (err) =>
          err instanceof ApplyOutcomeUnknownError &&
          /timed out after 50000 ms/.test((err as Error).message),
      );
    }
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a non-transport error inside the gate is stored too, with a generic message (R-51)', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('internal detail');
    });
    const gate = new GatekeeperBase({
      manifest: [executeOp()],
      transport: fakeTransport(invoke),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    await expect(gate.apply('stock.adjust', {}, 'req-plain')).rejects.toThrow('internal detail');
    const retry = gate.apply('stock.adjust', {}, 'req-plain');
    await expect(retry).rejects.toBeInstanceOf(TransportInvokeError);
    await expect(retry).rejects.toThrow('apply for "stock.adjust" failed inside the gate');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // D-11: a gate that dies mid-apply restarts with the key still pending on disk — it answers
  // "outcome unknown" from then on instead of freeing the key for the replay to re-execute.
  it('a key left pending by a crashed gate process answers outcome unknown after a restart, never re-runs (D-11)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gatekeeper-base-restart-'));
    try {
      const invoke = vi.fn(async () => ({ data: { applied: true } }));
      // The first process reserved the key and died before the transport returned.
      await new JsonFileIdempotencyStore(dir).reserve('req-crash', {
        operation: 'stock.adjust',
        paramsHash: hashIdempotencyParams({ qty: 1 }),
        onBehalfOf: 'user-a',
      });

      const restarted = new GatekeeperBase({
        manifest: [executeOp()],
        transport: fakeTransport(invoke),
        credentialResolver: { resolve: async () => ({}) },
        idempotencyStore: new JsonFileIdempotencyStore(dir),
      });
      await expect(
        restarted.apply('stock.adjust', { qty: 1 }, 'req-crash', { onBehalfOf: 'user-a' }),
      ).rejects.toBeInstanceOf(ApplyOutcomeUnknownError);
      // A different call reusing the key is still a conflict, not "unknown".
      await expect(
        restarted.apply('stock.adjust', { qty: 2 }, 'req-crash', { onBehalfOf: 'user-a' }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it('skips credential resolution entirely when the transport declares credentialRequired: false (ssh/cli)', async () => {
    const resolve = vi.fn(async () => {
      throw new CredentialResolutionError('no credential configured');
    });
    const invoke = vi.fn(async (_op: Operation, _params: unknown, _ctx: unknown) => ({
      data: { stdout: 'up' },
    }));
    const transport: Transport = { kind: 'ssh', credentialRequired: false, invoke };
    const gate = new GatekeeperBase({
      manifest: [observeOp(), executeOp()],
      transport,
      credentialResolver: { resolve },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    await expect(gate.observe('stock.get', {})).resolves.toMatchObject({ data: { stdout: 'up' } });
    await expect(gate.simulate('stock.adjust', {})).resolves.toHaveProperty('description');
    await expect(gate.apply('stock.adjust', {}, 'k1')).resolves.toBeDefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(invoke.mock.calls[0]?.[2]).toMatchObject({ credential: undefined });
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

describe('GatekeeperBase: the approved definition (legacy K)', () => {
  const approved = executeOp();
  const approvedDigest = operationDefinitionDigest(approved);
  // The gate's manifest changed after `approved` was published: same name, another path.
  const changed = executeOp({ binding: { kind: 'http', method: 'POST', path: '/admin/wipe' } });

  function gateRunning(operations: Operation[], invoke = vi.fn(async () => ({ data: { ok: 1 } }))) {
    const idempotencyStore = new InMemoryIdempotencyStore();
    const gate = new GatekeeperBase({
      manifest: operations,
      transport: fakeTransport(invoke),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore,
    });
    return { gate, invoke, idempotencyStore };
  }

  it('runs a call whose digest is the definition this gate runs', async () => {
    const { gate, invoke } = gateRunning([observeOp(), approved]);
    await gate.observe(
      'stock.get',
      {},
      { operationDigest: operationDefinitionDigest(observeOp()) },
    );
    await gate.apply('stock.adjust', {}, 'req-k1', { operationDigest: approvedDigest });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(gate.definitionDigest(approved)).toBe(approvedDigest);
  });

  it('refuses every protocol call for another definition, before the credential or the transport', async () => {
    const resolve = vi.fn(async () => ({}));
    const invoke = vi.fn(async () => ({ data: {} }));
    const gate = new GatekeeperBase({
      manifest: [observeOp({ params_schema: { type: 'object', required: ['sku'] } }), changed],
      transport: { kind: 'http', invoke, revert: invoke },
      credentialResolver: { resolve },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const stale = { operationDigest: operationDefinitionDigest(observeOp()) };
    await expect(gate.observe('stock.get', {}, stale)).rejects.toBeInstanceOf(
      OperationDefinitionMismatchError,
    );
    const ctx = { operationDigest: approvedDigest };
    await expect(gate.simulate('stock.adjust', {}, ctx)).rejects.toBeInstanceOf(
      OperationDefinitionMismatchError,
    );
    await expect(gate.apply('stock.adjust', {}, 'req-k2', ctx)).rejects.toThrow(
      /the definition that was approved \([0-9a-f]{12}\) is not the one this gate runs \([0-9a-f]{12}\) — refused, nothing ran/,
    );
    await expect(gate.revert('stock.adjust', {}, ctx)).rejects.toBeInstanceOf(
      OperationDefinitionMismatchError,
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses a call that names no definition (null), and checks nothing for an in-process caller (undefined)', async () => {
    const { gate, invoke } = gateRunning([approved]);
    await expect(
      gate.apply('stock.adjust', {}, 'req-k3', { operationDigest: null }),
    ).rejects.toThrow(/no operationDigest/);
    expect(invoke).not.toHaveBeenCalled();
    await gate.apply('stock.adjust', {}, 'req-k3');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a refused apply frees its key: the same key runs once the definitions agree', async () => {
    const { gate, invoke } = gateRunning([approved]);
    await expect(
      gate.apply('stock.adjust', { qty: 1 }, 'req-k4', {
        operationDigest: operationDefinitionDigest(changed),
      }),
    ).rejects.toBeInstanceOf(OperationDefinitionMismatchError);
    const result = await gate.apply('stock.adjust', { qty: 1 }, 'req-k4', {
      operationDigest: approvedDigest,
    });
    expect(result.replayed).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a replay is answered from the store even after the manifest changed — the call did run', async () => {
    const before = gateRunning([approved]);
    await before.gate.apply('stock.adjust', { qty: 1 }, 'req-k5', {
      operationDigest: approvedDigest,
    });
    await expect(
      before.gate.apply('stock.adjust', { qty: 2 }, 'req-k6', { operationDigest: approvedDigest }),
    ).resolves.toMatchObject({ replayed: false });

    // The gate re-handshakes with a changed manifest; its idempotency store survives.
    const invokeAfter = vi.fn(async () => ({ data: {} }));
    const after = new GatekeeperBase({
      manifest: [changed],
      transport: fakeTransport(invokeAfter),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: before.idempotencyStore,
    });
    await expect(
      after.apply('stock.adjust', { qty: 1 }, 'req-k5', { operationDigest: approvedDigest }),
    ).resolves.toEqual({ data: { ok: 1 }, observedFacts: [], replayed: true });
    // A new key under the old definition is refused; the changed definition never ran.
    await expect(
      after.apply('stock.adjust', { qty: 1 }, 'req-k7', { operationDigest: approvedDigest }),
    ).rejects.toBeInstanceOf(OperationDefinitionMismatchError);
    expect(invokeAfter).not.toHaveBeenCalled();
  });

  it('a stored failure is answered again under a mismatch, not refused (R-51)', async () => {
    const invoke = vi.fn(async () => {
      throw new TransportInvokeError('target failed mid-call');
    });
    const before = gateRunning([approved], invoke);
    await expect(
      before.gate.apply('stock.adjust', {}, 'req-k8', { operationDigest: approvedDigest }),
    ).rejects.toBeInstanceOf(TransportInvokeError);
    const after = new GatekeeperBase({
      manifest: [changed],
      transport: fakeTransport(),
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: before.idempotencyStore,
    });
    await expect(
      after.apply('stock.adjust', {}, 'req-k8', { operationDigest: approvedDigest }),
    ).rejects.toThrow('target failed mid-call');
  });

  it('a gate definition that does not parse refuses every call', async () => {
    const broken = { ...approved, binding: { kind: 'ssh' } } as unknown as Operation;
    const { gate, invoke } = gateRunning([broken]);
    expect(gate.definitionDigest(broken)).toBe('unreadable');
    await expect(
      gate.apply('stock.adjust', {}, 'req-k9', { operationDigest: approvedDigest }),
    ).rejects.toThrow(/is not the one this gate runs \(unreadable\)/);
    expect(invoke).not.toHaveBeenCalled();
  });
});
