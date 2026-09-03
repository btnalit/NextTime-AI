/**
 * governance/gatekeepers: Gatekeeper instance registration + Operation manifest import/publish
 * (design doc §5.1.4, §7.5; docs/development-tasks.md S2.4). See registry.ts's own doc comment
 * for why this is a separate module from `governance/connections` (S2.13's human-facing
 * `request_connection` flow will call into this module's service interface, the same way
 * `governance/approval` calls into `governance/policy`/`governance/capability`).
 *
 * This module owns no relational table of its own — a Gatekeeper and its Operations are graph
 * Objects (`substrate/ontology`'s meta-object projections); it exposes only this service
 * interface — it must not be reached into from another module's internal files, and other modules
 * must not write these Object types directly (I16, `application/gateway/meta-ontology-guard.ts`).
 */

export { registerGatekeeper, getGatekeeper } from './registry.js';
export type {
  RegisterGatekeeperInput,
  RegisterGatekeeperResult,
  GatekeeperRecord,
} from './registry.js';

export {
  importManifest,
  proposeOperation,
  getOperation,
  getPublishedOperation,
  listPublishedOperationsForGatekeepers,
  publishOperation,
  deprecateOperation,
  OperationNotFoundError,
  IllegalTransition,
} from './manifest.js';
export type {
  OperationRecord,
  ImportManifestInput,
  ProposeOperationInput,
  PublishOperationInput,
  DeprecateOperationInput,
} from './manifest.js';

export { getOrCreateGatekeeperServicePrincipal } from './service-principal.js';

export { SYSTEM_ACTOR_PLACEHOLDER } from './system-actor.js';
