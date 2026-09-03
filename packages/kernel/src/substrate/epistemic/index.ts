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

export { attachEvidence } from './evidence.js';
export type { AttachEvidenceInput, EvidenceRow } from './evidence.js';

export { registerPrivateSource, recordSourceObservation } from './sources.js';
export type { RegisterPrivateSourceInput, SourceRow } from './sources.js';
