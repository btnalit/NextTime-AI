-- module: core, version: 0001
--
-- Identity: workspaces, principals, sessions, and the RLS foundation every later migration in
-- this module builds on (design doc §5.1.1, §9.2; docs/development-tasks.md S1.1).
--
-- Key design decision (docs/development-tasks.md S1.1 dispatch): the compose Postgres login
-- user is a superuser and would bypass RLS entirely, so RLS is enforced through a non-login
-- application role. `nexttime_app` is NOLOGIN — nothing ever authenticates as it directly;
-- `withWorkspace()` (packages/kernel/src/adapters/db/pool.ts) runs `SET LOCAL ROLE nexttime_app`
-- after setting the `app.workspace_id` / `app.principal_id` session variables, so ordinary
-- request handling runs under this role's (RLS-constrained) privileges even though the physical
-- connection authenticated as a superuser. `SET LOCAL ROLE` is transaction-scoped and reverts
-- automatically at COMMIT/ROLLBACK, matching the `is_local = true` scoping already used for the
-- two session variables (see pool.ts). Bootstrap/admin operations that must run before any
-- workspace-scoped session variables exist (e.g. creating the first workspace, or looking up a
-- principal by `api_key_hash` before its workspace is known) use `withWorkspace(..., { skip
-- RoleSwitch: true })`, which keeps the connection on the superuser role and therefore bypasses
-- RLS by design — the same escape hatch Postgres itself expects a trusted admin path to use.
--
-- Cross-process bootstrap lock (empirically required — see PR body "假设"): the migration
-- runner (packages/kernel/src/adapters/db/migrate.ts) computes "which files are pending" once,
-- from a single read of `schema_migrations`, before executing any of them. Two independent test
-- files (packages/kernel/src/adapters/db/migrate.test.ts and .../substrate/invariants.test.ts)
-- each call `runMigrations()` against the same fresh, empty database; under real (not
-- hypothetical) concurrency this was observed to fail two different ways in turn while this fix
-- was being developed: first `duplicate key value violates unique constraint
-- "pg_proc_proname_args_nsp_index"` on `create or replace function app_workspace()` (two sessions
-- inserting the same new pg_proc row simultaneously, before either had committed — "or replace"
-- cannot protect against that, it can only replace a row it can already see); then, after adding
-- a lock only to *this* file, the identical failure shape on `pg_type` from 0002_substrate.sql —
-- because a caller whose upfront read landed after the winner committed 0001 but before it
-- committed 0002 sees 0001 as already-applied and *skips straight to 0002 without ever running
-- this file*, so a lock that only lived in 0001 never protected it. The fix that actually closes
-- this: `pg_advisory_xact_lock` (transaction-scoped, auto-released at this file's own COMMIT or
-- ROLLBACK — no matching unlock statement needed) as the very first statement of *every one* of
-- this module's five files (0001–0005), not just this one. Whichever file a session is about to
-- run, it takes the same lock first; no two sessions can have DDL from this module in flight at
-- the same time, regardless of which arbitrary subset of files each one's stale plan considers
-- pending. That still leaves a session holding a now-stale "this file is pending" plan once it
-- gets the lock and finds the objects already there, which is why every object below is *also*
-- written to be idempotent (`if not exists` / `or replace` / `drop ... if exists` + create / an
-- `exception when duplicate_object` guard for the one constraint that supports neither) — the
-- lock prevents the raw concurrent-insert race, idempotency makes a stale-plan replay a no-op
-- instead of an error. The key (a fixed, arbitrary bigint, the same in all five files) only needs
-- to be unique within this Postgres cluster; nothing else in this codebase takes an advisory
-- lock.
select pg_advisory_xact_lock(7241000101);

-- Role creation is additionally guarded on its own terms: roles are cluster-wide (not
-- per-database), so a second migration run against a *different* database in the same Postgres
-- cluster (not covered by the advisory lock above, which is per-database) would otherwise hit
-- "role already exists". `EXCEPTION WHEN duplicate_object` (rather than a
-- `SELECT ... WHERE NOT EXISTS` guard) closes that race completely: `CREATE ROLE` itself is the
-- atomic operation, so there is no check-then-act gap for two concurrent sessions to both slip
-- through.
do $$
begin
  create role nexttime_app nologin;
exception
  when duplicate_object then
    null;
end
$$;

-- RLS helper functions. `app_workspace()` is the one named explicitly in the S1.1 dispatch;
-- `app_principal()` is added alongside it (assumption — see PR body "假设") because the
-- visibility predicate on `chats` / `sources` (and the rows that derive visibility from them:
-- design doc §5.6) needs to compare against the current principal, not just the workspace.
-- `stable` (not `immutable`): the result depends on session-local GUC state, but is constant
-- within one statement, which is all `stable` promises.
create or replace function app_workspace() returns uuid
language sql stable as $$
  select nullif(current_setting('app.workspace_id', true), '')::uuid
$$;

create or replace function app_principal() returns uuid
language sql stable as $$
  select nullif(current_setting('app.principal_id', true), '')::uuid
$$;

-- workspaces: the tenant root. Deliberately has no `workspace_id` column and no RLS policy of
-- its own (assumption — see PR body "假设"): every other table's `workspace_id` foreign-keys
-- into it, but the row *is* the workspace, so a self-referential "workspace_id = id" RLS
-- predicate would add nothing. Creating a workspace is a bootstrap operation (no principal or
-- session exists in it yet) and runs over the admin/skip-role-switch path; `nexttime_app` gets
-- read-only access for ordinary lookups (e.g. rendering a workspace name).
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

grant select on workspaces to nexttime_app;

-- principals (§5.1.1): human / agent / service, with the five coarse roles (§5.1.1, I14) and the
-- API key hash used by the human channel's gateway auth (S1.3). `api_key_hash` is globally
-- unique (not per-workspace) because the gateway looks a principal up by key before it knows
-- which workspace the key belongs to — that lookup runs over the admin/skip-role-switch path.
create table if not exists principals (
  workspace_id uuid not null references workspaces (id),
  id uuid not null default gen_random_uuid(),
  kind text not null check (kind in ('human', 'agent', 'service')),
  role text not null check (role in ('owner', 'builder', 'operator', 'member', 'auditor')),
  display_name text,
  api_key_hash text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (api_key_hash)
);

alter table principals enable row level security;

drop policy if exists principals_workspace_isolation on principals;

create policy principals_workspace_isolation on principals
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on principals to nexttime_app;

-- sessions (§9.2 DDL sketch, §5.1.1): one Principal session — `web` (human channel) / `entry` /
-- `worker_run` / `mcp_session` / `service`. `on_behalf_of` is the I13 anchor: every Capability
-- Handle issued from this session inherits it and cannot change it; the gateway sets it from the
-- authenticated principal, never from request-body content (I13, §5.3 item 10). `status` is left
-- unconstrained by a CHECK — no shared enum exists for generic session status across all five
-- session kinds (assumption — see PR body "假设"); `EntryAgentSessionStatus` in packages/shared
-- covers only the `entry` kind's own lifecycle and would be the wrong fit for e.g. `worker_run`.
create table if not exists sessions (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  principal_id uuid not null,
  kind text not null check (kind in ('web', 'entry', 'worker_run', 'mcp_session', 'service')),
  on_behalf_of uuid not null,
  status text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id),
  foreign key (workspace_id, on_behalf_of) references principals (workspace_id, id)
);

alter table sessions enable row level security;

drop policy if exists sessions_workspace_isolation on sessions;

create policy sessions_workspace_isolation on sessions
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update, delete on sessions to nexttime_app;
