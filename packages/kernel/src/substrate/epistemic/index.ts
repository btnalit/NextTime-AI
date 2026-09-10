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
  ExplainInput,
  ExplainObservationRef,
  ExplainPrincipalRef,
  ExplainResult,
  ExplainSourceRef,
} from './explain.js';

export { attachEvidence, hasEvidence } from './evidence.js';
export type { AttachEvidenceInput, EvidenceRow } from './evidence.js';

export { registerPrivateSource, registerSource, recordSourceObservation } from './sources.js';
export type { RegisterPrivateSourceInput, SourceRow } from './sources.js';

// S3.2 冲突检测 (docs/development-tasks.md S3.2) — see conflicts.ts's own module doc comment for
// the write-path seam (`SqlGraphStore.assertFact` calls `resolveFactOrigin`/`sameFactOrigin`/
// `openConflict` directly) and decisions.ts's for the four read-only capabilities.
export {
  ConflictNotFoundError,
  getConflictForUpdate,
  listConflicts,
  markConflictResolved,
  openConflict,
  resolveFactOrigin,
  sameFactOrigin,
} from './conflicts.js';
export type {
  ConflictRow,
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
