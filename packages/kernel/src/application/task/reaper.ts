import { TASK_TRANSITIONS, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { withWorkspace } from '../../adapters/db/pool.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { getActionRequest } from '../../governance/approval/index.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import {
  failTaskRow,
  reactToSupervisorStatus,
  readTaskRow,
  terminateWorkerRunRow,
} from './lifecycle.js';
import type { TaskRuntimeDeps } from './runtime.js';
import { taskForWorkerRun } from './service.js';
import { recordTaskTransition } from './transition-log.js';

/**
 * application/task/reaper: the interval-driven duration/status sweep, and the event-driven
 * ActionRequest → Task `waiting_approval` router (design doc §5.5 Task state machine "running ⇄
 * waiting_approval", §7.10 outbox; docs/development-tasks.md S2.7 "an ActionRequest created by a
 * child WorkerRun ... must route back to the parent Task ... consume ActionRequestPending/
 * ActionRequestUpdated outbox events — never import governance/approval internals for this").
 *
 * **Why this consumes events instead of importing `governance/approval` internals:** it doesn't
 * need to — `getActionRequest` is that module's own *public* read (`governance/approval/index.ts`,
 * re-exported from `reads.ts`), and every event this module subscribes to already carries the
 * `actionRequestId`/`workspaceId` needed to call it. `ActionRequestPendingEvent`/
 * `ActionRequestUpdatedEvent` (packages/shared/src/events.ts) do not themselves carry
 * `parentWorkerRunId` — re-reading the row via the public API rather than widening those wire
 * events is the deliberate choice (see `registerActionRequestRoutingConsumer`'s own doc comment).
 *
 * **Known simplification** (documented, not silently assumed): `ActionRequestUpdated` resumes the
 * Task unconditionally (`waiting_approval -> running`) as soon as *the one* ActionRequest that
 * triggered the event leaves `pending_approval` — it does not check whether some *other*
 * concurrently-pending ActionRequest for a different WorkerRun under the same Task is still
 * outstanding (there is no public `governance/approval` read for "every pending ActionRequest
 * under a set of WorkerRun ids" today, and inventing one is governance/approval's own call, not
 * this module's to make unilaterally). A Task with more than one concurrently pending approval is
 * not part of this task's acceptance criteria; the single-approval flow — the one actually tested
 * — is unaffected by this simplification.
 */

// -------------------------------------------------------------------------------------------
// waiting_approval routing (event-driven)
// -------------------------------------------------------------------------------------------

type ActionRequestEventType = 'ActionRequestPending' | 'ActionRequestUpdated';

export interface ActionRequestEventMeta {
  readonly outboxId: string;
  readonly workspaceId: string;
}

/**
 * The minimal slice of `OutboxDispatcher` this module needs — same narrowing intent
 * `application/host-bridge/turn-started-consumer.ts`'s `TurnStartedSource` already establishes,
 * but kept generic (rather than two overloaded non-generic signatures) so a real `OutboxDispatcher`
 * — whose own `subscribe<T extends PlatformEventName>` is itself generic — remains structurally
 * assignable here (TypeScript's overload-vs-generic-method assignability is stricter than its
 * generic-vs-generic one).
 */
export interface ActionRequestEventSource {
  subscribe<T extends ActionRequestEventType>(
    eventType: T,
    consumer: (
      event: Extract<DomainEvent, { type: T }>,
      meta: ActionRequestEventMeta,
    ) => Promise<void> | void,
  ): () => void;
}

async function moveTaskToWaitingApproval(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
  actorPrincipalId: string,
): Promise<void> {
  const task = await readTaskRow(client, workspaceId, taskId);
  if (!task || task.status !== 'running') return; // already waiting, or terminal — nothing to do.

  transition(TASK_TRANSITIONS, 'running', 'await_approval');
  await client.query(
    "update tasks set status = 'waiting_approval' where workspace_id = $1 and id = $2",
    [workspaceId, taskId],
  );
  await recordTaskTransition(client, workspaceId, {
    actorPrincipalId,
    action: 'task.await_approval',
    taskId,
    resultingStatus: 'waiting_approval',
  });
}

async function resumeTaskFromWaitingApproval(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
  actorPrincipalId: string,
): Promise<void> {
  const task = await readTaskRow(client, workspaceId, taskId);
  if (!task || task.status !== 'waiting_approval') return;

  transition(TASK_TRANSITIONS, 'waiting_approval', 'resume');
  await client.query("update tasks set status = 'running' where workspace_id = $1 and id = $2", [
    workspaceId,
    taskId,
  ]);
  await recordTaskTransition(client, workspaceId, {
    actorPrincipalId,
    action: 'task.resume',
    taskId,
    resultingStatus: 'running',
  });
}

/** Registers the ActionRequestPending/ActionRequestUpdated consumers on `dispatcher`. Returns a
 *  combined unsubscribe function. */
export function registerActionRequestRoutingConsumer(
  dispatcher: ActionRequestEventSource,
  deps: TaskRuntimeDeps,
): () => void {
  const unsubscribePending = dispatcher.subscribe('ActionRequestPending', async (event) => {
    // `action_requests` RLS is workspace-only (governance/0003_action_requests.sql) — `principalId`
    // is inert for read authorization here, same "pass a real, syntactically-valid uuid already on
    // hand" convention `interfaces/http/internal/llm-usage.ts`'s own doc comment establishes.
    const actionRequest = await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: event.actionRequestId },
      (client) => getActionRequest(client, event.workspaceId, event.actionRequestId),
    );
    if (!actionRequest?.parentWorkerRunId) return;

    await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: actionRequest.onBehalfOf },
      async (client) => {
        const task = await taskForWorkerRun(
          client,
          event.workspaceId,
          actionRequest.parentWorkerRunId as string,
        );
        if (!task) return;
        await moveTaskToWaitingApproval(
          client,
          event.workspaceId,
          task.id,
          actionRequest.onBehalfOf,
        );
      },
    );
  });

  const unsubscribeUpdated = dispatcher.subscribe('ActionRequestUpdated', async (event) => {
    if (event.status === 'pending_approval') return; // only resolution transitions matter here.

    const actionRequest = await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: event.actionRequestId },
      (client) => getActionRequest(client, event.workspaceId, event.actionRequestId),
    );
    if (!actionRequest?.parentWorkerRunId) return;

    await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: actionRequest.onBehalfOf },
      async (client) => {
        const task = await taskForWorkerRun(
          client,
          event.workspaceId,
          actionRequest.parentWorkerRunId as string,
        );
        if (!task) return;
        await resumeTaskFromWaitingApproval(
          client,
          event.workspaceId,
          task.id,
          actionRequest.onBehalfOf,
        );
      },
    );
  });

  return () => {
    unsubscribePending();
    unsubscribeUpdated();
  };
}

