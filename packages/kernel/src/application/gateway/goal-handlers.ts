import {
  type ActionRequestReconciliation,
  type CancelGoalResultWire,
  type ConfirmGoalAcceptanceResultWire,
  type ConfirmGoalResultWire,
  type EndGoalResultWire,
  GOAL_LIST_DEFAULT_LIMIT,
  GOAL_LIST_MAX_LIMIT,
  type GoalAcceptanceCheckWire,
  type GoalAcceptanceRoundWire,
  type GoalAcceptanceWire,
  type GoalDetailWire,
  type GoalFromProcedure,
  type GoalOperationResultWire,
  type GoalPlan,
  type GoalRunStatus,
  type GoalRunWire,
  type ObjectiveOutcome,
  type OutputProblem,
  type PlanHint,
  type PlanRevisionSummaryWire,
  type PlanRevisionWire,
  type ProposeGoalResultWire,
  type ReconcileGoalActionResultWire,
  type ResumeGoalResultWire,
  type ReviseGoalResultWire,
  type StepRemoval,
  type StepRunWire,
  type UnresolvedGoalActionWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { currentPrincipalId } from '../../application/chat/index.js';
import {
  type GoalAcceptanceCheckView,
  type GoalAcceptanceRoundView,
  type GoalAcceptanceView,
  type GoalControlActor,
  type GoalRunBudget,
  type GoalRunDetail,
  type GoalRunStepView,
  type GoalRunSummary,
  type GoalViewer,
  type PlanRevisionRow,
  type PlanRevisionView,
  type PlanSourceView,
  type UnresolvedGoalAction,
  cancelGoalRun,
  confirmGoalAcceptance,
  confirmGoalRun,
  createGoalRun,
  endGoalRun,
  getGoalRun,
  getGoalRunVisibleTo,
  listGoalRunUnresolvedActionsVisibleTo,
  listGoalRunsVisibleTo,
  maxProposedGoalsPerRequester,
  pauseGoalRun,
  readGoalRunDetail,
  readPlanRevisionVisibleTo,
  reconcileGoalAction,
  rejectGoalRun,
  releaseGoalRunHold,
  resumeGoalRun,
  reviseGoalRun,
} from '../../application/goal/index.js';
import { findAttributableTurn } from '../../application/host-bridge/index.js';
import { shownFreeText, shownFreeTextIn } from '../../governance/redaction/index.js';
import { hashStableParams, scopeExplicitIdempotencyKey } from './action-executor.js';
import type { CapabilityHandler, CapabilityHandlerContext } from './capability-handler.js';

/**
 * application/gateway/goal-handlers (S11 GO5a): the `goal` reads — `get_goal`, `list_goals`,
 * `get_goal_revision`, `list_goal_unresolved_actions` — and their projections onto
 * `@nexttime/shared`'s `wire/goal.ts`. Who may read a run is `application/goal`'s
 * (`views.ts`'s `goalVisibleTo`: the owner and the requester); on the handle channel the viewer is
 * the Handle's `obo`, who sees their own runs only, an owner too (`views.ts`).
 *
 * S11 GO5b: a person's operations on a run — human channel only. Each takes the actor from the
 * authenticated caller, role included (legacy 389: the database's guards do not know the role),
 * first refuses a run the actor cannot read as not found — the 404 `get_goal` gives, so a refusal
 * never tells someone a run exists — and then calls `application/goal`, which decides who may
 * (403), what the run's state allows (409) and what it does, in the dispatch transaction.
 *
 * S11 GO5c: `propose_goal` — the entry agent's way to start a goal (handle channel, the entry
 * ceiling), or a person's own. The requester is the caller: the human channel's Principal, or the
 * Handle's `obo`; nothing runs until they confirm it (`confirm_goal`, human channel). Its stored
 * idempotency key (goal/0008) is the one `request_action` and `invoke_worker` use: an explicit
 * `idempotencyKey` scoped to (requester, sid) by `scopeExplicitIdempotencyKey`, else
 * `auto:<sid|requester>:<hash of statement, plan and budget>`, which dedupes only while that run is
 * still proposed. A proposal made on a Handle during a running Turn records it as the run's
 * origin (`originated_in_turn_id`), as `invoke_worker` records the Turn that generated a Task.
 */

/** The caller as a goal viewer: the human channel's resolved Principal — every run when it is the
 *  owner — or, on the handle channel, where `principalId` is the Handle's `obo`, that principal
 *  for their own runs only. */
async function goalViewer(
  client: PoolClient,
  ctx: CapabilityHandlerContext | undefined,
): Promise<GoalViewer> {
  if (ctx?.principal) {
    return { principalId: ctx.principal.id, seesEveryRun: ctx.principal.role === 'owner' };
  }
  return {
    principalId: ctx?.principalId || (await currentPrincipalId(client)),
    seesEveryRun: false,
  };
}

/** S11 GO5b: the caller of a person's operation — the human channel's authenticated Principal.
 *  Every one is `channel: 'human'`, so dispatch has resolved it; a missing one is a wiring bug. */
function goalActor(
  capability: string,
  ctx: CapabilityHandlerContext | undefined,
): GoalControlActor {
  if (!ctx?.principal) {
    throw new Error(
      `${capability}: no resolved human principal in context (this capability is channel:"human"-only)`,
    );
  }
  return { principalId: ctx.principal.id, role: ctx.principal.role };
}

/** The actor of an operation on `goalRunId` — the run not found unless they can read it. */
async function actorOnVisibleRun(
  client: PoolClient,
  workspaceId: string,
  capability: string,
  ctx: CapabilityHandlerContext | undefined,
  goalRunId: string,
): Promise<GoalControlActor> {
  const actor = goalActor(capability, ctx);
  await getGoalRunVisibleTo(
    client,
    workspaceId,
    { principalId: actor.principalId, seesEveryRun: actor.role === 'owner' },
    goalRunId,
  );
  return actor;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toWireGoalRun(summary: GoalRunSummary): GoalRunWire {
  const { goal } = summary;
  return {
    id: goal.id,
    status: goal.status,
    pauseReason: goal.pauseReason,
    pausedBy: goal.pausedBy,
    pausedByAuthority: goal.pausedByAuthority,
    cleanupPending: goal.cleanupPending,
    outcome: goal.outcome,
    outcomeBasis: goal.outcomeBasis,
    outcomeDecisionId: goal.outcomeDecisionId,
    onBehalfOf: goal.onBehalfOf,
    turnId: goal.originatedInTurnId,
    // Legacy 420: free text kept as written, shown as `shownFreeText` shows it. `propose_goal`
    // refuses a suspected credential in it at write (GO5c); this masks any run written before.
    statement: shownFreeText(goal.statement),
    currentRevision: goal.currentRevision,
    budget: { ...goal.budget },
    usage: { ...summary.usage },
    stepCounts: { ...summary.stepCounts },
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
    confirmedAt: iso(goal.confirmedAt),
    endedAt: iso(goal.endedAt),
  };
}

/** `source`: the Procedure `row`'s plan was made from (S11 GO5d-2), as the reader got it. */
function toWirePlanRevisionSummary(
  row: PlanRevisionRow,
  source: PlanSourceView | null,
): PlanRevisionSummaryWire {
  return {
    id: row.id,
    goalRunId: row.goalRunId,
    revision: row.revision,
    status: row.status,
    basedOnRevision: row.basedOnRevision,
    proposedBy: row.proposedBy,
    // Legacy 420: as `statement` above (`revise_goal` refuses a credential in it since GO5b).
    reason: shownFreeText(row.reason),
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    createdAt: row.createdAt.toISOString(),
    removals: Object.fromEntries(
      Object.entries(row.removals).map(([key, removal]) => [
        key,
        {
          mode: removal.mode,
          ...(removal.release !== undefined ? { release: [...removal.release] } : {}),
        },
      ]),
    ),
    // Legacy 420: a Procedure's name is free text, read as every read shows it.
    fromProcedure:
      row.sourceProcedure !== null && source !== null
        ? {
            procedureId: source.procedureId,
            version: source.version,
            name: shownFreeText(source.name),
            parameters: source.parameters,
            confirmCheck: source.confirmCheck
              ? {
                  key: source.confirmCheck.key,
                  procedureSteps: [...source.confirmCheck.procedureSteps],
                }
              : null,
          }
        : null,
  };
}

function toWirePlanRevision(view: PlanRevisionView): PlanRevisionWire {
  return {
    ...toWirePlanRevisionSummary(view.revision, view.source),
    // Legacy 420: the plan as every read shows it (`application/goal`'s `planAsRead`) — the plan
    // that runs is the stored one; `revise_goal` takes a value left as this read shows it as
    // unchanged (S11 GO5c, `reviewRevisedPlan`).
    plan: view.plan,
    hints: view.hints.map(toWirePlanHint),
  };
}

/** A plan hint on the wire — S11 GO5c's carry the step and the gates they are about. */
function toWirePlanHint(hint: PlanHint): PlanHint {
  return {
    code: hint.code,
    message: hint.message,
    ...(hint.stepKey !== undefined ? { stepKey: hint.stepKey } : {}),
    ...(hint.gatekeeperIds !== undefined ? { gatekeeperIds: [...hint.gatekeeperIds] } : {}),
    ...(hint.capabilityNames !== undefined ? { capabilityNames: [...hint.capabilityNames] } : {}),
  };
}

function toWireStepRun(view: GoalRunStepView): StepRunWire {
  const { step } = view;
  return {
    id: step.id,
    stepKey: step.stepKey,
    introducedInRevision: step.introducedInRevision,
    supersededInRevision: step.supersededInRevision,
    status: step.status,
    waitingReason: step.waitingReason,
    failureCategory: step.failureCategory,
    attemptCount: step.attemptCount,
    createdAt: step.createdAt.toISOString(),
    updatedAt: step.updatedAt.toISOString(),
    endedAt: iso(step.endedAt),
    attempts: view.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      taskId: attempt.taskId,
      status: attempt.status,
      createdAt: attempt.createdAt.toISOString(),
      failureReason: attempt.failureReason,
      rework: attempt.rework,
      // S11 GO5d-1: an output's keys are the Worker's text, read as the Task's result is (legacy
      // 420) — the places only, never the refused output itself (`get_task` shows it).
      outputProblems: attempt.rejectedOutput
        ? (shownFreeTextIn(attempt.rejectedOutput.problems) as OutputProblem[])
        : null,
      outputProblemCount: attempt.rejectedOutput?.problemCount ?? 0,
    })),
    actions: view.actions.map((action) => ({
      actionRequestId: action.id,
      status: action.status,
      failureKind: action.failureKind,
      reconciliation: action.reconciliation,
    })),
    output: stepOutput(view),
  };
}

