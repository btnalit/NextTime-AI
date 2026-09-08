/**
 * application/gateway: the two-channel authentication and capability-dispatch front door (design
 * doc §7.1 gateway, §7.10; docs/development-tasks.md S1.3). Owns the identity tables
 * (`workspaces`/`principals`/`sessions`, migrations/core/0001_identity.sql — see auth.ts's module
 * doc for why) and exposes only this service interface; `interfaces/http` is the only consumer.
 */

export {
  generateApiKey,
  hashApiKey,
  lookupPrincipalByApiKeyHash,
  authenticateHuman,
} from './auth.js';
export type { PrincipalRow, SessionRow, AuthenticatedHuman } from './auth.js';

export { authenticateHandle } from './handle-auth.js';
export type { HandleAuthDeps } from './handle-auth.js';

export { resolveCaller, UnauthorizedError } from './resolve-caller.js';
export type { ResolvedCaller, ResolveCallerDeps } from './resolve-caller.js';

export { authorizeCapabilityCall, roleSatisfiesMinRole, ForbiddenError } from './authorize.js';

// `explainHandler` (handlers.ts) already depends on `substrate/epistemic` directly (the six-layer
// rule permits application -> substrate); re-exported here so `interfaces/http`/`interfaces/ws`
// (which may not import substrate directly, .dependency-cruiser.cjs) can map it without their own
// layering workaround — see this module's own doc comment ("interfaces/http is the only consumer").
export { ExplainNodeNotFoundError } from '../../substrate/epistemic/index.js';

export {
  dispatchCapability,
  CapabilityNotFoundError,
  InvalidCapabilityParamsError,
  CapabilityNotImplementedError,
} from './dispatch.js';
export type { DispatchDeps } from './dispatch.js';

export { AssertFactWriteNotImplementedError } from './handlers.js';
export type {
  CapabilityHandler,
  CapabilityHandlerContext,
  CapabilityHandlerResult,
} from './handlers.js';

export {
  MetaOntologyWriteForbiddenError,
  assertMetaOntologyHandleWriteAllowed,
} from './meta-ontology-guard.js';

export {
  ActionRequestDeniedError,
  GatekeeperNotFoundError,
  requestActionHandler,
  setRequestActionDeps,
} from './request-action-handler.js';
export type { RequestActionHandlerDeps } from './request-action-handler.js';

export {
  createAdminWithTransaction,
  createGatekeeperActionExecutor,
  deriveDefaultIdempotencyKey,
  hashStableParams,
  reapStaleExecutingActionRequests,
  scopeExplicitIdempotencyKey,
} from './action-executor.js';
export type {
  GatekeeperActionExecutorDeps,
  ReapStaleExecutingActionRequestsOptions,
  ReapStaleExecutingActionRequestsResult,
  WithTransactionFn,
} from './action-executor.js';

export { writeObservedFacts } from './observed-facts.js';
export type { ObservedFactCandidateInput, WrittenObservedFact } from './observed-facts.js';

export { registerActionRequestDrainConsumer } from './action-request-drain-consumer.js';
export type { ActionRequestUpdatedSource } from './action-request-drain-consumer.js';

export {
  WorkerResultValidationError,
  listAllowedOperationsHandler,
  reportTaskResultHandler,
} from './worker-result-handler.js';

export {
  ConnectionCredentialRequiredError,
  ConnectionManifestFetchError,
  connectGatekeeperHandler,
  createConnectionHandler,
  listConnectionRequestsHandler,
  requestConnectionHandler,
  setConnectionHandlerDeps,
} from './connection-handlers.js';
export type { ConnectionHandlerDeps } from './connection-handlers.js';

export { publishManifestHandler } from './operation-manifest-handlers.js';

// S3.11 (docs/development-tasks.md "中台控制面") — control-plane read/management capabilities.
export {
  PrincipalNotFoundError,
  PrincipalOperationRefusedError,
} from './members-handlers.js';
export type { PrincipalDetailRow } from './members-handlers.js';

// `GatekeeperNotFoundError` itself is already exported above (from request-action-handler.js) —
// gatekeeper-read-handlers.ts re-exports the exact same class (governance/gatekeepers/index.js's
// own `GatekeeperNotFoundError`), not a second one, so it is not re-exported a third time here.
export { setGatekeeperReadHandlerDeps, probeGatekeeperHealth } from './gatekeeper-read-handlers.js';
export type { GatekeeperHealth, GatekeeperReadHandlerDeps } from './gatekeeper-read-handlers.js';

export { ModelsCatalogUnavailableError, readModelCatalog } from './models-catalog-handler.js';
export type { ModelCatalogEntry } from './models-catalog-handler.js';

// S3.13 (docs/development-tasks.md "每用户智能体配置") — agent-profile-handlers.ts.
export { AgentProfileValidationError } from './agent-profile-handlers.js';
