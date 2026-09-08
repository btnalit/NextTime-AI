import { describe, expect, it } from 'vitest';
import {
  deriveDefaultIdempotencyKey,
  hashStableParams,
  scopeExplicitIdempotencyKey,
} from './action-executor.js';

/**
 * Unit tests (no DB) for `request_action`'s idempotency-key derivation (P1-1 fix, review job
 * 652a4abc). The DB-integration half — a repeat call actually returning the existing row — is
 * covered by `request-action.integration.test.ts` and `governance/approval/
 * concurrency.integration.test.ts`; this file only exercises the pure derivation functions.
 */
describe('hashStableParams', () => {
  it('is stable regardless of key order', () => {
    expect(hashStableParams({ a: 1, b: 2 })).toBe(hashStableParams({ b: 2, a: 1 }));
  });

  it('differs when a value differs', () => {
    expect(hashStableParams({ a: 1 })).not.toBe(hashStableParams({ a: 2 }));
  });

  it('is stable for nested objects and arrays regardless of key order', () => {
    const left = { outer: { z: 1, a: [1, 2, { y: 1, x: 2 }] } };
    const right = { outer: { a: [1, 2, { x: 2, y: 1 }], z: 1 } };
    expect(hashStableParams(left)).toBe(hashStableParams(right));
  });

  it('distinguishes an empty object from an empty array nested at the same key', () => {
    expect(hashStableParams({ a: {} })).not.toBe(hashStableParams({ a: [] }));
  });
});

describe('deriveDefaultIdempotencyKey', () => {
  const base = {
    identity: 'session-1',
    gatekeeperId: 'gate-1',
    operationName: 'container.restart',
    params: { id: 'c1' },
  };

  it('is deterministic for identical inputs', () => {
    expect(deriveDefaultIdempotencyKey(base)).toBe(deriveDefaultIdempotencyKey({ ...base }));
  });

  it('differs when identity (sid|principal) differs', () => {
    expect(deriveDefaultIdempotencyKey(base)).not.toBe(
      deriveDefaultIdempotencyKey({ ...base, identity: 'session-2' }),
    );
  });

  it('differs when the gatekeeper differs', () => {
    expect(deriveDefaultIdempotencyKey(base)).not.toBe(
      deriveDefaultIdempotencyKey({ ...base, gatekeeperId: 'gate-2' }),
    );
  });

  it('differs when the operation differs', () => {
    expect(deriveDefaultIdempotencyKey(base)).not.toBe(
      deriveDefaultIdempotencyKey({ ...base, operationName: 'container.stop' }),
    );
  });

  it('differs when the params differ', () => {
    expect(deriveDefaultIdempotencyKey(base)).not.toBe(
      deriveDefaultIdempotencyKey({ ...base, params: { id: 'c2' } }),
    );
  });
});

describe('scopeExplicitIdempotencyKey', () => {
  it('is deterministic for identical inputs', () => {
    const args = { onBehalfOf: 'p1', sid: 's1', key: 'retry-1' };
    expect(scopeExplicitIdempotencyKey(args)).toBe(scopeExplicitIdempotencyKey({ ...args }));
  });

  it('two different principals passing the literal same key never collide', () => {
    expect(scopeExplicitIdempotencyKey({ onBehalfOf: 'p1', sid: undefined, key: 'k' })).not.toBe(
      scopeExplicitIdempotencyKey({ onBehalfOf: 'p2', sid: undefined, key: 'k' }),
    );
  });

  it('two different sessions of the same principal passing the literal same key never collide', () => {
    expect(scopeExplicitIdempotencyKey({ onBehalfOf: 'p1', sid: 's1', key: 'k' })).not.toBe(
      scopeExplicitIdempotencyKey({ onBehalfOf: 'p1', sid: 's2', key: 'k' }),
    );
  });
});
