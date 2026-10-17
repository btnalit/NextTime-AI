import type {
  ActionRequestReconcileCheckStatus,
  ActionRequestReconciliation,
  StepRunStatus,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type ActionRequestRow,
  getActionRequest,
  listUnresolvedStepActions,
  readReconcileChecks,
  reconcileActionRequest,
} from '../../governance/approval/index.js';
import { markGoalRunDue } from './advancer.js';
import { getGoalRun, listStepRuns, lockStepRuns } from './reads.js';
import { GoalRunNotFoundError, GoalRunStateError, lockGoalRun } from './service.js';

/**
 * application/goal/reconcile (S11 GO3c; plan §3.3 I-G4, §4.7 "结果未知", §4.8): a person settles an
 * action of a goal step whose outcome is unknown — records what they found (`effect_seen`: it
 * counts as executed; `effect_absent`: no effect), and the requester may decide to run it again.
 * The capability that exposes it is GO5 (human channel only); like the other goal controls this runs
 * in the caller's transaction and enforces what a capability must not be able to skip.
 *
 * Lock order as everywhere under a goal: the GoalRun, its StepRuns, then the request's row
 * (`governance/approval`'s `reconcileActionRequest` locks it and records the Decisions).
 *
 * Who may, and when:
 *   - a **finding**: the requester or a workspace owner, as a person (checked by `governance` from
 *     `principals`, and again by the database guard, governance/0023) — whatever became of the goal:
 *     an action whose outcome is unknown under a cancelled or ended goal is still checked and
 *     recorded (the console lists them, {@link listGoalRunUnresolvedActions}). A held run takes one
 *     too: a finding runs nothing.
 *   - a **re-execute**: the requester alone, as a person, after (or with) `effect_absent`; only while
 *     the goal can still run (`running` or `paused`, held or not) and the step has not ended or been
 *     revised away. It only lets the step's next request with the same identity be a new
 *     ActionRequest — that request is evaluated by the policy and approved like any other (I-G4,
 *     `request-action.ts`).
 *
 * Then the run is set due in the same transaction, so the advance re-reads the step: a step
 * `waiting(reconcile)` is judged again (`disposition.ts`: `effect_seen` → executed,
 * `effect_absent` → a person decides, re-execute → a new attempt). The run itself stays paused
 * until the requester resumes it (`resumeGoalRun`) — also the `awaiting_reconcile` pause the
 * advancer set: a finding never resumes a run (review #493 on #642: a requester's pause laid over
 * the advancer's, or the pause a lifted hold leaves, is not told apart from it by `paused_by`, so
 * lifting it automatically would override a person). After `effect_absent` the requester's resume
 * pauses it `needs_decision` again until they decide to run the request again (or revise the plan).
 *
 * A finding that turns out wrong is never rewritten: `effect_absent` is answered by a re-execute or
 * a revision of the plan; `effect_seen` that did not happen shows in the step's acceptance (GO4)
 * and is answered by a revision that does the work again; a re-execute that should not run is
 * rejected at its approval.
 */

export interface ReconcileGoalActionInput {
  readonly goalRunId: string;
  readonly actionRequestId: string;
  /** Who decides. Their standing is read from `principals`, never taken from here. */
  readonly deciderPrincipalId: string;
  readonly verdict?: ActionRequestReconciliation;
  readonly reexecute?: boolean;
  readonly note?: string;
}

export interface ReconciledGoalAction {
  readonly actionRequest: ActionRequestRow;
  readonly changed: boolean;
}

const ENDED_STEP_STATUSES: ReadonlySet<StepRunStatus> = new Set([
  'succeeded',
  'superseded',
  'cancelled',
  'skipped',
]);

