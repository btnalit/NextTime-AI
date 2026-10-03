-- module: core, version: 0039
--
-- Indexes for the provenance lookups and foreign-key child columns that had none (R-66, review
-- 2026-10-02, L4-9). `observations` carried only its primary key, so every lookup by Activity or
-- Source scanned the whole workspace's Observations — the largest table, with no retention
-- (STATUS leftover 103; this migration adds no retention or deletion, that is a separate
-- decision):
--
--   observations (workspace_id, activity_id)
--     `link_visible_to_caller` (0013) — the `links_visibility` RLS policy and the explicit Fact-
--     read predicate (`substrate/graph/queries.ts`) evaluate it once per candidate Fact;
--     `resolveFactOrigin` (`substrate/epistemic/conflicts.ts`) on every `assertFact` with a prior
--     row; and the foreign key to `activities`.
--   observations (workspace_id, source_id, created_at)
--     the silent-Source check (`listSourceFreshness` in `substrate/epistemic/sources.ts`, and
--     `invariant-checks.ts`): its `max(created_at)` per Source becomes one index probe instead of
--     a walk over every Observation that Source ever produced; the observation window's `exists`
--     (`substrate/graph/queries.ts`); and the foreign key to `sources`.
--   links (workspace_id, last_observation_id) where last_observation_id is not null
--     the foreign key to `observations` (0026), partial like 0018's `links_observation_id_idx`
--     (a Fact asserted without an Observation leaves the column null).
--   activities (workspace_id, started_by, kind, created_at)
--     `findAttributableTurn` (`application/host-bridge/turn-attribution.ts`) — equality on the
--     first three columns, `created_at` serves both its `order by created_at desc limit 1` and the
--     recency window — run for each egress observation and each LLM usage record; its leading
--     columns also cover the foreign key to `principals`.
--
-- Additive only: no data, constraint or grant changes, and no query changes meaning — the planner
-- simply has a cheaper path. Confirm on the host with `explain analyze` (the PR has the queries).
--
-- Lock time: the runner applies each file in one transaction, so `create index concurrently` is
-- not available here. A plain `create index` takes a SHARE lock — reads go on, INSERT / UPDATE /
-- DELETE on `observations`, `links` and `activities` wait — and all three are held until this file
-- commits. `scripts/apply-release.sh` migrates while the previous release's kernel is still
-- serving, so collector ingestion, Fact writes and Turn bookkeeping queue (they do not fail) for
-- the build. Expected on the host: `observations` ≈ 0.6 M rows means two sequential scans plus a
-- sort of two-uuid keys, a few seconds each; `links` and `activities` are smaller. Total well
-- under a minute — measure the table sizes first with the PR's pre-check query.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration
-- (see 0001_identity.sql's own comment for the rationale).
select pg_advisory_xact_lock(7241000101);

create index if not exists observations_activity_idx
  on observations (workspace_id, activity_id);

create index if not exists observations_source_idx
  on observations (workspace_id, source_id, created_at);

create index if not exists links_last_observation_id_idx
  on links (workspace_id, last_observation_id)
  where last_observation_id is not null;

create index if not exists activities_started_by_idx
  on activities (workspace_id, started_by, kind, created_at);
