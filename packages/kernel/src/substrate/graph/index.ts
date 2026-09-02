/**
 * substrate/graph: Object/Link/Fact writes and queries; traverse/search/state_at;
 * find_operations/find_workers/find_procedures (find_* land with S2.7 per docs/development-
 * tasks.md; this module currently ships the S1.2 minimal facade).
 *
 * This module owns its own tables (`objects`, `links` — migrations/core/0002_substrate.sql,
 * 0006_object_identity.sql) and exposes only the `GraphStore` service interface here — it must
 * not be reached into from another module's internal files, and other modules must not query its
 * tables directly; cross-module coordination happens through domain events (see packages/shared).
 */

export {
  DEFAULT_RECENT_FACTS_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_TRAVERSE_DEPTH,
  DEFAULT_TRAVERSE_DIRECTION,
  EpistemicStatusOverrideError,
  FactNotFoundError,
  MAX_TRAVERSE_DEPTH,
  MIN_TRAVERSE_DEPTH,
  TRAVERSE_DIRECTION_VALUES,
  TraverseDepthError,
  assertNoCallerSuppliedEpistemicStatus,
  deriveEpistemicStatus,
  factLifecycleState,
  normalizeTraverseDepth,
} from './store.js';
export type {
  AssertFactInput,
  CallerPrincipal,
  Fact,
  FactLifecycleState,
  GraphObject,
  GraphStore,
  InvalidateFactInput,
  NeighborsInput,
  SearchInput,
  StateAtInput,
  StateAtResult,
  SupersedeFactInput,
  TraverseDirection,
  TraverseEdge,
  TraverseInput,
  TraverseResult,
  UpsertObjectInput,
} from './store.js';

export { SqlGraphStore } from './sql-store.js';

export type { SqlQuery } from './queries.js';
