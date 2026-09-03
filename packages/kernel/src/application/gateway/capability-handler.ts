import type { CapabilityChannel, CapabilityScope } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';

/**
 * application/gateway/capability-handler: the `CapabilityHandler` shape every capability handler
 * (handlers.ts, request-action-handler.ts, operation-manifest-handlers.ts) implements. Split out
 * of handlers.ts (S2.4) so those other files can depend on the *type* without a circular module
 * import back through handlers.ts's own `CAPABILITY_HANDLERS` map (which imports them) —
 * `.dependency-cruiser.cjs`'s `no-circular` check is a warning, not a hard failure, but there is
 * no reason to carry the cycle when it costs nothing to avoid.
 */

export interface CapabilityHandlerResult {
  readonly result: unknown;
  readonly resourceType?: string;
  readonly resourceId?: string;
  /**
   * Optional post-commit continuation (S2.4 two-phase handler — see dispatch.ts's own doc
   * comment for the full contract). When present, `dispatchCapability` runs it *after* the
   * phase-1 transaction (this handler's own `client`) has committed, passing the same `pool` the
   * capability route was given, and uses its resolved value as the capability's real result
   * instead of `result` above. Exists so a handler whose real outcome depends on state becoming
   * visible to *other* connections (e.g. a human approving an ActionRequest from a different
   * request) never has to hold the phase-1 transaction open across that wait — `request_action`
   * (request-action-handler.ts) is the first user.
   */
  readonly afterCommit?: (pool: PoolLike) => Promise<unknown>;
}

/**
 * The caller-identity facts a handler needs beyond `(client, workspaceId, params)` — S2.6
 * addition, purely additive (see `CapabilityHandler`'s own doc comment below): `channel` is what
 * `application/gateway/meta-ontology-guard.ts`'s I16 check on the graph write path needs
 * (`assertFactHandler`), which `callerContext()` in dispatch.ts already computes for every call
 * but had no way to hand to a handler before this.
 *
 * `scope` (S2.4 addition, purely additive like `channel` before it): the calling Handle's
 * `CapabilityScope` (`{capabilities, resources}`), `undefined` on the human channel (a human
 * Principal has no Handle at all). `request_action`'s handler is the first caller — it needs the
 * requester's `resources.gatekeeper` list to pass through to `governance/policy`'s coverage check
 * (`governance/policy/engine.ts`'s `GATEKEEPER_RESOURCE_SCOPE_KEY` doc comment) — dispatch.ts's
 * `callerContext()` already has `caller.claims.scope` in hand for a handle caller; this field is
 * just where it is threaded through.
 */
export interface CapabilityHandlerContext {
  readonly channel: CapabilityChannel;
  readonly principalId: string;
  readonly scope?: CapabilityScope;
}

/**
 * `ctx` is optional so every handler written before S2.6 — none of which declare a 4th parameter
 * — continues to satisfy this type unchanged (a function of fewer parameters is assignable to a
 * type expecting more, TypeScript's own function-parameter-count contravariance); only
 * `dispatch.ts`'s one call site needs to actually pass it.
 */
export type CapabilityHandler = (
  client: PoolClient,
  workspaceId: string,
  params: unknown,
  ctx?: CapabilityHandlerContext,
) => Promise<CapabilityHandlerResult>;
