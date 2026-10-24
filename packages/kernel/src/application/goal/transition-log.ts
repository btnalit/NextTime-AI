import type { GoalRunChange, GoalRunStatus, StepRunStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import { enqueue } from '../../substrate/outbox/index.js';

/**
 * application/goal/transition-log (S11 GO2, plan §4.2 item 5): "record one GoalRun / StepRun
 * transition" — the audit record and the outbox event, written in the transaction that moves the
 * row, by every writer in this module. Same split as `application/task/transition-log.ts`: the
 * audit row documents the domain transition itself; a capability call that caused it (GO5) has its
 * own row under the capability's name.
 *
 * The actor is the principal the change is made for: the requester for the advancer's moves (a
 * GoalRun acts on the requester's behalf, with their authority), the person for their own
 * decisions. `by: 'advancer'` in the payload tells the advancer's moves from a person's.
 */

export interface RecordGoalRunTransitionParams {
  readonly actorPrincipalId: string;
  /** What happened (`GoalRunChange`): the audit action is `goal_run.<change>`, and the event
   *  carries it (S11 GO5e-2). */
  readonly change: GoalRunChange;
  readonly goalRunId: string;
  readonly resultingStatus: GoalRunStatus;
  readonly extraAuditPayload?: Record<string, unknown>;
}

export async function recordGoalRunTransition(
  client: PoolClient,
  workspaceId: string,
  params: RecordGoalRunTransitionParams,
): Promise<void> {
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: params.actorPrincipalId,
    action: `goal_run.${params.change}`,
    resourceType: 'goal_run',
    resourceId: params.goalRunId,
    payload: { resultingStatus: params.resultingStatus, ...params.extraAuditPayload },
  });
  await enqueue(client, {
    type: 'GoalRunUpdated',
    workspaceId,
    goalRunId: params.goalRunId,
    status: params.resultingStatus,
    change: params.change,
  });
}

export interface RecordStepRunTransitionParams {
  readonly actorPrincipalId: string;
  readonly action: string;
  readonly goalRunId: string;
  readonly stepRunId: string;
  readonly resultingStatus: StepRunStatus;
  readonly extraAuditPayload?: Record<string, unknown>;
}

export async function recordStepRunTransition(
  client: PoolClient,
  workspaceId: string,
  params: RecordStepRunTransitionParams,
): Promise<void> {
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: params.actorPrincipalId,
    action: params.action,
    resourceType: 'step_run',
    resourceId: params.stepRunId,
    payload: {
      resultingStatus: params.resultingStatus,
      goalRunId: params.goalRunId,
      ...params.extraAuditPayload,
    },
  });
  await enqueue(client, {
    type: 'StepRunUpdated',
    workspaceId,
    goalRunId: params.goalRunId,
    stepRunId: params.stepRunId,
    status: params.resultingStatus,
  });
}
