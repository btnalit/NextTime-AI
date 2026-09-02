/**
 * substrate/epistemic: Activity/Observation/Evidence/Conflict/Decision; explain; visibility.
 *
 * S1.2 ships only the minimal Activity start/end helper (`activities.ts`) — enough for the graph
 * module's `assertFact` callers to satisfy I3. The rest (Observation/Evidence/Conflict/Decision,
 * `explain`, visibility) is S1.3 (design doc §7.1, §7.10). This module owns its own
 * tables/migrations and exposes only a service interface here — it must not be reached into
 * from another module's internal files, and other modules must not query its tables directly;
 * cross-module coordination happens through domain events (see packages/shared).
 */
export {
  ActivityNotFoundError,
  endActivity,
  startActivity,
} from './activities.js';
export type { ActivityRow, StartActivityInput } from './activities.js';
