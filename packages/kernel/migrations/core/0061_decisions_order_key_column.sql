-- module: core, version: 0061
--
-- The Decision order key as a column (legacy 760, review #493 on #1247). 0060 indexed the key
-- `query_decisions` and `find_precedents` order by as an expression,
-- `date_trunc('milliseconds', created_at at time zone 'UTC')`. The newest page reads the first
-- rows of that index, but a page with a bound did not stop there: neither `date_trunc` nor
-- `at time zone` is LEAKPROOF, and `decisions` has row-level security, so for the application
-- role Postgres checks a condition on that expression only after the policy's own, never as an
-- index condition. A `since`, and the position a cursor page starts at, were filters: the scan
-- went from the newest Decision of the workspace through every row the bound excluded (for a
-- `since` that leaves fewer rows than the page, through the whole workspace). Only a superuser,
-- who bypasses RLS, got them as index conditions.
--
--   decisions.created_ms_utc  timestamp, generated from created_at, stored
--     the same key, `date_trunc('milliseconds', created_at at time zone 'UTC')`, written with the
--     row. A condition on a plain column with `>=` / `<` on timestamps (LEAKPROOF) is an index
--     condition for the application role too.
--   decisions (workspace_id, created_ms_utc desc, id desc)  decisions_workspace_created_ms_utc_idx
--     replaces 0060's decisions_workspace_created_ms_idx, which is dropped first so the rewrite
--     below does not rebuild it.
--
-- Same key, same order, same pages: `query_decisions` and `find_precedents` return what they
-- returned on 0060. No data changes; nothing writes the column (Postgres computes it), and every
-- INSERT names its columns, so the previous release writes Decisions unchanged on this schema.
-- Grants are on the table, so the application role reads the new column as it reads the others.
--
-- Lock time: adding a stored generated column rewrites `decisions` under an ACCESS EXCLUSIVE lock
-- until this file commits: every read and write of `decisions` waits for the rewrite and the
-- index build (206 000 Decisions, 64 MB, locally: 0.7 s). There is no lock-free way to add the
-- column; measure the table first (`select count(*) from decisions;`). Building 0060's index
-- ahead with `create index concurrently` (release.md §3.188) is no longer worth doing: this file
-- drops it.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration
-- (see 0001_identity.sql's own comment for the rationale).
select pg_advisory_xact_lock(7241000101);

drop index if exists decisions_workspace_created_ms_idx;

alter table decisions
  add column if not exists created_ms_utc timestamp
    generated always as (date_trunc('milliseconds', created_at at time zone 'UTC')) stored;

create index if not exists decisions_workspace_created_ms_utc_idx
  on decisions (workspace_id, created_ms_utc desc, id desc);
