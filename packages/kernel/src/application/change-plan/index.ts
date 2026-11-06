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
 * Skills and Workers install and roll back like its ontology families.
 *
 * P1-E: `operation_version` items (`operation-item.ts`: a revision of a published Operation's
 * governance fields, never of what the gate runs), and verifying a segment (`verify.ts`: whether
 * what it wrote is still in effect and the systems its source needs are in place, recorded on the
 * segment).
 *
 * S11 AA3b-1: Admin proposals (`admin-proposals.ts`, migrations/governance/0032) — what an admin
 * agent proposes from its trial workspace, one segment per target workspace, for the owners of
 * those workspaces to decide; read back and withdrawn by the agent for its administrator and by
 * platform administrators.
 *
 * S11 AA3b-2: the owner of a target workspace decides the segment addressed to it
 * (`admin-proposal-segments.ts`, migrations/governance/0033): its intents resolve to the
 * workspace's own objects, its dry run is this core's, and applying it records a change segment of
 * source `admin_proposal` — the second source (§5.4 "一个核心，两种来源") — rolled back like any
 * other.
 *
 * Boundaries: it lives in `application` because applying calls publish functions across
 * `substrate` (ontology), `application/worker` (Skills, WorkerDefinitions) and
 * `governance/gatekeepers` (Operations).
 */

export {
  ACTION_TYPE_FIELD_RULES,
  LINK_TYPE_FIELD_RULES,
  OBJECT_TYPE_FIELD_RULES,
  ONTOLOGY_SECTION_NAMES,
  WIDENING_REASON_VALUES,
  type WideningReason,
  type WideningReasonCode,
  OPERATION_FIELD_RULES,
  SKILL_FIELD_RULES,
  WORKER_DEFINITION_FIELD_RULES,
  classificationOf,
  classifyOntologyDefinitionChange,
  classifyOperationChange,
  classifySkillChange,
  classifyWorkerDefinitionChange,
} from './classify.js';
export { derivePackComponentId } from './component-id.js';
export { contentDigest } from './digest.js';
export {
  type AdminProposalOrigin,
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
export { assertChangeApplierIsPerson } from './applier.js';
export {
  ChangeApplierNotAPersonError,
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
  type KeptWorkerField,
  type SkillItemContent,
  type SkillVersionIntent,
  type StoredFamilyItem,
  type WorkerDefinitionVersionIntent,
  type ChangeGateRef,
  type WorkerItemGates,
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
  OPERATION_ITEM_FIELDS,
  type OperationFieldChange,
  type OperationGovernanceValues,
  type OperationItemTarget,
  type OperationVersionIntent,
  type StoredOperationItem,
  parseStoredOperationItem,
} from './operation-item.js';
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
  type ChangeVerification,
  ChangeSegmentSupersededError,
  ChangeVerificationCooldownError,
  type CheckSourceRequirements,
  type RequirementCheck,
  type RequirementGateCheck,
  type SourceRequirements,
  type VerifiedChangeSegment,
  type VerifyChangeSegmentInput,
  loadChangeVerification,
  verifyChangeSegment,
} from './verify.js';
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
export {
  AdminProposalCredentialError,
  AdminProposalNotFoundError,
  AdminProposalNotOpenError,
  type AdminProposalInput,
  AdminProposalInvalidError,
  type AdminProposalProblem,
  type AdminProposalProposer,
  AdminProposalQuotaExceededError,
  AdminProposalRoleMismatchError,
  type AdminProposalScope,
  AdminProposalTargetNotChosenError,
  AdminProposalTargetUnavailableError,
  type CheckedAdminProposal,
  adminProposalDigest,
  adminProposalPlatformSegmentDigest,
  adminProposalQuotaResetsAt,
  adminProposalSegmentDigest,
  agentProposalOf,
  checkAdminProposal,
  checkPackInstallProposal,
  type PackInstallProposalInput,
  type PackOnOffer,
  type StoredWorkspaceSegment,
  getAdminProposal,
  listAdminProposals,
  proposeAdminProposal,
  readAdminProposal,
  withdrawAdminProposal,
} from './admin-proposals.js';
export {
  ADMIN_PROPOSAL_REJECTION_LIMIT_VAR,
  ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR,
  type AdminProposalRejectionBreaker,
  AdminProposalTargetRejectedRepeatedlyError,
  type AdminProposalTargetRejection,
  type AdminProposalTrippedTarget,
  DEFAULT_ADMIN_PROPOSAL_REJECTION_LIMIT,
  DEFAULT_ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS,
  adminProposalRejectionBreaker,
  assertTargetsNotRejectedRepeatedly,
  readAdminProposalRejectionsSince,
  rejectionWindowStart,
  trippedTargetOf,
} from './admin-proposal-breaker.js';
export {
  type AppliedAdminProposalSegment,
  type ApplyAdminProposalSegmentInput,
  AdminProposalPackMismatchError,
  AdminProposalSegmentBlockedError,
  AdminProposalSegmentIsPackInstallError,
  AdminProposalSegmentNotFoundError,
  AdminProposalSegmentNotOpenError,
  AdminProposalSegmentUnchangedError,
  AdminProposalTargetNoLongerChosenError,
  type AdminProposalWorkerGateChoice,
  AdminProposalWorkerGatesError,
  PlatformSegmentChangedError,
  PlatformSegmentNotAppliedError,
  applyAdminProposalSegment,
  countAdminProposalSegments,
  getAdminProposalSegment,
  listAdminProposalSegments,
  markPackInstallSegmentApplied,
  type OpenPackInstallSegment,
  openPackInstallSegment,
  previewAdminProposalSegment,
  rejectAdminProposalSegment,
} from './admin-proposal-segments.js';
export {
  type AppliedPlatformSegment,
  type ApplyPlatformSegmentInput,
  DependentSegmentsAppliedError,
  type PlatformChangeDrift,
  PlatformChangeDriftedError,
  PlatformChangeSegmentNotFoundError,
  PlatformChangeSegmentRolledBackError,
  PlatformSegmentBlockedError,
  PlatformSegmentNotFoundError,
  type RejectedPlatformSegment,
  type RolledBackPlatformChangeSegment,
  applyPlatformSegment,
  getPlatformChangeSegment,
  listPlatformChangeSegments,
  previewPlatformChangeRollback,
  previewPlatformSegment,
  rejectPlatformSegment,
  rollBackPlatformChangeSegment,
} from './platform-segments.js';