/** S11 GO5d-1: the output the step's current attempt reported with its accepted result, read as
 *  the Task's result is (legacy 420) — what the steps bound to it read once it has succeeded. */
function stepOutput(view: GoalRunStepView): Record<string, unknown> | null {
  const current = view.attempts.find((attempt) => attempt.attempt === view.step.attemptCount);
  return current?.output ? (shownFreeTextIn(current.output) as Record<string, unknown>) : null;
}

function toWireAcceptanceCheck(check: GoalAcceptanceCheckView): GoalAcceptanceCheckWire {
  return {
    checkKey: check.checkKey,
    kind: check.kind,
    status: check.status,
    // Legacy 420: as the plan they come from reads (`toWirePlanRevision`); the implicit
    // requester confirmation's prompt is the goal statement.
    check: shownFreeTextIn(check.check) as typeof check.check,
    fact: shownFreeTextIn(check.fact) as typeof check.fact,
    prompt: shownFreeText(check.prompt),
    attempts: check.attempts,
    lastError: check.lastError,
    observationId: check.observationId,
    factId: check.factId,
    decisionId: check.decisionId,
    nextAttemptAt: iso(check.nextAttemptAt),
    settledAt: iso(check.settledAt),
    overridden: check.overridden,
  };
}

function toWireAcceptanceRound(round: GoalAcceptanceRoundView): GoalAcceptanceRoundWire {
  return {
    round: round.round,
    planRevision: round.planRevision,
    openedAt: round.openedAt.toISOString(),
    checks: round.checks.map(toWireAcceptanceCheck),
  };
}

