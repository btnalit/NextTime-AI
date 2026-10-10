import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  operationDefinitionDigest,
  shortOperationDigest,
} from './operation-digest.js';

function httpOp(overrides: Partial<Operation> = {}): Operation {
  return {
    name: 'stock.adjust',
    description: 'Adjust stock',
    binding: { kind: 'http', method: 'POST', path: '/stock/{sku}' },
    params_schema: {
      type: 'object',
      properties: { sku: { type: 'string', 'x-in': 'path' }, qty: { type: 'number' } },
      required: ['sku'],
    },
    mode: 'execute',
    blast_radius: 'medium',
    reversibility: false,
    auto_approvable: false,
    await_decision: true,
    reads: [],
    writes: ['Stock'],
    result_mapping: { jmes_path: '@', object_type: 'Stock', identity_keys: ['sku'] },
    ...overrides,
  };
}

describe('canonicalJson', () => {
  it('sorts object keys at every depth and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
    expect(canonicalJson([undefined, null, 'x'])).toBe('[null,null,"x"]');
  });
});

describe('operationDefinitionDigest (legacy K)', () => {
  it('is sha256 of the canonical definition, stable across key order and a jsonb round trip', () => {
    const op = httpOp();
    const digest = operationDefinitionDigest(op);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The kernel's copy: stored as jsonb (keys reordered, undefined dropped) and read back.
    const reordered = Object.fromEntries(Object.entries(op).reverse());
    const roundTripped = JSON.parse(JSON.stringify({ ...reordered, read_only_hint: undefined }));
    expect(operationDefinitionDigest(roundTripped)).toBe(digest);
  });

  it('ignores the governance-only fields, and keys no schema declares', () => {
    const digest = operationDefinitionDigest(httpOp());
    for (const overrides of [
      { description: 'Something else' },
      { auto_approvable: true },
      { await_decision: false },
      { reads: ['Stock'] },
      { writes: [] },
      { blast_radius: 'high' as const },
      { destructive_hint: true, idempotent_hint: false, read_only_hint: false },
    ]) {
      expect(operationDefinitionDigest(httpOp(overrides))).toBe(digest);
    }
    // Bookkeeping the kernel stores beside the definition, and binding keys the schema drops.
    expect(
      operationDefinitionDigest({
        ...httpOp(),
        status: 'published',
        version: 3,
        binding: { kind: 'http', method: 'POST', path: '/stock/{sku}', note: 'x' },
      }),
    ).toBe(digest);
  });

  it('changes with every field the gate acts on', () => {
    const digest = operationDefinitionDigest(httpOp());
    const changed: Partial<Operation>[] = [
      { name: 'stock.set' },
      { binding: { kind: 'http', method: 'PUT', path: '/stock/{sku}' } },
      { binding: { kind: 'http', method: 'POST', path: '/admin/stock/{sku}' } },
      // A param moved into a header is a different request, even with the same name and type.
      {
        params_schema: {
          type: 'object',
          properties: { sku: { type: 'string', 'x-in': 'header' }, qty: { type: 'number' } },
          required: ['sku'],
        },
      },
      { result_mapping: { jmes_path: 'items', object_type: 'Stock', identity_keys: ['sku'] } },
      { result_mapping: undefined },
      { mode: 'observe' },
      { reversibility: true },
    ];
    for (const overrides of changed) {
      expect(operationDefinitionDigest(httpOp(overrides))).not.toBe(digest);
    }
  });

  it('covers blast_radius for an ssh binding, where the gate enforces it', () => {
    const ssh = (blast: Operation['blast_radius']) =>
      httpOp({ binding: { kind: 'ssh', command_pattern: '^systemctl ' }, blast_radius: blast });
    expect(operationDefinitionDigest(ssh('low'))).not.toBe(operationDefinitionDigest(ssh('high')));
  });

  it('throws when the definition does not parse, so a caller can never send none', () => {
    const { binding: _binding, ...withoutBinding } = httpOp();
    expect(() => operationDefinitionDigest(withoutBinding)).toThrow();
    expect(() => operationDefinitionDigest({ ...httpOp(), result_mapping: null })).toThrow();
  });

  it('shortOperationDigest shows the first 12 hex characters', () => {
    expect(shortOperationDigest(`sha256:${'ab'.repeat(32)}`)).toBe('abababababab');
  });
});
