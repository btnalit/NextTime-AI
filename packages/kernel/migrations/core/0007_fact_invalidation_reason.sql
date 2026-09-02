-- module: core, version: 0007
--
-- Persists Fact invalidation reasons (S1.2 review follow-up; docs/development-tasks.md S1.3 item
-- 7): `InvalidateFactInput.reason` (packages/kernel/src/substrate/graph/store.ts) has been
-- accepted since S1.2 but silently dropped by `SqlGraphStore.invalidateFact` — there was no
-- column to put it in, and I4's content-column immutability trigger
-- (`links_block_content_update`, 0002_substrate.sql) blocks writing any column on an
-- already-recorded `links` row except the lifecycle-bookkeeping ones it explicitly enumerates
-- (superseded_at/invalidated_at/supersedes_id/epistemic_status/confidence/verified_by), so a raw
-- `alter table` with no matching write path would not have been enough on its own.
--
-- This adds a nullable `invalidation_reason` column. No change to `links_block_content_update`
-- is needed: that function is an explicit opt-in blocklist of nine named columns (link_type,
-- source_object_id, target_object_id, properties, valid_from, valid_until, activity_id,
-- asserted_by, recorded_at) — a column not named there (as `invalidated_at` already wasn't) is
-- unrestricted by construction, so `invalidation_reason` is "whitelisted" simply by never being
-- added to that list. Re-declaring the trigger function here to enumerate the same nine columns
-- again would only risk drifting from the canonical definition in 0002_substrate.sql for no
-- behavioral gain.
--
-- Cross-process bootstrap lock: see 0001_identity.sql's comment for the full rationale — the
-- same `pg_advisory_xact_lock` call is the first statement of every file in this module.
select pg_advisory_xact_lock(7241000101);

alter table links add column if not exists invalidation_reason text;
