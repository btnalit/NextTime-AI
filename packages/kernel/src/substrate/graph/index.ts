/**
 * substrate/graph: Object/Link/Fact writes and queries; traverse/search/state_at;
 * find_operations/find_workers/find_procedures (find_* land with S2.7 per docs/development-
 * tasks.md; this module currently ships the S1.2 minimal facade).
 *
 * This module owns its own tables (`objects`, `links` — migrations/core/0002_substrate.sql,
 * 0006_object_identity.sql) and exposes only the `GraphStore` service interface here — it must
 * not be reached into from another module's internal files, and other modules must not query its
 * tables directly; cross-module coordination happens through domain events (see packages/shared).
 *
 * **One deliberate exception (S3.2, docs/development-tasks.md)**: `SqlGraphStore.assertFact`
 * itself calls `substrate/epistemic`'s `resolveFactOrigin`/`sameFactOrigin`/`openConflict`
 * directly, not via an outbox event — I5's "异源不一致 → Conflict；同源变化 → supersede" must be
 * decided synchronously, in the same transaction as the insert it gates (the design doc's own
 * "写入路径按 source_id 判定"), which an async outbox consumer cannot give. This is one direction
 * only (`substrate/graph` → `substrate/epistemic`'s public interface, never its tables) — see
 * `epistemic/conflicts.ts`'s own module doc comment for the full reasoning.
 */

export {
  DEFAULT_RECENT_FACTS_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  DEFAULT_TRAVERSE_DEPTH,
  DEFAULT_TRAVERSE_DIRECTION,
  EpistemicStatusOverrideError,
  FactNotFoundError,
  MAX_TRAVERSE_DEPTH,
  MIN_TRAVERSE_DEPTH,
  SupersedeIdentityMismatchError,
  TRAVERSE_DIRECTION_VALUES,
  TraverseDepthError,
  assertNoCallerSuppliedEpistemicStatus,
  deriveEpistemicStatus,
  factContentEquals,
  factLifecycleState,
  normalizeTraverseDepth,
} from './store.js';
export type {
  AssertFactInput,
  AssertFactResult,
  CallerPrincipal,
  Fact,
  FactLifecycleState,
  GraphObject,
  GraphStore,
  InvalidateFactInput,
  NeighborsInput,
  SearchInput,
  SearchPage,
  StateAtInput,
  StateAtResult,
  SupersedeFactInput,
  TraverseDirection,
  TraverseEdge,
  TraverseInput,
  TraverseResult,
  UpsertObjectInput,
  VerifyFactInput,
} from './store.js';

export { SqlGraphStore } from './sql-store.js';

export type { SqlQuery } from './queries.js';

export {
  DEFAULT_FIND_MEANS_LIMIT,
  findOperationCandidates,
  findProcedureCandidates,
  findWorkerDefinitionCandidates,
} from './find-means.js';
export type { FindMeansInput } from './find-means.js';