function toWireAcceptance(view: GoalAcceptanceView): GoalAcceptanceWire {
  return {
    rounds: view.rounds.map(toWireAcceptanceRound),
    steps: view.steps.map((step) => ({
      stepRunId: step.stepRunId,
      stepKey: step.stepKey,
      attempt: step.attempt,
      state: step.state,
      rounds: step.rounds.map((round) => ({
        ...toWireAcceptanceRound(round),
        stepAttempt: round.stepAttempt,
      })),
    })),
    overriddenChecks: (view.outcome?.overriddenChecks ?? []).map((check) => ({
      checkKey: check.checkKey,
      kind: check.kind,
      round: check.round,
      status: check.status,
      observationId: check.observationId,
      factId: check.factId,
      lastError: check.lastError,
    })),
  };
}

function toWireGoalDetail(detail: GoalRunDetail): GoalDetailWire {
  return {
    ...toWireGoalRun(detail),
    planRevision: toWirePlanRevision(detail.planRevision),
    revisions: detail.revisions.map((row) =>
      toWirePlanRevisionSummary(row, row.sourceProcedure !== null ? detail.planSource : null),
    ),
    steps: detail.steps.map(toWireStepRun),
    acceptance: toWireAcceptance(detail.acceptance),
    leftovers: detail.leftovers
      ? {
          liveTaskIds: [...detail.leftovers.liveTaskIds],
          executingActions: detail.leftovers.executingActions.map((action) => ({
            actionRequestId: action.id,
            stepRunId: action.stepRunId,
            gatekeeperId: action.gatekeeperId,
            actionKindTag: action.actionKind,
          })),
        }
      : null,
  };
}

