import {
  DECISION_TRANSITIONS,
  type FactCheck,
  type GoalAcceptanceCheckKind,
  type GoalAcceptanceCheckStatus,
  type GoalOutcomeBasis,
  type GoalRunStatus,
  MAX_GOAL_NOTE_CHARS,
  type ObjectiveOutcome,
  type ObservationAbsenceCheck,
  type ObservationCheck,
  type StepAcceptanceState,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { listStepActionOutcomes } from '../../governance/approval/index.js';
import { redactedForAudit, refuseCredentialText } from '../../governance/redaction/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { listGoalRunLiveTaskSteps } from '../task/index.js';
import {
  type AcceptanceCheckRow,
  listAcceptanceChecks,
  listStepAcceptanceChecks,
  passAcceptanceConfirmation,
  readCurrentAcceptanceRound,
} from './acceptance-checks.js';
import { markGoalRunDue } from './advancer.js';
import { actionDisposition } from './disposition.js';
import { moveGoalRun, moveStepRun } from './moves.js';
import { isPlatformAcceptanceCheck, roundAcceptance } from './plan.js';
import { getGoalRun, getPlanRevision, listStepRuns, lockStepRuns } from './reads.js';
import {
  GoalRunForbiddenError,
  GoalRunInputError,
  GoalRunNotFoundError,
  GoalRunStateError,
  lockGoalRun,
} from './service.js';
import type { GoalControlActor, GoalRunRow } from './types.js';

/**
 * application/goal/acceptance (S11 GO4a; plan §4.6, I-G5, scenario S6): the requester's word on a
 * GoalRun's outcome, and what a person reads about its verification. The capabilities that expose
 * these (`confirm_goal_acceptance`, `end_goal`, S11 GO5b) are the requester's own decisions on the
 * human channel, never in an agent's Handle scope; like `control.ts`, these run in the caller's
 * transaction, GoalRun locked first, and enforce what a capability must not be able to skip. Only
 * the requester gives an outcome: a workspace owner may hold or cancel someone else's run
 * (`control.ts`), not judge it.
 *
 *   - {@link confirmGoalAcceptance}: the requester confirms the round's `requester_confirm` check —
 *     only while the run is `verifying` and only once every check of the round the platform makes
 *     (an observation, a Fact it judges) passed. A
 *     Decision of theirs (`goal_outcome`, `achieved`, naming the run, the round and the check) is
 *     what the row passes on; the run is due, and the advance completes it (`advance.ts` phase V).
 *   - {@link endGoalRun}: the requester ends the run with an outcome, on their word (`requester`
 *     basis, their Decision on the run): `not_achieved` from `verifying` or `paused` (S6: "按未达成
 *     结束"); `achieved` from `paused` only — the round's own way to `achieved` is the confirmation
 *     above, and a verifying run is still checking. An `achieved` that overrides checks — a round
 *     that did not pass on the current plan, or none run on it at all — is never silent: the
 *     Decision, the transition's audit row and {@link readGoalAcceptance} name every overridden
 *     check with its evidence (the Observation it rests on, what went wrong). Nothing of the run
 *     may still run: no step running or waiting, no Task live, no request in flight (one could
 *     still execute after the end — cancel the run instead, which withdraws them). Steps not
 *     started (`pending`, `ready`) are skipped; a failed step stays failed — that is what it was.
 *   - {@link readGoalAcceptance}: the verification rounds and their checks, and what the outcome
 *     rests on — the read model the console tells "the platform's checks passed" from "checks did
 *     not pass, the requester declared it achieved" by (GO6), never by parsing a pause's detail.
 */

/** The longest note the requester gives with an outcome (`@nexttime/shared`'s, which the
 *  capabilities' params hold to). */
export const GOAL_OUTCOME_NOTE_MAX = MAX_GOAL_NOTE_CHARS;

/** One acceptance check an `achieved` on the requester's word overrides, with its evidence. */
export interface OverriddenAcceptanceCheck {
  readonly checkKey: string;
  readonly kind: GoalAcceptanceCheckKind;
  /** The round it was checked in — `null` when no round ran on the current plan. */
  readonly round: number | null;
  /** What became of it: `failed`, `unavailable`, `superseded` (the round ended first) or
   *  `not_run` (no round on the current plan). */
  readonly status: Exclude<GoalAcceptanceCheckStatus, 'passed' | 'pending'> | 'not_run';
  /** The Observation it rests on — the evidence a person reads. */
  readonly observationId: string | null;
  /** A fact check's (S11 GO4c): the Fact it saw — the evidence a person reads. */
  readonly factId: string | null;
  readonly lastError: string | null;
}

/** The note as kept — in the outcome Decision's rationale, as written: trimmed, a blank one absent;
 *  refused when too long or when it carries a suspected credential (S11 GO5b). */
function normalizeNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  if (!trimmed) return undefined;
  if ([...trimmed].length > GOAL_OUTCOME_NOTE_MAX) {
    throw new GoalRunInputError(`a note is at most ${GOAL_OUTCOME_NOTE_MAX} characters`);
  }
  refuseCredentialText('note', trimmed);
  return trimmed;
}

