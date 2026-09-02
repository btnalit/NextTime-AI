-- module: core, version: 0006
--
-- Object identity keys (design doc §16 "身份键"; docs/development-tasks.md S1.2): upsertObject
-- (packages/kernel/src/substrate/graph/sql-store.ts) upserts an Object by (object_type, identity)
-- via `INSERT ... ON CONFLICT` against this partial unique index, instead of always inserting a
-- new row.
--
-- Storage location (assumption — see PR body "假设"): the S1.2 dispatch sketch says "store the
-- identity key in properties.identity_key". By the time this migration was written, `objects`
-- already had a dedicated `identity_key jsonb` column (0002_substrate.sql, from S1.1, predating
-- this task) — a cleaner fit than nesting it inside the general-purpose `properties` blob, and
-- the one this index is built against. `identity_key` holds only the caller-supplied key/value
-- pairs (e.g. `{"org": "example", "repo": "widgets"}`); `object_type` is already a separate
-- column, so it is not duplicated inside the JSON value — the composite index below is what
-- scopes identity uniqueness to (workspace, object_type, identity key value), matching "identity
-- = object_type + key/value pairs" from the dispatch.
--
-- Partial (not full) unique index: only rows that were upserted by identity carry a non-null
-- `identity_key`; plain (non-identity) objects must remain free to coexist without colliding on
-- a shared `null` value — `where identity_key is not null` is what makes that possible (a full
-- unique index would treat repeated NULLs as a conflict under some interpretations and, more
-- importantly, would apply the constraint to rows that were never meant to participate in
-- identity-based upsert at all).
--
-- Cross-process bootstrap lock: see 0001_identity.sql's comment for the full rationale — the
-- same `pg_advisory_xact_lock` call is the first statement of every file in this module.
select pg_advisory_xact_lock(7241000101);

create unique index if not exists objects_identity_key_uidx
  on objects (workspace_id, object_type, identity_key)
  where identity_key is not null;