function toWireUnresolvedAction(action: UnresolvedGoalAction): UnresolvedGoalActionWire {
  return {
    actionRequestId: action.actionRequestId,
    stepRunId: action.stepRunId,
    stepKey: action.stepKey,
    gatekeeperId: action.gatekeeperId,
    actionKindTag: action.actionKindTag,
    failedAt: iso(action.failedAt),
    needs: action.needs,
    platformCheck: action.platformCheck
      ? {
          status: action.platformCheck.status,
          attempts: action.platformCheck.attempts,
          lastError: action.platformCheck.lastError,
          observationId: action.platformCheck.observationId,
          nextAttemptAt: iso(action.platformCheck.nextAttemptAt),
        }
      : null,
  };
}

export const getGoalHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { goalRunId } = params as { goalRunId: string };
  const viewer = await goalViewer(client, ctx);
  const detail = await readGoalRunDetail(client, workspaceId, viewer, goalRunId);
  return { result: toWireGoalDetail(detail), resourceType: 'goal_run', resourceId: goalRunId };
};

export const listGoalsHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const filter = params as {
    status?: GoalRunStatus[];
    onBehalfOf?: string;
    limit?: number;
    cursor?: string;
  };
  const viewer = await goalViewer(client, ctx);
  const page = await listGoalRunsVisibleTo(client, workspaceId, viewer, filter, {
    defaultLimit: GOAL_LIST_DEFAULT_LIMIT,
    maxLimit: GOAL_LIST_MAX_LIMIT,
  });
  return {
    result: {
      items: page.items.map(toWireGoalRun),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
    },
  };
};

