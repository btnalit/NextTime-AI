import { IllegalTransition, TASK_TRANSITIONS, storableText } from '@nexttime/shared';
import { withWorkspace } from '../../adapters/db/pool.js';
import { TaskSupervisorError } from '../../adapters/supervisor-client/index.js';
import type {
  TaskSkillInlineMountInput,
  TaskSpawnOutcome,
  TaskUpstreamFilesInput,
} from '../../adapters/supervisor-client/index.js';
import { revokeSession } from '../../governance/capability/index.js';
import { currentCorrelationId } from '../../substrate/correlation/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import {
  EvaluationContentWithheldError,
  EvaluationProbeHoldError,
  assertNoSealHold,
  recordEvaluationWithheld,
  recordProbeHoldRefusal,
  sealWithholds,
} from '../eval-seal/index.js';
import { ensureWorkerAgentPrincipal } from './agent-principal.js';
import type { LoadedSkillRef } from './definition-content.js';
import {
  type MintWorkerRunHandleInput,
  type ParentAuthority,
  computeChildHandleScope,
  mintWorkerRunHandle,
} from './handle-mint.js';
import {
  type RunRuntimeReport,
  buildRunSpec,
  environmentDigest,
  toRunRuntimeReport,
} from './run-fingerprint.js';
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
  /** S10 E1: the Skill versions `skillsInline` was rendered from (`definition-content.ts`'s
   *  `resolveSkillsInline`, same caller-resolved convention). Written to `worker_run_skills` in the
   *  transaction that creates the WorkerRun, which is also marked `skills_recorded` — so a run's
   *  Skill record exists exactly when the run does. Omitted = none loaded (still recorded). */
  readonly loadedSkills?: readonly LoadedSkillRef[];
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
  /** S11 GO14: set for a goal step's attempt Task only (`step-attempt.ts`) — the goal run it works
   *  for, so worker-supervisor makes its handoff directory and owner marker. */
  readonly goalRunId?: string;
  /** S11 GO14: the earlier steps' handoff directories this attempt mounts (the step's
   *  `filesFrom`, each one's accepted attempt — `application/goal/step-files.ts`). */
  readonly upstream?: readonly TaskUpstreamFilesInput[];
}

