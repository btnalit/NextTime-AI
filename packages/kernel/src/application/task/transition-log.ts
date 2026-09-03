import type { TaskStatus, WorkerRunStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import { enqueue } from '../../substrate/outbox/index.js';

/**
 * application/task/transition-log: the shared "record one Task/WorkerRun transition" helpers
 * every mutator in this module calls (design doc §5.4 I11, §7.10 domain events; docs/development-
 * tasks.md S2.7 "emit TaskUpdated/WorkerRunUpdated outbox events on every transition; audit (I11)
 * on every governed transition"). Same split-audit-row reasoning `governance/approval/
 * transition-log.ts`'s own doc comment gives: `dispatchCapability`'s own audit row (when a
 * transition happens to be reached through a capability call) documents "this capability was
 * called"; this row documents the *domain* transition itself — and for transitions reached from
 * the reaper or from `invoke.ts`'s own independently-committed sub-transactions (see that file's
 * doc comment on why it does not use `dispatchCapability`'s `client` at all), this is the *only*
 * audit/outbox write that will ever exist for that transition.
 */

export interface RecordTaskTransitionParams {
  readonly actorPrincipalId: string;
  readonly action: string;
  readonly taskId: string;
  readonly resultingStatus: TaskStatus;
  readonly extraAuditPayload?: Record<string, unknown>;
}

export async function recordTaskTransition(
  client: PoolClient,
  workspaceId: string,
  params: RecordTaskTransitionParams,
): Promise<void> {
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: params.actorPrincipalId,
    action: params.action,
    resourceType: 'task',
    resourceId: params.taskId,
    payload: { resultingStatus: params.resultingStatus, ...params.extraAuditPayload },
  });
  await enqueue(client, {
    type: 'TaskUpdated',
    workspaceId,
    taskId: params.taskId,
    status: params.resultingStatus,
  });
}

export interface RecordWorkerRunTransitionParams {
  readonly actorPrincipalId: string;
  readonly action: string;
  readonly workerRunId: string;
  readonly taskId: string;
  readonly resultingStatus: WorkerRunStatus;
  readonly extraAuditPayload?: Record<string, unknown>;
}

export async function recordWorkerRunTransition(
  client: PoolClient,
  workspaceId: string,
  params: RecordWorkerRunTransitionParams,
): Promise<void> {
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: params.actorPrincipalId,
    action: params.action,
    resourceType: 'worker_run',
    resourceId: params.workerRunId,
    payload: { resultingStatus: params.resultingStatus, ...params.extraAuditPayload },
  });
  await enqueue(client, {
    type: 'WorkerRunUpdated',
    workspaceId,
    workerRunId: params.workerRunId,
    taskId: params.taskId,
    status: params.resultingStatus,
  });
}