export const getGoalRevisionHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { goalRunId, revision } = params as { goalRunId: string; revision: number };
  const viewer = await goalViewer(client, ctx);
  const view = await readPlanRevisionVisibleTo(client, workspaceId, viewer, goalRunId, revision);
  return { result: toWirePlanRevision(view), resourceType: 'goal_run', resourceId: goalRunId };
};

export const listGoalUnresolvedActionsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { goalRunId } = params as { goalRunId: string };
  const viewer = await goalViewer(client, ctx);
  const actions = await listGoalRunUnresolvedActionsVisibleTo(
    client,
    workspaceId,
    viewer,
    goalRunId,
  );
  return {
    result: { items: actions.map(toWireUnresolvedAction) },
    resourceType: 'goal_run',
    resourceId: goalRunId,
  };
};

// ---------------------------------------------------------------------------------------------
// S11 GO5b — a person's operations (see the module comment).
// ---------------------------------------------------------------------------------------------

const onRun = (goalRunId: string) => ({ resourceType: 'goal_run', resourceId: goalRunId });

/** `propose_goal`'s derived idempotency key (goal/0008): the same statement, plan and budget from
 *  the same session (`sid`, else the requester) collapse onto the run while it is still proposed.
 *  S11 GO5d-2: a plan made from a Procedure counts as its `fromProcedure` — the Procedure, version
 *  and parameters asked for (a written plan's key is as before). */
export function deriveDefaultProposeGoalIdempotencyKey(args: {
  readonly identity: string;
  readonly statement: string;
  readonly plan?: unknown;
  readonly fromProcedure?: GoalFromProcedure;
  readonly budget: GoalRunBudget;
}): string {
  const intentHash = hashStableParams({
    statement: args.statement,
    ...(args.fromProcedure !== undefined
      ? { fromProcedure: args.fromProcedure }
      : { plan: args.plan }),
    budget: args.budget,
  });
  return `auto:${args.identity}:${intentHash}`;
}

export const proposeGoalHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const input = params as {
    statement: string;
    plan?: GoalPlan;
    fromProcedure?: GoalFromProcedure;
    budget: GoalRunBudget;
    idempotencyKey?: string;
  };
  const requesterId =
    ctx?.principal?.id ?? (ctx?.principalId || (await currentPrincipalId(client)));
  const sid = ctx?.principal ? undefined : ctx?.claims?.sid;
  const idempotencyKey =
    input.idempotencyKey !== undefined
      ? scopeExplicitIdempotencyKey({ onBehalfOf: requesterId, sid, key: input.idempotencyKey })
      : deriveDefaultProposeGoalIdempotencyKey({
          identity: sid ?? requesterId,
          statement: input.statement,
          ...(input.fromProcedure !== undefined
            ? { fromProcedure: input.fromProcedure }
            : { plan: input.plan }),
          budget: input.budget,
        });
  const turn = ctx?.principal
    ? undefined
    : await findAttributableTurn(client, { workspaceId, principalId: requesterId, at: new Date() });
  const proposed = await createGoalRun(client, workspaceId, {
    requesterId,
    proposedBy: requesterId,
    statement: input.statement,
    ...(input.fromProcedure !== undefined
      ? { fromProcedure: input.fromProcedure }
      : { plan: input.plan }),
    budget: input.budget,
    idempotencyKey,
    maxProposed: maxProposedGoalsPerRequester(process.env.GOAL_MAX_PROPOSED_PER_REQUESTER),
    ...(turn?.wasRunning ? { originatedInTurnId: turn.id } : {}),
  });
  const result: ProposeGoalResultWire = {
    goalRunId: proposed.goalRunId,
    status: proposed.status,
    changed: proposed.changed,
    planRevisionId: proposed.planRevisionId,
    hints: proposed.hints.map(toWirePlanHint),
  };
  return { result, ...onRun(proposed.goalRunId) };
};

