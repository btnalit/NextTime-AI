import { INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS } from '@nexttime/shared';
import type { CapabilityChannel, HandleClaims } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { withWorkspace } from '../../adapters/db/pool.js';
import { readEffectiveAgentProfile } from '../../governance/agent-profile/index.js';
import { WORKER_CEILING_CAPABILITIES } from '../../governance/capability/index.js';
import { sumTodayCostUsd } from '../../governance/llm-usage/index.js';
import { requirePublishedWorkerDefinition } from '../worker/index.js';
import { readDefinitionContent, resolveSkillsInline } from './definition-content.js';
import {
  computeChildHandleScope,
  defaultWorkerCapabilities,
  resolveParentAuthority,
} from './handle-mint.js';
import type { MintWorkerRunHandleInput } from './handle-mint.js';
import { reactToSupervisorStatus } from './lifecycle.js';
import { HARD_MAX_DEPTH, resolveQuotas } from './quotas.js';
import type { TaskRuntimeDeps } from './runtime.js';
import { spawnWorkerRun } from './spawn.js';
import { recordTaskTransition } from './transition-log.js';
import {
  InvokeWorkerValidationError,
  QuotaExceededError,
  TASK_ROW_COLUMNS,
  type TaskRow,
  WORKER_RUN_ROW_COLUMNS,
  type WorkerRunRow,
  mapTaskRow,
  mapWorkerRunRow,
} from './types.js';

/**
 * application/task/invoke: `invoke_worker` (design doc §5.1.4 "invoke_worker(definition@version,
 * input, wait, timeout) → result | task_id", §8.1/§8.2, §5.4 I18; docs/development-tasks.md S2.7).
 *
 * **Why this module never uses the `client`/transaction `application/gateway/dispatch.ts`'s
 * `dispatchCapability` opens for the capability call:** every other capability handler in this
 * codebase does its work inside that one transaction, which commits only after the handler
 * returns. `invoke_worker` cannot: it mints a CapabilityHandle the spawned Worker container must
 * be able to *use immediately* (its very first API call back to the kernel verifies that Handle
 * against `capability_handles`, which is invisible to any other connection until the inserting
 * transaction commits — `governance/capability/handles.ts`'s `createDbRevocationCheck` fails
 * *closed* on an unknown `jti`, so an uncommitted Handle looks exactly like a revoked one). Holding
 * `dispatchCapability`'s single transaction open across a `wait=true` poll (up to 90s by default)
 * would therefore make the very Worker it just spawned unable to authenticate for the entire wait
 * window — a self-inflicted deadlock, not merely a missed optimization. `invokeWorkerCreate`
 * (below) manages its own short, independently-committed `withWorkspace(deps.pool, ...)`
 * transactions (`TaskRuntimeDeps.pool` — see `runtime.ts`'s own doc comment) so the CREATE phase
 * commits and the Handle becomes usable *before* any waiting begins; `application/gateway/
 * handlers.ts`'s `invokeWorkerHandler` therefore ignores the `client` dispatch.ts hands it
 * entirely (dispatch.ts's own generic audit row for "invoke_worker was called" still commits
 * normally in its own transaction — a documented, deliberate exception, see this task's PR body).
 *
 * **P1-4 fix (review job 652a4abc): the `wait:true` poll itself is two-phase, same shape
 * `request_action` established.** Handle-usability was never the only problem here — even with
 * every one of `invokeWorkerCreate`'s own transactions committing independently, the *original*
 * single-function `invokeWorker` awaited the whole `wait:true` poll (up to 90s) from *inside*
 * `invokeWorkerHandler`, which itself runs inside `dispatch.ts`'s own `withWorkspace` transaction
 * — that outer transaction (and the pool connection under it) stayed open, idle, for the entire
 * wait regardless of what `invokeWorkerCreate` committed underneath it. Under load this can
 * exhaust the pool and block unrelated callers (e.g. a Worker's own `report_task_result`).
 * `invokeWorkerHandler` now calls `invokeWorkerCreate` (fast, no network wait) for its phase-1
 * result and defers any `wait:true` polling (`waitForOutcome`, exported below) to `afterCommit` —
 * run only *after* the phase-1 transaction has committed, holding no transaction of its own across
 * the wait. `invokeWorker` (also below) remains a thin single-call convenience wrapper — create,
 * then optionally wait — used directly by every existing test and any caller that already manages
 * its own transaction lifetime.
 *
 * **Quota checks (I18) run before anything is created**, in the same transaction as the
 * Task/WorkerRun/Handle creation itself — a violation rolls the whole thing back, so a rejected
 * `invoke_worker` call never leaves a half-created Task behind.
 */

