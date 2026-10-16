import { ACTION_REQUEST_STATUS_VALUES, type ActionRequestStatus } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { type ActionOutcomeColumns, actionDisposition, stepActionEffect } from './disposition.js';

/**
 * application/goal/disposition (S11 GO1, plan §4.7): the advancer splits a step on two columns of
 * each of its ActionRequests — `status` and `failure_kind` — and nothing else.
 */

const failed = (failureKind: ActionOutcomeColumns['failureKind']): ActionOutcomeColumns => ({
  status: 'failed',
  failureKind,
});
const at = (status: ActionRequestStatus): ActionOutcomeColumns => ({ status, failureKind: null });

describe('actionDisposition — one per failure kind', () => {
  it('not delivered: nothing ran, so a new attempt is safe', () => {
    expect(actionDisposition(failed('not_delivered'))).toBe('retry');
    expect(stepActionEffect([failed('not_delivered')])).toEqual({
      kind: 'fail',
      failureCategory: 'transient',
    });
  });

  it('refused: a definitive no goes to a person, never retried', () => {
    expect(actionDisposition(failed('refused'))).toBe('needs_decision');
    expect(stepActionEffect([failed('refused')])).toEqual({
      kind: 'fail',
      failureCategory: 'action_refused',
    });
  });

  it('outcome unknown: the step waits to reconcile, never re-runs', () => {
    expect(actionDisposition(failed('outcome_unknown'))).toBe('reconcile');
    expect(stepActionEffect([failed('outcome_unknown')])).toEqual({
      kind: 'wait',
      waitingReason: 'reconcile',
    });
  });

  it('a failed row read without a kind is outcome unknown — the reading that never re-runs', () => {
    expect(actionDisposition(failed(null))).toBe('reconcile');
  });
});

describe('actionDisposition — every status', () => {
  const expected: Record<Exclude<ActionRequestStatus, 'failed'>, string> = {
    proposed: 'in_flight',
    policy_evaluated: 'in_flight',
    pending_approval: 'in_flight',
    approved: 'in_flight',
    auto_approved: 'in_flight',
    executing: 'in_flight',
    executed: 'executed',
    verified: 'executed',
    rejected: 'needs_decision',
    expired: 'needs_decision',
    denied: 'needs_decision',
    compensated: 'needs_decision',
    withdrawn: 'withdrawn',
  };

  it('covers all 14 statuses', () => {
    expect(new Set([...Object.keys(expected), 'failed'])).toEqual(
      new Set(ACTION_REQUEST_STATUS_VALUES),
    );
  });

  it.each(Object.entries(expected))('%s → %s', (status, disposition) => {
    expect(actionDisposition(at(status as ActionRequestStatus))).toBe(disposition);
  });

  it('a compensated row needs a decision whatever kind of failure preceded it', () => {
    for (const kind of ['not_delivered', 'refused', 'outcome_unknown'] as const) {
      expect(actionDisposition({ status: 'compensated', failureKind: kind })).toBe(
        'needs_decision',
      );
    }
  });
});

describe('stepActionEffect — a step with several requests', () => {
  it('is clear with no requests, or when every one executed or was withdrawn', () => {
    expect(stepActionEffect([])).toEqual({ kind: 'clear' });
    expect(stepActionEffect([at('executed'), at('verified'), at('withdrawn')])).toEqual({
      kind: 'clear',
    });
  });

  it('waits for approval while a request is undecided or executing (scenario S5)', () => {
    expect(stepActionEffect([at('executed'), at('pending_approval')])).toEqual({
      kind: 'wait',
      waitingReason: 'approval',
    });
    expect(stepActionEffect([at('executing')])).toEqual({
      kind: 'wait',
      waitingReason: 'approval',
    });
  });

  it('reconciles first: an outcome-unknown request outranks a refusal and a pending one', () => {
    expect(
      stepActionEffect([failed('refused'), at('pending_approval'), failed('outcome_unknown')]),
    ).toEqual({ kind: 'wait', waitingReason: 'reconcile' });
  });

  it('asks a person before waiting on the rest: a rejection outranks a pending request', () => {
    expect(stepActionEffect([at('pending_approval'), at('rejected')])).toEqual({
      kind: 'fail',
      failureCategory: 'action_refused',
    });
  });

  it('does not start another attempt while one of this attempt’s requests may still run (I-G4)', () => {
    expect(stepActionEffect([failed('not_delivered'), at('approved')])).toEqual({
      kind: 'wait',
      waitingReason: 'approval',
    });
  });

  it('retries only once nothing else is pending', () => {
    expect(stepActionEffect([at('executed'), failed('not_delivered')])).toEqual({
      kind: 'fail',
      failureCategory: 'transient',
    });
  });
});
