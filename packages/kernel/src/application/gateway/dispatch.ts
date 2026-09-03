import type { Capability } from '@nexttime/shared';
import { getCapability } from '@nexttime/shared';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { authorizeCapabilityCall } from './authorize.js';
import { CAPABILITY_HANDLERS } from './handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/dispatch: `POST /api/cap/<name>`'s business logic (design doc §9.3, I11;
 * docs/development-tasks.md S1.3, items 3-4). `interfaces/http` calls only `dispatchCapability` —
 * everything below (registry lookup, authorization, param validation, the transaction, the audit
 * write) is this module's job, keeping `interfaces/http` a thin HTTP adapter that never reaches
 * into substrate directly (depcruise `kernel-interfaces-must-not-reach-into-substrate-directly`).
 *
 * I11 mechanism: a capability with a wired handler (handlers.ts) runs inside exactly one
 * `withWorkspace()` transaction that also calls `writeAudit` before returning — if the audit
 * insert throws (e.g. a forced failure in a test, or a real constraint violation), `withWorkspace`
 * rolls back the *whole* transaction, so the handler's own writes (once S1.4+ wires a write
 * capability here) never persist either. A capability with no wired handler
 * (`CapabilityNotImplementedError`, HTTP 501) never opens a transaction at all — nothing was
 * "executed", so there is nothing to audit.
 *
 * **Two-phase handlers** (S2.4, `CapabilityHandlerResult.afterCommit` — capability-handler.ts):
 * a handler may return `afterCommit(pool)` alongside its phase-1 `result`. Phase 1 (this
 * function's existing behavior, unchanged) runs the handler inside the one transaction, writes
 * the audit row for the *phase-1* result, and commits — this is deliberately correct as-is: the
 * phase-1 result (e.g. `request_action`'s `{actionRequestId, status}`) is what actually happened
 * inside this transaction, and any phase-2 state transitions (approve-triggered execution, etc.)
 * write their own audit rows through the governed service functions that perform them, same as
 * every other multi-step governed flow in this codebase. Only once the transaction has committed
 * (so the row a phase-2 continuation needs to see — e.g. a human approving it from a different
 * connection — is actually visible outside this call) does `dispatchCapability` invoke
 * `afterCommit(deps.pool)` and use *its* resolved value as the capability's real `result`. A
 * handler with no `afterCommit` behaves exactly as before. `afterCommit` is intentionally generic
 * and tiny (one function, `pool` in, `unknown` out) — `request_action` (this task) is the first
 * user; S2.7's `invoke_worker` (a long, possibly-async wait with the same "must not hold the
 * request's own transaction open" constraint) is expected to need the identical shape. An error
 * thrown by `afterCommit` propagates and is mapped exactly like any other handler error — the
 * phase-1 work has already committed by then regardless (it is not, and cannot be, rolled back by
 * a phase-2 failure).
 */

export class CapabilityNotFoundError extends Error {
  constructor(name: string) {
    super(`unknown capability "${name}"`);
    this.name = 'CapabilityNotFoundError';
  }
}

export class InvalidCapabilityParamsError extends Error {
  readonly issues: unknown;
  constructor(name: string, issues: unknown) {
    super(`invalid params for capability "${name}"`);
    this.name = 'InvalidCapabilityParamsError';
    this.issues = issues;
  }
}

export class CapabilityNotImplementedError extends Error {
  constructor(name: string) {
    super(`capability "${name}" is not implemented yet`);
    this.name = 'CapabilityNotImplementedError';
  }
}

export interface DispatchDeps {
  readonly pool: PoolLike;
}

/** The acting (workspaceId, principalId) for RLS + audit attribution — I13: always the Handle's
 *  `on_behalf_of` for a handle caller, never a session/agent id of its own. */
function callerContext(caller: ResolvedCaller): { workspaceId: string; principalId: string } {
  if (caller.channel === 'human') {
    return { workspaceId: caller.principal.workspaceId, principalId: caller.principal.id };
  }
  return { workspaceId: caller.claims.ws, principalId: caller.claims.obo };
}

function lookupCapabilityOrThrow(name: string): Capability {
  const capability = getCapability(name);
  if (!capability) throw new CapabilityNotFoundError(name);
  return capability;
}

/**
 * Dispatches one capability call. Throws `CapabilityNotFoundError` (404), `ForbiddenError` (403,
 * authorize.ts), `InvalidCapabilityParamsError` (400), or `CapabilityNotImplementedError` (501);
 * resolves with the handler's `result` on success.
 */
export async function dispatchCapability(
  deps: DispatchDeps,
  caller: ResolvedCaller,
  name: string,
  rawParams: unknown,
): Promise<unknown> {
  const capability = lookupCapabilityOrThrow(name);

  authorizeCapabilityCall(caller, capability);

  const parsed = capability.paramsSchema.safeParse(rawParams ?? {});
  if (!parsed.success) throw new InvalidCapabilityParamsError(name, parsed.error.issues);

  const handler = CAPABILITY_HANDLERS.get(name);
  if (!handler) throw new CapabilityNotImplementedError(name);

  const { workspaceId, principalId } = callerContext(caller);
  const onBehalfOf = principalId;

  const handlerResult = await withWorkspace(
    deps.pool,
    { workspaceId, principalId },
    async (client) => {
      const result = await handler(client, workspaceId, parsed.data, {
        channel: caller.channel,
        principalId,
        scope: caller.channel === 'handle' ? caller.claims.scope : undefined,
        // S2.7 addition (purely additive, alongside `scope` above): `invoke_worker`'s child-Handle
        // minting needs the caller's full Handle claims (jti/sid/exp, not just scope) to attenuate
        // from and to look up its own WorkerRun (I18 depth) — this is the only place that has
        // verified claims in hand.
        ...(caller.channel === 'handle' ? { claims: caller.claims } : {}),
      });
      await writeAudit(client, {
        workspaceId,
        actorPrincipalId: principalId,
        action: name,
        resourceType: result.resourceType,
        resourceId: result.resourceId,
        payload: { channel: caller.channel, onBehalfOf, params: parsed.data },
      });
      return result;
    },
  );

  if (handlerResult.afterCommit) {
    return handlerResult.afterCommit(deps.pool);
  }
  return handlerResult.result;
}