/** Creates one WorkerRun row (`provisioning`), its `kind='worker_run'` Activity (S2.7 egress
 *  attribution seam), and its child Handle, all in one transaction; then — *outside* any
 *  transaction — calls the supervisor's `/task/spawn` and records the outcome in a second short
 *  transaction. Shared by `invoke.ts`'s initial spawn and `lifecycle.ts`'s requeue-once path.
 *  Returns the final `WorkerRunRow` (already `running` on success). Throws whatever the supervisor
 *  client throws (`TaskSupervisorError`) after marking the WorkerRun `terminated` and revoking its
 *  Handle on a spawn failure — the caller decides what "failed to even start" means for the Task
 *  (initial spawn: `spawn_failed`; requeue: `worker_failed`, no further retry) and fails it through
 *  `lifecycle.ts`'s `failTaskAndReapWorkerRuns` (R-09), which also best-effort stops a container
 *  the supervisor may have started after the client gave up. Throws `IllegalTransition` before
 *  creating anything when the Task is already terminal (R-58). */
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

  // S11 W1a (run-fingerprint.ts): the kernel's half of what this run runs with — from exactly what
  // is forwarded to the supervisor below, recorded with the run itself.
  const runSpec = buildRunSpec({
    definitionId: input.task.workerDefinitionId,
    definitionVersion: input.task.workerDefinitionVersion,
    model: input.model,
    image: input.image,
    systemPrompt: input.systemPrompt,
  });

  const created = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: input.onBehalfOf },
    async (client) => {
      // 2026-10-02 review R-58: never start a WorkerRun under a Task that is already terminal. The
      // caller read `input.task` earlier (`invoke.ts`'s initial spawn sees it `queued`,
      // `lifecycle.ts`'s crash retry `running`), and a cancel may have landed since. Checked before
      // anything is created or the supervisor is called; both callers handle the throw through
      // `failTaskAndReapWorkerRuns`, which leaves an already-terminal Task as it is.
      // `for share`: a cancel whose UPDATE is in flight makes this read wait for it, so it sees
      // `cancelled` rather than the stale `running`; and a cancel that starts after this read
      // waits for this transaction, so `terminateTask`'s sweep (after its cancel commits) finds
      // the WorkerRun created below and terminates it. Without the lock a spawn that read
      // `running` could commit its WorkerRun after that sweep and run under a cancelled Task.
      const taskResult = await client.query<{ status: string }>(
        'select status from tasks where workspace_id = $1 and id = $2 for share',
        [workspaceId, input.task.id],
      );
      const taskStatus = taskResult.rows[0]?.status;
      if (
        taskStatus === undefined ||
        taskStatus === 'completed' ||
        taskStatus === 'failed' ||
        taskStatus === 'cancelled'
      ) {
        throw new IllegalTransition(TASK_TRANSITIONS.machine, taskStatus ?? 'missing', 'start');
      }

      // S10 E3-2c (legacy 514): no Worker starts for a Principal the evaluation seal has paused
      // (application/eval-seal hold.ts) — before anything is created, like the seal below.
      await assertNoSealHold(client, workspaceId, input.onBehalfOf);

      // S10 E3-1c (I-E4): a Worker never starts with evaluation content — what it is handed (its
      // Task input; the system prompt and Skills forwarded to the supervisor below) carrying a
      // suite's canary or a verbatim run of a holdout case's text. Checked before anything is
      // created, so the refusal leaves nothing behind; every caller then fails the Task as for any
      // other failed start. Covers the initial spawn and the requeue alike.
      // S10 E3-2a: an evaluation Task's input is its case's input — its Worker is meant to read it,
      // held out or not; everything else is checked as for any Worker.
      if (
        await sealWithholds(
          client,
          workspaceId,
          {
            input: input.task.input,
            systemPrompt: input.systemPrompt,
            skillsInline: input.skillsInline,
          },
          input.task.purpose === 'evaluation' ? { allow: input.task.input } : {},
        )
      ) {
        throw new EvaluationContentWithheldError('worker_start');
      }

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
           workspace_id, status, task_id, parent_worker_run_id, depth, attempt, agent_principal_id,
           skills_recorded, run_spec
         )
         values ($1, 'provisioning', $2, $3, $4, $5, $6, true, $7::jsonb)
         returning ${WORKER_RUN_ROW_COLUMNS}`,
        [
          workspaceId,
          input.task.id,
          input.parentWorkerRunId,
          input.depth,
          input.attempt,
          agentPrincipalId,
          JSON.stringify(runSpec),
        ],
      );
      const row = workerRunResult.rows[0];
      if (!row) throw new Error('spawnWorkerRun: worker_runs INSERT ... RETURNING produced no row');
      let workerRun = mapWorkerRunRow(row);

      // S10 E1 (`WorkerRun loaded SkillVersion`, migrations/worker/0004): what this run mounts,
      // in the same transaction as the run itself.
      const loadedSkills = input.loadedSkills ?? [];
      if (loadedSkills.length > 0) {
        await client.query(
          `insert into worker_run_skills (workspace_id, worker_run_id, skill_id, skill_version)
           select $1, $2, s.skill_id, s.skill_version
           from unnest($3::uuid[], $4::int[]) as s(skill_id, skill_version)`,
          [
            workspaceId,
            workerRun.id,
            loadedSkills.map((skill) => skill.skillId),
            loadedSkills.map((skill) => skill.version),
          ],
        );
      }

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
  ).catch(async (err: unknown) => {
    // The seal's audit row, in its own transaction (this one rolled back). Marked recorded, so a
    // dispatch the refusal passes back through does not write a second.
    if (err instanceof EvaluationContentWithheldError && !err.recorded) {
      err.recorded = true;
      await recordEvaluationWithheld(deps.pool, {
        workspaceId,
        principalId: input.onBehalfOf,
        where: err.where,
        taskId: input.task.id,
      });
    }
    if (err instanceof EvaluationProbeHoldError && !err.recorded) {
      err.recorded = true;
      await recordProbeHoldRefusal(deps.pool, {
        workspaceId,
        principalId: input.onBehalfOf,
        path: 'worker_start',
        taskId: input.task.id,
      });
    }
    throw err;
  });

  // Leftover 87: the id this WorkerRun inherits (worker-supervisor puts it into the container's
  // `NEXTTIME_CORRELATION_ID`, the Worker's platform extension sends it on every kernel call): the
  // id of the call doing this spawn — for an entry agent's `invoke_worker` that is its Turn id, for
  // a Worker's own `invoke_worker` the id it inherited — else, on the reaper's requeue path (no
  // inbound call), the Task's generating Turn (`created_by_activity_id`). Never placed in the Handle.
  const correlationId = currentCorrelationId() ?? input.task.createdByActivityId ?? undefined;

  let spawnOutcome: TaskSpawnOutcome;
  try {
    spawnOutcome = await deps.supervisorClient.spawn(
      {
        taskId: input.task.id,
        workerRunId: created.workerRun.id,
        workspaceId,
        onBehalfOf: input.onBehalfOf,
        capabilityHandle: created.handleToken,
        model: input.model,
        skillsInline: input.skillsInline,
        timeoutSec: durationLimitSec,
        egressDeny: input.egressDeny,
        // S10 E3-2a: from what the Task is for, whoever spawns it (the trial runner today). S11
        // GO9a: a goal planner observes nothing and only reports (`planning-task.ts`), so it has
        // no egress either.
        ...(input.task.purpose === 'evaluation' || input.task.purpose === 'planning'
          ? { egressDenyAll: true }
          : {}),
        systemPrompt: input.systemPrompt,
        image: input.image,
        ...(input.goalRunId !== undefined ? { goalRunId: input.goalRunId } : {}),
        ...(input.upstream && input.upstream.length > 0 ? { upstream: input.upstream } : {}),
      },
      { correlationId },
    );
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
        // R-09 (§5.5 "terminated revokes every Handle"): revoke this run's own Handle in the same
        // transaction that makes it `terminated` — even when the guarded UPDATE above lost
        // (revocation is idempotent). A client timeout does not mean the supervisor stopped: it
        // may still start the container with this Handle in its env. The caller's
        // `failTaskAndReapWorkerRuns` (lifecycle.ts) then revokes any descendants and best-effort
        // stops the container; revoking here as well means a kernel crash between the two
        // transactions cannot leave a terminated run with a live Handle (on the requeue path the
        // Task is not `queued`, so the `spawn_lost` sweep would never revisit it).
        if (created.workerRun.sessionId) {
          await revokeSession(client, created.workerRun.sessionId);
        }
        if ((updateResult.rowCount ?? 0) === 0) return;
        await recordWorkerRunTransition(client, workspaceId, {
          actorPrincipalId: input.onBehalfOf,
          action: 'worker_run.spawn_failed',
          workerRunId: created.workerRun.id,
          taskId: input.task.id,
          resultingStatus: 'terminated',
          extraAuditPayload: {
            reason: err instanceof TaskSupervisorError ? err.kind : 'unknown',
            // Legacy 320: the supervisor's text — stored with U+0000 as the visible `\u{0}`, so
            // this cleanup cannot fail on it and leave the run `provisioning`.
            message: storableText(err instanceof Error ? err.message : String(err)),
          },
        });
      },
    );
    throw err;
  }

  // S11 W1a: the supervisor's half — what the container it started actually runs. A supervisor
  // that reported nothing leaves both unrecorded.
  const runtimeReport: RunRuntimeReport | null = spawnOutcome.runtime
    ? toRunRuntimeReport(spawnOutcome.runtime)
    : null;
  const runEnvironmentDigest = environmentDigest(runSpec, runtimeReport);

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
      // The runtime is recorded in this same UPDATE: migrations/task/0009 accepts it only with the
      // run's `provisioning → running`, and a run terminated first keeps none.
      const updateResult = await client.query(
        `update worker_runs set status = 'running', container_id = $3, runtime_report = $4::jsonb,
           environment_digest = $5
       where workspace_id = $1 and id = $2 and status = 'provisioning'`,
        [
          workspaceId,
          created.workerRun.id,
          spawnOutcome.containerId,
          runtimeReport === null ? null : JSON.stringify(runtimeReport),
          runEnvironmentDigest,
        ],
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
