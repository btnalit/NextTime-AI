import { IllegalTransition } from '@nexttime/shared';
import type { CapabilityChannel, CapabilityScope } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import {
  awaitActionRequestResolution,
  getActionRequest,
  getActionRequestOrThrow,
  markActionRequestExecuted,
  markActionRequestFailed,
  requestAction,
  startActionRequestExecution,
} from '../../governance/approval/index.js';
import type { ActionRequestRow } from '../../governance/approval/index.js';
import { getGatekeeper, getPublishedOperation } from '../../governance/gatekeepers/index.js';
import type { GatekeeperRecord } from '../../governance/gatekeepers/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler, CapabilityHandlerResult } from './capability-handler.js';
import { writeObservedFacts } from './observed-facts.js';

/**
 * application/gateway/request-action-handler: the `request_action` capability (design doc
 * §5.1.4/§7.4/§8.1; docs/development-tasks.md S2.4). See this file's own long doc comment in the
 * PR body for the full decision table; short version:
 *
 *   - unresolved Operation (draft/unknown, I17)  → treated as unclassified: `blast_radius: medium,
 *     auto_approvable: false, await_decision: true` — always goes through the ActionRequest path,
 *     never executes without a human decision.
 *   - `mode: 'observe'`                          → calls the gate's `observe` directly inside an
 *     Activity; writes `observedFacts` as `observed` Facts; never creates an ActionRequest.
 *   - `mode: 'execute'`, resolves `auto_approved` → executes immediately (same transaction — see
 *     `executeActionRequestInline`'s own doc comment for why) and returns the result.
 *   - `mode: 'execute'`, resolves `pending_approval`, `await_decision: true` → polls (same
 *     transaction) until resolved or `timeoutMs`; `approved` → executes inline; `rejected`/
 *     `expired` → returns that status; still `pending_approval` at timeout → returns
 *     `{status:'pending_approval', actionRequestId}`.
 *   - `mode: 'execute'`, resolves `pending_approval`, `await_decision: false` → calls the gate's
 *     `simulate` once and returns `{status:'pending_approval', actionRequestId, simulate}`
 *     immediately.
 *   - resolves `denied`                          → throws `ActionRequestDeniedError` (403-shaped).
 *
 * `ApprovalDrainer` wiring for the async path (a human approving well after `await_decision`
 * timed out, or an `await_decision:false` request) is `packages/kernel/src/index.ts`'s job — an
 * outbox consumer on `ActionRequestUpdated` (`approved`/`auto_approved`) plus a periodic tick, per
 * this task's own deliverable list.
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

/**
 * `drainer`/`withTransaction` are deliberately **not** part of this handler's own dependencies:
 * every execution path here runs on the one `client` dispatch.ts already opened for this call
 * (see `executeActionRequestInline`'s own doc comment for why — a fresh connection cannot see this
 * handler's own still-uncommitted `requestAction` insert). The `ApprovalDrainer` this task also
 * wires is for the *other* trigger paths — a human `approve()` well after this handler's own
 * `await_decision` timeout already returned, or an `await_decision:false` request — which
 * `packages/kernel/src/index.ts` (composition root) wires directly via an outbox consumer +
 * periodic tick, not through this module at all.
 */
export interface RequestActionHandlerDeps {
  readonly gatekeeperClient: GatekeeperClient;
  /** `await_decision:true`'s poll timeout — default 90s (design doc §8.2's own `invoke_worker`
   *  timeout default; this task brief: "configurable, default 90s"). */
  readonly awaitDecisionTimeoutMs?: number;
}

const DEFAULT_AWAIT_DECISION_TIMEOUT_MS = 90_000;

/** The seam `packages/kernel/src/index.ts` (composition root) uses to wire in the real
 *  `GatekeeperClient` — same "module-level singleton set once at startup" shape `handlers.ts`
 *  already uses for `AgentRuntime` (`setAgentRuntimeForHandlers`). */
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

// -------------------------------------------------------------------------------------------
// observe path
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
// inline execution — auto_approved (immediately) and pending_approval->approved (after the poll
// below observes a human decision). Same-transaction (not the drainer's own separate-connection
// pattern, `application/gateway/action-executor.ts`): dispatch.ts commits only after this whole
// handler returns, so a fresh connection opened mid-handler cannot see this handler's own
// still-uncommitted `requestAction` insert (see this file's PR-body doc for the full reasoning) —
// executing through the *same* `client` is the only way to both create the ActionRequest and
// return its actual execution result from one capability call.
// -------------------------------------------------------------------------------------------

interface InlineExecutionOutcome {
  readonly status: 'executed' | 'failed';
  readonly data?: unknown;
  readonly reason?: string;
}

