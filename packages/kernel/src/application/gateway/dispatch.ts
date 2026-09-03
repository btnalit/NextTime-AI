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

  return withWorkspace(deps.pool, { workspaceId, principalId }, async (client) => {
    const handlerResult = await handler(client, workspaceId, parsed.data, {
      channel: caller.channel,
      principalId,
    });
    await writeAudit(client, {
      workspaceId,
      actorPrincipalId: principalId,
      action: name,
      resourceType: handlerResult.resourceType,
      resourceId: handlerResult.resourceId,
      payload: { channel: caller.channel, onBehalfOf, params: parsed.data },
    });
    return handlerResult.result;
  });
}
