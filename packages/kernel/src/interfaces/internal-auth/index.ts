/**
 * interfaces/internal-auth: shared-secret authentication for the kernel's internal plane
 * (`/internal/*` HTTP routes + the `/internal/agent-host` WebSocket upgrade) and the
 * `NEXTTIME_SUBNET_WORKERS` peer rule. See internal-auth.ts's doc comment for the threat model
 * and the three checks; `@nexttime/shared`'s `internal-token.ts` for the wire contract every
 * internal client shares with this module.
 *
 * `packages/kernel/src/index.ts` (composition root) calls `loadInternalToken()` in `main()` and
 * `registerInternalPlaneGuard(app, options.internalAuth)` in `createServer()`.
 */

export {
  INTERNAL_PLANE_ROUTE_PREFIX,
  createInternalPlaneGuard,
  loadInternalToken,
  registerInternalPlaneGuard,
} from './internal-auth.js';
export type {
  InternalPlaneAuthConfig,
  InternalPlaneGuard,
  InternalPlaneRejectReason,
} from './internal-auth.js';
export { InvalidCidrError, createSubnetMatcher } from './subnet.js';
export type { SubnetMatcher } from './subnet.js';
