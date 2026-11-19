import { createHash } from 'node:crypto';
import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  canonicalBinding,
  canonicalJson,
  operationDefinition,
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

  it('reads the answers that mean "does not exist" as a set: their order never changes it (UX acceptance of #1490)', () => {
    const observe = (binding: Operation['binding']) =>
      httpOp({ mode: 'observe', result_mapping: undefined, binding });
    const http = (absent_statuses: (404 | 410)[]) =>
      observe({ kind: 'http', method: 'GET', path: '/stock/{sku}', absent_statuses });
    expect(operationDefinitionDigest(http([410, 404]))).toBe(
      operationDefinitionDigest(http([404, 410])),
    );
    // What they are still counts: one answer fewer is another definition.
    expect(operationDefinitionDigest(http([404]))).not.toBe(
      operationDefinitionDigest(http([404, 410])),
    );
    for (const kind of ['cli', 'ssh'] as const) {
      const exit = (absent_exit_codes: number[]) =>
        observe({ kind, command_template: 'stat {sku}', absent_exit_codes });
      expect(operationDefinitionDigest(exit([4, 1, 2]))).toBe(
        operationDefinitionDigest(exit([1, 2, 4])),
      );
      expect(operationDefinitionDigest(exit([1, 2]))).not.toBe(
        operationDefinitionDigest(exit([1, 2, 4])),
      );
    }
  });

  it('hashes a declaration already in ascending order exactly as before, so older gates agree on it', () => {
    // The digest a base that hashed the binding as written computes: the same canonical JSON with
    // the declaration left in place. Equal whenever the declaration is ascending.
    const asWritten = (operation: Operation) => {
      const definition = { ...operationDefinition(operation), binding: operation.binding };
      return `sha256:${createHash('sha256').update(canonicalJson(definition)).digest('hex')}`;
    };
    const declaring = (absent_statuses: (404 | 410)[]) =>
      httpOp({
        mode: 'observe',
        result_mapping: undefined,
        binding: { kind: 'http', method: 'GET', path: '/stock/{sku}', absent_statuses },
      });
    expect(operationDefinitionDigest(declaring([404, 410]))).toBe(asWritten(declaring([404, 410])));
    expect(operationDefinitionDigest(declaring([404]))).toBe(asWritten(declaring([404])));
    expect(operationDefinitionDigest(httpOp())).toBe(asWritten(httpOp()));
    // Out of order, the older digest differs — the case release notes ask a gate's maintainer about.
    expect(operationDefinitionDigest(declaring([410, 404]))).not.toBe(
      asWritten(declaring([410, 404])),
    );
  });

  it('canonicalBinding sorts only the declaration, numerically, and leaves its input alone', () => {
    const declared = {
      kind: 'cli' as const,
      command_template: 'ls {p}',
      absent_exit_codes: [10, 9, 2],
    };
    expect(canonicalBinding(declared)).toEqual({
      kind: 'cli',
      command_template: 'ls {p}',
      absent_exit_codes: [2, 9, 10],
    });
    expect(declared.absent_exit_codes).toEqual([10, 9, 2]);
    const plain = { kind: 'mcp' as const, tool_name: 'search' };
    expect(canonicalBinding(plain)).toBe(plain);
    const none = { kind: 'http' as const, method: 'GET', path: '/x' };
    expect(canonicalBinding(none)).toBe(none);
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
