import {
  TASK_TRANSITIONS,
  type TaskEvent,
  type TaskStatus,
  WORKER_RUN_TRANSITIONS,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { withWorkspace } from '../../adapters/db/pool.js';
import type { TaskSupervisorStatus } from '../../adapters/supervisor-client/index.js';
import { revokeSession } from '../../governance/capability/index.js';
import type { TaskRuntimeDeps } from './runtime.js';
import { spawnWorkerRun } from './spawn.js';
import { recordTaskTransition, recordWorkerRunTransition } from './transition-log.js';
import {
  TASK_ROW_COLUMNS,
  type TaskRow,
  WORKER_RUN_ROW_COLUMNS,
  type WorkerRunRow,
  mapTaskRow,
  mapWorkerRunRow,
} from './types.js';

/**
 * application/task/lifecycle: everything that reacts to a WorkerRun's life ending — crash
 * requeue, terminate (+ Handle revocation down the `parent_worker_run_id` tree), the S2.9 result-
 * contract seam, and the shared "ask the supervisor, react" step both `invoke.ts`'s `wait=true`
 * poll and `reaper.ts`'s interval scan call (design doc §5.5 Task/WorkerRun state machines;
 * docs/development-tasks.md S2.7 "on exit code 0 the Task completes only when S2.9's result
 * contract has been posted ... non-zero exit → requeue once, then failed; terminateTask revokes
 * the child Handle (and its descendants by par chain)").
 */

export async function readTaskRow(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
): Promise<TaskRow | null> {
  const result = await client.query(
    `select ${TASK_ROW_COLUMNS} from tasks where workspace_id = $1 and id = $2`,
    [workspaceId, taskId],
  );
  const row = result.rows[0];
  return row ? mapTaskRow(row) : null;
}

export async function readWorkerRunRow(
  client: PoolClient,
  workspaceId: string,
  workerRunId: string,
): Promise<WorkerRunRow | null> {
  const result = await client.query(
    `select ${WORKER_RUN_ROW_COLUMNS} from worker_runs where workspace_id = $1 and id = $2`,
    [workspaceId, workerRunId],
  );
  const row = result.rows[0];
  return row ? mapWorkerRunRow(row) : null;
}

/** Revokes `workerRunId`'s own Handle (its session's Handle(s), `governance/capability`'s
 *  `revokeSession`) and recursively every descendant WorkerRun's Handle (the `par` chain, walked
 *  via `worker_runs.parent_worker_run_id` — bounded by I18's depth ≤ 3, so this recursion is
 *  always shallow). Idempotent: revoking an already-revoked Handle is a no-op
 *  (`governance/capability/handles.ts`'s `revokeHandle`/`revokeSession` doc comments). */
export async function revokeWorkerRunAndDescendants(
  client: PoolClient,
  workspaceId: string,
  workerRunId: string,
): Promise<void> {
  const children = await client.query<{ id: string }>(
    'select id from worker_runs where workspace_id = $1 and parent_worker_run_id = $2',
    [workspaceId, workerRunId],
  );
  for (const child of children.rows) {
    await revokeWorkerRunAndDescendants(client, workspaceId, child.id);
  }

  const row = await readWorkerRunRow(client, workspaceId, workerRunId);
  if (row?.sessionId) {
    await revokeSession(client, row.sessionId);
  }
}

/** Transitions a WorkerRun to `terminated` (if it is not already there — a no-op, not an error,
 *  when it is: `terminate` a second time should never throw for the caller's convenience, matching
 *  `TaskSupervisorClientPort.terminate`'s own idempotency contract) and revokes its Handle tree.
 *  Does **not** touch the Task's own status — callers decide that separately (a terminated
 *  WorkerRun might be immediately requeued under the same Task, or might be the Task's final
 *  outcome). */
export async function terminateWorkerRunRow(
  client: PoolClient,
  workspaceId: string,
  actorPrincipalId: string,
  workerRunId: string,
  reason: string,
): Promise<void> {
  const row = await readWorkerRunRow(client, workspaceId, workerRunId);
  if (!row || row.status === 'terminated') {
    if (row) await revokeWorkerRunAndDescendants(client, workspaceId, workerRunId);
    return;
  }

  transition(WORKER_RUN_TRANSITIONS, row.status, 'terminate');
  await client.query(
    `update worker_runs set status = 'terminated', terminated_at = now()
     where workspace_id = $1 and id = $2`,
    [workspaceId, workerRunId],
  );
  await recordWorkerRunTransition(client, workspaceId, {
    actorPrincipalId,
    action: 'worker_run.terminate',
    workerRunId,
    taskId: row.taskId,
    resultingStatus: 'terminated',
    extraAuditPayload: { reason },
  });
  await revokeWorkerRunAndDescendants(client, workspaceId, workerRunId);
}

/** The real, if momentary, hop sequence from `status` to `running` — Task's own transition table
 *  only has a `fail` edge out of `running`, so a Task still `queued` (spawn itself failed) or
 *  `waiting_approval` (the reaper catches a timeout while awaiting approval) must walk through
 *  `running` first for the shared transition table to accept `fail` (I6: "只沿转移表走"), never
 *  externally observable as a separate persisted row state — same reasoning `governance/approval/
 *  request-action.ts`'s own doc comment gives for its own multi-hop resolution. `created` is
 *  unreachable in practice (`invoke_worker` always inserts a Task directly at `queued`, mirroring
 *  that same file's "single INSERT already at its resolved status" choice) but included for
 *  completeness/defense-in-depth. */
function pathToRunning(status: TaskStatus): readonly TaskEvent[] {
  switch (status) {
    case 'created':
      return ['queue', 'start'];
    case 'queued':
      return ['start'];
    case 'waiting_approval':
      return ['resume'];
    default:
      return [];
  }
}

/** Transitions a Task to `failed` with `failure_reason = reason`, unless it is already in a
 *  terminal status (`completed`/`failed`/`cancelled`) — idempotent for the same reasons
 *  `terminateWorkerRunRow` is. */
export async function failTaskRow(
  client: PoolClient,
  workspaceId: string,
  actorPrincipalId: string,
  taskId: string,
  reason: string,
): Promise<void> {
  const row = await readTaskRow(client, workspaceId, taskId);
  if (!row || row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
    return;
  }

  let cursor: TaskStatus = row.status;
  for (const event of pathToRunning(row.status)) {
    cursor = transition(TASK_TRANSITIONS, cursor, event);
  }
  transition(TASK_TRANSITIONS, cursor, 'fail');

  await client.query(
    `update tasks set status = 'failed', failed_at = now(), failure_reason = $3
     where workspace_id = $1 and id = $2`,
    [workspaceId, taskId, reason],
  );
  await recordTaskTransition(client, workspaceId, {
    actorPrincipalId,
    action: 'task.fail',
    taskId,
    resultingStatus: 'failed',
    extraAuditPayload: { failureReason: reason },
  });
}

/**
 * The S2.9 result-contract seam (docs/development-tasks.md S2.7 "leave a completeTaskWithResult
 * seam S2.9 will call"): transitions a `running` Task to `completed` and records
 * `result` (design doc §7.3 "Worker 结束时返回结构化结果 ... 内核把 facts_to_assert 以 inferred 状态
 * 写入..." — writing `facts_to_assert`/evidence/proposals from that result is S2.9's own job, not
 * this function's; this function only owns the Task row's own transition). Also terminates the
 * WorkerRun that produced the result (revoking its Handle) — a completed Task's WorkerRun has
 * nothing left to do. Throws `IllegalTransition` if the Task is not currently `running` (e.g.
 * called twice, or after the reaper already marked it `failed: no_result` — S2.9's own caller is
 * expected to race against that and accept the failure).
 */
export async function completeTaskWithResult(
  client: PoolClient,
  workspaceId: string,
  actorPrincipalId: string,
  taskId: string,
  workerRunId: string,
  result: unknown,
): Promise<TaskRow> {
  const row = await readTaskRow(client, workspaceId, taskId);
  if (!row)
    throw new Error(`completeTaskWithResult: no Task ${taskId} in workspace ${workspaceId}`);

  transition(TASK_TRANSITIONS, row.status, 'complete');
  const updateResult = await client.query(
    `update tasks set status = 'completed', completed_at = now(), result = $3::jsonb
     where workspace_id = $1 and id = $2
     returning ${TASK_ROW_COLUMNS}`,
    [workspaceId, taskId, JSON.stringify(result ?? null)],
  );
  const updated = updateResult.rows[0];
  if (!updated) throw new Error('completeTaskWithResult: UPDATE ... RETURNING produced no row');

  await recordTaskTransition(client, workspaceId, {
    actorPrincipalId,
    action: 'task.complete',
    taskId,
    resultingStatus: 'completed',
  });

  await terminateWorkerRunRow(client, workspaceId, actorPrincipalId, workerRunId, 'completed');

  return mapTaskRow(updated);
}

/**
 * Fetches `workerRunId`'s current supervisor status and reacts — the single reaction rule shared
 * by `invoke.ts`'s `wait=true` poll and `reaper.ts`'s interval scan:
 *
 *   - `running`   — no-op.
 *   - `exited` (exit code 0, no crash) — if the Task has not already been completed by S2.9's
 *     `completeTaskWithResult` seam, marks it `failed: no_result` (see that seam's own doc
 *     comment); always terminates the WorkerRun.
 *   - `failed` (non-zero exit) — requeues once (`task.retryCount < 1`: spawns a fresh WorkerRun
 *     under the same Task, attenuating from the *failed* WorkerRun's own already-granted scope —
 *     see `spawnWorkerRunForRetry` below) or, on a second failure, marks the Task
 *     `failed: worker_failed`.
 *   - `terminated` — marks the Task `failed: timeout` when `reason === 'timeout'` (the supervisor's
 *     own duration enforcement); a `reason === 'requested'` termination is assumed already handled
 *     by whoever called `terminateTask` (this function only ensures the Task does not stay stuck
 *     `running` forever if it was not).
 *
 * A `workerRunId` unknown to the supervisor (never spawned, or the supervisor itself restarted
 * without reconciling it) or already `terminated` on this side is a no-op — nothing to react to.
 */
export async function reactToSupervisorStatus(
  deps: TaskRuntimeDeps,
  workspaceId: string,
  onBehalfOf: string,
  workerRunId: string,
): Promise<void> {
  const workerRun = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: onBehalfOf },
    (client) => readWorkerRunRow(client, workspaceId, workerRunId),
  );
  if (!workerRun || workerRun.status === 'terminated') return;

  let status: TaskSupervisorStatus | undefined;
  try {
    status = await deps.supervisorClient.status(workerRunId);
  } catch {
    return; // transient supervisor/network error — the next poll/reaper tick retries.
  }
  if (!status || status.status === 'running') return;

  const task = await withWorkspace(deps.pool, { workspaceId, principalId: onBehalfOf }, (client) =>
    readTaskRow(client, workspaceId, workerRun.taskId),
  );
  if (!task) return;

  if (status.status === 'exited') {
    await withWorkspace(deps.pool, { workspaceId, principalId: onBehalfOf }, async (client) => {
      await terminateWorkerRunRow(client, workspaceId, onBehalfOf, workerRunId, 'exited');
      if (task.status === 'running') {
        await failTaskRow(client, workspaceId, onBehalfOf, task.id, 'no_result');
      }
    });
    return;
  }

  if (status.status === 'failed') {
    if (task.retryCount < 1) {
      await withWorkspace(deps.pool, { workspaceId, principalId: onBehalfOf }, async (client) => {
        await terminateWorkerRunRow(client, workspaceId, onBehalfOf, workerRunId, 'failed');
        await client.query(
          'update tasks set retry_count = retry_count + 1 where workspace_id = $1 and id = $2',
          [workspaceId, task.id],
        );
      });
      await spawnWorkerRunForRetry(deps, workspaceId, onBehalfOf, task, workerRun);
      return;
    }
    await withWorkspace(deps.pool, { workspaceId, principalId: onBehalfOf }, async (client) => {
      await terminateWorkerRunRow(client, workspaceId, onBehalfOf, workerRunId, 'failed');
      await failTaskRow(client, workspaceId, onBehalfOf, task.id, 'worker_failed');
    });
    return;
  }

  if (status.status === 'terminated') {
    await withWorkspace(deps.pool, { workspaceId, principalId: onBehalfOf }, async (client) => {
      await terminateWorkerRunRow(
        client,
        workspaceId,
        onBehalfOf,
        workerRunId,
        status.reason ?? 'terminated',
      );
      if (task.status === 'running' || task.status === 'waiting_approval') {
        await failTaskRow(
          client,
          workspaceId,
          onBehalfOf,
          task.id,
          status.reason === 'timeout' ? 'timeout' : 'terminated',
        );
      }
    });
  }
}

