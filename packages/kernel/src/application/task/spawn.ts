import { withWorkspace } from '../../adapters/db/pool.js';
import { TaskSupervisorError } from '../../adapters/supervisor-client/index.js';
import type { TaskSkillInlineMountInput } from '../../adapters/supervisor-client/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { ensureWorkerAgentPrincipal } from './agent-principal.js';
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
  /** P-A2: the composed Worker system prompt (WorkerDefinition `systemPrompt` + platform
   *  `instanceInstructions`, `application/platform`'s `composeSystemPrompt`) — resolved by the
   *  callers (`invoke.ts`, `lifecycle.ts`), forwarded verbatim to `/task/spawn`. */
  readonly systemPrompt?: string;
  /** The WorkerDefinition's own human-readable `definition.name` (packages/shared/src/
   *  worker-definition.ts), or the WorkerDefinition id when it declared none — passed to
   *  `ensureWorkerAgentPrincipal`'s `display_name` (`worker:<definitionName>`) below. Resolved by
   *  the caller (`invoke.ts`'s initial spawn, `lifecycle.ts`'s requeue), not re-derived here, same
   *  convention `model`/`skillsInline` already follow. */
  readonly definitionName: string;
  /** Pre-resolved by the caller (`definition-content.ts`'s `resolveSkillsInline`, S2.14
   *  deliverable 4) — mirrors `model` above: this function never re-derives it from the
   *  WorkerDefinition itself, it only ever forwards what it is given. On the requeue path
   *  (`lifecycle.ts`'s `spawnWorkerRunForRetry`), both `model` and `skillsInline` are re-resolved
   *  from the Task's own *pinned* WorkerDefinition (P2-10 fix — see that function's own doc
   *  comment for why `getWorkerDefinition`, not `requirePublishedWorkerDefinition`); everything
   *  else about the retry (capabilities/gates/authority) still comes from the failed WorkerRun's
   *  own already-granted Handle scope, never re-derived. */
  readonly skillsInline?: readonly TaskSkillInlineMountInput[];
  /** feat/egress-definition-lists: the invoked WorkerDefinition's own `egressDeny`
   *  (`definition-content.ts`'s `WorkerDefinitionContentShape`), resolved by the caller
   *  (`invoke.ts`'s initial spawn, `lifecycle.ts`'s requeue — same convention `model`/
   *  `skillsInline` above already follow) and forwarded verbatim to the supervisor's `/task/spawn`
   *  — never re-derived here. */
  readonly egressDeny?: readonly string[];
  /** S7-E (P-C §6.5 决定 E1): the platform's active runtime image (`PlatformSettings.
   *  activeRuntimeImage`), resolved by the caller (`invoke.ts`'s initial spawn, `lifecycle.ts`'s
   *  requeue) and forwarded verbatim to `/task/spawn`. `undefined` leaves worker-supervisor's own
   *  `WORKER_IMAGE` env default in effect, unchanged from before this field existed. */
  readonly image?: string;
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
      // One agent principal per (workspace, WorkerDefinition) — resolved/created idempotently
      // before the WorkerRun row exists so its id can be stamped on the row in the same INSERT
      // (agent-principal.ts's own doc comment has the full "why this identity, why not per-run"
      // rationale). `task.workerDefinitionId` is the stable identity across versions.
      const agentPrincipalId = await ensureWorkerAgentPrincipal(
        client,
        workspaceId,
        input.task.workerDefinitionId,
        input.definitionName,
      );

      const workerRunResult = await client.query(
        `insert into worker_runs (
           workspace_id, status, task_id, parent_worker_run_id, depth, attempt, agent_principal_id
         )
         values ($1, 'provisioning', $2, $3, $4, $5, $6)
         returning ${WORKER_RUN_ROW_COLUMNS}`,
        [
          workspaceId,
          input.task.id,
          input.parentWorkerRunId,
          input.depth,
          input.attempt,
          agentPrincipalId,
        ],
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
      egressDeny: input.egressDeny,
      systemPrompt: input.systemPrompt,
      image: input.image,
    });
  } catch (err) {
    await withWorkspace(
      deps.pool,
      { workspaceId, principalId: input.onBehalfOf },
      async (client) => {
        // Status-guarded UPDATE + rowCount (leftover 90, docs/STATUS.md §4 — same race class
        // leftover 67 guarded for `tasks`, #293): `created.workerRun` is only ever `provisioning`
        // here — this catch only fires when `deps.supervisorClient.spawn()` above threw, before
        // this function ever had a chance to move the row to `running` itself, and
        // `WORKER_RUN_TRANSITIONS` (packages/shared/src/transitions.ts) has no edge back into
        // `provisioning` from anywhere, so nothing else could have moved it there either. A
        // concurrent `terminate` (a parent Task cancel racing this in-flight supervisor call, or
        // `lifecycle.ts`'s own `terminateWorkerRunRow` — itself now guarded the same way, see that
        // function) can already have moved the row to `terminated`; condition on `status =
        // 'provisioning'` so a losing race is a silent no-op — never a second write over whatever
        // terminal state the row already reached — and skip the transition record too. The
        // original spawn error is rethrown either way: a failed-and-already-terminated run still
        // means this call never produced a usable WorkerRun.
        const updateResult = await client.query(
          `update worker_runs set status = 'terminated', terminated_at = now()
         where workspace_id = $1 and id = $2 and status = 'provisioning'`,
          [workspaceId, created.workerRun.id],
        );
        if ((updateResult.rowCount ?? 0) === 0) return;
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
      // Status-guarded UPDATE + rowCount (leftover 90, docs/STATUS.md §4 — same race class
      // leftover 67 guarded for `tasks`, #293): condition on `status = 'provisioning'`, the only
      // status this freshly created row can legitimately still be in here — `WORKER_RUN_TRANSITIONS`
      // `start` edge (packages/shared/src/transitions.ts) is only legal from `provisioning`. A
      // concurrent `terminate` (a parent Task cancel, or `lifecycle.ts`'s own
      // `terminateWorkerRunRow` — itself now guarded the same way, see that function) racing this
      // very `deps.supervisorClient.spawn()` call above can already have moved the row to
      // `terminated`.
      const updateResult = await client.query(
        `update worker_runs set status = 'running', container_id = $3
       where workspace_id = $1 and id = $2 and status = 'provisioning'`,
        [workspaceId, created.workerRun.id, spawnOutcome.containerId],
      );
      if ((updateResult.rowCount ?? 0) === 0) {
        // Lost the race: the run was already terminated by the time the supervisor confirmed the
        // spawn, so the container it just started is orphaned — nothing under this now-terminal
        // WorkerRun will ever poll or reap it on its own. Best-effort stop it through the same
        // supervisor client that spawned it, same `.terminate(workerRunId).catch(...)`-style
        // "never let cleanup itself fail the caller" convention `reaper.ts`/`service.ts` already use
        // for every other supervisor-side terminate.
        try {
          const stopped = await deps.supervisorClient.terminate(created.workerRun.id);
          if (!stopped) {
            console.warn(
              `spawnWorkerRun: lost the running-write race for WorkerRun ${created.workerRun.id} (container ${spawnOutcome.containerId}) and the supervisor did not confirm the stop — it may be orphaned until the reaper duration-limit sweep or a manual check reclaims it`,
            );
          }
        } catch {
          console.warn(
            `spawnWorkerRun: lost the running-write race for WorkerRun ${created.workerRun.id} (container ${spawnOutcome.containerId}) and the best-effort supervisorClient.terminate call itself failed — it may be orphaned until the reaper duration-limit sweep or a manual check reclaims it`,
          );
        }
        // Never throw here — the run reached its terminal status through a legitimate concurrent
        // actor (a cancel/terminate), not because this spawn failed. The callers
        // (`invoke.ts`'s own guarded `queued -> running` UPDATE, `lifecycle.ts`'s requeue path) are
        // themselves conditioned on the Task's prior status and will no-op the same way when it has
        // moved on — throwing here instead would make an intentionally-cancelled Task look exactly
        // like a spawn failure.
        const reread = await client.query(
          `select ${WORKER_RUN_ROW_COLUMNS} from worker_runs where workspace_id = $1 and id = $2`,
          [workspaceId, created.workerRun.id],
        );
        const row = reread.rows[0];
        return row ? mapWorkerRunRow(row) : { ...created.workerRun, status: 'terminated' as const };
      }
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
