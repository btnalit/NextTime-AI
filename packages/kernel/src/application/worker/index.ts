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
  deprecateWorkerDefinition,
  getPublishedEntryDefinition,
  getWorkerDefinition,
  listWorkerDefinitions,
  proposeWorkerDefinition,
  publishWorkerDefinition,
  requirePublishedWorkerDefinition,
  validateWorkerDefinitionContent,
  WorkerDefinitionKindMismatchError,
  WorkerDefinitionNotFoundError,
  WorkerDefinitionNotPublishedError,
  WorkerDefinitionValidationError,
} from './definitions.js';
export type {
  ProposeWorkerDefinitionInput,
  WorkerDefinitionRow,
  WorkerDefinitionVersionRef,
} from './definitions.js';

export {
  deprecateSkill,
  listSkills,
  proposeSkill,
  publishSkill,
  renderSkillMarkdownFile,
  resolvePublishedSkills,
  validateSkillContent,
  SkillNotFoundError,
  SkillValidationError,
} from './skills.js';
export type { ProposeSkillInput, SkillRow } from './skills.js';

export {
  deprecateProcedure,
  getProcedure,
  listProcedures,
  proposeProcedure,
  publishProcedure,
  ProcedureNotFoundError,
  ProcedureStepReferenceError,
} from './procedures.js';
export type { ProcedureRow, ProposeProcedureInput } from './procedures.js';
