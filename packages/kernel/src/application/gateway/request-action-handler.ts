import { IllegalTransition } from '@nexttime/shared';
import type { CapabilityChannel, CapabilityScope } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import type { ActionExecutor, ActionRequestRow } from '../../governance/approval/index.js';
import {
  awaitActionRequestResolution,
  getActionRequest,
  markActionRequestExecuted,
  markActionRequestFailed,
  requestAction,
  startActionRequestExecution,
} from '../../governance/approval/index.js';
import {
  SYSTEM_ACTOR_PLACEHOLDER,
  getGatekeeper,
  getOrCreateGatekeeperServicePrincipal,
  getPublishedOperation,
} from '../../governance/gatekeepers/index.js';
import type { GatekeeperRecord } from '../../governance/gatekeepers/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import type { WithTransactionFn } from './action-executor.js';
import { createAdminWithTransaction } from './action-executor.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler, CapabilityHandlerResult } from './capability-handler.js';
import { writeObservedFacts } from './observed-facts.js';

/**
 * application/gateway/request-action-handler: the `request_action` capability (design doc
 * §5.1.4/§7.4/§8.1; docs/development-tasks.md S2.4), as a **two-phase** handler
 * (`CapabilityHandlerResult.afterCommit` — dispatch.ts's own doc comment has the general
 * contract).
 *
 * **Why two phases** (coordinator review, PR #42): `dispatchCapability` runs a handler inside one
 * `withWorkspace` transaction that only commits *after* the handler returns. A single-phase
 * `request_action` that both creates the ActionRequest row *and* waits for it to be approved (or
 * executes it) inside that same call therefore has two real bugs, not just a documented cost:
 * (a) polling the row on the *same uncommitted transaction* for up to `awaitDecisionTimeoutMs` —
 * the row is invisible to every other connection, so a human's `approve()` (a separate request, a
 * separate transaction) can never see it; the wait can only ever time out. (b) for `auto_approved`,
 * calling the gate's `apply` — a real external side effect — while the ActionRequest, its audit
 * row, and the Activity are all still uncommitted: if anything after `apply` fails, the effect
 * happened with **no durable record** (I7/I11), and the row's own `executing` transition was never
 * visible to the drain consumer that fires on the *committed* `ActionRequestUpdated{auto_approved}`
 * event either.
 *
 * The fix: phase 1 (this handler function, still inside dispatch.ts's transaction) only ever
 * *resolves* the ActionRequest — creates it via `requestAction` (I6/I11: this call already writes
 * its own row + audit + outbox atomically), throws for `denied`, calls the gate's cheap read-only
 * `simulate` for the `pending_approval && !awaitDecision` row, and otherwise returns
 * `{actionRequestId, status}` plus an `afterCommit` continuation. Phase 2 (`afterCommit`, run by
 * dispatch.ts only once the phase-1 transaction has committed) does everything that either waits
 * for another connection's write to become visible or performs a real external effect — and it
 * never holds one of *its own* transactions across either a wait or a gate call: every DB write
 * below opens its own short-lived admin-mode transaction (`createAdminWithTransaction`, the same
 * one the periodic drain tick and the outbox consumer already use), and `apply` always runs
 * outside all of them.
 *
 * **Decision table** (`R` = phase 1, in dispatch.ts's transaction; `A` = phase 2, `afterCommit`,
 * post-commit, short transactions only):
 *
 *   - draft/unknown Operation (I17 unclassified)   → R: `requestAction` with
 *     `blast_radius=medium, auto_approvable=false, await_decision=true` → always resolves
 *     `pending_approval` (never `auto_approved`/`denied` for a truly unclassified request, since
 *     `operationAutoApprovable=false` forces `require_approval` in `governance/policy/engine.ts`
 *     regardless of workspace policy) → falls into the same `A` path as any other
 *     `pending_approval && awaitDecision` row below.
 *   - `mode: 'observe'`                            → R only: calls the gate's `observe` directly
 *     inside an Activity, writes `observedFacts`, returns the final result — no ActionRequest, no
 *     `afterCommit` (a read has no "effect with no record" risk; if the write of the observed
 *     Facts itself fails, the whole phase-1 transaction rolls back cleanly, which is correct).
 *   - `mode: 'execute'`, resolves `denied`          → R: throws `ActionRequestDeniedError` (403).
 *   - `mode: 'execute'`, resolves `auto_approved`   → R returns `{actionRequestId, status}` +
 *     `afterCommit`; A: `tryExecuteInline` (see below) runs immediately.
 *   - `mode: 'execute'`, resolves `pending_approval`, `awaitDecision: false` → R: calls the gate's
 *     `simulate` (read-only, no `afterCommit` needed) and returns
 *     `{status:'pending_approval', actionRequestId, simulate}`.
 *   - `mode: 'execute'`, resolves `pending_approval`, `awaitDecision: true` → R returns
 *     `{actionRequestId, status}` + `afterCommit`; A: `pollAndExecute` polls (short transactions)
 *     until the row leaves `pending_approval`/`approved` decisively or `awaitDecisionTimeoutMs`
 *     elapses — `approved`/`auto_approved` within budget → executes via `tryExecuteInline`;
 *     `rejected`/`expired` → returned as-is; already `executed`/`failed` (a concurrent drain beat
 *     us to it) → reads the stored outcome back; timed out → `{status:'pending_approval'}` if
 *     still undecided, or `{status:'approved'}` (execution left to the already-wired async drain
 *     paths — the outbox consumer / periodic tick, `packages/kernel/src/index.ts`) if a decision
 *     landed but we ran out of budget to also finish executing it.
 *
 * **Racing the drain consumer** (`tryExecuteInline`): phase 2 and the async drain paths
 * (`ActionRequestUpdated` outbox consumer, periodic tick) can both try to execute the same
 * `approved`/`auto_approved` row. `startActionRequestExecution`'s row lock + conditional UPDATE
 * (S2.3) makes exactly one of them win; the loser gets `IllegalTransition` and, rather than
 * retrying `apply` itself (a real retry after a genuine failure could double-run a non-idempotent
 * effect — only the gate's own idempotency store, keyed by `actionRequestId`, is trusted to dedupe
 * `apply`), polls for the row to reach a terminal state and reads the winner's stored result back
 * from the audit trail (`markActionRequestExecuted`/`markActionRequestFailed`'s own
 * `resultMetadata`/`reason` payload — `readTerminalOutcome` below) instead.
 */

