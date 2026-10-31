/**
 * application/worker: WorkerDefinition/Skill/Procedure lifecycle and find_* worker discovery.
 *
 * S2.6 ships the WorkerDefinition registry (`definitions.ts`: propose/publish/deprecate,
 * `getPublishedEntryDefinition`, `requirePublishedWorkerDefinition`). `find_operations` /
 * `find_workers` / `find_procedures` land with S2.7. S2.14 adds the Skill (`skills.ts`) and
 * Procedure (`procedures.ts`) registries, mirroring `definitions.ts`'s own structure. This module
 * owns its own tables (`worker_definitions`, `skills`, `procedures` —
 * migrations/worker/0001_worker_definitions.sql, 0002_skills_procedures.sql) and exposes only this
 * service interface here — it must not be reached into from another module's internal files, and
 * other modules must not query its tables directly; cross-module coordination happens through
 * domain events (see packages/shared).
 */
export {
  deprecatePublishedWorkerDefinitionVersion,
  deprecateWorkerDefinition,
  getPublishedEntryDefinition,
  getWorkerDefinition,
  listWorkerDefinitions,
  listWorkerDefinitionsPage,
  loadPublishedWorkerDefinitionHead,
  proposeWorkerDefinition,
  publishWorkerDefinition,
  requirePublishedWorkerDefinition,
  validateWorkerDefinitionContent,
  workerDefinitionFamilyKind,
  WorkerDefinitionKindMismatchError,
  WorkerDefinitionNotFoundError,
  WorkerDefinitionNotPublishedError,
  WorkerDefinitionValidationError,
} from './definitions.js';
export {
  unresolvedWorkerDefinitionReferences,
  WORKER_DEFINITION_REFERENCE_FIELDS,
  WorkerDefinitionReferenceError,
} from './definition-references.js';
export type {
  UnresolvedWorkerDefinitionReferences,
  WorkerDefinitionReferenceField,
  WorkerDefinitionReferenceSources,
} from './definition-references.js';
export {
  EntryTemplateChangedError,
  EntryTemplateCurrentError,
  entryTemplateDigest,
  entryTemplateStatus,
  loadEntryTemplate,
  loadWorkerDefinitionTemplate,
  proposeEntryTemplateUpgrade,
} from './entry-template.js';
export type {
  EntryTemplate,
  EntryTemplateExpectation,
  EntryTemplateStatus,
  EntryTemplateUpgrade,
} from './entry-template.js';
export type {
  ListWorkerDefinitionsPageFilter,
  ProposeWorkerDefinitionInput,
  WorkerDefinitionRow,
  WorkerDefinitionsPage,
  WorkerDefinitionVersionRef,
} from './definitions.js';

export {
  assertNoPendingSkillDraft,
  assertSkillNameAvailable,
  deprecatePublishedSkillVersion,
  deprecateSkill,
  getSkill,
  latestPublishedSkills,
  listPublishedSkillIds,
  listSkills,
  loadPublishedSkillHead,
  loadSkillVersion,
  proposeSkill,
  publishSkill,
  readSkillVersions,
  renderSkillMarkdownFile,
  skillDraftDigest,
  skillReviewContent,
  resolvePublishedSkills,
  validateSkillContent,
  SkillFamilyNameChangedError,
  SkillNameConflictError,
  SkillNotFoundError,
  SkillValidationError,
} from './skills.js';
export type { ListSkillsFilter, ProposeSkillInput, SkillRow, SkillsPage } from './skills.js';

export {
  deprecateProcedure,
  getProcedure,
  getPublishedProcedure,
  latestPublishedProcedures,
  listProcedures,
  procedureDraftDigest,
  procedureReviewContent,
  proposeProcedure,
  publishProcedure,
  ProcedureNotFoundError,
  ProcedureStepReferenceError,
  ProcedureTemplateError,
} from './procedures.js';
export type {
  ListProceduresFilter,
  ProcedureRow,
  ProceduresPage,
  ProposeProcedureInput,
  PublishProcedureOptions,
} from './procedures.js';

export type { DraftViewer } from './draft-visibility.js';

export { FamilyDraftPendingError } from './family-version.js';
export type { FamilyKind } from './family-version.js';

export { lockWorkerRegistry } from './registry-lock.js';

export { DraftEvaluatingError } from './draft-evaluating.js';
// S10 E3-3: what a draft's proposer (and their agent) is told of its evaluations.
export { readSkillDraftVerdicts } from './draft-verdicts.js';
export {
  DEFAULT_DRAFT_EXPIRY_DAYS,
  DraftNotDiscardableError,
  DraftNotRejectableError,
  discardDraft,
  expireDraftsOnce,
  rejectDraft,
} from './draft-lifecycle.js';
export type {
  DiscardedDraft,
  DraftRef,
  ExpireDraftsOnceOptions,
  ExpireDraftsOnceResult,
  RejectableDraftKind,
  RejectableDraftRef,
  RejectedDraft,
} from './draft-lifecycle.js';
export { listDraftRejections, recordDraftRejection } from './draft-rejections.js';
export type { DraftRejectionInput, DraftRejectionRow } from './draft-rejections.js';
