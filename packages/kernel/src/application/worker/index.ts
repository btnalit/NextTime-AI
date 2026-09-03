/**
 * application/worker: WorkerDefinition lifecycle and find_* worker discovery.
 *
 * S2.6 ships the WorkerDefinition registry (`definitions.ts`: propose/publish/deprecate,
 * `getPublishedEntryDefinition`, `requirePublishedWorkerDefinition`). `find_operations` /
 * `find_workers` / `find_procedures` land with S2.7. This module owns its own table
 * (`worker_definitions`, migrations/worker/0001_worker_definitions.sql) and exposes only this
 * service interface here — it must not be reached into from another module's internal files, and
 * other modules must not query its table directly; cross-module coordination happens through
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
