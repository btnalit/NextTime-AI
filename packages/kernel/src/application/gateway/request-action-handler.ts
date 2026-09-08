import { IllegalTransition } from '@nexttime/shared';
import type {
  ActionRequestStatus,
  CapabilityChannel,
  CapabilityScope,
  Role,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import { findWorkerRunBySessionId } from '../../application/task/index.js';
import type { ActionRequestRow, ApprovalDrainer } from '../../governance/approval/index.js';
import {
  awaitActionRequestResolution,
  getActionRequest,
  requestAction,
} from '../../governance/approval/index.js';
import {
  hasActiveGrant,
  listActiveGrantResourceScopes,
} from '../../governance/capability/index.js';
import {
  GatekeeperNotFoundError,
  OperationNotFoundError,
  SYSTEM_ACTOR_PLACEHOLDER,
  getGatekeeper,
  getOrCreateGatekeeperServicePrincipal,
  getPublishedOperation,
} from '../../governance/gatekeepers/index.js';
import type { GatekeeperRecord } from '../../governance/gatekeepers/index.js';
import { GATEKEEPER_RESOURCE_SCOPE_KEY } from '../../governance/policy/index.js';
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
 *   - `mode: 'execute'`, resolves `denied`          → R returns `{actionRequestId, status:'denied'}`
 *     + `afterCommit`; A: throws `ActionRequestDeniedError` (403) — deferred past commit (P2-1
 *     fix) so the denied row/audit/outbox survive, rather than a synchronous R-side throw rolling
 *     them back along with dispatch.ts's own transaction.
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
 *     still undecided, or `{status:'approved'}`/`{status:'auto_approved'}` (execution left to the
 *     already-wired async drain paths — the outbox consumer / periodic tick, `packages/kernel/src/
 *     index.ts`) if a decision landed but we ran out of budget to also finish executing it, or the
 *     drainer's own "遇 pending 停" ordering left it queued behind an earlier row.
 *
 * **Routed through the drainer, not a direct `ActionExecutor` call** (`tryExecuteInline`, P2-2
 * fix, review job 652a4abc: "inline execution bypasses drainer ordering"): phase 2 calls
 * `ApprovalDrainer.drainGatekeeper` — the same per-Gatekeeper single-flight, ascending, "遇
 * pending 停" queue the outbox consumer and the periodic tick already go through — rather than
 * `startActionRequestExecution` + `ActionExecutor.execute` directly, so a Worker's own inline
 * `auto_approved`/approved-within-budget request can never jump ahead of an earlier
 * `pending_approval` row on the same Gatekeeper. `drainGatekeeper`'s own loop has no per-row
 * `try/catch`, so a benign race with *any* other concurrent drain trigger winning
 * `startActionRequestExecution` on some row in the queue (not necessarily ours) surfaces as
 * `IllegalTransition` here — swallowed, since it means "the queue is being worked by someone else
 * right now". Either way, `tryExecuteInline` always finishes by reading back *this* row's own
 * actual status: `executed`/`verified`/`failed` reads the stored outcome
 * (`markActionRequestExecuted`/`markActionRequestFailed`'s own `resultMetadata`/`reason` payload —
 * `readTerminalOutcome` below); `approved`/`auto_approved` behind an earlier `pending_approval` row
 * reports that status as-is (nothing is currently executing it); otherwise (a concurrent execution
 * genuinely in flight, or the drainer's own single-flight lock skipped this call while another
 * in-flight drain handles it) `awaitConcurrentExecution` waits briefly rather than retrying `apply`
 * itself (a real retry after a genuine failure could double-run a non-idempotent effect — only the
 * gate's own idempotency store, keyed by `actionRequestId`, is trusted to dedupe `apply`).
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
  /** P2-2 fix (review job 652a4abc: "inline execution bypasses drainer ordering"): phase 2 no
   *  longer calls an `ActionExecutor` directly — it routes every execution attempt through this
   *  `ApprovalDrainer` (`drainGatekeeper`), the same per-Gatekeeper single-flight, ascending,
   *  "遇 pending 停" queue every other execution trigger (the outbox consumer, the periodic tick)
   *  already goes through, so a Worker's own inline `auto_approved`/`await_decision:true` request
   *  can never jump ahead of an earlier `pending_approval` row on the same Gatekeeper. Built by
   *  the composition root from the same `buildGatekeeperExecutionDeps` construction
   *  `createBackgroundServices` uses for its own drainer — "the single shared executor path"
   *  (coordinator review) now means *one definition of how to build the pieces*, materialized as
   *  two behaviorally-identical `ApprovalDrainer` instances (this one built synchronously in
   *  `createServer()`, the other once `createBackgroundServices` finishes its own async bootstrap)
   *  — the same split `buildGatekeeperExecutionDeps`'s own doc comment already documents for
   *  `ActionExecutor`. */
  readonly drainer: ApprovalDrainer;
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
 * Tries to execute one `auto_approved`/`approved` ActionRequest — routed through the
 * `ApprovalDrainer`'s per-Gatekeeper `drainGatekeeper` (P2-2 fix, review job 652a4abc: "inline
 * execution bypasses drainer ordering"), the same single-flight, ascending, "遇 pending 停" queue
 * every other execution trigger already goes through, rather than calling `startActionRequestExecution`
 * + `ActionExecutor.execute` directly (which let a Worker's own inline request jump ahead of an
 * earlier `pending_approval` row on the same Gatekeeper).
 *
 * `drainGatekeeper`'s own loop (`drainer.ts`) has no per-row `try/catch` — a benign race with
 * *any other* concurrent drain trigger winning `startActionRequestExecution` on some row in the
 * queue (not necessarily this one) surfaces as `IllegalTransition` here; swallowed, since it means
 * "the queue is being worked by someone else right now", not a real failure. Either way (drain
 * succeeded, was skipped in-flight, or raced), this function always finishes by reading back
 * *this* row's own actual status rather than trusting `DrainResult`'s aggregate counts:
 *
 *   - `executed`/`verified`/`failed` → the drain (by us or a racer) already finished it; read the
 *     stored outcome back (`readTerminalOutcome`), never re-`apply`.
 *   - `approved`/`auto_approved` and the drain stopped at an earlier `pending_approval` row
 *     (§8.1) → nothing is currently executing this row; report its status as-is rather than
 *     waiting for something that has not started — the already-wired async drain paths (the
 *     outbox consumer, the periodic tick) pick it up once the blocking row resolves.
 *   - otherwise (`executing`, or still `approved`/`auto_approved` with no `stoppedAtPending`
 *     signal — a concurrent execution is actively in flight, or the drainer's own single-flight
 *     lock skipped this call while another in-flight drain handles it) → `awaitConcurrentExecution`
 *     waits briefly for that winner to finish, rather than retrying `apply` itself.
 */
async function tryExecuteInline(
  drainer: ApprovalDrainer,
  withTransaction: WithTransactionFn,
  workspaceId: string,
  systemActorId: string,
  gatekeeperId: string,
  actionRequestId: string,
): Promise<ExecutionOutcome> {
  let stoppedAtPending = false;
  try {
    const drainResult = await drainer.drainGatekeeper(workspaceId, systemActorId, gatekeeperId);
    stoppedAtPending = drainResult.stoppedAtPending;
  } catch (err) {
    if (!(err instanceof IllegalTransition)) throw err;
    // benign race — see this function's own doc comment; fall through to reading our own row.
  }

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
  if ((row?.status === 'approved' || row?.status === 'auto_approved') && stoppedAtPending) {
    return { status: row.status };
  }
  return awaitConcurrentExecution(withTransaction, workspaceId, systemActorId, actionRequestId);
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
  drainer: ApprovalDrainer,
  withTransaction: WithTransactionFn,
  workspaceId: string,
  systemActorId: string,
  gatekeeperId: string,
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
          drainer,
          withTransaction,
          workspaceId,
          systemActorId,
          gatekeeperId,
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
    // Item 2 fix (review job 652a4abc: "resource_scope never populated (NULL) → scoped grants
    // never match"): every governed request now snapshots the Gatekeeper it targets as its own
    // `resource_scope` at request time — I14's approve-time scope check (`decide.ts`'s
    // `assertApproverScope`/`reads.ts`'s `approverHasScope`) and the `list_pending`/holder-routing
    // reads (`reads.ts`/`routing.ts`) can then actually narrow by gate, not just by bare
    // `action_kind` (which, per `getPublishedOperation`'s own shape, is just the Operation's own
    // name — the same op name could exist on multiple Gatekeepers).
    resourceScope: args.gatekeeper.gatekeeperId,
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
      // P2-1 fix (review job 652a4abc: "denials leave zero trace"): phase 1 returns
      // `{status:'denied'}` (a normal result, not a throw) so the row/audit/outbox this
      // `requestAction` call just wrote commit along with the rest of dispatch.ts's phase-1
      // transaction; the 403-shaped `ActionRequestDeniedError` is deferred to `afterCommit`,
      // thrown only once that row is durably on record. Previously this threw synchronously here
      // — inside dispatch.ts's still-open transaction — which rolled the denied row back along
      // with it, leaving the denial with no trace at all (I7/I11).
      return {
        ...phase1Result(actionRequest),
        afterCommit: async () => {
          throw new ActionRequestDeniedError(actionRequest.id);
        },
      };

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
          const { drainer } = requireDeps();
          const withTransaction = createAdminWithTransaction(pool);
          const systemActorId = await resolveSystemActor(withTransaction, workspaceId);
          const outcome = await tryExecuteInline(
            drainer,
            withTransaction,
            workspaceId,
            systemActorId,
            args.gatekeeper.gatekeeperId,
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
          const { drainer, awaitDecisionTimeoutMs } = requireDeps();
          const withTransaction = createAdminWithTransaction(pool);
          const systemActorId = await resolveSystemActor(withTransaction, workspaceId);
          const outcome = await pollAndExecute(
            drainer,
            withTransaction,
            workspaceId,
            systemActorId,
            args.gatekeeper.gatekeeperId,
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

/**
 * Resolves the calling human Principal's `role` (authority-tightening fix, review job 652a4abc
 * item 1) — a direct `principals` lookup by id, the same query `handlers.ts`'s own local
 * `currentPrincipalRole` runs, kept as a small local duplicate here rather than importing that
 * unexported helper (would require either exporting it from `handlers.ts`, which imports *this*
 * module's `requestActionHandler`/`observeOperationHandler` and would create a circular import, or
 * moving it to a shared module outside this task's owned files). `ctx.principalId` (the caller's
 * own id, dispatch.ts's `callerContext()`) is already in hand for a human caller — this only adds
 * the `role` column dispatch.ts does not thread through `CapabilityHandlerContext` today.
 */
async function resolvePrincipalRole(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<Role> {
  const result = await client.query<{ role: Role }>(
    'select role from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const role = result.rows[0]?.role;
  if (!role) {
    throw new Error(
      `request_action/observe_operation: principal ${principalId} not found in workspace ${workspaceId}`,
    );
  }
  return role;
}

/**
 * The real authorization gate for a **human** caller of `request_action`/`observe_operation`
 * (authority-tightening fix, review job 652a4abc lane3 P1-5 / lane2 P1: "resolveRequesterScope
 * synthesizes gate coverage for every human caller, so policy's own deny check could never fire" —
 * `minRole` alone cannot express this, see `request_action`'s own registry doc comment). A
 * non-owner human must hold an active `capability='gatekeeper'` Grant for `gatekeeperId`
 * (`hasActiveGrant`, the same convention `agent-host-runtime.ts`'s `ensureEntryHandle` already
 * flows into an entry Handle's `resources.gatekeeper` scope, S2.13). `auditor` is excluded
 * outright, before any grant lookup — §5.1.1 frames it as the one role deliberately scoped to
 * read-only (+secrets) access; a read-only role must never reach a Gatekeeper, granted or not.
 * `owner` bypasses the grant lookup entirely (§5.8/I14 "workspace owner 视为持有一切范围").
 *
 * Never called for a `handle`-channel caller: a Worker/entry Handle's own scope (checked by
 * `authorize.ts`'s `authorizeCapabilityCall` before this handler ever runs) is the actual gate for
 * that channel — this function is human-channel-only, matching this task's own scope.
 */
async function assertHumanGatekeeperAccess(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  role: Role,
  gatekeeperId: string,
): Promise<void> {
  if (role === 'auditor') {
    throw new ForbiddenError(
      'request_action/observe_operation: role "auditor" may never call a Gatekeeper (read-only role)',
    );
  }
  if (role === 'owner') return;

  const allowed = await hasActiveGrant(client, workspaceId, {
    principalId,
    resourceType: GATEKEEPER_RESOURCE_SCOPE_KEY,
    resourceId: gatekeeperId,
  });
  if (!allowed) {
    throw new ForbiddenError(
      `request_action/observe_operation: principal ${principalId} holds no active ` +
        `"${GATEKEEPER_RESOURCE_SCOPE_KEY}" grant for gatekeeper ${gatekeeperId}`,
    );
  }
}

/** The `gatekeeper` resource-scope key `evaluate()` reads (see `governance/policy/engine.ts`'s
 *  own `GATEKEEPER_RESOURCE_SCOPE_KEY` doc comment) — defense-in-depth alongside
 *  `assertHumanGatekeeperAccess` above (the real gate for a human caller), not a replacement for
 *  it: a Handle caller's own scope is returned unchanged (its Handle already carries the correct,
 *  attenuated scope). A human caller's scope is built from their real active `'gatekeeper'` Grants
 *  (`listActiveGrantResourceScopes`, item 1's own instruction) rather than synthesized to always
 *  cover whichever Gatekeeper is being asked about (the pre-fix behavior, which made policy's own
 *  `deny` decision unreachable for any human). `owner` is unconstrained — represented here by
 *  always including `gatekeeperId` itself (owner already bypassed the real gate above; no grant
 *  row is expected to exist for an owner testing a gate directly). For a non-owner, `gatekeeperId`
 *  is still unioned in explicitly: `assertHumanGatekeeperAccess` may have accepted a *wildcard*
 *  `'gatekeeper'` Grant (`resourceScope` unset) that `listActiveGrantResourceScopes` cannot
 *  represent as a concrete id (see that function's own doc comment: "skipped ... there is no
 *  single id to add") — without the union, a wildcard-granted principal would pass the real gate
 *  above only to have `evaluate()`'s own coverage check deny it a moment later. */
async function resolveRequesterScope(
  client: PoolClient,
  workspaceId: string,
  channel: CapabilityChannel,
  scope: CapabilityScope | undefined,
  role: Role | undefined,
  principalId: string,
  gatekeeperId: string,
): Promise<CapabilityScope> {
  if (channel === 'handle' && scope) return scope;

  if (role === 'owner') {
    return { capabilities: [], resources: { gatekeeper: [gatekeeperId] } };
  }

  const granted = await listActiveGrantResourceScopes(client, workspaceId, {
    principalId,
    resourceType: GATEKEEPER_RESOURCE_SCOPE_KEY,
  });
  const resourceIds = new Set(granted);
  resourceIds.add(gatekeeperId);
  return { capabilities: [], resources: { gatekeeper: [...resourceIds] } };
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
 * On the **handle** channel this still does not check `resources.gatekeeper` (S2.4 known gap —
 * projected tools only exist for granted gates, but a direct call is not narrowed; a Handle's own
 * scope is still checked by `authorize.ts` before this handler ever runs, just not narrowed to
 * *this* Gatekeeper specifically). On the **human** channel (item 1 fix, review job 652a4abc), a
 * non-owner caller must hold an active `'gatekeeper'` Grant for `gatekeeperId` —
 * `assertHumanGatekeeperAccess` below, same gate `request_action` now applies.
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

  if ((ctx?.channel ?? 'handle') === 'human') {
    const role = await resolvePrincipalRole(client, workspaceId, onBehalfOf);
    await assertHumanGatekeeperAccess(client, workspaceId, onBehalfOf, role, gatekeeperId);
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

  // Item 1 fix (review job 652a4abc lane3 P1-5 / lane2 P1): resolved once, before *any* branch
  // below (including the observe fallthrough and the I17 unclassified path) — every way this
  // handler can reach a Gatekeeper on the human channel goes through the same gate.
  let role: Role | undefined;
  if (channel === 'human') {
    role = await resolvePrincipalRole(client, workspaceId, onBehalfOf);
    await assertHumanGatekeeperAccess(client, workspaceId, onBehalfOf, role, gatekeeperId);
  }

  const requesterScope = await resolveRequesterScope(
    client,
    workspaceId,
    channel,
    ctx?.scope,
    role,
    onBehalfOf,
    gatekeeperId,
  );
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
