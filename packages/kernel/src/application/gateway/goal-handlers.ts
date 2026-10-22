import {
  GOAL_LIST_DEFAULT_LIMIT,
  GOAL_LIST_MAX_LIMIT,
  type GoalAcceptanceCheckWire,
  type GoalAcceptanceRoundWire,
  type GoalAcceptanceWire,
  type GoalDetailWire,
  type GoalRunStatus,
  type GoalRunWire,
  type PlanRevisionSummaryWire,
  type PlanRevisionWire,
  type StepRunWire,
  type UnresolvedGoalActionWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { currentPrincipalId } from '../../application/chat/index.js';
import {
  type GoalAcceptanceCheckView,
  type GoalAcceptanceRoundView,
  type GoalAcceptanceView,
  type GoalRunDetail,
  type GoalRunStepView,
  type GoalRunSummary,
  type GoalViewer,
  type PlanRevisionRow,
  type PlanRevisionView,
  type UnresolvedGoalAction,
  listGoalRunUnresolvedActionsVisibleTo,
  listGoalRunsVisibleTo,
  readGoalRunDetail,
  readPlanRevisionVisibleTo,
} from '../../application/goal/index.js';
import type { CapabilityHandler, CapabilityHandlerContext } from './capability-handler.js';

/**
 * application/gateway/goal-handlers (S11 GO5a): the `goal` reads — `get_goal`, `list_goals`,
 * `get_goal_revision`, `list_goal_unresolved_actions` — and their projections onto
 * `@nexttime/shared`'s `wire/goal.ts`. Who may read a run is `application/goal`'s
 * (`views.ts`'s `goalVisibleTo`: the owner and the requester); on the handle channel the viewer is
 * the Handle's `obo`, who sees their own runs only, an owner too (`views.ts`).
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
    statement: goal.statement,
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

function toWirePlanRevisionSummary(row: PlanRevisionRow): PlanRevisionSummaryWire {
  return {
    id: row.id,
    goalRunId: row.goalRunId,
    revision: row.revision,
    status: row.status,
    basedOnRevision: row.basedOnRevision,
    proposedBy: row.proposedBy,
    reason: row.reason,
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
  };
}

function toWirePlanRevision(view: PlanRevisionView): PlanRevisionWire {
  return {
    ...toWirePlanRevisionSummary(view.revision),
    plan: view.plan,
    hints: view.hints.map((hint) => ({ code: hint.code, message: hint.message })),
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
    })),
    actions: view.actions.map((action) => ({
      actionRequestId: action.id,
      status: action.status,
      failureKind: action.failureKind,
      reconciliation: action.reconciliation,
    })),
  };
}

function toWireAcceptanceCheck(check: GoalAcceptanceCheckView): GoalAcceptanceCheckWire {
  return {
    checkKey: check.checkKey,
    kind: check.kind,
    status: check.status,
    check: check.check,
    fact: check.fact,
    prompt: check.prompt,
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
    revisions: detail.revisions.map(toWirePlanRevisionSummary),
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
