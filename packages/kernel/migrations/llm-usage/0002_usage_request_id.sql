-- module: llm-usage, version: 0002
--
-- Per-request usage identity (R-67, review 2026-10-02, L6-13). 0001 deduplicated reports on
-- `(workspace_id, jti, started_at)`: `started_at` is llm-proxy's request start at millisecond
-- precision and every request a container sends carries the same Handle `jti`, so two requests
-- that started in the same millisecond collapsed into one row — the provider billed both, and
-- the workspace's daily cost / token sums and the per-Task budget counted one (I18). An agent can
-- do that on purpose with parallel requests.
--
-- `request_id`: llm-proxy now mints a UUID for every upstream request and sends it with the
-- record; `governance/llm-usage/service.ts` deduplicates on it (a replay of the same record
-- carries the same id). Nullable: a record from an llm-proxy that predates R-67 has none, and
-- falls back to the 0001 key exactly as before (a conflict on it is a replay) — that is the
-- rolling-upgrade window only, the two services ship in one release.
--
-- The 0001 unique key stays. The previous release's kernel names it in its `on conflict
-- (workspace_id, jti, started_at)`, which Postgres resolves only against a non-partial unique
-- index on exactly those columns; dropping or narrowing it would make that code fail every usage
-- insert after a code-only rollback. So a record with a `request_id` whose millisecond is already
-- taken by another request under the same Handle is stored a few microseconds later (always
-- within that millisecond — below what llm-proxy measures, so the instant is unchanged at the
-- precision it was reported). A later migration may drop the 0001 key, and the service its
-- microsecond step, once no rollback target needs the key.
--
-- Lock: `add column` without a default is a catalog-only change; the new index is partial on a
-- column that is null in every existing row, so its build reads `llm_usage` once and writes
-- nothing.
--
-- Runner ordering / advisory lock: same module (`llm-usage`), same key as 0001.
select pg_advisory_xact_lock(7241000301);

alter table llm_usage add column if not exists request_id uuid;

create unique index if not exists llm_usage_request_id_uidx
  on llm_usage (workspace_id, request_id)
  where request_id is not null;
