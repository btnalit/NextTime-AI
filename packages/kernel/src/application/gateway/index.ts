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

// Error-mapping followup (docs/development-tasks.md, "unmapped error classes → 500"): four more
// substrate error classes reachable through real S3.2/S3.3 handlers that `interfaces/http/
// capability-route.ts`/`interfaces/ws/rpc.ts` had no mapping for — same re-export shape as
// `ExplainNodeNotFoundError` just above.
//  - `ConflictNotFoundError` (`resolve_conflict`'s `getConflictForUpdate`/`markConflictResolved` —
//    also the "not visible" case: `conflicts_visibility` RLS makes a Conflict the caller cannot
//    see indistinguishable from one that does not exist, so this one class already covers both)
//    and `DecisionNotFoundError` (`causal_chain`/`decision_impact`'s `getDecisionRow`) — both S3.2
//    `epistemic`-group capabilities (`epistemic-handlers.ts`'s own module doc comment).
//  - `FactNotFoundError`/`SupersedeIdentityMismatchError` (`substrate/graph`) — `supersede_fact`/
//    `invalidate_fact`/`verify_fact` (`fact-handlers.ts`) pass a caller-supplied `factId` straight
//    into `GraphStore.supersedeFact`/`invalidateFact`/`verifyFact`, which read the row (or check
//    I5's identity match) before writing; these two became live-reachable, not merely defined,
//    once S3.3 replaced the pre-S3.3 write stubs with real handlers.
export {
  ConflictNotFoundError,
  DecisionNotFoundError,
} from '../../substrate/epistemic/index.js';
export {
  FactNotFoundError,
  SupersedeIdentityMismatchError,
} from '../../substrate/graph/index.js';
// S3.1 (docs/development-tasks.md S3.1) — `propose_ontology_change`/`publish_ontology_version`
// (`ontology-handlers.ts`) pass caller input straight into `substrate/ontology/registry.ts`'s
// `proposeOntologyChange`/`publishOntologyDraft`.
export {
  OntologyChangeValidationError,
  OntologyDraftNotFoundError,
} from '../../substrate/ontology/index.js';
// S3.2 `verify_fact` (I3.6's "harder half" — epistemic-handlers.ts's own doc comment on this
// class): defined in the handler file itself, not a substrate module, so no six-layer workaround
// is needed — re-exported here purely to keep every capability-reachable error class importable
// from this one curated surface, matching every sibling error re-export above.
export { FactHasNoEvidenceError } from './epistemic-handlers.js';

export {
  dispatchCapability,
  CapabilityNotFoundError,
  InvalidCapabilityParamsError,
  CapabilityNotImplementedError,
} from './dispatch.js';
export type { DispatchDeps } from './dispatch.js';

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

// S3.3 (docs/development-tasks.md S3.3) — ingest-handlers.ts.
export { ObservationIdentityError, SourceNotFoundError } from './ingest-handlers.js';
