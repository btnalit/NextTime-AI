-- module: core, version: 0000
--
-- Extensions required by the graph substrate: pgvector for embedding columns (design doc §9.1),
-- pgcrypto for gen_random_uuid()/crypto helpers used by principals and capability handles.
--
-- schema_migrations itself is created by the migration runner (packages/kernel/src/adapters/db/
-- migrate.ts), not by a migration file — see docs/development-tasks.md R2.

create extension if not exists vector;
create extension if not exists pgcrypto;
