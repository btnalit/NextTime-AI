-- module: governance, version: 0001
--
-- capability_handles (§9.2, §5.1.4, §5.4 I13; docs/development-tasks.md S1.9): the revocation
-- and audit table backing every issued CapabilityHandle. The signed compact JWT (EdDSA,
-- packages/kernel/src/governance/capability/handles.ts) carries the same fields as claims
-- (`ws / sid / obo / scope / jti / exp / iat / par`) so a Handle is self-describing to any
-- verifier holding only the kernel's public key (llm-proxy, S1.7); this table is the kernel's own
-- source of truth for revocation (`revoked_at`) and for reconstructing a Handle's lineage
-- (`parent_jti`) without needing to decode a token.
--
-- Runner ordering (docs/development-tasks.md S1.9 note): packages/kernel/src/adapters/db/
-- migrate.ts's `discoverMigrations` sorts strictly by module directory name, then by version
-- within a module (see `sortMigrationFiles`). "core" < "governance" lexicographically, so every
-- core/NNNN file always runs before this one — `sessions` (core/0001_identity.sql) and
-- `principals` (same file) already exist by the time this file's foreign keys below are created.
--
-- Cross-process bootstrap lock: the same empirically-required fix documented at length in
-- core/0001_identity.sql's header comment applies here too — `runMigrations()` computes "which
-- files are pending" once, up front, so two sessions racing to apply this module's migrations
-- concurrently (e.g. two Vitest test files each calling `runMigrations()` against the same fresh
-- database) can both decide this file is pending and race on its DDL. `pg_advisory_xact_lock`
-- (transaction-scoped, released automatically at this file's own COMMIT/ROLLBACK) as the very
-- first statement closes that race the same way; the key below (7241000201) is a new, arbitrary
-- bigint distinct from core's (7241000101) — advisory lock keys only need to be unique within one
-- Postgres cluster, and there is no reason for the `governance` module's migrations to serialize
-- against unrelated `core` module DDL. Every future migration file added under
-- migrations/governance/ should take this same lock as its first statement, exactly as core's
-- five files all take theirs.
select pg_advisory_xact_lock(7241000201);

-- `on_behalf_of` is copied from `sessions.on_behalf_of` at issuance time (handles.ts's
-- `issueHandle` reads it from the session row, never from a caller-supplied parameter — I13) and
-- must never change afterward, including for an attenuated child Handle (I13: "子 Handle 继承且
-- 不可改"). Every other column stays plainly UPDATE-able (in particular `revoked_at`, which
-- `revokeHandle` / `revokeSession` set) — only this one column is locked down, via the trigger
-- below, mirroring the narrow (single-column) immutability pattern core/0002_substrate.sql uses
-- for `links` content vs. `superseded_at` rather than the whole-row append-only pattern
-- core/0004_audit.sql uses for `audit_records` (a Handle row is not append-only: revocation is a
-- legitimate, expected mutation).
create table if not exists capability_handles (
  workspace_id uuid not null,
  jti uuid not null,
  session_id uuid not null,
  on_behalf_of uuid not null,
  parent_jti uuid,
  scope jsonb not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, jti),
  foreign key (workspace_id, session_id) references sessions (workspace_id, id),
  foreign key (workspace_id, on_behalf_of) references principals (workspace_id, id),
  foreign key (workspace_id, parent_jti) references capability_handles (workspace_id, jti)
);

alter table capability_handles enable row level security;

drop policy if exists capability_handles_workspace_isolation on capability_handles;

create policy capability_handles_workspace_isolation on capability_handles
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant: a Handle row is revoked (`revoked_at` set), never removed — the row is the
-- durable record of a capability grant having existed, which audit/reconstruct (§12) may need
-- long after `expires_at`/`revoked_at`.
grant select, insert, update on capability_handles to nexttime_app;

create or replace function capability_handles_block_on_behalf_of_update() returns trigger
language plpgsql as $$
begin
  if new.on_behalf_of is distinct from old.on_behalf_of then
    raise exception 'capability_handles: on_behalf_of is immutable once issued (I13)';
  end if;
  return new;
end;
$$;

create or replace trigger capability_handles_immutable_on_behalf_of
  before update on capability_handles
  for each row execute function capability_handles_block_on_behalf_of_update();
