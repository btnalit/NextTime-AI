/**
 * substrate/epistemic: Activity/Observation/Evidence/Conflict/Decision; explain; visibility.
 *
 * S1.2 shipped only the minimal Activity start/end helper (`activities.ts`) — enough for the
 * graph module's `assertFact` callers to satisfy I3. S1.3 adds `explain` (design doc §7.1,
 * §7.10). Observation/Evidence/Conflict/Decision write paths beyond what `explain` reads remain
 * future scope. This module owns its own tables/migrations and exposes only a service interface
 * here — it must not be reached into from another module's internal files, and other modules
 * must not query its tables directly; cross-module coordination happens through domain events
 * (see packages/shared).
 */
export {
  ActivityNotFoundError,
  endActivity,
  startActivity,
} from './activities.js';
export type { ActivityRow, StartActivityInput } from './activities.js';

export { ExplainNodeNotFoundError, explain, explainByNodeId } from './explain.js';
export type {
  ExplainActivityRef,
  ExplainDecisionRef,
  ExplainFactRef,
  ExplainHumanAttestationRef,
  ExplainInput,
  ExplainObservationRef,
  ExplainPrincipalRef,
  ExplainResult,
  ExplainSourceRef,
} from './explain.js';

export {
  HumanAttestationRequiresHumanError,
  ReservedEvidenceKindError,
  attachEvidence,
  attachHumanAttestation,
  hasEvidence,
  listHumanAttestations,
} from './evidence.js';
export type {
  AttachEvidenceInput,
  AttachHumanAttestationInput,
  EvidenceRow,
  HumanAttestationRow,
} from './evidence.js';

// S11 GO3d: judging a predicate against an observation's result, and the lint that refuses one
// that proves nothing (predicate.ts's own module doc comment).
export {
  PREDICATE_EMPTY_PROBES,
  PREDICATE_LINT_PLAN_WORK,
  PREDICATE_REFUSAL_ANSWERS,
  evaluatePredicate,
  lintPredicate,
  predicateLiterals,
} from './predicate.js';
export type {
  PredicateEvaluation,
  PredicateLintBudget,
  PredicateLiteral,
  PredicateOutcome,
} from './predicate.js';

export {
  findSourceByName,
  registerPrivateSource,
  registerSource,
  recordSourceObservation,
  listSourceFreshness,
} from './sources.js';
export type {
  RegisterPrivateSourceInput,
  SourceRow,
  SourceFreshnessRow,
} from './sources.js';

// S3.2 冲突检测 (docs/development-tasks.md S3.2) — see conflicts.ts's own module doc comment for
// the write-path seam (`SqlGraphStore.assertFact` calls `resolveFactOrigin`/`sameFactOrigin`/
// `openConflict` directly) and decisions.ts's for the four read-only capabilities.
export {
  ConflictNotFoundError,
  conflictRulingInvalidationReason,
  getConflictForUpdate,
  listConflicts,
  markConflictResolved,
  openConflict,
  resolveFactOrigin,
  sameFactOrigin,
  shownInvalidationReason,
} from './conflicts.js';
export type {
  ConflictRow,
  ConflictRuling,
  ConflictsPage,
  FactOrigin,
  ListConflictsInput,
} from './conflicts.js';

export {
  DecisionNotFoundError,
  causalChain,
  decisionImpact,
  findPrecedents,
  queryDecisions,
} from './decisions.js';
export type {
  ActionRequestRef,
  CausalChainInput,
  CausalChainResult,
  DecisionImpactResult,
  DecisionRow,
  DecisionsPage,
  FactRef,
  FindPrecedentsInput,
  QueryDecisionsInput,
} from './decisions.js';

// Legacy 421: a Decision is read by whoever may see its subject (decision-visibility.ts).
export {
  GATEKEEPER_GRANT_RESOURCE_TYPE,
  actionRequestVisibleToCallerSql,
  decisionVisibleSql,
} from './decision-visibility.js';
export type { DecisionViewer } from './decision-visibility.js';
