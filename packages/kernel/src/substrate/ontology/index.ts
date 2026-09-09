/**
 * substrate/ontology: OntologyVersion lifecycle, type validation, platform meta-ontology (design
 * doc §7.1, §7.10; docs/development-tasks.md S2.6, S3.1). This module owns its own table
 * (`ontology_versions`, migrations/core/0002_substrate.sql) and exposes only this service
 * interface — it must not be reached into from another module's internal files, and other
 * modules must not query its tables directly; cross-module coordination happens through domain
 * events (see packages/shared).
 *
 * S2.6 shipped the `ontology/*.yaml` loader + bootstrap-time publisher (`loader.ts` — the *first*
 * such mechanism in this codebase; see its own doc comment) and the platform meta-ontology's
 * Object-projection helpers (`meta-objects.ts` — WorkerDefinition/Gatekeeper/Operation/Skill/
 * Procedure). S3.1 (this task) ships: the OntologyDefinition schema's `identityKey`/`actionTypes`
 * extension (`schema.ts`, re-exporting `@nexttime/shared`'s `ontology-definition.ts` — see that
 * module's own doc comment for why the Zod shape itself lives there now); a generalized domain-pack
 * loader any number of named packs can call (`loader.ts`'s `publishOntologyDomainPack`/
 * `deriveOntologyPackId`); and the runtime propose/publish/get_type/list_types/validate logic
 * (`registry.ts`) `application/gateway/ontology-handlers.ts` wires to the five `ontology`-group
 * capabilities.
 */

export {
  OntologyDefinitionParseError,
  OntologyDefinitionSchema,
  deriveOntologyPackId,
  loadOntologyDefinitionFile,
  mapOntologyVersionRow,
  nextOntologyVersion,
  parseOntologyDefinition,
  publishOntologyDomainPack,
  publishOntologyVersion,
  resolveOntologyDir,
  seedPlatformMetaOntology,
} from './loader.js';
export type {
  ActionTypeDefinition,
  LinkTypeDefinition,
  ObjectTypeDefinition,
  OntologyDefinition,
  OntologyVersionDbRow,
  OntologyVersionRow,
  PublishOntologyDomainPackInput,
  PublishOntologyVersionInput,
} from './loader.js';

export {
  projectProcedureObject,
  projectSkillObject,
  projectWorkerDefinitionObject,
  registerGatekeeperObject,
  registerOperationDraftObject,
  setOperationStatusObject,
} from './meta-objects.js';
export type {
  OperationIdentity,
  OperationObjectResult,
  OperationOrigin,
  ProcedureObjectInput,
  RegisterGatekeeperObjectInput,
  RegisterGatekeeperObjectResult,
  RegisterOperationDraftInput,
  SkillObjectInput,
  WorkerDefinitionObjectInput,
} from './meta-objects.js';

export {
  OntologyChangeValidationError,
  OntologyDraftNotFoundError,
  getType,
  listTypes,
  loadVisibleOntology,
  proposeOntologyChange,
  publishOntologyDraft,
  validateLink,
} from './registry.js';
export type {
  LinkTypeSignature,
  OntologyTypeEntry,
  ProposeOntologyChangeInput,
  PublishOntologyDraftInput,
  ValidateLinkInput,
  ValidateLinkResult,
  VisibleOntologyFamily,
} from './registry.js';
