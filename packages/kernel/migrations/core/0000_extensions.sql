-- module: core, version: 0000
--
-- Extensions required by the graph substrate: pgvector for embedding columns (design doc §9.1),
-- pgcrypto for gen_random_uuid()/crypto helpers used by principals and capability handles.
--
-- schema_migrations itself is created by the migration runner (packages/kernel/src/adapters/db/
-- migrate.ts), not by a migration file — see docs/development-tasks.md R2.
--
-- Cross-process bootstrap lock (see 0001_identity.sql's comment for the full rationale): this
-- file was missing the same `pg_advisory_xact_lock` call every other file in this module takes
-- as its first statement, and under real concurrency that gap reproduces the exact race
-- documented there — two sessions each running `create extension if not exists vector`
-- concurrently, both passing the "if not exists" check before either commits, then racing to
-- insert the same `pg_extension` row and failing with `duplicate key value violates unique
-- constraint "pg_extension_name_index"`. Observed directly in CI once this module's test suite
-- grew enough concurrent `runMigrations()` callers (S1.2: substrate/graph's own integration
-- tests) to make the race hit reliably instead of occasionally — see PR body "假设". Adding the
-- lock here (same fixed key, 7241000101, as every other file in this module) closes it the same
-- way 0001_identity.sql closed it for 0001-0006.
select pg_advisory_xact_lock(7241000101);

create extension if not exists vector;
create extension if not exists pgcrypto;
