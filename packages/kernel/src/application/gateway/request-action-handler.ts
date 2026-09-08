import { IllegalTransition } from '@nexttime/shared';
import type { ActionRequestStatus, CapabilityChannel, CapabilityScope } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import { findWorkerRunBySessionId } from '../../application/task/index.js';
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
  GatekeeperNotFoundError,
  OperationNotFoundError,
  SYSTEM_ACTOR_PLACEHOLDER,
  getGatekeeper,
  getOrCreateGatekeeperServicePrincipal,
  getPublishedOperation,
} from '../../governance/gatekeepers/index.js';
import type { GatekeeperRecord } from '../../governance/gatekeepers/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import type { WithTransactionFn } from './action-executor.js';
import {
  createAdminWithTransaction,
  deriveDefaultIdempotencyKey,
  scopeExplicitIdempotencyKey,
} from './action-executor.js';
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
 *
 * **Idempotency** (P1-1 fix, review job 652a4abc lane3/lane2): `requestActionHandler` always
 * derives an idempotency key before calling `requestAction` — an explicit `idempotencyKey` param,
 * scoped to `(workspace, on_behalf_of, sid)` (`action-executor.ts`'s `scopeExplicitIdempotencyKey`
 * — the DB's own unique index is only workspace-scoped); or, when omitted, a default derived from
 * `(sid|principal, gatekeeperId, operation, stable params hash)`
 * (`deriveDefaultIdempotencyKey`). A retry — from a caller-side timeout, an aborted connection, or
 * simple redelivery — that reuses the same key returns the *existing* row instead of creating a
 * second one (`governance/approval/request-action.ts` owns the storage half: a partial unique
 * index plus a SAVEPOINT-guarded INSERT for the concurrent-callers case). Because of this, the
 * decision table above is necessary but not sufficient — `runGovernedRequest`'s switch handles
 * every `ActionRequestStatus`, not just the three a *fresh* resolution can produce, since a replay
 * can return a row already carried to any status (including terminal) by an earlier call.
 */

// Re-exported for `application/gateway/index.ts`'s existing consumers; the class itself now lives
// with the module that owns Gatekeeper Objects (`governance/gatekeepers/registry.ts`) so
// `governance/connections` throws the very same class and one `instanceof` maps it on both
// transports.
export { GatekeeperNotFoundError };

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
  /** `await_decision:true`'s poll timeout — default 25s (P1-1 fix, review job 652a4abc: kept
   *  below `packages/platform-extension/src/kernel-client.ts`'s `DEFAULT_KERNEL_CLIENT_TIMEOUT_MS`
   *  (30s) so `request_action` itself always resolves — with `{status:'pending_approval'|
   *  'approved', actionRequestId}` if the decision/execution has not landed yet — *before* the
   *  Worker's own HTTP client would time out and retry; a 90s default let the client's 30s
   *  timeout fire first, and an unmarked retry used to create a second ActionRequest (now
   *  prevented independently by the idempotency key below, but the tighter default avoids relying
   *  on that alone). */
  readonly awaitDecisionTimeoutMs?: number;
}

const DEFAULT_AWAIT_DECISION_TIMEOUT_MS = 25_000;
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
  readonly status: ActionRequestStatus;
  readonly data?: unknown;
  readonly reason?: string;
}

/** The two `action` values `readTerminalOutcome` trusts as carrying a real terminal payload
 *  (`resultMetadata`/`reason`) — `execution.ts`'s `markActionRequestExecuted`/
 *  `markActionRequestFailed`, which write it in the same transaction as the status transition
 *  itself (see that module's own doc comment). P2-7 fix: `queryAudit`'s own filter takes a single
 *  exact `action`, not a set, so this reads a small page of the most recent audit rows for the
 *  resource and picks the first one whose `action` is one of these two — never the row a *later*,
 *  unrelated transition (`verify`/`compensate`) happened to also touch this resource with. */
const TERMINAL_OUTCOME_ACTIONS = new Set(['action_request.complete', 'action_request.fail']);
const TERMINAL_OUTCOME_SCAN_LIMIT = 10;

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
      limit: TERMINAL_OUTCOME_SCAN_LIMIT,
    }),
  );
  const terminalRow = rows.find((row) => TERMINAL_OUTCOME_ACTIONS.has(row.action));
  const payload = terminalRow?.payload as
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
      // P2-8 fix: report the row's *actual* last-observed status, not a fabricated 'failed' — the
      // winner may simply still be executing (or, once phase-2 inline execution is routed through
      // the drainer's per-gatekeeper ordering, still sitting `approved`/`auto_approved` behind an
      // earlier `pending_approval` row — §8.1 "遇 pending 停"). A caller reading `{status:
      // 'failed'}` here would wrongly conclude the action never happened when it may complete a
      // moment later; the already-wired async drain paths pick it up regardless.
      return { status: row?.status ?? 'pending_approval' };
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
  /** P1-1 fix — always populated by the caller (`requestActionHandler`, explicit or derived
   *  default), threaded straight through to `requestAction()`. */
  readonly idempotencyKey: string;
  /** P1-2 fix — the Worker's own WorkerRun (resolved from `claims.sid`), so
   *  `application/task/reaper.ts`'s ActionRequestPending/Updated routing can move the right Task
   *  to/from `waiting_approval`. `undefined` for a human caller (no WorkerRun to attribute to). */
  readonly parentWorkerRunId?: string;
}