async function lockRequesterRun(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
  actor: GoalControlActor,
): Promise<GoalRunRow> {
  const goal = await lockGoalRun(client, workspaceId, goalRunId);
  if (!goal) throw new GoalRunNotFoundError(goalRunId);
  if (goal.onBehalfOf !== actor.principalId) {
    throw new GoalRunForbiddenError('only the requester gives a goal run its outcome');
  }
  return goal;
}

/** The requester's Decision on the run's outcome — the row the database lets an outcome on their
 *  word, or a passed confirmation, rest on (goal/0005). */
async function writeOutcomeDecision(
  client: PoolClient,
  workspaceId: string,
  goal: GoalRunRow,
  rationale: { readonly outcome: ObjectiveOutcome } & Record<string, unknown>,
): Promise<string> {
  const activity = await startActivity(client, workspaceId, {
    kind: 'goal.outcome_decision',
    principalId: goal.onBehalfOf,
    metadata: { goalRunId: goal.id, outcome: rationale.outcome },
  });
  await endActivity(client, workspaceId, activity.id, 'completed');
  const result = await client.query<{ id: string }>(
    `insert into decisions (workspace_id, status, activity_id, summary, rationale, decided_by,
       decided_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, now())
     returning id`,
    [
      workspaceId,
      transition(DECISION_TRANSITIONS, 'proposed', 'approve'),
      activity.id,
      `goal run ${goal.id}: ${rationale.outcome}, on the requester's word`,
      JSON.stringify({ decision: 'goal_outcome', goalRunId: goal.id, ...rationale }),
      goal.onBehalfOf,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('writeOutcomeDecision: INSERT ... RETURNING produced no row');
  return row.id;
}

export interface ConfirmGoalAcceptanceInput {
  readonly goalRunId: string;
  readonly actor: GoalControlActor;
  /** The confirmation's key — optional: a round asks at most once. */
  readonly checkKey?: string;
  readonly note?: string;
}

export interface ConfirmGoalAcceptanceResult {
  readonly status: GoalRunStatus;
  /** `false` when the round's confirmation already passed. */
  readonly changed: boolean;
  readonly decisionId: string | null;
}

/** The requester confirms the round's `requester_confirm` check — see the module comment. */
export async function confirmGoalAcceptance(
  client: PoolClient,
  workspaceId: string,
  input: ConfirmGoalAcceptanceInput,
): Promise<ConfirmGoalAcceptanceResult> {
  const goal = await lockRequesterRun(client, workspaceId, input.goalRunId, input.actor);
  if (goal.status !== 'verifying') {
    throw new GoalRunStateError(
      `goal run ${goal.id} is ${goal.status}; a confirmation is given while it is verifying`,
    );
  }
  const round = await readCurrentAcceptanceRound(client, workspaceId, goal.id, goal.updatedAt);
  const confirmation = round.find(
    (check) =>
      check.kind === 'requester_confirm' &&
      (input.checkKey === undefined || check.checkKey === input.checkKey),
  );
  if (!confirmation) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: the current round asks no confirmation${input.checkKey ? ` "${input.checkKey}"` : ''}`,
    );
  }
  if (confirmation.status === 'passed') {
    return { status: goal.status, changed: false, decisionId: confirmation.decisionId };
  }
  if (confirmation.status !== 'pending') {
    throw new GoalRunStateError(
      `goal run ${goal.id}: confirmation ${confirmation.checkKey} is ${confirmation.status}`,
    );
  }
  const unpassed = round.filter(
    (check) => isPlatformAcceptanceCheck(check.kind) && check.status !== 'passed',
  );
  if (unpassed.length > 0) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: the platform's checks have not all passed yet (${unpassed
        .map((check) => `${check.checkKey}: ${check.status}`)
        .join(', ')}); the requester confirms after them`,
    );
  }
  const note = normalizeNote(input.note);
  const decisionId = await writeOutcomeDecision(client, workspaceId, goal, {
    outcome: 'achieved',
    round: confirmation.round,
    checkKey: confirmation.checkKey,
    note: note ?? null,
  });
  await passAcceptanceConfirmation(client, workspaceId, confirmation, decisionId, goal.onBehalfOf);
  await markGoalRunDue(client, workspaceId, goal.id);
  return { status: goal.status, changed: true, decisionId };
}

