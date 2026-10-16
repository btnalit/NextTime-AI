import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOT_DELIVERED_FAILURE_CODES,
  REFUSED_BEFORE_RUNNING_FAILURE_CODES,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  GatekeeperClientError,
  GatekeeperTimeoutError,
} from '../../adapters/gatekeeper-client/index.js';
import {
  applyErrorVerdict,
  deriveDefaultIdempotencyKey,
  hashStableParams,
  lookupErrorVerdict,
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

/** S11 GO1: which kind of failure each way a gate call can end is — decided here, at the call,
 *  and written to the row's `failure_kind`; nothing downstream reads the reason text for it. */
describe('failure kinds of a gate call (S11 GO1)', () => {
  const gateError = (code: string, status = 400) =>
    new GatekeeperClientError(`gate answered ${code}`, { code, status });

  it('not_delivered: nothing reached the gate, or the gate closed a key it never ran', () => {
    for (const code of NOT_DELIVERED_FAILURE_CODES) {
      expect(applyErrorVerdict(gateError(code, 503)), code).toMatchObject({
        kind: 'failed',
        failureKind: 'not_delivered',
        message: expect.stringMatching(new RegExp(`^${code}: `)),
      });
    }
    // Thrown before the call left the kernel: not the gate client's own error.
    expect(applyErrorVerdict(new Error('could not build the request'))).toMatchObject({
      kind: 'failed',
      failureKind: 'not_delivered',
    });
    expect(lookupErrorVerdict(gateError('apply_not_received', 404))).toMatchObject({
      kind: 'failed',
      failureKind: 'not_delivered',
      reason: expect.stringMatching(/^apply_not_received: /),
    });
  });

  it('refused: the platform or the gate answered no, or the target answered with a failure', () => {
    for (const code of [...REFUSED_BEFORE_RUNNING_FAILURE_CODES, 'transport_error']) {
      expect(applyErrorVerdict(gateError(code, 422)), code).toMatchObject({
        kind: 'failed',
        failureKind: 'refused',
        message: expect.stringMatching(new RegExp(`^${code}: `)),
      });
    }
    expect(lookupErrorVerdict(gateError('transport_error', 502))).toMatchObject({
      kind: 'failed',
      failureKind: 'refused',
    });
  });

  it('outcome_unknown: the gate says it cannot know, or cannot be asked', () => {
    expect(applyErrorVerdict(gateError('apply_outcome_unknown', 409)).kind).toBe('outcome_unknown');
    expect(applyErrorVerdict(gateError('response_too_large', 502)).kind).toBe('outcome_unknown');
    expect(lookupErrorVerdict(gateError('apply_outcome_unknown', 409))).toMatchObject({
      kind: 'failed',
      failureKind: 'outcome_unknown',
      reason: expect.stringMatching(/^outcome_unknown: /),
    });
    // A 404 that is not the gate's own: it has no apply_lookup route and cannot be asked.
    expect(lookupErrorVerdict(gateError('not_found', 404))).toMatchObject({
      kind: 'failed',
      failureKind: 'outcome_unknown',
    });
  });

  it('a code this kernel does not know is in doubt, never a refusal (review of #601, M1)', () => {
    for (const code of ['network_error', 'some_future_code', 'not_found', 'conflict']) {
      expect(applyErrorVerdict(gateError(code, 400)), code).toEqual({
        kind: 'in_doubt',
        message: `${code}: gate answered ${code}`,
      });
    }
  });

  it('a call with no verdict yet is not a failure of any kind (legacy 287)', () => {
    expect(applyErrorVerdict(new GatekeeperTimeoutError('timed out', 'gate/apply')).kind).toBe(
      'in_doubt',
    );
    expect(applyErrorVerdict(gateError('gate_connection_lost', 502)).kind).toBe('in_doubt');
    expect(lookupErrorVerdict(gateError('gate_not_found', 404)).kind).toBe('indeterminate');
    expect(lookupErrorVerdict(new Error('socket hang up')).kind).toBe('indeterminate');
  });

  it('migration governance/0021 backfills existing rows from the shared lists of codes', () => {
    const migration = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../migrations/governance/0021_action_request_withdraw_failure_kind.sql',
      ),
      'utf8',
    );
    const codes = (kind: string) => {
      const match = new RegExp(`when f\\.reason ~ '\\^\\(([a-z_|]+)\\):' then '${kind}'`).exec(
        migration,
      );
      expect(match, kind).not.toBeNull();
      return new Set(match?.[1]?.split('|'));
    };
    expect(codes('not_delivered')).toEqual(new Set(NOT_DELIVERED_FAILURE_CODES));
    expect(codes('refused')).toEqual(new Set(REFUSED_BEFORE_RUNNING_FAILURE_CODES));
  });
});