export async function reconcileGoalAction(
  client: PoolClient,
  workspaceId: string,
  input: ReconcileGoalActionInput,
): Promise<ReconciledGoalAction> {
  const goal = await lockGoalRun(client, workspaceId, input.goalRunId);
  if (!goal) throw new GoalRunNotFoundError(input.goalRunId);
  const steps = await lockStepRuns(client, workspaceId, goal.id);
  const request = await getActionRequest(client, workspaceId, input.actionRequestId);
  const step = request ? steps.find((s) => s.id === request.stepRunId) : undefined;
  if (!request || !step) {
    throw new GoalRunStateError(
      `ActionRequest ${input.actionRequestId} is not a request of goal run ${goal.id}`,
    );
  }
  if (input.reexecute && request.reexecuteDecisionId === null) {
    if (goal.status !== 'running' && goal.status !== 'paused') {
      throw new GoalRunStateError(
        `goal run ${goal.id} is ${goal.status}; a request is run again only in a run that can still run`,
      );
    }
    if (ENDED_STEP_STATUSES.has(step.status)) {
      throw new GoalRunStateError(
        `step ${step.stepKey} is ${step.status}; a request is run again only for a step still in the plan`,
      );
    }
  }
  const result = await reconcileActionRequest(client, workspaceId, {
    actionRequestId: request.id,
    deciderPrincipalId: input.deciderPrincipalId,
    ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
    ...(input.reexecute !== undefined ? { reexecute: input.reexecute } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    context: { goalRunId: goal.id },
  });
  if (result.changed) await markGoalRunDue(client, workspaceId, goal.id);
  return result;
}

/** S11 GO3c: an action of a goal run that still needs a person — `finding` (its outcome is unknown,
 *  nobody has recorded what they found) or `decision` (found `effect_absent`; re-execute it or
 *  change the plan — only while the run can still run and its step is still in the plan). */
export interface UnresolvedGoalAction {
  readonly actionRequestId: string;
  readonly stepRunId: string;
  readonly stepKey: string;
  readonly gatekeeperId: string;
  readonly actionKindTag: string;
  readonly failedAt: Date | null;
  readonly needs: 'finding' | 'decision';
  /** GO3d: the platform's check of the action, when its step declared one (`plan.ts`
   *  `reconcile`) — where it stands, how many attempts it made, and the short code of why it is
   *  `unavailable` or was retried. A `pending` one may still settle the finding itself. */
  readonly platformCheck: {
    readonly status: ActionRequestReconcileCheckStatus;
    readonly attempts: number;
    readonly lastError: string | null;
  } | null;
}

/** The actions of every step of `goalRunId` — revised away or cancelled ones included — whose
 *  outcome is unknown and that still need a person, whatever the run's status (#493 on #626: an
 *  action under a cancelled run is still checked). */
export async function listGoalRunUnresolvedActions(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly UnresolvedGoalAction[]> {
  const goal = await getGoalRun(client, workspaceId, goalRunId);
  if (!goal) throw new GoalRunNotFoundError(goalRunId);
  const steps = await listStepRuns(client, workspaceId, goalRunId);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const canRun = goal.status === 'running' || goal.status === 'paused';
  const rows = await listUnresolvedStepActions(client, workspaceId, [...byId.keys()]);
  const checks = await readReconcileChecks(
    client,
    workspaceId,
    rows.map((row) => row.id),
  );
  const unresolved: UnresolvedGoalAction[] = [];
  for (const row of rows) {
    const step = byId.get(row.stepRunId);
    if (!step) continue;
    const needs = row.reconciliation === null ? 'finding' : 'decision';
    if (needs === 'decision' && (!canRun || ENDED_STEP_STATUSES.has(step.status))) continue;
    const check = checks.get(row.id);
    unresolved.push({
      actionRequestId: row.id,
      stepRunId: row.stepRunId,
      stepKey: step.stepKey,
      gatekeeperId: row.gatekeeperId,
      actionKindTag: row.actionKindTag,
      failedAt: row.failedAt,
      needs,
      platformCheck: check
        ? { status: check.status, attempts: check.attempts, lastError: check.lastError }
        : null,
    });
  }
  return unresolved;
}