// -------------------------------------------------------------------------------------------
// interval scan: duration-limit enforcement (defense in depth alongside the supervisor's own
// `timeoutSec`) + opportunistic reaction to any WorkerRun the wait=true poll never caught up
// with (design doc §5.4 I18 "时长超限由 reaper 终止"; docs/development-tasks.md S2.7 "reaper
// (interval, wired into the composition root like the approval reaper): duration quota exceeded
// → terminate + failed: timeout").
// -------------------------------------------------------------------------------------------

interface ReapCandidateRow {
  workspace_id: string;
  worker_run_id: string;
  task_id: string;
  started_at: Date;
  on_behalf_of: string;
  duration_limit_sec: number | null;
}

export interface RunTaskReaperResult {
  readonly scanned: number;
  readonly timedOut: number;
}

const DEFAULT_DURATION_LIMIT_SEC = 3600;

/**
 * Scans every workspace for WorkerRuns not yet `terminated` (mirrors `governance/approval/
 * execution.ts`'s `expireOverduePendingApprovals`: one raw cross-workspace `SELECT`, no
 * `withWorkspace` — "exactly one kernel process, not one per workspace"), terminates + fails any
 * whose Task duration limit has elapsed, and otherwise asks `reactToSupervisorStatus` to react to
 * whatever the supervisor currently reports (exit/failure/requeue/timeout — see `lifecycle.ts`).
 * Call on an interval from the composition root, same shape as the approval reaper.
 */
export async function runTaskReaper(deps: TaskRuntimeDeps): Promise<RunTaskReaperResult> {
  const scanClient = await (deps.pool as PoolLike).connect();
  let candidates: readonly ReapCandidateRow[];
  try {
    const result = await scanClient.query<ReapCandidateRow>(
      `select wr.workspace_id, wr.id as worker_run_id, wr.task_id, wr.started_at,
              t.on_behalf_of, t.duration_limit_sec
       from worker_runs wr
       join tasks t on t.workspace_id = wr.workspace_id and t.id = wr.task_id
       where wr.status in ('provisioning', 'running', 'suspended')`,
    );
    candidates = result.rows;
  } finally {
    scanClient.release();
  }

  const now = (deps.now ?? (() => new Date()))().getTime();
  let timedOut = 0;

  for (const candidate of candidates) {
    const limitSec = candidate.duration_limit_sec ?? DEFAULT_DURATION_LIMIT_SEC;
    const elapsedMs = now - new Date(candidate.started_at).getTime();
    if (elapsedMs > limitSec * 1000) {
      timedOut += 1;
      await deps.supervisorClient.terminate(candidate.worker_run_id).catch(() => {});
      await withWorkspace(
        deps.pool,
        { workspaceId: candidate.workspace_id, principalId: candidate.on_behalf_of },
        async (client) => {
          await terminateWorkerRunRow(
            client,
            candidate.workspace_id,
            candidate.on_behalf_of,
            candidate.worker_run_id,
            'timeout',
          );
          await failTaskRow(
            client,
            candidate.workspace_id,
            candidate.on_behalf_of,
            candidate.task_id,
            'timeout',
          );
        },
      );
      continue;
    }

    await reactToSupervisorStatus(
      deps,
      candidate.workspace_id,
      candidate.on_behalf_of,
      candidate.worker_run_id,
    );
  }

  return { scanned: candidates.length, timedOut };
}