export interface EndGoalRunInput {
  readonly goalRunId: string;
  readonly actor: GoalControlActor;
  readonly outcome: ObjectiveOutcome;
  readonly note?: string;
}

export interface EndGoalRunResult {
  readonly status: GoalRunStatus;
  /** `false` when the run had already ended with this outcome on the requester's word. */
  readonly changed: boolean;
  readonly decisionId: string | null;
  /** The checks an `achieved` overrides — empty otherwise. */
  readonly overriddenChecks: readonly OverriddenAcceptanceCheck[];
  readonly skippedStepRunIds: readonly string[];
}

/** The requester ends the run with an outcome — see the module comment. */
export async function endGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: EndGoalRunInput,
): Promise<EndGoalRunResult> {
  const goal = await lockRequesterRun(client, workspaceId, input.goalRunId, input.actor);
  if (
    goal.status === 'completed' &&
    goal.outcome === input.outcome &&
    goal.outcomeBasis === 'requester'
  ) {
    return {
      status: goal.status,
      changed: false,
      decisionId: goal.outcomeDecisionId,
      overriddenChecks: [],
      skippedStepRunIds: [],
    };
  }
  if (goal.status !== 'paused' && goal.status !== 'verifying') {
    throw new GoalRunStateError(
      `goal run ${goal.id} is ${goal.status}; a paused or verifying run is ended with an outcome`,
    );
  }
  if (goal.status === 'verifying' && input.outcome === 'achieved') {
    throw new GoalRunStateError(
      `goal run ${goal.id} is verifying; confirm its acceptance check once the platform's checks passed, or wait for them`,
    );
  }
  const note = normalizeNote(input.note);
  const steps = await lockStepRuns(client, workspaceId, goal.id);
  const busy = steps.find((step) => step.status === 'running' || step.status === 'waiting');
  if (busy) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: step ${busy.stepKey} is ${busy.status}; wait for it, or cancel the run`,
    );
  }
  if ((await listGoalRunLiveTaskSteps(client, workspaceId, goal.id)).length > 0) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: a Task of it still runs; wait for it, or cancel the run`,
    );
  }
  for (const step of steps) {
    // Each request on its own, not the step's combined effect: there an outcome-unknown request
    // (`reconcile`) outranks one in flight (`approval`), and would hide it (review #493 on GO4a).
    const outcomes = await listStepActionOutcomes(client, workspaceId, step.id);
    if (outcomes.some((outcome) => actionDisposition(outcome) === 'in_flight')) {
      throw new GoalRunStateError(
        `goal run ${goal.id}: an action of step ${step.stepKey} still awaits a decision or runs; wait for it, or cancel the run (which withdraws it)`,
      );
    }
  }

  const overriddenChecks =
    input.outcome === 'achieved' ? await overriddenAcceptance(client, workspaceId, goal) : [];
  const decisionId = await writeOutcomeDecision(client, workspaceId, goal, {
    outcome: input.outcome,
    from: goal.status,
    ...(goal.pauseReason ? { pauseReason: goal.pauseReason } : {}),
    ...(input.outcome === 'achieved' ? { overriddenChecks } : {}),
    note: note ?? null,
  });
  const actor = { principalId: input.actor.principalId, by: 'person' as const };
  const skipped: string[] = [];
  for (const step of steps) {
    if (step.status !== 'pending' && step.status !== 'ready') continue;
    await moveStepRun(client, actor, step, 'skip', { audit: { reason: 'goal_ended' } });
    skipped.push(step.id);
  }
  const status = await moveGoalRun(client, actor, goal, goal.status, 'complete', {
    outcome: { outcome: input.outcome, basis: 'requester', decisionId },
    audit: {
      ...(goal.pauseReason ? { pauseReason: goal.pauseReason } : {}),
      ...(input.outcome === 'achieved' ? { overriddenChecks } : {}),
      ...(skipped.length > 0 ? { skippedSteps: skipped.length } : {}),
      ...(note ? redactedForAudit({ note }) : {}),
    },
  });
  return { status, changed: true, decisionId, overriddenChecks, skippedStepRunIds: skipped };
}

