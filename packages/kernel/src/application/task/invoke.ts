import type { CapabilityChannel, HandleClaims } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { withWorkspace } from '../../adapters/db/pool.js';
import { WORKER_CEILING_CAPABILITIES } from '../../governance/capability/index.js';
import { sumTodayCostUsd } from '../../governance/llm-usage/index.js';
import { requirePublishedWorkerDefinition } from '../worker/index.js';
import { computeChildHandleScope, resolveParentAuthority } from './handle-mint.js';
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
 * window — a self-inflicted deadlock, not merely a missed optimization. `invokeWorker` below
 * instead manages its own short, independently-committed `withWorkspace(deps.pool, ...)`
 * transactions (`TaskRuntimeDeps.pool` — see `runtime.ts`'s own doc comment) so the CREATE phase
 * commits and the Handle becomes usable *before* any waiting begins; `application/gateway/
 * handlers.ts`'s `invokeWorkerHandler` therefore ignores the `client` dispatch.ts hands it
 * entirely (dispatch.ts's own generic audit row for "invoke_worker was called" still commits
 * normally in its own transaction — a documented, deliberate exception, see this task's PR body).
 *
 * **Quota checks (I18) run before anything is created**, in the same transaction as the
 * Task/WorkerRun/Handle creation itself — a violation rolls the whole thing back, so a rejected
 * `invoke_worker` call never leaves a half-created Task behind.
 */

const DEFAULT_WAIT_TIMEOUT_SECONDS = 90;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 500;
/** A WorkerRun Handle's ttl is the Task's own duration limit plus this grace window, so the
 *  Worker can still finish reporting its result (S2.9) after its own deadline fires without its
 *  credential going stale mid-report. */
const HANDLE_TTL_GRACE_SECONDS = 300;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InvokeWorkerCallerCtx {
  readonly principalId: string;
  readonly channel: CapabilityChannel;
  readonly claims?: HandleClaims;
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

/** The WorkerDefinition content fields `invoke_worker`/requeue need — a structural subset of
 *  `packages/shared/src/worker-definition.ts`'s `WorkerWorkerDefinitionContent`, read from the
 *  already-parsed `definition` jsonb (this module trusts `publishWorkerDefinition`'s own
 *  `validateWorkerDefinitionContent` call already shaped it correctly at publish time — no
 *  re-validation here). */
interface WorkerDefinitionContentShape {
  readonly capabilities?: readonly string[];
  readonly gates?: readonly string[];
  readonly model?: string;
}

function readDefinitionContent(definition: unknown): WorkerDefinitionContentShape {
  if (!definition || typeof definition !== 'object') return {};
  const record = definition as Record<string, unknown>;
  return {
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter((c): c is string => typeof c === 'string')
      : undefined,
    gates: Array.isArray(record.gates)
      ? record.gates.filter((g): g is string => typeof g === 'string')
      : undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
  };
}

/** Default declared capabilities for a WorkerDefinition that does not declare its own (least
 *  privilege — see `packages/shared/src/worker-definition.ts`'s own doc comment): the full worker
 *  ceiling minus every execute-class name, computed lazily so `handle-mint.ts`'s
 *  `WORKER_CEILING_CAPABILITIES`/`isExecuteClassCapability` stay the single source of truth for
 *  what "execute-class" means. */
function defaultWorkerCapabilities(ceiling: readonly string[]): readonly string[] {
  return ceiling; // computeChildHandleScope itself rejects execute-class names lacking parent
  // coverage — see that function's own doc comment. Passing the *full* ceiling here (rather than
  // pre-filtering out execute-class names) is deliberately safe either way: an entry-Handle-
  // initiated call still gets rejected for any execute-class name the parent lacks, exactly as if
  // the definition had declared it explicitly; a Worker-Handle-initiated call that *does* already
  // hold execute-class capabilities of its own is not artificially prevented from passing them to
  // a grandchild just because the intermediate WorkerDefinition left `capabilities` unset.
}

/**
 * `invoke_worker`'s full flow: resolves and validates the WorkerDefinition, runs the I18 quota
 * checks, mints the child Handle, spawns the WorkerRun, and — when `input.wait` — polls for
 * completion up to `input.timeout` seconds (default 90) before returning `{taskId, status:
 * 'running'}` rather than hanging (design doc §8.2).
 */
export async function invokeWorker(
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

  const { newDepth, parentWorkerRun, quotas } = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: caller.principalId },
    async (client) => {
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
         from worker_runs wr
         join tasks t on t.workspace_id = wr.workspace_id and t.id = wr.task_id
         where wr.workspace_id = $1
           and t.on_behalf_of = $2
           and wr.status in ('provisioning', 'running', 'suspended')`,
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

      return { newDepth: depth, parentWorkerRun: callerWorkerRun, quotas: resolvedQuotas };
    },
  );

  const parentAuthority = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: caller.principalId },
    (client) => resolveParentAuthority(client, workspaceId, caller),
  );

  // Pre-check the child-Handle scope *before* creating anything (docs/development-tasks.md S2.7
  // "quota checks (I18) before anything is created" — this is the attenuation-equivalent of that
  // same rule): a rejection here (e.g. "入口 Handle 请求含 execute 的子 Handle 被拒", S2.7
  // acceptance) never leaves a Task row behind. `spawnWorkerRun` below recomputes the identical,
  // pure result — cheap, and keeps this function from having to thread a precomputed scope through
  // the requeue path too (`lifecycle.ts`'s `spawnWorkerRunForRetry` calls `spawnWorkerRun`
  // directly, with no equivalent pre-check of its own — a requeue attenuates from the failed
  // WorkerRun's own already-granted scope, which cannot newly fail this check).
  computeChildHandleScope({
    parentAuthority,
    declaredCapabilities,
    declaredGates,
    requestedGates: input.gates,
  });

  const task = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: caller.principalId },
    async (client) => {
      const taskResult = await client.query(
        `insert into tasks (
           workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version,
           input, token_budget, duration_limit_sec
         ) values ($1, 'queued', $2, $3, $4, $5::jsonb, $6, $7)
         returning ${TASK_ROW_COLUMNS}`,
        [
          workspaceId,
          caller.principalId,
          input.definitionId,
          input.version,
          JSON.stringify(input.input ?? null),
          quotas.defaultTokenBudget,
          quotas.defaultDurationLimitSec,
        ],
      );
      const row = taskResult.rows[0];
      if (!row) throw new Error('invokeWorker: tasks INSERT ... RETURNING produced no row');
      const mapped = mapTaskRow(row);
      await recordTaskTransition(client, workspaceId, {
        actorPrincipalId: caller.principalId,
        action: 'task.queue',
        taskId: mapped.id,
        resultingStatus: 'queued',
      });
      return mapped;
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
      model: content.model,
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

  if (!input.wait) {
    return { taskId: task.id, workerRunId: workerRun.id, status: 'running' };
  }

  return waitForOutcome(deps, workspaceId, caller.principalId, task.id, workerRun.id, {
    timeoutMs: (input.timeout ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000,
  });
}

const TERMINAL_TASK_STATUSES: readonly TaskRow['status'][] = ['completed', 'failed', 'cancelled'];

/** Polls the Task row (and, opportunistically, the supervisor directly — `lifecycle.ts`'s
 *  `reactToSupervisorStatus`) until the Task reaches a terminal status or `options.timeoutMs`
 *  elapses, whichever first — never hangs past the timeout (design doc §8.2). */
async function waitForOutcome(
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
