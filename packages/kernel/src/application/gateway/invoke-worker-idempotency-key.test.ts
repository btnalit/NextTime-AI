import { describe, expect, it } from 'vitest';
import { DERIVED_IDEMPOTENCY_KEY_PREFIX } from '../../governance/approval/request-action.js';
import { DERIVED_TASK_IDEMPOTENCY_KEY_PREFIX } from '../task/index.js';
import { deriveDefaultIdempotencyKey, scopeExplicitIdempotencyKey } from './action-executor.js';
import { deriveDefaultInvokeWorkerIdempotencyKey } from './handlers.js';

/**
 * Unit tests (no DB) for the derived-key half of the 2026-10-02 review's R-53 / R-54 (decision
 * D-12). The stores tell a derived key from an explicit one by its prefix alone (the partial unique
 * indexes in governance 0014 / task 0005 and the lookups beside them), so the prefixes the
 * derivations emit are pinned here. The DB half — which rows a key collapses onto — is covered by
 * `governance/approval/service.integration.test.ts`, `application/task/invoke.integration.test.ts`
 * and `invoke-worker-handler.integration.test.ts`.
 */
describe('derived vs explicit idempotency keys', () => {
  it('request_action: a derived key carries the prefix the governance store windows; an explicit one does not', () => {
    const derived = deriveDefaultIdempotencyKey({
      identity: 'session-1',
      gatekeeperId: 'gate-1',
      operationName: 'container.restart',
      params: { id: 'c1' },
    });
    expect(derived.startsWith(DERIVED_IDEMPOTENCY_KEY_PREFIX)).toBe(true);

    // Even a caller key that itself starts with the prefix stays explicit once scoped.
    const explicit = scopeExplicitIdempotencyKey({ onBehalfOf: 'p1', sid: 's1', key: 'auto:x' });
    expect(explicit.startsWith(DERIVED_IDEMPOTENCY_KEY_PREFIX)).toBe(false);
  });
});

describe('deriveDefaultInvokeWorkerIdempotencyKey (R-54)', () => {
  const base = {
    identity: 'session-1',
    definitionId: 'def-1',
    version: 1,
    input: { target: 'c1', options: { a: 1, b: 2 } },
    gates: ['gate-1'],
  };

  it('carries the prefix the task store windows to non-terminal Tasks', () => {
    expect(
      deriveDefaultInvokeWorkerIdempotencyKey(base).startsWith(DERIVED_TASK_IDEMPOTENCY_KEY_PREFIX),
    ).toBe(true);
  });

  it('is deterministic, regardless of key order inside input', () => {
    expect(deriveDefaultInvokeWorkerIdempotencyKey(base)).toBe(
      deriveDefaultInvokeWorkerIdempotencyKey({
        ...base,
        input: { options: { b: 2, a: 1 }, target: 'c1' },
      }),
    );
  });

  it('differs when the session, definition, version, input or gates differ', () => {
    const key = deriveDefaultInvokeWorkerIdempotencyKey(base);
    for (const variant of [
      { ...base, identity: 'session-2' },
      { ...base, definitionId: 'def-2' },
      { ...base, version: 2 },
      { ...base, input: { target: 'c2', options: { a: 1, b: 2 } } },
      { ...base, gates: ['gate-2'] },
      { ...base, gates: undefined },
    ]) {
      expect(deriveDefaultInvokeWorkerIdempotencyKey(variant)).not.toBe(key);
    }
  });
});
