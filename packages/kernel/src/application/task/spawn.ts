import { withWorkspace } from '../../adapters/db/pool.js';
import { TaskSupervisorError } from '../../adapters/supervisor-client/index.js';
import type { TaskSkillInlineMountInput } from '../../adapters/supervisor-client/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import {
  type MintWorkerRunHandleInput,
  type ParentAuthority,
  computeChildHandleScope,
  mintWorkerRunHandle,
} from './handle-mint.js';
import type { TaskRuntimeDeps } from './runtime.js';
import { recordWorkerRunTransition } from './transition-log.js';
import {
  type TaskRow,
  WORKER_RUN_ROW_COLUMNS,
  type WorkerRunRow,
  mapWorkerRunRow,
} from './types.js';

/**
 * application/task/spawn: `spawnWorkerRun` — creates one WorkerRun + its child Handle and calls
 * the supervisor (design doc §5.1.4, §5.5; docs/development-tasks.md S2.7). Split out of
 * `invoke.ts` into its own file so `lifecycle.ts` (the required-once, non-negotiable requeue path)
 * can import it without creating an `invoke.ts` ⇄ `lifecycle.ts` import cycle — `invoke.ts` itself
 * also imports this file for its own initial spawn, and separately imports `lifecycle.ts` for the
 * `wait=true` poll's `reactToSupervisorStatus` call; neither of those two ever needs to import the
 * other directly.
 */

/** A WorkerRun Handle's ttl is the Task's own duration limit plus this grace window, so the
 *  Worker can still finish reporting its result (S2.9) after its own deadline fires without its
 *  credential going stale mid-report. */
const HANDLE_TTL_GRACE_SECONDS = 300;

export interface SpawnWorkerRunInput {
  readonly task: TaskRow;
  readonly parentWorkerRunId: string | null;
  readonly depth: number;
  readonly attempt: number;
  readonly onBehalfOf: string;
  readonly parentAuthority: ParentAuthority;
  readonly parentClaimsForLineage: MintWorkerRunHandleInput['parentClaims'];
  readonly declaredCapabilities: readonly string[];
  readonly declaredGates: readonly string[];
  readonly requestedGates?: readonly string[];
  readonly model?: string;
  /** Pre-resolved by the caller (`invoke.ts`'s `resolveSkillsInline`, S2.14 deliverable 4) —
   *  mirrors `model` above: this function never re-derives it from the WorkerDefinition itself,
   *  it only ever forwards what it is given. `undefined` on the requeue path
   *  (`lifecycle.ts`'s `spawnWorkerRunForRetry`, which does not re-resolve `model` either — see
   *  that function's own doc comment for why a retry re-derives nothing beyond the already-granted
   *  Handle scope). */
  readonly skillsInline?: readonly TaskSkillInlineMountInput[];
}

/** Creates one WorkerRun row (`provisioning`), its `kind='worker_run'` Activity (S2.7 egress
 *  attribution seam), and its child Handle, all in one transaction; then — *outside* any
 *  transaction — calls the supervisor's `/task/spawn` and records the outcome in a second short
 *  transaction. Shared by `invoke.ts`'s initial spawn and `lifecycle.ts`'s requeue-once path.
 *  Returns the final `WorkerRunRow` (already `running` on success). Throws whatever the supervisor
 *  client throws (`TaskSupervisorError`) after marking the WorkerRun `terminated`/Task `failed` on
 *  a spawn failure — the caller decides what "failed to even start" means for the Task (initial
 *  spawn: fail immediately; requeue: no further retry). */