/** The phase-1 `{result, resourceType, resourceId}` shape every branch of `runGovernedRequest`'s
 *  switch below starts from — only the branches that need one add an `afterCommit`. */
function phase1Result(actionRequest: ActionRequestRow): CapabilityHandlerResult {
  return {
    result: { actionRequestId: actionRequest.id, status: actionRequest.status },
    resourceType: 'action_request',
    resourceId: actionRequest.id,
  };
}

/**
 * Resolves an ActionRequest through the policy engine (`requestAction`, I6/I11) and then decides
 * what phase 1 returns and what — if anything — phase 2 (`afterCommit`) does next.
 *
 * **Idempotent replay changes what "the resolved status" can be** (P1-1 fix): with an
 * `idempotencyKey`, `requestAction` may return an *existing* row instead of a freshly-resolved
 * one — in any status a previous call already carried it to, including a terminal one. The switch
 * below is therefore exhaustive over every `ActionRequestStatus`, not just the three outcomes a
 * fresh resolution can produce (`denied`/`auto_approved`/`pending_approval`) — a replayed
 * `executed`/`failed`/`executing`/`approved`/`rejected`/`expired`/`compensated` row must report
 * *that* status (and, where relevant, its already-recorded result) rather than being coerced
 * through logic written only for a brand-new row.
 */
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
    idempotencyKey: args.idempotencyKey,
    parentWorkerRunId: args.parentWorkerRunId,
  });

  switch (actionRequest.status) {
    case 'denied':
      // P2-1 (denials leave zero trace) is addressed by a later commit in this same fix series
      // (phase 1 will return `{status:'denied'}` and defer this throw to `afterCommit`, so the
      // row/audit/outbox this `requestAction` call just wrote survive the commit). Unchanged here.
      throw new ActionRequestDeniedError(actionRequest.id);

    case 'rejected':
    case 'expired':
    case 'compensated':
    case 'proposed':
    case 'policy_evaluated':
      // Terminal (or, for the last two, never actually persisted mid-resolution — request-
      // action.ts's own doc comment) — nothing left to do; report the status as-is.
      return phase1Result(actionRequest);

    case 'auto_approved':
    case 'approved':
      return {
        ...phase1Result(actionRequest),
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

    case 'executing':
      // A replay landed on a row a *different* call (or the async drain path) is actively
      // executing right now — wait for it rather than trying to execute it a second time.
      return {
        ...phase1Result(actionRequest),
        afterCommit: async (pool: PoolLike) => {
          const withTransaction = createAdminWithTransaction(pool);
          const systemActorId = await resolveSystemActor(withTransaction, workspaceId);
          const outcome = await awaitConcurrentExecution(
            withTransaction,
            workspaceId,
            systemActorId,
            actionRequest.id,
          );
          return { ...outcome, actionRequestId: actionRequest.id };
        },
      };

    case 'executed':
    case 'verified':
    case 'failed':
      // A replay landed on an already-terminal row — read its stored outcome back rather than
      // re-deriving anything (never re-`apply`s).
      return {
        ...phase1Result(actionRequest),
        afterCommit: async (pool: PoolLike) => {
          const withTransaction = createAdminWithTransaction(pool);
          const systemActorId = await resolveSystemActor(withTransaction, workspaceId);
          const outcome = await readTerminalOutcome(
            withTransaction,
            workspaceId,
            systemActorId,
            actionRequest.id,
          );
          return {
            status: actionRequest.status === 'failed' ? 'failed' : 'executed',
            ...outcome,
            actionRequestId: actionRequest.id,
          };
        },
      };

    case 'pending_approval':
      if (!args.awaitDecision) {
        // The simulation is decoration on the approval card, not a precondition of the request: a
        // gate that cannot simulate (S2.12 host run — the ssh gate's simulate call failed and the
        // whole request rolled back, so the Worker's action never reached a human) must still
        // produce a pending ActionRequest. The failure is reported on the card instead. Re-running
        // this on a replay is harmless — read-only, and its result is decoration only.
        let simulate: unknown;
        try {
          simulate = await requireDeps().gatekeeperClient.simulate(args.gatekeeper.endpoint, {
            operation: args.operationName,
            params: args.operationParams,
            onBehalfOf: args.onBehalfOf,
          });
        } catch (err) {
          simulate = {
            unavailable: true,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
        return {
          result: { status: 'pending_approval', actionRequestId: actionRequest.id, simulate },
          resourceType: 'action_request',
          resourceId: actionRequest.id,
        };
      }

      return {
        ...phase1Result(actionRequest),
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

    default:
      // Exhaustiveness net, not a reachable branch (every ActionRequestStatus is a case above) —
      // report as-is rather than throwing, matching every other terminal branch's shape.
      return phase1Result(actionRequest);
  }
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

/**
 * `observe_operation` (S2.12 fix) — the dispatchable capability behind the `<gate>.<op>` observe
 * projection (packages/shared/src/capabilities.ts `gate` group; design doc §5.1.4 "门上的 observe
 * 类 Operation" is in the entry ceiling, §11 "观察免审"). Same observe path as `request_action`
 * (`runObserve`: gate `observe` + observed Facts + `gatekeeper_observe` Activity), but:
 *
 *   - an unpublished Operation is `OperationNotFoundError` (404) — I17 "未发布的清单对 agent 不可见",
 *     never the governed "unclassified → require approval" branch `request_action` takes;
 *   - an execute-class Operation is refused (`ForbiddenError`, 403) — this capability's mode is
 *     `observe`, which is exactly why an entry Handle may hold it while it holds no execute-mode
 *     capability at all (governance/capability/handles.ts `entryScope()`). An entry agent that
 *     needs an execute-class effect delegates through `invoke_worker`; a Worker uses
 *     `request_action`.
 *
 * Like `request_action`'s own observe path, this does not check `resources.gatekeeper` (S2.4
 * known gap — projected tools only exist for granted gates, but a direct call is not narrowed).
 */
export const observeOperationHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const {
    gatekeeperId,
    operation: operationName,
    params: operationParams,
  } = params as { gatekeeperId: string; operation: string; params?: Record<string, unknown> };
  const onBehalfOf = ctx?.principalId;
  if (!onBehalfOf) {
    throw new Error('observe_operation: caller context is required (dispatch.ts must supply it)');
  }

  const gatekeeper = await getGatekeeper(client, workspaceId, gatekeeperId);
  if (!gatekeeper) throw new GatekeeperNotFoundError(gatekeeperId);

  const published = await getPublishedOperation(client, workspaceId, gatekeeperId, operationName);
  if (!published) throw new OperationNotFoundError(gatekeeperId, operationName);
  if (published.operation.mode !== 'observe') {
    const mode = published.operation.mode;
    throw new ForbiddenError(
      `observe_operation: "${operationName}" on gatekeeper ${gatekeeperId} is ${mode}-class — delegate it through invoke_worker (a Worker requests it via request_action)`,
    );
  }

  return runObserve(
    client,
    workspaceId,
    gatekeeper,
    operationName,
    operationParams ?? {},
    onBehalfOf,
  );
};

export const requestActionHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const {
    gatekeeperId,
    operation: operationName,
    params: operationParams,
    idempotencyKey: callerIdempotencyKey,
  } = params as {
    gatekeeperId: string;
    operation: string;
    params?: Record<string, unknown>;
    idempotencyKey?: string;
  };
  const channel: CapabilityChannel = ctx?.channel ?? 'handle';
  const onBehalfOf = ctx?.principalId;
  if (!onBehalfOf) {
    throw new Error('request_action: caller context is required (dispatch.ts must supply it)');
  }
  const actorRuntime = channel === 'human' ? 'human' : 'pi';
  const requesterScope = resolveRequesterScope(channel, ctx?.scope, gatekeeperId);
  const resolvedParams = operationParams ?? {};
  const sid = channel === 'handle' ? ctx?.claims?.sid : undefined;

  // P1-1 fix: an explicit key is scoped to (on_behalf_of, sid) before it reaches the DB's
  // (workspace_id, idempotency_key) unique index (workspace scoping is the DB's own job — see
  // `scopeExplicitIdempotencyKey`'s doc comment); omitted, a default is derived from (sid|
  // principal, gatekeeperId, operation, stable params hash) so an unmarked retry still collapses
  // onto the same row. Only `mode:'execute'` calls reach `runGovernedRequest` (an ActionRequest is
  // only ever created there) — the observe path below never needs one.
  const idempotencyKey = callerIdempotencyKey
    ? scopeExplicitIdempotencyKey({ onBehalfOf, sid, key: callerIdempotencyKey })
    : deriveDefaultIdempotencyKey({
        identity: sid ?? onBehalfOf,
        gatekeeperId,
        operationName,
        params: resolvedParams,
      });

  // P1-2 fix: a Handle caller's own WorkerRun (resolved by `sid`, the same identity `report_task_
  // result` already trusts — `worker-result-handler.ts`'s own doc comment) becomes the
  // ActionRequest's `parent_worker_run_id`, so `application/task/reaper.ts`'s routing consumer can
  // move the *right* Task to/from `waiting_approval`. `undefined` for a human caller, or a Handle
  // whose session is not a WorkerRun (e.g. an entry session) — `request_action` structurally
  // cannot be called from an entry Handle anyway (governance/capability/handles.ts's
  // `ENTRY_CEILING_CAPABILITIES` never contains it), so this only ever resolves for a real Worker.
  const parentWorkerRunId = sid
    ? (await findWorkerRunBySessionId(client, workspaceId, sid))?.id
    : undefined;

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
      idempotencyKey,
      parentWorkerRunId,
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
    idempotencyKey,
    parentWorkerRunId,
  });
};