// fix/invoke-worker-wait-and-outbox-prune: sourced from the shared ceiling (`@nexttime/shared`'s
// `INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS`) so the kernel's own default and the paramsSchema
// `.max()` clamp on `timeout` (capabilities.ts) can never drift apart — this re-export is kept
// (rather than inlining the import at every call site) since every existing caller/test already
// imports `DEFAULT_WAIT_TIMEOUT_SECONDS` from this module.
export const DEFAULT_WAIT_TIMEOUT_SECONDS = INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 500;
/** A WorkerRun Handle's ttl is the Task's own duration limit plus this grace window, so the
 *  Worker can still finish reporting its result (S2.9) after its own deadline fires without its
 *  credential going stale mid-report. */
const HANDLE_TTL_GRACE_SECONDS = 300;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clamps a caller-provided `timeout` (seconds, `invoke_worker`'s own param) to
 * `DEFAULT_WAIT_TIMEOUT_SECONDS` and converts to milliseconds for `waitForOutcome`. Defense in
 * depth alongside the schema-level `.max()` (`@nexttime/shared`'s `capabilities.ts`, enforced by
 * `dispatchCapability`) for the two callers that reach `waitForOutcome` without going through that
 * validation: `invokeWorker` below (every existing test/caller) and `application/gateway/
 * handlers.ts`'s `invokeWorkerHandler` (its `afterCommit` runs after `dispatchCapability`'s own
 * `safeParse` already succeeded, but re-derives `timeoutMs` from the same raw `input.timeout`
 * rather than trusting it stayed within bounds across that boundary) — same "schema rejects above
 * the ceiling, resolve-time code also clamps" two-layer convention `application/task/quotas.ts`'s
 * `resolveQuotas` already uses for `HARD_MAX_DEPTH`.
 */
