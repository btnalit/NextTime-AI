import type {
  ActionRequestFailureKind,
  ActionRequestStatus,
  StepRunFailureCategory,
  StepRunWaitingReason,
} from '@nexttime/shared';

/**
 * application/goal/disposition (S11 GO1, plan §4.7): how the advancer splits a step on what its
 * ActionRequests became — from two columns of each request, `status` and `failure_kind`, and
 * nothing else. The reason text a failure carries stays in the audit payload for people; no branch
 * here can see it (`ActionOutcomeColumns` has no field for it), so a reworded reason never moves
 * a step.
 *
 * Per request ({@link actionDisposition}):
 *
 * | status / failure_kind | disposition | why |
 * |---|---|---|
 * | `proposed`, `policy_evaluated`, `pending_approval`, `approved`, `auto_approved`, `executing` | `in_flight` | not decided or not finished yet |
 * | `executed`, `verified` | `executed` | it ran |
 * | `failed` + `not_delivered` | `retry` | it never reached the gate: nothing ran, a new attempt is safe |
 * | `failed` + `refused` | `needs_decision` | a definitive no; asking again unchanged gets the same answer |
 * | `failed` + `outcome_unknown` | `reconcile` | it may have run: check the target before anything else, never re-run |
 * | `rejected`, `expired`, `denied` | `needs_decision` | a person or the policy said no (scenario S11) |
 * | `compensated` | `needs_decision` | it failed and was compensated; what comes next is a person's call |
 * | `withdrawn` | `withdrawn` | taken back with its step (I-G9); says nothing about the step |
 *
 * A `failed` / `compensated` row always has a `failure_kind` (a DB CHECK, governance/0021); a
 * failed row read without one is treated as `outcome_unknown` — the reading that never re-runs.
 */

/** The two columns of an ActionRequest the advancer reads — deliberately no reason text. */
export interface ActionOutcomeColumns {
  readonly status: ActionRequestStatus;
  readonly failureKind: ActionRequestFailureKind | null;
}

export type ActionDisposition =
  | 'in_flight'
  | 'executed'
  | 'retry'
  | 'reconcile'
  | 'needs_decision'
  | 'withdrawn';

const DISPOSITION_BY_FAILURE_KIND: Record<ActionRequestFailureKind, ActionDisposition> = {
  not_delivered: 'retry',
  refused: 'needs_decision',
  outcome_unknown: 'reconcile',
};

const DISPOSITION_BY_STATUS: Record<Exclude<ActionRequestStatus, 'failed'>, ActionDisposition> = {
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

/** What one request means for its step — see the module table. */
export function actionDisposition(action: ActionOutcomeColumns): ActionDisposition {
  if (action.status === 'failed') {
    return DISPOSITION_BY_FAILURE_KIND[action.failureKind ?? 'outcome_unknown'];
  }
  return DISPOSITION_BY_STATUS[action.status];
}

/**
 * What a step's requests, taken together, call for:
 *   - `wait` — `reconcile` (an outcome-unknown action must be checked first: scenario S4) or
 *     `approval` (a request is still awaiting its decision or execution: scenario S5);
 *   - `fail` — `action_refused` (a person must decide: scenario S11) or `transient` (a request
 *     never reached its gate: a new attempt is safe, under the attempt limit);
 *   - `clear` — nothing left to wait on: every request executed or was withdrawn, or there were
 *     none. Whether the step succeeds still depends on its output and acceptance (§4.5).
 *
 * Precedence, first match wins: `reconcile` (the platform can act on it now, and a person deciding
 * anything else needs its answer), then `action_refused`, then `approval` (do not start another
 * attempt while one of this attempt's requests may still run — I-G4), then `transient`.
 */
export type StepActionEffect =
  | {
      readonly kind: 'wait';
      readonly waitingReason: Extract<StepRunWaitingReason, 'approval' | 'reconcile'>;
    }
  | {
      readonly kind: 'fail';
      readonly failureCategory: Extract<StepRunFailureCategory, 'action_refused' | 'transient'>;
    }
  | { readonly kind: 'clear' };

export function stepActionEffect(actions: readonly ActionOutcomeColumns[]): StepActionEffect {
  const dispositions = new Set(actions.map(actionDisposition));
  if (dispositions.has('reconcile')) return { kind: 'wait', waitingReason: 'reconcile' };
  if (dispositions.has('needs_decision'))
    return { kind: 'fail', failureCategory: 'action_refused' };
  if (dispositions.has('in_flight')) return { kind: 'wait', waitingReason: 'approval' };
  if (dispositions.has('retry')) return { kind: 'fail', failureCategory: 'transient' };
  return { kind: 'clear' };
}