/** Reads the just-failed WorkerRun's own Handle scope (`capability_handles`, keyed by its
 *  session) and re-spawns under the same Task, attenuating from that already-granted scope — a
 *  requeue asks for nothing new, so there is no caller-side "declared needs" to re-resolve, and no
 *  risk of the retry silently gaining privilege the original invocation did not have. */
async function spawnWorkerRunForRetry(
  deps: TaskRuntimeDeps,
  workspaceId: string,
  onBehalfOf: string,
  task: TaskRow,
  failedWorkerRun: WorkerRunRow,
): Promise<void> {
  const handleRow = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: onBehalfOf },
    async (client) => {
      if (!failedWorkerRun.sessionId) return null;
      const result = await client.query<{ jti: string; expires_at: Date; scope: unknown }>(
        'select jti, expires_at, scope from capability_handles where workspace_id = $1 and session_id = $2 limit 1',
        [workspaceId, failedWorkerRun.sessionId],
      );
      return result.rows[0] ?? null;
    },
  );
  if (!handleRow) return; // nothing to attenuate from — leave the Task failed rather than guess.

  const scope = handleRow.scope as { capabilities: string[]; resources: Record<string, string[]> };

  try {
    await spawnWorkerRun(deps, workspaceId, {
      task,
      parentWorkerRunId: failedWorkerRun.parentWorkerRunId,
      depth: failedWorkerRun.depth,
      attempt: failedWorkerRun.attempt + 1,
      onBehalfOf,
      parentAuthority: scope,
      parentClaimsForLineage: {
        jti: handleRow.jti,
        exp: Math.floor(new Date(handleRow.expires_at).getTime() / 1000),
      },
      declaredCapabilities: scope.capabilities,
      declaredGates: scope.resources.gatekeeper ?? [],
    });
  } catch {
    await withWorkspace(deps.pool, { workspaceId, principalId: onBehalfOf }, (client) =>
      failTaskRow(client, workspaceId, onBehalfOf, task.id, 'worker_failed'),
    );
  }
}
