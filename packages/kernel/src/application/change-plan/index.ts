/**
 * application/change-plan: the ChangePlan core (docs/goal-orchestration-and-admin-agent-plan-
 * 2026-10-16.md §3.1–§3.4, §5.4; S11 P1). Owns `migrations/governance/0025_change_segments.sql`
 * (`change_segments`, `change_items`) and exposes only this interface.
 *
 * P1-A (this cut): workspace segments with `ontology_version` items — plan (dry run, whitelist
 * classification, digest), apply in one transaction with the reviewed digest re-checked, a record
 * of what changed and one audit row per item, and which item installed a family's current
 * version (`provenance.ts`; `provenance_unknown` for one installed before P1 or outside the core).
 * `install_module` / `upgrade_module` and workspace creation's default modules apply through it
 * (`application/platform/modules.ts`).
 *
 * P1-B: reading segments back (`segments.ts`; `inspect.ts` adds what each item's target is now)
 * and rolling a segment back (`rollback.ts`: compare before writing, the same whitelist on the
 * inverse, one transaction).
 *
 * P1-C: packs (`application/packs`, Pack Contract v1) are the source a segment is planned from;
 * a planned item carries what it would change for the reviewer (`ChangeItemDetail`), and the
 * in-use count for removed types is shared (`usage.ts`).
 *
 * P1-D: `skill_version` and `worker_definition_version` items (`family-item.ts`), so a pack's
 * Skills and Workers install and roll back like its ontology families. Operation items and
 * recorded verification follow in later P1 PRs.
 *
 * Boundaries: it lives in `application` because applying calls publish functions across
 * `substrate` (ontology) and `application/worker` (Skills, WorkerDefinitions).
 */

export {
  ACTION_TYPE_FIELD_RULES,
  LINK_TYPE_FIELD_RULES,
  OBJECT_TYPE_FIELD_RULES,
  ONTOLOGY_SECTION_NAMES,
  WIDENING_REASON_VALUES,
  type WideningReason,
  type WideningReasonCode,
  SKILL_FIELD_RULES,
  WORKER_DEFINITION_FIELD_RULES,
  classificationOf,
  classifyOntologyDefinitionChange,
  classifySkillChange,
  classifyWorkerDefinitionChange,
} from './classify.js';
export { contentDigest } from './digest.js';
export {
  type ApplyWorkspaceSegmentInput,
  type AppliedChangeItem,
  type AppliedWorkspaceSegment,
  type ChangeChannel,
  type ChangeItemDetail,
  type ChangeItemIntent,
  type ChangeSource,
  type PlannedChangeItem,
  type WorkspaceSegmentInput,
  type WorkspaceSegmentPlan,
  applyWorkspaceSegment,
  assertWideningConfirmed,
  planWorkspaceSegment,
} from './engine.js';
export {
  ChangeConfirmationRequiredError,
  ChangePlanChangedError,
  type ChangeRollbackConflict,
  ChangeRollbackConflictError,
  ChangeSegmentRolledBackError,
  type UnconfirmedChangeItem,
} from './errors.js';
export {
  type ContentVersionRef,
  type FamilyItemKind,
  type FamilyItemTarget,
  type FamilyVersionIntent,
  type SkillItemContent,
  type SkillVersionIntent,
  type StoredFamilyItem,
  type WorkerDefinitionVersionIntent,
  parseStoredFamilyItem,
  readFamilyHeadDigest,
  skillTargetOf,
  workerDefinitionTargetOf,
} from './family-item.js';
export {
  type InspectedChangeItem,
  type InspectedChangeSegment,
  inspectChangeSegment,
} from './inspect.js';
export {
  type OntologyTypeChanges,
  type OntologyTypeNames,
  type OntologyVersionIntent,
  type StoredOntologyItem,
  ontologyTypeChanges,
  parseStoredOntologyItem,
} from './ontology-item.js';
export {
  type ChangeProvenance,
  loadFamilyProvenance,
  loadOntologyProvenance,
} from './provenance.js';
export {
  type ItemRollbackDetail,
  type PlannedItemRollback,
  type RollBackWorkspaceSegmentInput,
  type SegmentRollbackPlan,
  type SegmentRollbackPreview,
  previewSegmentRollback,
  rollBackWorkspaceSegment,
} from './rollback.js';
export { countRemovedTypeUsage } from './usage.js';
export {
  type ChangeItemRecord,
  type ChangePrincipalRef,
  type ChangeSegmentRecord,
  ChangeSegmentNotFoundError,
  type ChangeSegmentsPage,
  DEFAULT_LIST_CHANGE_SEGMENTS_LIMIT,
  type ListChangeSegmentsInput,
  MAX_LIST_CHANGE_SEGMENTS_LIMIT,
  listChangeSegments,
} from './segments.js';