export const confirmGoalHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { goalRunId, revision } = params as { goalRunId: string; revision: number };
  const actor = await actorOnVisibleRun(client, workspaceId, 'confirm_goal', ctx, goalRunId);
  const confirmed = await confirmGoalRun(client, workspaceId, {
    goalRunId,
    revision,
    confirmedBy: actor.principalId,
  });
  const result: ConfirmGoalResultWire = {
    goalRunId,
    status: confirmed.status,
    changed: confirmed.changed,
    createdStepRunIds: [...confirmed.createdStepRunIds],
  };
  return { result, ...onRun(goalRunId) };
};

export const rejectGoalHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { goalRunId, revision } = params as { goalRunId: string; revision: number };
  const actor = await actorOnVisibleRun(client, workspaceId, 'reject_goal', ctx, goalRunId);
  const rejected = await rejectGoalRun(client, workspaceId, { goalRunId, revision, actor });
  const result: GoalOperationResultWire = { goalRunId, ...rejected };
  return { result, ...onRun(goalRunId) };
};

export const pauseGoalHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { goalRunId } = params as { goalRunId: string };
  const actor = await actorOnVisibleRun(client, workspaceId, 'pause_goal', ctx, goalRunId);
  const paused = await pauseGoalRun(client, workspaceId, { goalRunId, actor });
  const result: GoalOperationResultWire = { goalRunId, ...paused };
  return { result, ...onRun(goalRunId) };
};

export const resumeGoalHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { goalRunId, retrySteps } = params as { goalRunId: string; retrySteps?: string[] };
  const actor = await actorOnVisibleRun(client, workspaceId, 'resume_goal', ctx, goalRunId);
  const resumed = await resumeGoalRun(client, workspaceId, {
    goalRunId,
    actor,
    ...(retrySteps !== undefined ? { retrySteps } : {}),
  });
  const result: ResumeGoalResultWire = {
    goalRunId,
    status: resumed.status,
    changed: resumed.changed,
    retriedStepRunIds: [...resumed.retriedStepRunIds],
  };
  return { result, ...onRun(goalRunId) };
};

export const cancelGoalHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { goalRunId } = params as { goalRunId: string };
  const actor = await actorOnVisibleRun(client, workspaceId, 'cancel_goal', ctx, goalRunId);
  const cancelled = await cancelGoalRun(client, workspaceId, { goalRunId, actor });
  const result: CancelGoalResultWire = {
    goalRunId,
    status: cancelled.status,
    changed: cancelled.changed,
    cancelledStepRunIds: [...cancelled.cancelledStepRunIds],
    withdrawnActionRequestIds: [...cancelled.withdrawnActionRequestIds],
  };
  return { result, ...onRun(goalRunId) };
};

export const releaseGoalHoldHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { goalRunId } = params as { goalRunId: string };
  const actor = await actorOnVisibleRun(client, workspaceId, 'release_goal_hold', ctx, goalRunId);
  const released = await releaseGoalRunHold(client, workspaceId, { goalRunId, actor });
  const result: GoalOperationResultWire = { goalRunId, ...released };
  return { result, ...onRun(goalRunId) };
};