/** What an `achieved` on the requester's word overrides: every check the platform makes of the
 *  latest round on the current plan that did not pass — or, when no round ran on it, every such
 *  check of the plan in force, `not_run`. (A confirmation is not overridden: the requester is the
 *  one giving it.) */
async function overriddenAcceptance(
  client: PoolClient,
  workspaceId: string,
  goal: GoalRunRow,
): Promise<readonly OverriddenAcceptanceCheck[]> {
  const rows = await listAcceptanceChecks(client, workspaceId, goal.id);
  const latest = rows.reduce((max, row) => Math.max(max, row.round), 0);
  const round = rows.filter(
    (row) => row.round === latest && row.planRevision === goal.currentRevision,
  );
  if (round.length > 0) {
    const overridden: OverriddenAcceptanceCheck[] = [];
    for (const row of round) {
      if (row.kind === 'requester_confirm' || row.status === 'passed') continue;
      overridden.push({
        checkKey: row.checkKey,
        kind: row.kind,
        round: row.round,
        // Pending only in a round its run left without superseding it (a release before GO4a).
        status: row.status === 'pending' ? 'superseded' : row.status,
        observationId: row.observationId,
        factId: row.factId,
        lastError: row.lastError,
      });
    }
    return overridden;
  }
  const revision =
    goal.currentRevision === null
      ? null
      : await getPlanRevision(client, workspaceId, goal.id, goal.currentRevision);
  return (roundAcceptance(revision?.plan ?? null, goal.statement) ?? [])
    .filter((check) => check.kind !== 'requester_confirm')
    .map((check) => ({
      checkKey: check.key,
      kind: check.kind,
      round: null,
      status: 'not_run' as const,
      observationId: null,
      factId: null,
      lastError: null,
    }));
}

/** One check of a round, as a person reads it. */
export interface GoalAcceptanceCheckView {
  readonly checkKey: string;
  readonly kind: GoalAcceptanceCheckKind;
  readonly status: GoalAcceptanceCheckStatus;
  /** An observation's: what is observed — with its predicate, or (an absence check, S11
   *  「门确认不存在」 B) none. */
  readonly check: ObservationCheck | ObservationAbsenceCheck | null;
  /** A fact check's (S11 GO4c): the Fact judged. */
  readonly fact: FactCheck | null;
  readonly prompt: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  /** The evidence: the latest Observation (an observation), the latest Fact seen (a fact check),
   *  or the requester's Decision (a confirmation). */
  readonly observationId: string | null;
  readonly factId: string | null;
  readonly decisionId: string | null;
  /** When the next attempt is due — only while a check the platform makes is pending. */
  readonly nextAttemptAt: Date | null;
  readonly settledAt: Date | null;
  /** 「已覆盖」: the requester declared the goal achieved over this check, which had not passed. */
  readonly overridden: boolean;
}

export interface GoalAcceptanceRoundView {
  readonly round: number;
  readonly planRevision: number;
  readonly openedAt: Date;
  readonly checks: readonly GoalAcceptanceCheckView[];
}

/**
 * Where a step's own acceptance stands (S11 GO4b) — the console gives each a different next step:
 * `verifying` (its checks are being observed), `unavailable` (a check could not be made: the run
 * waits on a person, and resuming it verifies the step again without redoing its work), `failed`
 * (a check was made and did not pass: `verification_failed`, retried only by a person, which redoes
 * the work), `passed` (the step succeeded on its checks). `null`: none of these now — a step
 * working again after a retry, or one a revision or cancel ended. The values are `@nexttime/shared`'s
 * `STEP_ACCEPTANCE_STATE_VALUES` (S11 GO5a: the wire carries them).
 */
export type { StepAcceptanceState };

export interface StepAcceptanceRoundView extends GoalAcceptanceRoundView {
  /** The attempt of the step the round verifies. */
  readonly stepAttempt: number;
}

export interface StepAcceptanceView {
  readonly stepRunId: string;
  readonly stepKey: string;
  readonly attempt: number;
  readonly state: StepAcceptanceState | null;
  readonly rounds: readonly StepAcceptanceRoundView[];
}

export interface GoalAcceptanceView {
  readonly goalRunId: string;
  readonly status: GoalRunStatus;
  readonly rounds: readonly GoalAcceptanceRoundView[];
  /** Steps that verify their own work (S11 GO4b): every step with an acceptance round or waiting on
   *  one, in creation order. */
  readonly steps: readonly StepAcceptanceView[];
  /** What a completed run's outcome rests on — `null` until it completes. */
  readonly outcome: {
    readonly outcome: ObjectiveOutcome;
    readonly basis: GoalOutcomeBasis;
    readonly decisionId: string | null;
    /** `achieved` on the requester's word over checks that had not passed — each one with its
     *  evidence; empty when the platform's checks passed, or the outcome is `not_achieved`. */
    readonly overriddenChecks: readonly OverriddenAcceptanceCheck[];
  } | null;
}

