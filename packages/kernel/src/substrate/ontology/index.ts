/**
 * substrate/ontology: OntologyVersion lifecycle, type validation, platform meta-ontology (design
 * doc §7.1, §7.10; docs/development-tasks.md S2.6). This module owns its own table
 * (`ontology_versions`, migrations/core/0002_substrate.sql) and exposes only this service
 * interface — it must not be reached into from another module's internal files, and other
 * modules must not query its tables directly; cross-module coordination happens through domain
 * events (see packages/shared).
 *
 * S2.6 ships: the `ontology/*.yaml` loader + bootstrap-time publisher (`loader.ts` — the *first*
 * such mechanism in this codebase; see its own doc comment) and the platform meta-ontology's
 * Object-projection helpers (`meta-objects.ts` — WorkerDefinition/Gatekeeper). Full
 * propose/publish/deprecate lifecycle management for arbitrary OntologyVersions (JSON Schema
 * projection, `validate`/`get_type`/`list_types` capabilities) remains S3.1 scope.
 */

export {
  OntologyDefinitionParseError,
  OntologyDefinitionSchema,
  loadOntologyDefinitionFile,
  parseOntologyDefinition,
  publishOntologyVersion,
  resolveOntologyDir,
  seedPlatformMetaOntology,
} from './loader.js';
export type {
  LinkTypeDefinition,
  ObjectTypeDefinition,
  OntologyDefinition,
  OntologyVersionRow,
  PublishOntologyVersionInput,
} from './loader.js';

export {
  projectWorkerDefinitionObject,
  registerGatekeeperObject,
  registerOperationDraftObject,
  setOperationStatusObject,
} from './meta-objects.js';
export type {
  OperationIdentity,
  OperationObjectResult,
  RegisterGatekeeperObjectInput,
  RegisterGatekeeperObjectResult,
  RegisterOperationDraftInput,
  WorkerDefinitionObjectInput,
} from './meta-objects.js';
