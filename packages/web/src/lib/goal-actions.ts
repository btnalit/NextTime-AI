import type {
  AuditRecordWire,
  GoalAcceptanceCheckWire,
  GoalDetailWire,
  PlanRevisionSummaryWire,
  UnresolvedGoalActionWire,
} from '@nexttime/shared';
import { planCheckSentence, roundCheckSentence } from './goals.js';
import type { Translate } from './i18n.js';

/**
 * lib/goal-actions (S11 GO6, operations): which of a person's operations on a GoalRun
 * (`confirm_goal` … `reconcile_goal_action`, GO5b) the goal page offers the reader, and why one it
 * shows is not available now. The kernel decides — 403 for who may not, 409 for a state that does
 * not allow it — this only keeps a button off the page that would certainly be refused, and says
 * why a visible one waits. Who may (capability descriptions in `@nexttime/shared`):
 *
 *   - the requester alone: confirm, resume, end with an outcome, confirm the acceptance, run an
 *     action again;
 *   - the requester or a workspace owner: reject a proposal, pause, cancel, record what was found
 *     about an action — an owner pausing someone else's run holds it;
 *   - a workspace owner: lift a hold.
 */

export interface GoalViewer {
  /** The signed-in principal (`get_workspace.caller.id`); `null` until it is known. */
  readonly principalId: string | null;
  readonly isOwner: boolean;
}

/** A button the page shows: `disabledReason` set when it waits on something. */
export interface GoalOperation {
  readonly disabledReason: string | null;
}

export interface GoalOperations {
  readonly confirm?: GoalOperation;
  readonly reject?: GoalOperation;
  /** `holds`: an owner pausing someone else's run — the pause is a hold. */
  readonly pause?: GoalOperation & { readonly holds: boolean };
  /** An owner placing a hold on someone else's run that is already paused. */
  readonly hold?: GoalOperation;
  readonly resume?: GoalOperation;
  readonly cancel?: GoalOperation;
  readonly release?: GoalOperation;
  /** `achieved`: whether ending as achieved is open (from paused only). */
  readonly end?: GoalOperation & { readonly achieved: boolean };
  /** The requester's confirmation of the current round's `requester_confirm` check. */
  readonly confirmAcceptance?: GoalOperation & { readonly check: GoalAcceptanceCheckWire };
}

export function isRequester(goal: { readonly onBehalfOf: string }, viewer: GoalViewer): boolean {
  return viewer.principalId !== null && viewer.principalId === goal.onBehalfOf;
}

export function isHeld(goal: {
  readonly status: string;
  readonly pausedByAuthority: string | null;
}): boolean {
  return goal.status === 'paused' && goal.pausedByAuthority === 'owner';
}

/** The steps of the plan in force that still run or wait — ending the run waits for them. */
function liveStepKeys(detail: GoalDetailWire): string[] {
  return detail.steps
    .filter(
      (step) =>
        step.supersededInRevision === null &&
        (step.status === 'running' || step.status === 'waiting'),
    )
    .map((step) => step.stepKey);
}

/** The current round's requester confirmation, with whether the platform's checks passed. */
function pendingRequesterConfirm(
  detail: GoalDetailWire,
): { check: GoalAcceptanceCheckWire; othersPassed: boolean } | null {
  const rounds = detail.acceptance.rounds.filter(
    (round) => round.planRevision === detail.currentRevision,
  );
  const round = rounds[rounds.length - 1];
  if (!round) return null;
  const check = round.checks.find(
    (item) => item.kind === 'requester_confirm' && item.status === 'pending',
  );
  if (!check) return null;
  const othersPassed = round.checks
    .filter((item) => item.kind !== 'requester_confirm')
    .every((item) => item.status === 'passed');
  return { check, othersPassed };
}