export class GatekeeperNotFoundError extends Error {
  constructor(gatekeeperId: string) {
    super(`Gatekeeper not found: ${gatekeeperId}`);
    this.name = 'GatekeeperNotFoundError';
  }
}

/** I7/§8.1 "denied → 403-shaped result": a policy `deny` decision (the requester's Handle scope
 *  does not cover this Gatekeeper) is a real authorization failure, not a domain outcome the
 *  caller reads out of a 200 response body — extends `ForbiddenError` so every existing generic
 *  403 mapping (HTTP/WS) picks it up unchanged, same convention as `MetaOntologyWriteForbiddenError`. */
export class ActionRequestDeniedError extends ForbiddenError {
  readonly actionRequestId: string;
  constructor(actionRequestId: string) {
    super(`ActionRequest ${actionRequestId} was denied by policy`);
    this.name = 'ActionRequestDeniedError';
    this.actionRequestId = actionRequestId;
  }
}

export interface RequestActionHandlerDeps {
  readonly gatekeeperClient: GatekeeperClient;
  /** The same `ActionExecutor` instance (or an equivalently-constructed one — it is stateless)
   *  the composition root wires into `ApprovalDrainer` — "the single shared executor path"
   *  (coordinator review): phase 2 never re-implements "call apply, then write observed facts". */
  readonly actionExecutor: ActionExecutor;
  /** `await_decision:true`'s poll timeout — default 90s (design doc §8.2's own `invoke_worker`
   *  timeout default; this task brief: "configurable, default 90s"). */
  readonly awaitDecisionTimeoutMs?: number;
}