export function resolveWaitTimeoutMs(timeoutSeconds: number | undefined): number {
  return (
    Math.min(timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS, DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000
  );
}

export interface InvokeWorkerCallerCtx {
  readonly principalId: string;
  readonly channel: CapabilityChannel;
  readonly claims?: HandleClaims;
  /**
   * The Turn (`activities.id`, `kind='agent_turn'`) that generated this `invoke_worker` call, if
   * any — design doc §5.2 `Turn --generated--> Task`; docs/development-tasks.md S2.11 deliverable
   * 4. Resolved by the caller (`application/gateway/handlers.ts`'s `invokeWorkerHandler`, via
   * `application/host-bridge`'s `findAttributableTurn`) *before* calling `invokeWorker` — this
   * module never resolves it itself, matching `invoke_worker`'s existing rule that everything
   * needed to create the Task is passed in, not re-derived (`caller`'s other fields are handled
   * the same way). `undefined` when the call had no attributable running Turn (e.g. the human
   * channel, or a Handle call outside any Turn) — `tasks.created_by_activity_id` stays `null` in
   * that case, exactly as it always has (S2.7's own doc comment on that column: "写这条边是 S2.11
   * 自己的职责范围").
   */
  readonly turnId?: string;
}

export interface InvokeWorkerInput {
  readonly definitionId: string;
  readonly version: number;
  readonly input: unknown;
  readonly wait?: boolean;
  /** Seconds — design doc §8.2 "默认 90 秒". */
  readonly timeout?: number;
  readonly gates?: readonly string[];
}

export interface InvokeWorkerResult {
  readonly taskId: string;
  readonly workerRunId: string;
  readonly status: TaskRow['status'];
  /** Present only when `wait` reached a terminal Task status within `timeout`. */
  readonly result?: unknown;
  readonly failureReason?: string | null;
}

async function resolveCallerWorkerRun(
  client: PoolClient,
  workspaceId: string,
  sessionId: string,
): Promise<WorkerRunRow | null> {
  const result = await client.query(
    `select ${WORKER_RUN_ROW_COLUMNS} from worker_runs where workspace_id = $1 and session_id = $2`,
    [workspaceId, sessionId],
  );
  const row = result.rows[0];
  return row ? mapWorkerRunRow(row) : null;
}

/**
 * `invoke_worker`'s create phase: resolves and validates the WorkerDefinition, runs the I18 quota
 * checks, mints the child Handle, and spawns the WorkerRun — never waits for the Task to reach a
 * terminal (or `waiting_approval`) status. Split out from `invokeWorker` below (P1-4 fix, review
 * job 652a4abc: "dispatch keeps the withWorkspace txn/pool connection open through the wait (≤90s)
 * → pool exhaustion blocks report_task_result") so `application/gateway/handlers.ts`'s
 * `invokeWorkerHandler` can run *this* inside `dispatch.ts`'s phase-1 transaction (fast — no
 * network wait) and defer any `wait:true` polling to `afterCommit`, the same two-phase shape
 * `request_action` already established — never holding the capability call's own transaction open
 * across the wait. `invokeWorker` below (still the direct entry point every existing caller/test
 * uses) is now a thin wrapper: create, then optionally wait.
 */
export async function invokeWorkerCreate(
  workspaceId: string,
  caller: InvokeWorkerCallerCtx,
  input: InvokeWorkerInput,
  deps: TaskRuntimeDeps,
): Promise<InvokeWorkerResult> {
  const definition = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: caller.principalId },
    (client) =>
      requirePublishedWorkerDefinition(client, workspaceId, {
        definitionId: input.definitionId,
        version: input.version,
      }),
  );

  if (definition.kind !== 'worker') {
    throw new InvokeWorkerValidationError(
      `invoke_worker: WorkerDefinition ${input.definitionId}@${input.version} is kind ` +
        `"${definition.kind}", not "worker" — only a worker-kind WorkerDefinition may be invoked`,
    );
  }

  const content = readDefinitionContent(definition.definition);
  const declaredCapabilities =
    content.capabilities ?? defaultWorkerCapabilities(WORKER_CEILING_CAPABILITIES);
  const declaredGates = content.gates ?? [];
  // `ensureWorkerAgentPrincipal`'s `display_name` input (spawn.ts) — the WorkerDefinition's own
  // declared `name` (packages/shared/src/worker-definition.ts, optional) when present, else the
  // definition id itself so the agent principal is still identifiable without one.
  const definitionName =
    typeof definition.definition.name === 'string' ? definition.definition.name : definition.id;

  const { parentAuthority, skillsInline, effectiveModel } = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: caller.principalId },
    async (client) => ({
      parentAuthority: await resolveParentAuthority(client, workspaceId, caller),
      skillsInline: await resolveSkillsInline(client, workspaceId, content.skills ?? []),
      // S3.13: only read when the WorkerDefinition itself declares no model — the requesting
      // principal's own effective.model is the fallback, never a widening of what the
      // WorkerDefinition author already pinned. `EffectiveAgentProfile.model` is always a
      // concrete `string` (`''` = "nothing configured anywhere",
      // `governance/agent-profile/resolve.ts`'s own doc comment) — normalized to `undefined`
      // here so an unconfigured model never becomes a literal empty-string CMD arg.
      effectiveModel:
        content.model === undefined
          ? (await readEffectiveAgentProfile(client, workspaceId, caller.principalId)).model ||
            undefined
          : undefined,
    }),
  );

  // Pre-check the child-Handle scope *before* creating anything (docs/development-tasks.md S2.7
  // "quota checks (I18) before anything is created" — this is the attenuation-equivalent of that
  // same rule): a rejection here (e.g. "入口 Handle 请求含 execute 的子 Handle 被拒", S2.7
  // acceptance) never leaves a Task row behind. `spawnWorkerRun` below recomputes the identical,
  // pure result — cheap, and keeps this function from having to thread a precomputed scope through
  // the requeue path too (`lifecycle.ts`'s `spawnWorkerRunForRetry` calls `spawnWorkerRun`
  // directly, with no equivalent pre-check of its own — a requeue attenuates from the failed
  // WorkerRun's own already-granted scope, which cannot newly fail this check). Pure/synchronous —
  // deliberately run *before* the locked transaction below, not inside it, so an attenuation
  // rejection never even attempts to take the advisory lock.
  computeChildHandleScope({
    parentAuthority,
    declaredCapabilities,
    declaredGates,
    requestedGates: input.gates,
  });

  // P2-6 fix (review job 652a4abc: "quota checks in separate txns, no lock → concurrent invokes
  // exceed maxConcurrentWorkerRunsPerUser"): the I18 quota checks and the Task INSERT that makes
  // the *next* caller's own concurrency count accurate now share one transaction, serialized per
  // (workspace, principal) by a session-scoped advisory lock (`pg_advisory_xact_lock`, the same
  // "auto-released at COMMIT/ROLLBACK" convention `application/chat/service.ts`'s own
  // `insertChatMessage` already uses for its own sequence-allocation race) — a second concurrent
  // `invoke_worker` call for the same principal blocks here until the first commits (or rolls
  // back on a quota violation), then re-reads the *already-committed* count.
  //
  // **Deviation from the S2.7 dispatch text's own "每用户并发 WorkerRun" wording**: the concurrency
  // count below is `tasks.status in ('queued','running','waiting_approval')`, not a `worker_runs`
  // join (the pre-existing query, still used by `find_workers`'s own unrelated depth math is not
  // affected). `worker_runs` rows are deliberately created in a *separate*, later-committed
  // transaction (`spawnWorkerRun`'s own module doc comment: a freshly-minted Handle must be usable
  // before any Task/WorkerRun creation transaction... commits, so it cannot share this lock without
  // reopening the exact race this fix closes) — locking around a `tasks` count instead means the
  // count and the row that makes the *next* caller's own count accurate are atomic with each
  // other, which no `worker_runs`-based count could achieve without an equally-locked WorkerRun
  // insert. A `queued`/`running`/`waiting_approval` Task has, in every real case, exactly one
  // active WorkerRun underneath it (a crash-requeue terminates the old one before spawning a new
  // one — `lifecycle.ts`'s `spawnWorkerRunForRetry`), so this is a faithful proxy for "concurrent
  // WorkerRuns per user", not a different quota.
  const { newDepth, parentWorkerRun, quotas, task } = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: caller.principalId },
    async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
        `${workspaceId}:${caller.principalId}`,
      ]);

      const callerWorkerRun = caller.claims
        ? await resolveCallerWorkerRun(client, workspaceId, caller.claims.sid)
        : null;
      const depth = (callerWorkerRun?.depth ?? 0) + 1;
      const resolvedQuotas = await resolveQuotas(client, workspaceId);

      if (depth > resolvedQuotas.maxDepth) {
        throw new QuotaExceededError(
          'depth_exceeded',
          `invoke_worker: derivation depth ${depth} exceeds the workspace's max depth (${resolvedQuotas.maxDepth}, hard ceiling ${HARD_MAX_DEPTH}) — invoke from a shallower WorkerRun or reduce nesting`,
        );
      }

      const concurrentResult = await client.query<{ count: string }>(
        `select count(*)::bigint as count
         from tasks
         where workspace_id = $1
           and on_behalf_of = $2
           and status in ('queued', 'running', 'waiting_approval')`,
        [workspaceId, caller.principalId],
      );
      const concurrentCount = Number(concurrentResult.rows[0]?.count ?? 0);
      if (concurrentCount >= resolvedQuotas.maxConcurrentWorkerRunsPerUser) {
        throw new QuotaExceededError(
          'concurrency_exceeded',
          `invoke_worker: ${concurrentCount} WorkerRun(s) already running for this user, at or ` +
            `above the workspace limit (${resolvedQuotas.maxConcurrentWorkerRunsPerUser})`,
        );
      }

      if (resolvedQuotas.dailyCostBudgetUsd !== null) {
        const spentToday = await sumTodayCostUsd(client, workspaceId);
        if (spentToday >= resolvedQuotas.dailyCostBudgetUsd) {
          throw new QuotaExceededError(
            'daily_cost_exceeded',
            `invoke_worker: workspace has spent $${spentToday.toFixed(2)} today, at or above ` +
              `the daily cost budget ($${resolvedQuotas.dailyCostBudgetUsd.toFixed(2)})`,
          );
        }
      }

      const taskResult = await client.query(
        `insert into tasks (
           workspace_id, status, on_behalf_of, created_by_activity_id, worker_definition_id,
           worker_definition_version, input, token_budget, duration_limit_sec
         ) values ($1, 'queued', $2, $3, $4, $5, $6::jsonb, $7, $8)
         returning ${TASK_ROW_COLUMNS}`,
        [
          workspaceId,
          caller.principalId,
          caller.turnId ?? null,
          input.definitionId,
          input.version,
          JSON.stringify(input.input ?? null),
          resolvedQuotas.defaultTokenBudget,
          resolvedQuotas.defaultDurationLimitSec,
        ],
      );
      const row = taskResult.rows[0];
      if (!row) throw new Error('invokeWorker: tasks INSERT ... RETURNING produced no row');
      const mappedTask = mapTaskRow(row);
      await recordTaskTransition(client, workspaceId, {
        actorPrincipalId: caller.principalId,
        action: 'task.queue',
        taskId: mappedTask.id,
        resultingStatus: 'queued',
      });

      return {
        newDepth: depth,
        parentWorkerRun: callerWorkerRun,
        quotas: resolvedQuotas,
        task: mappedTask,
      };
    },
  );

  const parentClaimsForLineage: MintWorkerRunHandleInput['parentClaims'] = caller.claims
    ? { jti: caller.claims.jti, exp: caller.claims.exp }
    : undefined;

  let workerRun: WorkerRunRow;
  try {
    workerRun = await spawnWorkerRun(deps, workspaceId, {
      task,
      parentWorkerRunId: parentWorkerRun?.id ?? null,
      depth: newDepth,
      attempt: 1,
      onBehalfOf: caller.principalId,
      parentAuthority,
      parentClaimsForLineage,
      declaredCapabilities,
      declaredGates,
      requestedGates: input.gates,
      // S3.13: falls back to the requesting principal's own effective.model only when the
      // WorkerDefinition declares none — never overrides an explicit WorkerDefinition.model.
      model: content.model ?? effectiveModel ?? undefined,
      definitionName,
      skillsInline,
      egressDeny: content.egressDeny,
    });
  } catch (err) {
    await withWorkspace(
      deps.pool,
      { workspaceId, principalId: caller.principalId },
      async (client) => {
        await client.query(
          `update tasks set status = 'failed', failed_at = now(), failure_reason = $3
         where workspace_id = $1 and id = $2`,
          [workspaceId, task.id, 'spawn_failed'],
        );
        await recordTaskTransition(client, workspaceId, {
          actorPrincipalId: caller.principalId,
          action: 'task.fail',
          taskId: task.id,
          resultingStatus: 'failed',
          extraAuditPayload: { failureReason: 'spawn_failed' },
        });
      },
    );
    throw err;
  }

  await withWorkspace(
    deps.pool,
    { workspaceId, principalId: caller.principalId },
    async (client) => {
      await client.query(
        "update tasks set status = 'running' where workspace_id = $1 and id = $2",
        [workspaceId, task.id],
      );
      await recordTaskTransition(client, workspaceId, {
        actorPrincipalId: caller.principalId,
        action: 'task.start',
        taskId: task.id,
        resultingStatus: 'running',
      });
    },
  );

  return { taskId: task.id, workerRunId: workerRun.id, status: 'running' };
}