export const reviseGoalHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const input = params as {
    goalRunId: string;
    basedOnRevision: number;
    plan: GoalPlan;
    reason?: string;
    budget?: GoalRunBudget;
    removals?: Record<string, StepRemoval>;
  };
  const actor = await actorOnVisibleRun(client, workspaceId, 'revise_goal', ctx, input.goalRunId);
  const revised = await reviseGoalRun(client, workspaceId, {
    goalRunId: input.goalRunId,
    actor,
    basedOnRevision: input.basedOnRevision,
    plan: input.plan,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.removals !== undefined ? { removals: input.removals } : {}),
  });
  const result: ReviseGoalResultWire = {
    goalRunId: input.goalRunId,
    // A revision leaves the run paused (`revise.ts`).
    status: 'paused',
    changed: true,
    revision: revised.revision,
    planRevisionId: revised.planRevisionId,
    supersededStepRunIds: [...revised.supersededStepRunIds],
    createdStepRunIds: [...revised.createdStepRunIds],
    withdrawnActionRequestIds: [...revised.withdrawnActionRequestIds],
    releasedActionRequestIds: [...revised.releasedActionRequestIds],
    hints: revised.hints.map(toWirePlanHint),
  };
  return { result, ...onRun(input.goalRunId) };
};

export const confirmGoalAcceptanceHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { goalRunId, checkKey, note } = params as {
    goalRunId: string;
    checkKey?: string;
    note?: string;
  };
  const actor = await actorOnVisibleRun(
    client,
    workspaceId,
    'confirm_goal_acceptance',
    ctx,
    goalRunId,
  );
  const confirmed = await confirmGoalAcceptance(client, workspaceId, {
    goalRunId,
    actor,
    ...(checkKey !== undefined ? { checkKey } : {}),
    ...(note !== undefined ? { note } : {}),
  });
  const result: ConfirmGoalAcceptanceResultWire = { goalRunId, ...confirmed };
  return { result, ...onRun(goalRunId) };
};

export const endGoalHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { goalRunId, outcome, note } = params as {
    goalRunId: string;
    outcome: ObjectiveOutcome;
    note?: string;
  };
  const actor = await actorOnVisibleRun(client, workspaceId, 'end_goal', ctx, goalRunId);
  const ended = await endGoalRun(client, workspaceId, {
    goalRunId,
    actor,
    outcome,
    ...(note !== undefined ? { note } : {}),
  });
  const result: EndGoalResultWire = {
    goalRunId,
    status: ended.status,
    changed: ended.changed,
    decisionId: ended.decisionId,
    overriddenChecks: ended.overriddenChecks.map((check) => ({
      checkKey: check.checkKey,
      kind: check.kind,
      round: check.round,
      status: check.status,
      observationId: check.observationId,
      factId: check.factId,
      lastError: check.lastError,
    })),
    skippedStepRunIds: [...ended.skippedStepRunIds],
  };
  return { result, ...onRun(goalRunId) };
};

export const reconcileGoalActionHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const input = params as {
    goalRunId: string;
    actionRequestId: string;
    verdict?: ActionRequestReconciliation;
    reexecute?: boolean;
    note?: string;
  };
  const actor = await actorOnVisibleRun(
    client,
    workspaceId,
    'reconcile_goal_action',
    ctx,
    input.goalRunId,
  );
  const reconciled = await reconcileGoalAction(client, workspaceId, {
    goalRunId: input.goalRunId,
    actionRequestId: input.actionRequestId,
    // Who decides is read again from `principals` by governance (and by the database guard).
    deciderPrincipalId: actor.principalId,
    ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
    ...(input.reexecute !== undefined ? { reexecute: input.reexecute } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
  const goal = await getGoalRun(client, workspaceId, input.goalRunId);
  if (!goal) throw new Error(`reconcile_goal_action: goal run ${input.goalRunId} vanished`);
  const action = reconciled.actionRequest;
  const result: ReconcileGoalActionResultWire = {
    goalRunId: input.goalRunId,
    status: goal.status,
    changed: reconciled.changed,
    action: {
      actionRequestId: action.id,
      status: action.status,
      failureKind: action.failureKind,
      reconciliation: action.reconciliation,
      reconciliationDecisionId: action.reconciliationDecisionId,
      reexecuteDecisionId: action.reexecuteDecisionId,
    },
  };
  return { result, ...onRun(input.goalRunId) };
};
