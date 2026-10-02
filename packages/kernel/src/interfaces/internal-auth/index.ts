/**
 * interfaces/internal-auth: per-caller credential authentication for the kernel's internal plane
 * (`/internal/*` HTTP routes + the `/internal/agent-host` WebSocket upgrade), the per-route caller
 * allow-list and the `NEXTTIME_SUBNET_WORKERS` peer rule. See internal-auth.ts's doc comment for
 * the threat model, the credential derivation and the four checks; `@nexttime/shared`'s
 * `internal-token.ts` for the wire contract every internal client shares with this module.
 *
 * `packages/kernel/src/index.ts` (composition root) calls `loadInternalToken()` in `main()` and
 * `registerInternalPlaneGuard(app, options.internalAuth)` in `createServer()`.
 */

export {
  INTERNAL_CREDENTIAL_LABEL_PREFIX,
  INTERNAL_PLANE_ROUTE_PREFIX,
  INTERNAL_ROUTE_CALLERS,
  createInternalPlaneGuard,
  deriveInternalCredential,
  loadInternalToken,
  loadSupervisorToken,
  registerInternalPlaneGuard,
} from './internal-auth.js';
export type {
  InternalCaller,
  InternalPlaneAuthConfig,
  InternalPlaneDecision,
  InternalPlaneGuard,
  InternalPlaneRejectReason,
} from './internal-auth.js';
export { InvalidCidrError, createSubnetMatcher } from './subnet.js';
export type { SubnetMatcher } from './subnet.js';
