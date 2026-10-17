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
 * (`application/platform/modules.ts`). Packs, more item kinds, verification and rollback follow in
 * later P1 PRs.
 *
 * Boundaries: it lives in `application` because applying calls publish functions across
 * `substrate` (ontology today; WorkerDefinition / Skill / Procedure in `application/worker` next).
 */

export {
  ACTION_TYPE_FIELD_RULES,
  LINK_TYPE_FIELD_RULES,
  OBJECT_TYPE_FIELD_RULES,
  ONTOLOGY_SECTION_NAMES,
  WIDENING_REASON_VALUES,
  type WideningReason,
  type WideningReasonCode,
  classificationOf,
  classifyOntologyDefinitionChange,
} from './classify.js';
export { contentDigest } from './digest.js';
export {
  type ApplyWorkspaceSegmentInput,
  type AppliedChangeItem,
  type AppliedWorkspaceSegment,
  type ChangeChannel,
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
  type UnconfirmedChangeItem,
} from './errors.js';
export type { OntologyVersionIntent } from './ontology-item.js';
export { type OntologyProvenance, loadOntologyProvenance } from './provenance.js';
