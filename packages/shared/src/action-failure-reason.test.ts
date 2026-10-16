import { describe, expect, it } from 'vitest';
import {
  NOT_DELIVERED_FAILURE_CODES,
  REFUSED_BEFORE_RUNNING_FAILURE_CODES,
  failureKindOfReason,
} from './action-failure-reason.js';

/**
 * action-failure-reason (S11 GO1, review of #601 M1): a reason is `not_delivered` or `refused` only
 * when its code says for certain nothing ran; every other reason — including each one earlier
 * releases wrote for a call that may have run — is `outcome_unknown`.
 */

/** Reasons earlier releases wrote on a failed request whose call may have run. */
const HISTORICAL_MAY_HAVE_RUN_REASONS: readonly string[] = [
  // v0.35.0: the reaper wrote an indeterminate replay as failed, with a space, not an underscore.
  'outcome unknown: gatekeeper client: gate/apply timed out after 60000ms — the gate may still complete it',
  // v0.20–v0.30: a timeout written as failed, no code.
  'gatekeeper client: gate/apply timed out after 15000ms',
  // v0.36–v0.49 (before legacy 287 split it): may have been delivered.
  'network_error: gatekeeper client: gate/apply request failed: socket hang up',
  // Earlier still: no code at all.
  'gatekeeper client: gate/apply request failed',
  // The gate answered and its answer could not be read: it had the call.
  'response_too_large: gatekeeper client: gate/apply response exceeds 1048576 bytes',
  // Written as failed before they were in doubt.
  'invalid_response: gatekeeper client: gate/apply answered 502 with no gate envelope',
  'internal_error: internal error',
  'unrecognized_gate_error: gatekeeper client: gate/apply answered 504',
  // A gate before legacy 287 also called a failure after sending a transport error.
  'transport_error: ssh: connection reset by peer',
  // The current spelling.
  'outcome_unknown: apply for "restart" … may have run',
];

describe('failureKindOfReason', () => {
  it.each(HISTORICAL_MAY_HAVE_RUN_REASONS)(
    'a reason for a call that may have run: %s',
    (reason) => {
      expect(failureKindOfReason(reason)).toBe('outcome_unknown');
    },
  );

  it('no reason, an unknown code, or a code that is not at the start is outcome unknown', () => {
    expect(failureKindOfReason(null)).toBe('outcome_unknown');
    expect(failureKindOfReason(undefined)).toBe('outcome_unknown');
    expect(failureKindOfReason('')).toBe('outcome_unknown');
    expect(failureKindOfReason('boom')).toBe('outcome_unknown');
    expect(failureKindOfReason('some_future_code: …')).toBe('outcome_unknown');
    expect(failureKindOfReason('the gate said operation_refused: no')).toBe('outcome_unknown');
    expect(failureKindOfReason('Operation_refused: no')).toBe('outcome_unknown');
  });

  it.each(NOT_DELIVERED_FAILURE_CODES)('%s: nothing ran', (code) => {
    expect(failureKindOfReason(`${code}: detail`)).toBe('not_delivered');
  });

  it.each(REFUSED_BEFORE_RUNNING_FAILURE_CODES)('%s: refused before anything ran', (code) => {
    expect(failureKindOfReason(`${code}: detail`)).toBe('refused');
  });

  it('an unregistered gatekeeper is a refusal; the reaper’s "no gate to ask" is not', () => {
    expect(
      failureKindOfReason('gatekeeper "6f1c9a52-3d2b-4c1e-9a8f-0b7d5e4c3a21" is not registered'),
    ).toBe('refused');
    expect(
      failureKindOfReason(
        'gatekeeper "6f1c9a52-3d2b-4c1e-9a8f-0b7d5e4c3a21" is not registered — no gate to ask',
      ),
    ).toBe('outcome_unknown');
  });

  it('the two lists never overlap', () => {
    const refused = new Set<string>(REFUSED_BEFORE_RUNNING_FAILURE_CODES);
    expect(NOT_DELIVERED_FAILURE_CODES.filter((code) => refused.has(code))).toEqual([]);
  });
});