const DEFAULT_AWAIT_DECISION_TIMEOUT_MS = 90_000;
/** How long `tryExecuteInline` waits for a *concurrent* execution (the race-loss path) to reach a
 *  terminal state before giving up — deliberately short: the winner is actively executing right
 *  now, not waiting on a human, so this should resolve in well under a second in the ordinary
 *  case. If the winner crashed mid-flight, the periodic drain tick (packages/kernel/src/index.ts)
 *  eventually re-drains the row — this function does not wait for that. */
const CONCURRENT_EXECUTION_WAIT_TIMEOUT_MS = 10_000;
const PHASE2_POLL_INTERVAL_MS = 200;

/** The seam `packages/kernel/src/index.ts` (composition root) uses to wire in the real
 *  `GatekeeperClient`/`ActionExecutor` — same "module-level singleton set once at startup" shape
 *  `handlers.ts` already uses for `AgentRuntime` (`setAgentRuntimeForHandlers`). */
let deps: RequestActionHandlerDeps | undefined;

export function setRequestActionDeps(next: RequestActionHandlerDeps): void {
  deps = next;
}

function requireDeps(): RequestActionHandlerDeps {
  if (!deps) {
    throw new Error(
      'request_action: gatekeeper dependencies are not wired — call setRequestActionDeps() from the composition root',
    );
  }
  return deps;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------------------------------------
// observe path — phase 1 only (see module doc comment: no durable-record risk in a read).
// -------------------------------------------------------------------------------------------

async function runObserve(
  client: PoolClient,
  workspaceId: string,
  gatekeeper: GatekeeperRecord,
  operationName: string,
  operationParams: unknown,
  onBehalfOf: string,
): Promise<CapabilityHandlerResult> {
  const activity = await startActivity(client, workspaceId, {
    kind: 'gatekeeper_observe',
    principalId: onBehalfOf,
    metadata: { gatekeeperId: gatekeeper.gatekeeperId, operation: operationName },
  });
  try {
    const observeResult = await requireDeps().gatekeeperClient.observe(gatekeeper.endpoint, {
      operation: operationName,
      params: operationParams,
      onBehalfOf,
    });
    const written = await writeObservedFacts(
      client,
      workspaceId,
      gatekeeper.gatekeeperId,
      observeResult.observedFacts ?? [],
      activity.id,
    );
    await endActivity(client, workspaceId, activity.id, 'completed');
    return {
      result: { status: 'ok', data: observeResult.data, observedFactCount: written.length },
      resourceType: 'gatekeeper',
      resourceId: gatekeeper.gatekeeperId,
    };
  } catch (err) {
    await endActivity(client, workspaceId, activity.id, 'failed');
    throw err;
  }
}

// -------------------------------------------------------------------------------------------
// phase 2 primitives — every DB write opens its own short-lived admin transaction; `apply` (via
// `ActionExecutor.execute`) always runs outside all of them. See module doc comment.
// -------------------------------------------------------------------------------------------

interface ExecutionOutcome {
  readonly status: 'executed' | 'failed';
  readonly data?: unknown;
  readonly reason?: string;
}

/** Resolves the Gatekeeper service Principal via one short admin transaction (bootstrapped with
 *  `SYSTEM_ACTOR_PLACEHOLDER`, then reused for every later admin transaction in this phase-2
 *  call — see `system-actor.ts`'s own doc comment for why the placeholder is safe to bootstrap
 *  with). */
async function resolveSystemActor(
  withTransaction: WithTransactionFn,
  workspaceId: string,
): Promise<string> {
  return withTransaction(workspaceId, SYSTEM_ACTOR_PLACEHOLDER, (client) =>
    getOrCreateGatekeeperServicePrincipal(client, workspaceId),
  );
}

/** Reads back a terminal ActionRequest's stored result from the audit trail —
 *  `markActionRequestExecuted`/`markActionRequestFailed` (governance/approval/execution.ts) each
 *  write their `resultMetadata`/`reason` into the same transaction as the status transition
 *  itself, so by the time a caller observes the row's status as `executed`/`verified`/`failed`,
 *  the corresponding audit row is already committed too — no separate race to worry about here. */
async function readTerminalOutcome(
  withTransaction: WithTransactionFn,
  workspaceId: string,
  systemActorId: string,
  actionRequestId: string,
): Promise<{ data?: unknown; reason?: string }> {
  const rows = await withTransaction(workspaceId, systemActorId, (client) =>
    queryAudit(client, workspaceId, {
      resourceType: 'action_request',
      resourceId: actionRequestId,
      limit: 1,
    }),
  );
  const payload = rows[0]?.payload as
    | { resultMetadata?: { data?: unknown }; reason?: string }
    | undefined;
  return { data: payload?.resultMetadata?.data, reason: payload?.reason };
}

/** Waits (short polling transactions, never one held open) for a *concurrently* executing row —
 *  one `tryExecuteInline` lost the `startActionRequestExecution` race on — to reach a terminal
 *  state, then reads the winner's result back. See `CONCURRENT_EXECUTION_WAIT_TIMEOUT_MS`'s own
 *  doc comment for the (short) timeout budget here. */
async function awaitConcurrentExecution(
  withTransaction: WithTransactionFn,
  workspaceId: string,
  systemActorId: string,
  actionRequestId: string,
): Promise<ExecutionOutcome> {
  const deadline = Date.now() + CONCURRENT_EXECUTION_WAIT_TIMEOUT_MS;
  for (;;) {
    const row = await withTransaction(workspaceId, systemActorId, (client) =>
      getActionRequest(client, workspaceId, actionRequestId),
    );
    if (row?.status === 'executed' || row?.status === 'verified') {
      const outcome = await readTerminalOutcome(
        withTransaction,
        workspaceId,
        systemActorId,
        actionRequestId,
      );
      return { status: 'executed', data: outcome.data };
    }
    if (row?.status === 'failed') {
      const outcome = await readTerminalOutcome(
        withTransaction,
        workspaceId,
        systemActorId,
        actionRequestId,
      );
      return { status: 'failed', reason: outcome.reason };
    }
    if (Date.now() >= deadline) {
      return {
        status: 'failed',
        reason: `timed out waiting for a concurrent execution to finish (last observed status: "${row?.status ?? 'unknown'}")`,
      };
    }
    await sleep(PHASE2_POLL_INTERVAL_MS);
  }
}

/**
 * Tries to execute one `auto_approved`/`approved` ActionRequest. Wins the race
 * (`startActionRequestExecution` succeeds) → runs the shared `ActionExecutor.execute` (apply
 * outside any transaction, observed facts inside its own short one — action-executor.ts's own
 * doc comment), then records the outcome in one more short admin transaction. Loses the race
 * (`IllegalTransition` — a concurrent drain trigger already moved the row) →
 * `awaitConcurrentExecution` instead of retrying `apply` itself.
 */
async function tryExecuteInline(
  actionExecutor: ActionExecutor,
  withTransaction: WithTransactionFn,
  workspaceId: string,
  systemActorId: string,
  actionRequestId: string,
): Promise<ExecutionOutcome> {
  let executing: ActionRequestRow;
  try {
    executing = await withTransaction(workspaceId, systemActorId, (client) =>
      startActionRequestExecution(client, workspaceId, actionRequestId),
    );
  } catch (err) {
    if (!(err instanceof IllegalTransition)) throw err;
    return awaitConcurrentExecution(withTransaction, workspaceId, systemActorId, actionRequestId);
  }

  const result = await actionExecutor.execute(executing);
  await withTransaction(workspaceId, systemActorId, (client) =>
    result.ok
      ? markActionRequestExecuted(client, workspaceId, actionRequestId, {
          resultMetadata: result.resultMetadata,
        })
      : markActionRequestFailed(client, workspaceId, actionRequestId, { reason: result.reason }),
  );
  if (result.ok) {
    const data = (result.resultMetadata as { data?: unknown } | undefined)?.data;
    return { status: 'executed', data };
  }
  return { status: 'failed', reason: result.reason };
}

/**
 * Phase 2 for a `pending_approval && awaitDecision:true` row: polls short admin transactions
 * until the row leaves `pending_approval` decisively or `timeoutMs` elapses. `approved`/
 * `auto_approved` observed *within* budget → executes via `tryExecuteInline`; past the deadline →
 * reports `approved` as-is and leaves execution to the already-wired async drain paths (this
 * bounds how long the original `request_action` caller waits, rather than adding one more gate
 * round-trip past the nominal budget).
 */
async function pollAndExecute(
  actionExecutor: ActionExecutor,
  withTransaction: WithTransactionFn,
  workspaceId: string,
  systemActorId: string,
  actionRequestId: string,
  timeoutMs: number,
): Promise<{ status: string; data?: unknown; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await withTransaction(workspaceId, systemActorId, (client) =>
      getActionRequest(client, workspaceId, actionRequestId),
    );
    if (!row) return { status: 'pending_approval' };

    if (row.status === 'rejected' || row.status === 'expired') {
      return { status: row.status };
    }
    if (row.status === 'executed' || row.status === 'verified') {
      const outcome = await readTerminalOutcome(
        withTransaction,
        workspaceId,
        systemActorId,
        actionRequestId,
      );
      return { status: 'executed', data: outcome.data };
    }
    if (row.status === 'failed') {
      const outcome = await readTerminalOutcome(
        withTransaction,
        workspaceId,
        systemActorId,
        actionRequestId,
      );
      return { status: 'failed', reason: outcome.reason };
    }
    if (row.status === 'approved' || row.status === 'auto_approved') {
      if (Date.now() < deadline) {
        return tryExecuteInline(
          actionExecutor,
          withTransaction,
          workspaceId,
          systemActorId,
          actionRequestId,
        );
      }
      return { status: 'approved' };
    }
    // still pending_approval
    if (Date.now() >= deadline) return { status: 'pending_approval' };
    await sleep(Math.min(PHASE2_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
  }
}

// -------------------------------------------------------------------------------------------
// phase-1 orchestration (declared execute Operation, or the I17 unclassified fallback) — creates
// the ActionRequest, resolves the immediately-knowable outcomes (denied, simulate), and defers
// everything else to `afterCommit`.
// -------------------------------------------------------------------------------------------

interface RunGovernedRequestArgs {
  readonly gatekeeper: GatekeeperRecord;
  readonly operationName: string;
  readonly operationParams: Record<string, unknown>;
  readonly onBehalfOf: string;
  readonly actorRuntime: string;
  readonly requesterScope: CapabilityScope;
  readonly blastRadius: 'low' | 'medium' | 'high';
  readonly autoApprovable: boolean;
  readonly awaitDecision: boolean;
}

async function runGovernedRequest(
  client: PoolClient,
  workspaceId: string,
  args: RunGovernedRequestArgs,
): Promise<CapabilityHandlerResult> {
  const actionRequest = await requestAction(client, workspaceId, {
    gatekeeperId: args.gatekeeper.gatekeeperId,
    actionKind: args.operationName,
    blastRadius: args.blastRadius,
    operationAutoApprovable: args.autoApprovable,
    awaitDecision: args.awaitDecision,
    onBehalfOf: args.onBehalfOf,
    actorRuntime: args.actorRuntime,
    requesterScope: args.requesterScope,
    params: args.operationParams,
  });

  if (actionRequest.status === 'denied') {
    throw new ActionRequestDeniedError(actionRequest.id);
  }

  if (actionRequest.status === 'auto_approved') {
    return {
      result: { actionRequestId: actionRequest.id, status: actionRequest.status },
      resourceType: 'action_request',
      resourceId: actionRequest.id,
      afterCommit: async (pool: PoolLike) => {
        const { actionExecutor } = requireDeps();
        const withTransaction = createAdminWithTransaction(pool);
        const systemActorId = await resolveSystemActor(withTransaction, workspaceId);
        const outcome = await tryExecuteInline(
          actionExecutor,
          withTransaction,
          workspaceId,
          systemActorId,
          actionRequest.id,
        );
        return { ...outcome, actionRequestId: actionRequest.id };
      },
    };
  }

  // pending_approval
  if (!args.awaitDecision) {
    const simulate = await requireDeps().gatekeeperClient.simulate(args.gatekeeper.endpoint, {
      operation: args.operationName,
      params: args.operationParams,
      onBehalfOf: args.onBehalfOf,
    });
    return {
      result: { status: 'pending_approval', actionRequestId: actionRequest.id, simulate },
      resourceType: 'action_request',
      resourceId: actionRequest.id,
    };
  }

  return {
    result: { actionRequestId: actionRequest.id, status: actionRequest.status },
    resourceType: 'action_request',
    resourceId: actionRequest.id,
    afterCommit: async (pool: PoolLike) => {
      const { actionExecutor, awaitDecisionTimeoutMs } = requireDeps();
      const withTransaction = createAdminWithTransaction(pool);
      const systemActorId = await resolveSystemActor(withTransaction, workspaceId);
      const outcome = await pollAndExecute(
        actionExecutor,
        withTransaction,
        workspaceId,
        systemActorId,
        actionRequest.id,
        awaitDecisionTimeoutMs ?? DEFAULT_AWAIT_DECISION_TIMEOUT_MS,
      );
      return { ...outcome, actionRequestId: actionRequest.id };
    },
  };
}

// -------------------------------------------------------------------------------------------
// the capability handler
// -------------------------------------------------------------------------------------------

/** The `gatekeeper` resource-scope key `evaluate()` reads (see `governance/policy/engine.ts`'s
 *  own `GATEKEEPER_RESOURCE_SCOPE_KEY` doc comment) — the human channel is at least as trusted as
 *  any Handle (§9.3 "human 通道调用同样允许"), so a human caller's scope is synthesized to cover
 *  whichever Gatekeeper it names, matching this task's own "human-channel calls are allowed the
 *  same way (owner testing)" brief. */
function resolveRequesterScope(
  channel: CapabilityChannel,
  scope: CapabilityScope | undefined,
  gatekeeperId: string,
): CapabilityScope {
  if (channel === 'handle' && scope) return scope;
  return { capabilities: [], resources: { gatekeeper: [gatekeeperId] } };
}

export const requestActionHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const {
    gatekeeperId,
    operation: operationName,
    params: operationParams,
  } = params as {
    gatekeeperId: string;
    operation: string;
    params?: Record<string, unknown>;
  };
  const channel: CapabilityChannel = ctx?.channel ?? 'handle';
  const onBehalfOf = ctx?.principalId;
  if (!onBehalfOf) {
    throw new Error('request_action: caller context is required (dispatch.ts must supply it)');
  }
  const actorRuntime = channel === 'human' ? 'human' : 'pi';
  const requesterScope = resolveRequesterScope(channel, ctx?.scope, gatekeeperId);
  const resolvedParams = operationParams ?? {};

  const gatekeeper = await getGatekeeper(client, workspaceId, gatekeeperId);
  if (!gatekeeper) throw new GatekeeperNotFoundError(gatekeeperId);

  const published = await getPublishedOperation(client, workspaceId, gatekeeperId, operationName);

  if (published && published.operation.mode === 'observe') {
    return runObserve(client, workspaceId, gatekeeper, operationName, resolvedParams, onBehalfOf);
  }

  if (!published) {
    // I17: draft/unknown Operation → unclassified, always require_approval, never execute.
    return runGovernedRequest(client, workspaceId, {
      gatekeeper,
      operationName,
      operationParams: resolvedParams,
      onBehalfOf,
      actorRuntime,
      requesterScope,
      blastRadius: 'medium',
      autoApprovable: false,
      awaitDecision: true,
    });
  }

  const operation = published.operation;
  return runGovernedRequest(client, workspaceId, {
    gatekeeper,
    operationName,
    operationParams: resolvedParams,
    onBehalfOf,
    actorRuntime,
    requesterScope,
    blastRadius: operation.blast_radius,
    autoApprovable: operation.auto_approvable,
    awaitDecision: operation.await_decision,
  });
};
