import {
  GOAL_RUN_TRANSITIONS,
  type GoalOutcomeBasis,
  type GoalRunEvent,
  type GoalRunPauseAuthority,
  type GoalRunPauseReason,
  type GoalRunStatus,
  type ObjectiveOutcome,
  STEP_RUN_TRANSITIONS,
  type StepRunEvent,
  type StepRunFailureCategory,
  type StepRunStatus,
  type StepRunWaitingReason,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { supersedePendingAcceptanceChecks } from './acceptance-checks.js';
import { recordGoalRunTransition, recordStepRunTransition } from './transition-log.js';
import {
  STEP_RUN_ROW_COLUMNS,
  type StepRunDbRow,
  type StepRunRow,
  mapStepRunRow,
} from './types.js';

/**
 * application/goal/moves (S11 GO3a): one GoalRun or StepRun transition — the shared transition
 * table, the status-guarded UPDATE and the transition log (`transition-log.ts`) in one call — for
 * both writers in this module: the advancer (`advance.ts`) and a person's decisions
 * (`control.ts`). The caller holds the GoalRun lock (and the StepRun's), as every writer under a
 * GoalRun does.
 *
 * The actor is the principal the change is made for; `by` tells the advancer's moves from a
 * person's in the audit payload.
 */

export interface GoalMoveActor {
  readonly principalId: string;
  readonly by: 'advancer' | 'person';
}

const FINAL_GOAL_STATUSES: ReadonlySet<GoalRunStatus> = new Set([
  'completed',
  'cancelled',
  'failed',
]);
const FINAL_STEP_STATUSES: ReadonlySet<StepRunStatus> = new Set([
  'succeeded',
  'superseded',
  'cancelled',
  'skipped',
]);

export interface StepMove {
  readonly waitingReason?: StepRunWaitingReason;
  readonly failureCategory?: StepRunFailureCategory;
  /** Required by `supersede`: the revision that removes the step — the GoalRun's current one
   *  once the revision took effect (the step_runs guard checks it). */
  readonly supersededInRevision?: number;
  readonly audit?: Record<string, unknown>;
}

/** Moves `step` along `event`; throws when the row is no longer in the status it was read in. */
export async function moveStepRun(
  client: PoolClient,
  actor: GoalMoveActor,
  step: StepRunRow,
  event: StepRunEvent,
  move: StepMove = {},
): Promise<StepRunRow> {
  const to = transition(STEP_RUN_TRANSITIONS, step.status, event);
  if (to === 'superseded' && move.supersededInRevision === undefined) {
    throw new Error(`superseding step run ${step.id} needs the revision that removes it`);
  }
  const result = await client.query<StepRunDbRow>(
    `update step_runs
        set status = $3, waiting_reason = $4, failure_category = $5,
            attempt_count = attempt_count + $6, updated_at = now(),
            ended_at = case when $7 then now() else null end,
            superseded_in_revision = coalesce($9, superseded_in_revision)
      where workspace_id = $1 and id = $2 and status = $8
      returning ${STEP_RUN_ROW_COLUMNS}`,
    [
      step.workspaceId,
      step.id,
      to,
      to === 'waiting' ? (move.waitingReason ?? null) : null,
      to === 'failed' ? (move.failureCategory ?? null) : null,
      event === 'start' ? 1 : 0,
      FINAL_STEP_STATUSES.has(to),
      step.status,
      to === 'superseded' ? move.supersededInRevision : null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`step run ${step.id} is no longer ${step.status}`);
  await recordStepRunTransition(client, step.workspaceId, {
    actorPrincipalId: actor.principalId,
    action: `step_run.${event}`,
    goalRunId: step.goalRunId,
    stepRunId: step.id,
    resultingStatus: to,
    extraAuditPayload: {
      by: actor.by,
      stepKey: step.stepKey,
      ...(to === 'waiting' ? { waitingReason: move.waitingReason } : {}),
      ...(to === 'failed' ? { failureCategory: move.failureCategory } : {}),
      ...(to === 'superseded' ? { supersededInRevision: move.supersededInRevision } : {}),
      ...move.audit,
    },
  });
  return mapStepRunRow(row);
}

export interface GoalMove {
  /** Set exactly while paused (`goal_runs_pause_reason`): required by `pause`, cleared otherwise. */
  readonly pauseReason?: GoalRunPauseReason;
  /** A person's `pause`: who paused and the authority it carries (goal/0004). Absent when the
   *  advancer pauses; cleared by every move out of `paused`. */
  readonly pausedBy?: { readonly principalId: string; readonly authority: GoalRunPauseAuthority };
  /** Only on `finish_cancel` (`goal_runs_cleanup_pending`). */
  readonly cleanupPending?: boolean;
  /** `now`: the run is due at once (a person resumed or cancelled it). Otherwise `next_tick_at`
   *  stays as it is — the advance writes it last — and a final status clears it (goal/0002). */
  readonly due?: 'now';
  /** Only on `complete` (`goal_runs_outcome`): the objective outcome, what it rests on (I-G5) and,
   *  for an outcome on the requester's word, their Decision (goal/0005). */
  readonly outcome?: {
    readonly outcome: ObjectiveOutcome;
    readonly basis: GoalOutcomeBasis;
    readonly decisionId?: string;
  };
  readonly audit?: Record<string, unknown>;
}

/** Moves the GoalRun `goal` (in status `from`) along `event`; returns the new status. A move out of
 *  `verifying` supersedes the round's pending acceptance checks in the same transaction (S11 GO4a:
 *  nothing is observed for a run that is not verifying, and no row of an ended round stays
 *  pending). */
export async function moveGoalRun(
  client: PoolClient,
  actor: GoalMoveActor,
  goal: { readonly workspaceId: string; readonly id: string },
  from: GoalRunStatus,
  event: GoalRunEvent,
  move: GoalMove = {},
): Promise<GoalRunStatus> {
  const to = transition(GOAL_RUN_TRANSITIONS, from, event);
  if ((to === 'completed') !== (move.outcome !== undefined)) {
    throw new Error(`goal run ${goal.id}: an outcome is given exactly when it completes`);
  }
  const final = FINAL_GOAL_STATUSES.has(to);
  const result = await client.query(
    `update goal_runs
        set status = $3, pause_reason = $4, cleanup_pending = $5, updated_at = now(),
            ended_at = case when $6 then now() else ended_at end,
            next_tick_at = case when $6 then null when $7 then now() else next_tick_at end,
            paused_by = $9, paused_by_authority = $10,
            advance_failures = case when $11 then 0 else advance_failures end,
            outcome = $12, outcome_basis = $13, outcome_decision_id = $14
      where workspace_id = $1 and id = $2 and status = $8`,
    [
      goal.workspaceId,
      goal.id,
      to,
      to === 'paused' ? (move.pauseReason ?? null) : null,
      move.cleanupPending ?? false,
      final,
      move.due === 'now',
      from,
      to === 'paused' ? (move.pausedBy?.principalId ?? null) : null,
      to === 'paused' ? (move.pausedBy?.authority ?? null) : null,
      // A person's resume gives the run a fresh count of failed advances (legacy 356).
      event === 'resume',
      move.outcome?.outcome ?? null,
      move.outcome?.basis ?? null,
      move.outcome?.decisionId ?? null,
    ],
  );
  if ((result.rowCount ?? 0) === 0) throw new Error(`goal run ${goal.id} is no longer ${from}`);
  const supersededChecks =
    from === 'verifying'
      ? await supersedePendingAcceptanceChecks(client, goal.workspaceId, {
          goalRunId: goal.id,
          actorPrincipalId: actor.principalId,
          reason: 'goal_moved',
        })
      : 0;
  await recordGoalRunTransition(client, goal.workspaceId, {
    actorPrincipalId: actor.principalId,
    action: `goal_run.${event}`,
    goalRunId: goal.id,
    resultingStatus: to,
    extraAuditPayload: {
      by: actor.by,
      ...(to === 'paused' && move.pausedBy ? { pausedByAuthority: move.pausedBy.authority } : {}),
      ...(move.outcome
        ? {
            outcome: move.outcome.outcome,
            outcomeBasis: move.outcome.basis,
            ...(move.outcome.decisionId ? { outcomeDecisionId: move.outcome.decisionId } : {}),
          }
        : {}),
      ...(supersededChecks > 0 ? { supersededAcceptanceChecks: supersededChecks } : {}),
      ...move.audit,
    },
  });
  return to;
}
