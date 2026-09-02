/**
 * application/gateway: the two-channel authentication and capability-dispatch front door (design
 * doc §7.1 gateway, §7.10; docs/development-tasks.md S1.3). Owns the identity tables
 * (`workspaces`/`principals`/`sessions`, migrations/core/0001_identity.sql — see auth.ts's module
 * doc for why) and exposes only this service interface; `interfaces/http` is the only consumer.
 */

export { hashApiKey, lookupPrincipalByApiKeyHash, authenticateHuman } from './auth.js';
export type { PrincipalRow, SessionRow, AuthenticatedHuman } from './auth.js';

export { authenticateHandle } from './handle-auth.js';
export type { HandleAuthDeps } from './handle-auth.js';

export { resolveCaller, UnauthorizedError } from './resolve-caller.js';
export type { ResolvedCaller, ResolveCallerDeps } from './resolve-caller.js';

export { authorizeCapabilityCall, roleSatisfiesMinRole, ForbiddenError } from './authorize.js';

export {
  dispatchCapability,
  CapabilityNotFoundError,
  InvalidCapabilityParamsError,
  CapabilityNotImplementedError,
} from './dispatch.js';
export type { DispatchDeps } from './dispatch.js';

export type { CapabilityHandler, CapabilityHandlerResult } from './handlers.js';