/**
 * `invoke_worker`'s full flow (the direct entry point every existing test/caller — other than the
 * two-phase capability handler, see `invokeWorkerCreate`'s own doc comment — uses): create, then,
 * when `input.wait`, poll for completion up to `input.timeout` seconds (default 90) before
 * returning `{taskId, status: 'running'}` rather than hanging (design doc §8.2).
 */
export async function invokeWorker(
  workspaceId: string,
  caller: InvokeWorkerCallerCtx,
  input: InvokeWorkerInput,
  deps: TaskRuntimeDeps,
): Promise<InvokeWorkerResult> {
  const created = await invokeWorkerCreate(workspaceId, caller, input, deps);
  if (!input.wait) return created;
  return waitForOutcome(
    deps,
    workspaceId,
    caller.principalId,
    created.taskId,
    created.workerRunId,
    {
      timeoutMs: resolveWaitTimeoutMs(input.timeout),
    },
  );
}

const TERMINAL_TASK_STATUSES: readonly TaskRow['status'][] = ['completed', 'failed', 'cancelled'];

/**
 * Polls the Task row (and, opportunistically, the supervisor directly — `lifecycle.ts`'s
 * `reactToSupervisorStatus`) until the Task reaches a terminal status or `options.timeoutMs`
 * elapses, whichever first — never hangs past the timeout (design doc §8.2). Exported (P1-4 fix)
 * so `application/gateway/handlers.ts`'s `invokeWorkerHandler` can run it from `afterCommit`,
 * *after* `dispatch.ts`'s phase-1 transaction has already committed — see `invokeWorkerCreate`'s
 * own doc comment for why holding that transaction open across this wait was the actual defect.
 */