/**
 * Executes one `auto_approved`/`approved` ActionRequest via the SAME `client`. If a concurrent
 * drain (the async outbox-consumer trigger, or the periodic tick — `packages/kernel/src/index.ts`)
 * already won the race and moved the row past this status, `startActionRequestExecution` throws
 * `IllegalTransition`; that is treated as "someone else already executed it", not a failure — this
 * function re-reads the row's final status rather than retrying `apply` a second time (a real
 * `apply` retry after a genuine failure could double-run a non-idempotent effect; only the gate's
 * own idempotency store, keyed by `actionRequestId`, is trusted to dedupe an `apply` call, and this
 * function makes at most one). The trade-off, accepted and documented (see PR body "已知偏离"): in
 * that race-loss case the caller gets the correct terminal `status` but not the winner's `data`.
 */
async function executeActionRequestInline(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<InlineExecutionOutcome> {
  let executing: ActionRequestRow;
  try {
    executing = await startActionRequestExecution(client, workspaceId, actionRequestId);
  } catch (err) {
    if (err instanceof IllegalTransition) {
      const row = await getActionRequestOrThrow(client, workspaceId, actionRequestId);
      if (row.status === 'executed' || row.status === 'verified') return { status: 'executed' };
      if (row.status === 'failed')
        return { status: 'failed', reason: 'concurrent execution failed' };
      // Still `executing` (a concurrent apply is in flight) or some other unexpected state — report
      // the row's own status rather than guessing.
      return { status: 'failed', reason: `concurrent transition left status "${row.status}"` };
    }
    throw err;
  }

  const gatekeeper = await getGatekeeper(client, workspaceId, executing.gatekeeperId);
  if (!gatekeeper) {
    await markActionRequestFailed(client, workspaceId, actionRequestId, {
      reason: 'gatekeeper_not_found',
    });
    return { status: 'failed', reason: 'gatekeeper_not_found' };
  }

  try {
    const applyResult = await requireDeps().gatekeeperClient.apply(gatekeeper.endpoint, {
      operation: executing.actionKind,
      params: executing.params,
      onBehalfOf: executing.onBehalfOf,
      idempotencyKey: executing.id,
    });
    const activity = await startActivity(client, workspaceId, {
      kind: 'gatekeeper_apply',
      principalId: executing.onBehalfOf,
      metadata: { actionRequestId: executing.id, gatekeeperId: executing.gatekeeperId },
    });
    await writeObservedFacts(
      client,
      workspaceId,
      executing.gatekeeperId,
      applyResult.observedFacts ?? [],
      activity.id,
    );
    await endActivity(client, workspaceId, activity.id, 'completed');
    await markActionRequestExecuted(client, workspaceId, actionRequestId, {
      resultMetadata: { data: applyResult.data },
    });
    return { status: 'executed', data: applyResult.data };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markActionRequestFailed(client, workspaceId, actionRequestId, { reason });
    return { status: 'failed', reason };
  }
}

// -------------------------------------------------------------------------------------------
// execute path (declared execute Operation, or the I17 unclassified fallback)
// -------------------------------------------------------------------------------------------

interface RunGovernedExecuteArgs {
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

async function runGovernedExecute(
  client: PoolClient,
  workspaceId: string,
  args: RunGovernedExecuteArgs,
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
    const outcome = await executeActionRequestInline(client, workspaceId, actionRequest.id);
    return {
      result: { ...outcome, actionRequestId: actionRequest.id },
      resourceType: 'action_request',
      resourceId: actionRequest.id,
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

  const timeoutMs = requireDeps().awaitDecisionTimeoutMs ?? DEFAULT_AWAIT_DECISION_TIMEOUT_MS;
  const resolved = await awaitActionRequestResolution(
    () => getActionRequest(client, workspaceId, actionRequest.id),
    { timeoutMs },
  );

  if (!resolved || resolved.status === 'pending_approval') {
    return {
      result: { status: 'pending_approval', actionRequestId: actionRequest.id },
      resourceType: 'action_request',
      resourceId: actionRequest.id,
    };
  }

  if (resolved.status === 'approved') {
    const outcome = await executeActionRequestInline(client, workspaceId, actionRequest.id);
    return {
      result: { ...outcome, actionRequestId: actionRequest.id },
      resourceType: 'action_request',
      resourceId: actionRequest.id,
    };
  }

  if (resolved.status === 'rejected' || resolved.status === 'expired') {
    return {
      result: { status: resolved.status, actionRequestId: actionRequest.id },
      resourceType: 'action_request',
      resourceId: actionRequest.id,
    };
  }

  // Some other terminal status (e.g. already executed/failed by a concurrent path by the time we
  // polled) — report it as-is rather than re-deriving.
  return {
    result: { status: resolved.status, actionRequestId: actionRequest.id },
    resourceType: 'action_request',
    resourceId: actionRequest.id,
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

  if (!published) {
    // I17: draft/unknown Operation → unclassified, always require_approval, never execute.
    return runGovernedExecute(client, workspaceId, {
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
  if (operation.mode === 'observe') {
    return runObserve(client, workspaceId, gatekeeper, operationName, resolvedParams, onBehalfOf);
  }

  return runGovernedExecute(client, workspaceId, {
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