export function goalOperations(
  detail: GoalDetailWire,
  viewer: GoalViewer,
  t: Translate,
): GoalOperations {
  const requester = isRequester(detail, viewer);
  const owner = viewer.isOwner;
  const stopper = requester || owner;
  const held = isHeld(detail);
  const ops: {
    -readonly [K in keyof GoalOperations]: GoalOperations[K];
  } = {};
  const open = { disabledReason: null };

  switch (detail.status) {
    case 'proposed':
      if (requester) ops.confirm = open;
      if (stopper) ops.reject = open;
      break;
    case 'running':
    case 'verifying':
      if (stopper) {
        ops.pause = { ...open, holds: !requester };
        ops.cancel = open;
      }
      break;
    case 'paused':
      if (requester) {
        // The hold itself is explained once, in the status note above; this only says what
        // unlocks the button — the reader who is an owner too lifts the hold themselves.
        ops.resume = held
          ? {
              disabledReason: owner
                ? t(
                    '已被锁定：先点「解除锁定」，才能继续。',
                    'Held: lift the hold first, then resume.',
                  )
                : t(
                    '已被锁定：要等所有者解除锁定才能继续。',
                    'Held: you can resume it once an owner lifts the hold.',
                  ),
            }
          : open;
      }
      if (owner && !requester && !held) ops.hold = open;
      if (owner && held) ops.release = open;
      if (stopper) ops.cancel = open;
      break;
    default:
      break;
  }

  if (requester && (detail.status === 'paused' || detail.status === 'verifying')) {
    const live = liveStepKeys(detail);
    ops.end = {
      achieved: detail.status === 'paused',
      disabledReason:
        live.length > 0
          ? t(
              `还有步骤在运行或等待（${live.join('、')}）：等它们停下，或者取消目标。`,
              `Steps still run or wait (${live.join(', ')}): wait for them to stop, or cancel the goal.`,
            )
          : null,
    };
  }

  if (requester && detail.status === 'verifying') {
    const pending = pendingRequesterConfirm(detail);
    if (pending) {
      ops.confirmAcceptance = {
        check: pending.check,
        disabledReason: pending.othersPassed
          ? null
          : t(
              '平台的检查还没全部通过：通过后才能确认目标达成。',
              'The platform’s checks have not all passed yet: confirm once they have.',
            ),
      };
    }
  }

  return ops;
}

/** An acceptance check ending as achieved records as the requester's decision instead. */
export interface OverriddenCheck {
  readonly key: string;
  readonly sentence: string;
}

/** The acceptance checks ending as achieved records as the requester's decision instead
 *  (`end_goal`, `overridden`): those of the current round not passed — or, before any round, every
 *  check of the plan in force — each with what it checks. */
export function checksOverriddenByEnding(
  detail: GoalDetailWire,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
): OverriddenCheck[] {
  const rounds = detail.acceptance.rounds.filter(
    (round) => round.planRevision === detail.currentRevision,
  );
  const round = rounds[rounds.length - 1];
  if (round) {
    return round.checks
      .filter((check) => check.status !== 'passed')
      .map((check) => ({ key: check.checkKey, sentence: roundCheckSentence(check, gateNames, t) }));
  }
  return (detail.planRevision.plan.acceptance ?? []).map((check) => ({
    key: check.key,
    sentence: planCheckSentence(check, gateNames, t),
  }));
}

/** The failed steps of the plan in force a person may send back with `resume_goal` — the kernel
 *  checks the rest (nothing of the step in flight, no action of it awaiting a finding). */
export function retryableStepKeys(detail: GoalDetailWire): string[] {
  return detail.steps
    .filter((step) => step.supersededInRevision === null && step.status === 'failed')
    .map((step) => step.stepKey);
}

/** What a person may do about one unresolved action: record a finding (requester or owner), run it
 *  again (the requester, while the run can still run). */
export interface ReconcileOptions {
  readonly record: boolean;
  readonly reexecute: boolean;
}

export function reconcileOptions(
  detail: GoalDetailWire,
  action: UnresolvedGoalActionWire,
  viewer: GoalViewer,
): ReconcileOptions {
  const requester = isRequester(detail, viewer);
  const canStillRun =
    detail.status === 'running' || detail.status === 'paused' || detail.status === 'verifying';
  return {
    record: action.needs === 'finding' && (requester || viewer.isOwner),
    reexecute: requester && canStillRun,
  };
}

/** When the hold now on the run was placed, read from its audit trail (newest first): the latest
 *  `goal_run.hold`, or `goal_run.pause` by an owner. `null` when the page found none. */
export function holdPlacedAt(records: readonly AuditRecordWire[]): string | null {
  const found = records.find(
    (record) =>
      record.action === 'goal_run.hold' ||
      (record.action === 'goal_run.pause' && record.payload.pausedByAuthority === 'owner'),
  );
  return found ? found.createdAt : null;
}

/** The revisions accepted after `since` — the plan the requester changed while the run was held
 *  (`release_goal_hold` lifts the hold whatever the plan now is; review #493 on #685). */
export function revisionsSince(
  revisions: readonly PlanRevisionSummaryWire[],
  since: string,
): PlanRevisionSummaryWire[] {
  const from = Date.parse(since);
  return revisions.filter(
    (revision) =>
      revision.status === 'accepted' &&
      revision.revision > 1 &&
      Date.parse(revision.decidedAt ?? revision.createdAt) > from,
  );
}