export async function waitForOutcome(
  deps: TaskRuntimeDeps,
  workspaceId: string,
  onBehalfOf: string,
  taskId: string,
  workerRunId: string,
  options: { timeoutMs: number },
): Promise<InvokeWorkerResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now().getTime() + options.timeoutMs;

  for (;;) {
    const task = await withWorkspace(
      deps.pool,
      { workspaceId, principalId: onBehalfOf },
      (client) => readTask(client, workspaceId, taskId),
    );
    if (
      task &&
      (TERMINAL_TASK_STATUSES.includes(task.status) || task.status === 'waiting_approval')
    ) {
      return {
        taskId,
        workerRunId,
        status: task.status,
        result: task.result,
        failureReason: task.failureReason,
      };
    }

    // Opportunistically react to the supervisor's own state (rather than only waiting for the
    // background reaper's own, coarser interval) — same reaction logic the reaper uses.
    await reactToSupervisorStatus(deps, workspaceId, onBehalfOf, workerRunId).catch(() => {
      // Best-effort: a transient supervisor/network error here must not abort the wait loop — the
      // next tick, or the background reaper, will retry.
    });

    const remainingMs = deadline - now().getTime();
    if (remainingMs <= 0) {
      const finalTask = await withWorkspace(
        deps.pool,
        { workspaceId, principalId: onBehalfOf },
        (client) => readTask(client, workspaceId, taskId),
      );
      return {
        taskId,
        workerRunId,
        status: finalTask?.status ?? 'running',
        result: finalTask?.result,
        failureReason: finalTask?.failureReason,
      };
    }
    await sleep(Math.min(DEFAULT_WAIT_POLL_INTERVAL_MS, remainingMs));
  }
}

export async function readTask(
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
