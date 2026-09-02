-- module: llm-usage, version: 0001
--
-- llm_usage (§7.7, §9.2 sketch extended by S1.7; docs/development-tasks.md S1.7): one row per
-- normalized usage record `llm-proxy` reports to `POST /internal/llm-usage` — provider/model,
-- token counts, and (when the provider's model entry configures a `cost` — pi-ai's `ModelCost`
-- shape, packages/llm-proxy) an estimated `cost_usd`. This is the only place in the kernel that
-- ever sees a provider/model name or a token count; `llm-proxy`, not the kernel, is the only
-- process that ever holds a provider API key (I9, §11 "provider key 只在 llm-proxy").
--
-- Runner ordering (docs/development-tasks.md S1.7 note, mirroring governance/0001's own note):
-- packages/kernel/src/adapters/db/migrate.ts's `discoverMigrations` sorts strictly by module
-- directory name, then by version within a module. "llm-usage" sorts after both "core" and
-- "governance" lexicographically (c < g < l), so `sessions` (core/0001_identity.sql) and
-- `capability_handles` (governance/0001_capability_handles.sql) already exist by the time this
-- file's foreign keys below are created.
--
-- Cross-process bootstrap lock: the same empirically-required fix documented at length in
-- core/0001_identity.sql's header comment applies here too — `pg_advisory_xact_lock`
-- (transaction-scoped, released automatically at this file's own COMMIT/ROLLBACK) as the very
-- first statement. The key below (7241000301) is a new, arbitrary bigint distinct from core's
-- (7241000101) and governance's (7241000201) — advisory lock keys only need to be unique within
-- one Postgres cluster, and there is no reason for the `llm-usage` module's migrations to
-- serialize against unrelated `core`/`governance` module DDL.
select pg_advisory_xact_lock(7241000301);

-- Idempotency (docs/development-tasks.md S1.7 "recordUsage ... idempotent on (workspace_id, jti,
-- started_at) or an explicit client-generated id — pick one and document"): this migration picks
-- the composite-key option — `id` stays a server-generated surrogate primary key (as the task
-- brief's column list asks for: "PK (workspace_id,id)"), and a separate `unique (workspace_id,
-- jti, started_at)` constraint is what `governance/llm-usage/service.ts`'s `recordUsage` actually
-- upserts against (`insert ... on conflict (workspace_id, jti, started_at) do nothing`). A single
-- Handle (`jti`) proxies one logical LLM call; `llm-proxy` captures `started_at` once when that
-- call begins and resends the identical record (including the identical `started_at`) on every
-- retry of its bounded in-memory replay queue, so this composite key is stable across retries
-- without requiring `llm-proxy` to mint and remember its own record ids.
--
-- `turn_id` is deliberately *not* foreign-keyed to `activities` here, unlike `session_id`/`jti`
-- below (assumption, see PR body "假设"): S1.7's `resolveTurnId` hook always returns `null` (Turn
-- resolution is S1.4's "session → running Turn" mapping, not yet implemented), and the task
-- brief's FK list names only "sessions and capability_handles" — not activities. Left as a bare
-- nullable uuid; a later task may add the FK once `resolveTurnId` is real.
--
-- `provider`/`model` are free-text (not a CHECK-constrained enum): they name entries in the
-- operator-editable `${NEXTTIME_DATA}/config/llm-providers.yaml`, not a closed platform
-- vocabulary — same reasoning `core/0002_substrate.sql` gives for leaving `activities.kind`/
-- `status` unconstrained. `status` is similarly free-text for the same reason (no shared enum
-- exists for a usage record's outcome; `packages/llm-proxy` documents the values it actually
-- writes).
create table if not exists llm_usage (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  session_id uuid not null,
  jti uuid not null,
  turn_id uuid,
  provider text not null,
  model text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  cost_usd numeric(18, 6),
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, session_id) references sessions (workspace_id, id),
  foreign key (workspace_id, jti) references capability_handles (workspace_id, jti),
  unique (workspace_id, jti, started_at)
);

-- Index for the budget-crossing sum query (governance/llm-usage/service.ts: "today's total for
-- this workspace") and for general per-workspace/day reporting.
create index if not exists llm_usage_workspace_started_at_idx on llm_usage (workspace_id, started_at);

alter table llm_usage enable row level security;

drop policy if exists llm_usage_workspace_isolation on llm_usage;

create policy llm_usage_workspace_isolation on llm_usage
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No update/delete grant (docs/development-tasks.md S1.7: "grant select, insert to
-- nexttime_app"): a usage record is written once, atomically, by `recordUsage` and never revised
-- afterward — there is no lifecycle here the way `capability_handles.revoked_at` has one.
grant select, insert on llm_usage to nexttime_app;