/** The run's verification — see the module comment. `null` when the run does not exist. */
export async function readGoalAcceptance(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<GoalAcceptanceView | null> {
  const goal = await getGoalRun(client, workspaceId, goalRunId);
  if (!goal) return null;
  const rows = await listAcceptanceChecks(client, workspaceId, goalRunId);
  let overriddenChecks: readonly OverriddenAcceptanceCheck[] = [];
  if (goal.outcomeDecisionId && goal.outcome === 'achieved') {
    const decision = await client.query<{ rationale: { overriddenChecks?: unknown } | null }>(
      'select rationale from decisions where workspace_id = $1 and id = $2',
      [workspaceId, goal.outcomeDecisionId],
    );
    const listed = decision.rows[0]?.rationale?.overriddenChecks;
    if (Array.isArray(listed)) overriddenChecks = listed as OverriddenAcceptanceCheck[];
  }
  const overridden = new Set(
    overriddenChecks
      .filter((check) => check.round !== null)
      .map((check) => `${check.round}:${check.checkKey}`),
  );
  const stepRows = await listStepAcceptanceChecks(client, workspaceId, goalRunId);
  const steps: StepAcceptanceView[] = [];
  for (const step of await listStepRuns(client, workspaceId, goalRunId)) {
    const own = stepRows.filter((row) => row.stepRunId === step.id);
    const state = stepAcceptanceState(step, own.length > 0);
    if (own.length === 0 && state === null) continue;
    steps.push({
      stepRunId: step.id,
      stepKey: step.stepKey,
      attempt: step.attemptCount,
      state,
      rounds: roundViews(own, () => false).map((round) => ({
        ...round,
        stepAttempt: own.find((row) => row.round === round.round)?.stepAttempt ?? 0,
      })),
    });
  }
  return {
    goalRunId: goal.id,
    status: goal.status,
    rounds: roundViews(rows, (round, checkKey) => overridden.has(`${round}:${checkKey}`)),
    steps,
    outcome:
      goal.status === 'completed' && goal.outcome && goal.outcomeBasis
        ? {
            outcome: goal.outcome,
            basis: goal.outcomeBasis,
            decisionId: goal.outcomeDecisionId,
            overriddenChecks,
          }
        : null,
  };
}

function stepAcceptanceState(
  step: {
    readonly status: string;
    readonly waitingReason: string | null;
    readonly failureCategory: string | null;
  },
  hasRounds: boolean,
): StepAcceptanceState | null {
  if (step.status === 'waiting' && step.waitingReason === 'acceptance') return 'verifying';
  if (step.status === 'waiting' && step.waitingReason === 'acceptance_unavailable') {
    return 'unavailable';
  }
  if (step.status === 'failed' && step.failureCategory === 'verification_failed') return 'failed';
  // goal/0006 lets a step that declares checks succeed only on a passed round.
  if (step.status === 'succeeded' && hasRounds) return 'passed';
  return null;
}

/** Rows grouped by round, in the order the rows came. */
function roundViews(
  rows: readonly AcceptanceCheckRow[],
  isOverridden: (round: number, checkKey: string) => boolean,
): GoalAcceptanceRoundView[] {
  const rounds = new Map<number, AcceptanceCheckRow[]>();
  for (const row of rows) rounds.set(row.round, [...(rounds.get(row.round) ?? []), row]);
  return [...rounds.entries()].map(([round, checks]) => ({
    round,
    planRevision: checks[0]?.planRevision ?? 0,
    openedAt: checks.reduce(
      (first, check) => (check.createdAt < first ? check.createdAt : first),
      checks[0]?.createdAt ?? new Date(0),
    ),
    checks: checks.map((check) => ({
      checkKey: check.checkKey,
      kind: check.kind,
      status: check.status,
      check: check.observationCheck,
      fact: check.factCheck,
      prompt: check.prompt,
      attempts: check.attempts,
      lastError: check.lastError,
      observationId: check.observationId,
      factId: check.factId,
      decisionId: check.decisionId,
      nextAttemptAt:
        check.status === 'pending' && isPlatformAcceptanceCheck(check.kind)
          ? check.nextAttemptAt
          : null,
      settledAt: check.settledAt,
      overridden: isOverridden(round, check.checkKey),
    })),
  }));
}
