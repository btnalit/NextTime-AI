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
 * application/task/reaper: the interval-driven duration/status sweep, the S5.6 `queued`
 * crash-gap sweep (`reapLostQueuedTasks`, I-S5-3), and the event-driven ActionRequest → Task
 * `waiting_approval` router (design doc §5.5 Task state machine "running ⇄ waiting_approval",
 * §7.10 outbox; docs/development-tasks.md S2.7 "an ActionRequest created by a child WorkerRun
 * ... must route back to the parent Task ... consume ActionRequestPending/ActionRequestUpdated
 * outbox events — never import governance/approval internals for this"; S5.6 "`queued` 崩溃缺口:
 * reaper 的周期清扫加一条 ... 置 failed, failure_reason='spawn_lost' ... 不重新 spawn").
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

/** Exported for `reaper.test.ts`'s fake-PoolClient unit coverage of the P1-b hotfix (post-v0.16.0
 *  review, "task status race") — otherwise only reached indirectly through
 *  `registerActionRequestRoutingConsumer`'s event consumers below. */
export async function moveTaskToWaitingApproval(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
  actorPrincipalId: string,
): Promise<void> {
  const task = await readTaskRow(client, workspaceId, taskId);
  if (!task || task.status !== 'running') return; // already waiting, or terminal — nothing to do.

  transition(TASK_TRANSITIONS, 'running', 'await_approval');
  // Status-guarded UPDATE + rowCount (P1-b hotfix): guards against the same class of race
  // `lifecycle.ts`'s `completeTaskWithResult` closes — a concurrent writer (e.g. the WorkerRun
  // completing/failing between the read above and this UPDATE) may have already moved the Task
  // off `running`; `rowCount === 0` is a silent, safe no-op rather than forcing `waiting_approval`
  // onto a row that has moved on, and the audit/outbox write below only happens once the UPDATE
  // actually took effect.
  const updateResult = await client.query(
    "update tasks set status = 'waiting_approval' where workspace_id = $1 and id = $2 and status = 'running'",
    [workspaceId, taskId],
  );
  if ((updateResult.rowCount ?? 0) === 0) return;
  await recordTaskTransition(client, workspaceId, {
    actorPrincipalId,
    action: 'task.await_approval',
    taskId,
    resultingStatus: 'waiting_approval',
  });
}

/** Exported for `reaper.test.ts` — see `moveTaskToWaitingApproval`'s own doc comment. */
export async function resumeTaskFromWaitingApproval(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
  actorPrincipalId: string,
): Promise<void> {
  const task = await readTaskRow(client, workspaceId, taskId);
  if (!task || task.status !== 'waiting_approval') return;

  transition(TASK_TRANSITIONS, 'waiting_approval', 'resume');
  // Status-guarded UPDATE + rowCount (leftover 47's race, P1-b hotfix, post-v0.16.0 review): before
  // this guard, a Worker completing from `waiting_approval` (`lifecycle.ts`'s
  // `completeTaskWithResult`, which itself now guards on status too) could race this resume — an
  // `ActionRequestUpdated` event resolving concurrently — and this unconditional UPDATE would
  // revert an already-`completed` Task back to `running` forever. `rowCount === 0` means the row
  // was no longer `waiting_approval` by the time this ran; a safe no-op, and the audit/outbox row
  // is written only once the UPDATE actually took effect.
  const updateResult = await client.query(
    "update tasks set status = 'running' where workspace_id = $1 and id = $2 and status = 'waiting_approval'",
    [workspaceId, taskId],
  );
  if ((updateResult.rowCount ?? 0) === 0) return;
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
    // S5.6 leftover 30: only a Worker that is itself blocked on this decision (`await_decision:
    // true`, the gate tool polling inside `request-action-handler.ts`) parks its Task at
    // `waiting_approval`. With `await_decision: false` the gate tool returns `pending_approval`
    // at once and the Worker carries on normally — it must not be treated as blocked: this gate
    // is what keeps `lifecycle.ts`'s `reactToSupervisorStatus` (P1-6: no requeue-on-crash, straight
    // to `failed: no_result` on exit, both keyed off `waiting_approval`) from misfiring on an
    // ordinary still-running Worker just because *some* gate call of its returned
    // `pending_approval`. `completeTaskWithResult`'s own `waiting_approval` handling (leftover 47 —
    // it now hops through the existing `resume` edge rather than rejecting outright) means a
    // `report_task_result` call while genuinely parked here no longer loses the whole contract, but
    // that is orthogonal to this gate: an `await_decision: false` Task was never meant to be parked
    // at all, `complete`-edge or not. `governance/approval/await-decision.ts`: "await_decision=true
    // 时 Task 进 waiting_approval" — the field was never read here before.
    if (!actionRequest.awaitDecision) return;

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
  readonly spawnLost: number;
}

const DEFAULT_DURATION_LIMIT_SEC = 3600;

// -------------------------------------------------------------------------------------------
// queued spawn-lost sweep (S5.6 "崩溃缺口"; I-S5-3): `create_task` is retired (W5, 遗留 3) —
// `invoke_worker`'s own `insertQueuedTaskWithQuotaCheck` (invoke.ts) is the only INSERT that ever
// puts a Task at `queued`, and the very next thing that same call does is either spawn a
// WorkerRun and flip the row to `running`, or — on a caught spawn error — fail it synchronously
// in its own catch block. A Task genuinely observed `queued` is therefore either mid-flight
// (milliseconds) or the kernel process died between the INSERT committing and either of those two
// outcomes ever running — there is no third way for a `queued` row to persist. `updated_at`
// (defaulted `now()` at INSERT, never written again by any code path before the row leaves
// `queued` — same "never touched until the transition that matters" property `created_at` has)
// is therefore an exact proxy for "how long has this row been stuck", not merely a heuristic.
// -------------------------------------------------------------------------------------------

/** How stale a `queued` Task must be before this sweep gives up waiting for the crashed kernel's
 *  own in-flight spawn to ever resume — five times the reaper's own tick interval
 *  (`DEFAULT_TASK_REAPER_INTERVAL_MS`, packages/kernel/src/index.ts), comfortably past any
 *  legitimate insert→spawn gap and well under I-S5-3's own 5-minute alarm threshold
 *  (`substrate/audit/invariant-checks.ts`'s `checkIS53`) so this sweep is expected to resolve
 *  every such row long before that invariant would ever flag one. */
const QUEUED_SPAWN_LOST_THRESHOLD_MS = 60 * 1000;

interface LostQueuedTaskRow {
  workspace_id: string;
  id: string;
  on_behalf_of: string;
}

/**
 * Sweeps every workspace for a Task stuck `queued` past {@link QUEUED_SPAWN_LOST_THRESHOLD_MS}
 * and fails it — `failure_reason='spawn_lost'` — through the same governed path every other
 * sweep in this file uses (`failTaskRow`: the shared/transition-table hop, the `task.fail` audit
 * row, the `TaskUpdated` outbox event), never a bare `UPDATE`. Deliberately does **not** attempt
 * to re-spawn: whatever the crashed kernel was about to do (mint a Handle, call the supervisor)
 * is unrecoverable from here — the caller that originally invoked `invoke_worker` already got no
 * response and must decide on its own whether to retry, the same way any other `worker_failed`/
 * `timeout` Task failure is surfaced to it. Cross-workspace, one raw `SELECT` — same shape as the
 * duration-limit scan above (`runTaskReaper`'s own doc comment: "exactly one kernel process, not
 * one per workspace").
 */
async function reapLostQueuedTasks(deps: TaskRuntimeDeps): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - QUEUED_SPAWN_LOST_THRESHOLD_MS);

  const scanClient = await (deps.pool as PoolLike).connect();
  let candidates: readonly LostQueuedTaskRow[];
  try {
    const result = await scanClient.query<LostQueuedTaskRow>(
      `select workspace_id, id, on_behalf_of
       from tasks
       where status = 'queued' and updated_at < $1::timestamptz`,
      [cutoff.toISOString()],
    );
    candidates = result.rows;
  } finally {
    scanClient.release();
  }

  for (const candidate of candidates) {
    await withWorkspace(
      deps.pool,
      { workspaceId: candidate.workspace_id, principalId: candidate.on_behalf_of },
      (client) =>
        failTaskRow(
          client,
          candidate.workspace_id,
          candidate.on_behalf_of,
          candidate.id,
          'spawn_lost',
        ),
    );
  }

  return candidates.length;
}

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

  const spawnLost = await reapLostQueuedTasks(deps);

  return { scanned: candidates.length, timedOut, spawnLost };
}