export async function spawnWorkerRun(
  deps: TaskRuntimeDeps,
  workspaceId: string,
  input: SpawnWorkerRunInput,
): Promise<WorkerRunRow> {
  const childScope = computeChildHandleScope({
    parentAuthority: input.parentAuthority,
    declaredCapabilities: input.declaredCapabilities,
    declaredGates: input.declaredGates,
    requestedGates: input.requestedGates,
  });

  const durationLimitSec = input.task.durationLimitSec ?? 3600;

  const created = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: input.onBehalfOf },
    async (client) => {
      const workerRunResult = await client.query(
        `insert into worker_runs (workspace_id, status, task_id, parent_worker_run_id, depth, attempt)
         values ($1, 'provisioning', $2, $3, $4, $5)
         returning ${WORKER_RUN_ROW_COLUMNS}`,
        [workspaceId, input.task.id, input.parentWorkerRunId, input.depth, input.attempt],
      );
      const row = workerRunResult.rows[0];
      if (!row) throw new Error('spawnWorkerRun: worker_runs INSERT ... RETURNING produced no row');
      let workerRun = mapWorkerRunRow(row);

      await recordWorkerRunTransition(client, workspaceId, {
        actorPrincipalId: input.onBehalfOf,
        action: 'worker_run.provision',
        workerRunId: workerRun.id,
        taskId: input.task.id,
        resultingStatus: 'provisioning',
      });

      const activity = await startActivity(client, workspaceId, {
        kind: 'worker_run',
        principalId: input.onBehalfOf,
        metadata: { taskId: input.task.id, workerRunId: workerRun.id },
      });
      await client.query(
        'update worker_runs set activity_id = $3 where workspace_id = $1 and id = $2',
        [workspaceId, workerRun.id, activity.id],
      );
      workerRun = { ...workerRun, activityId: activity.id };

      const issuedHandle = await mintWorkerRunHandle(client, workspaceId, {
        onBehalfOf: input.onBehalfOf,
        parentClaims: input.parentClaimsForLineage,
        scope: childScope,
        ttlSeconds: durationLimitSec + HANDLE_TTL_GRACE_SECONDS,
        privateKey: deps.privateKey,
      });
      await client.query(
        'update worker_runs set session_id = $3 where workspace_id = $1 and id = $2',
        [workspaceId, workerRun.id, issuedHandle.sessionId],
      );
      workerRun = { ...workerRun, sessionId: issuedHandle.sessionId };

      return { workerRun, handleToken: issuedHandle.token };
    },
  );

  let spawnOutcome: { containerId: string; ip: string | undefined };
  try {
    spawnOutcome = await deps.supervisorClient.spawn({
      taskId: input.task.id,
      workerRunId: created.workerRun.id,
      workspaceId,
      onBehalfOf: input.onBehalfOf,
      capabilityHandle: created.handleToken,
      model: input.model,
      skillsInline: input.skillsInline,
      timeoutSec: durationLimitSec,
    });
  } catch (err) {
    await withWorkspace(
      deps.pool,
      { workspaceId, principalId: input.onBehalfOf },
      async (client) => {
        await client.query(
          `update worker_runs set status = 'terminated', terminated_at = now()
         where workspace_id = $1 and id = $2`,
          [workspaceId, created.workerRun.id],
        );
        await recordWorkerRunTransition(client, workspaceId, {
          actorPrincipalId: input.onBehalfOf,
          action: 'worker_run.spawn_failed',
          workerRunId: created.workerRun.id,
          taskId: input.task.id,
          resultingStatus: 'terminated',
          extraAuditPayload: {
            reason: err instanceof TaskSupervisorError ? err.kind : 'unknown',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      },
    );
    throw err;
  }

  return withWorkspace(
    deps.pool,
    { workspaceId, principalId: input.onBehalfOf },
    async (client) => {
      await client.query(
        `update worker_runs set status = 'running', container_id = $3
       where workspace_id = $1 and id = $2`,
        [workspaceId, created.workerRun.id, spawnOutcome.containerId],
      );
      await recordWorkerRunTransition(client, workspaceId, {
        actorPrincipalId: input.onBehalfOf,
        action: 'worker_run.start',
        workerRunId: created.workerRun.id,
        taskId: input.task.id,
        resultingStatus: 'running',
      });
      return {
        ...created.workerRun,
        status: 'running' as const,
        containerId: spawnOutcome.containerId,
      };
    },
  );
}
