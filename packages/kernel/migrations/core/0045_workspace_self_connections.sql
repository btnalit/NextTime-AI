-- module: core, version: 0045
--
-- S10 W2 P0b (docs/global-roadmap-2026-10-16.md W3; STATUS leftover 118 remainder ①): a gate a
-- workspace connected itself gets an origin record, so the platform can see it and cut it off.
--
-- Every Gatekeeper in a workspace now has exactly one origin, written by the one landing path
-- (`application/gates/landing.ts`, which both `create_connection` and `enable_gate_instance` go
-- through):
--   - `workspace_gate_links` (0023): enabled from a platform gate instance — the connector's
--     Operation deny list, the instance's trust and status apply;
--   - `workspace_self_connections` (this file): connected by the workspace itself. Before this
--     table such a gate had no row anywhere the platform could read, so neither the connector's
--     three-state mode nor its deny list reached it (the leftover). `suspended_at` is the platform's
--     cut-off: while it is set, every Operation of that Gatekeeper is refused as disabled by the
--     platform (`operationPlatformStatus`), on every call path.
--
-- `connector` is the generic connector of the gate's transport kind (http / mcp / cli / ssh) — the
-- one `create_connection` checked for `self_serve`. `target` and `endpoint` are copied from the
-- Gatekeeper at landing: the platform plane cannot read `objects` (workspace isolation only), and
-- the administrator deciding on a cut-off needs to see what the connection points at. Neither ever
-- carries a credential (`registerGatekeeper` refuses one).
--
-- Who may write what (RLS, forced like 0023): a workspace transaction inserts its own rows (the
-- landing) and may delete an unsuspended one (the landing converts a self-connected Gatekeeper into
-- a catalog link when its owner enables the platform instance at the same address). Only a platform
-- transaction updates a row — suspends or resumes it — so no workspace-side code path, buggy or
-- injected, can lift the platform's cut-off, and a suspended row cannot be deleted from the
-- workspace side either. The purge cascade runs on the superuser login role and is unaffected.
--
-- Backfill: every existing Gatekeeper with no `workspace_gate_links` row — connected with
-- `create_connection`, or registered with the removed `register-gatekeeper` CLI — gets its origin
-- row, attributed to nobody (`connected_by` null: the old paths did not record it here) and dated
-- by the Gatekeeper Object's own `created_at`. A Gatekeeper whose transport kind names no
-- connector row is left out and counted in a NOTICE (none is expected: the four generic connectors
-- are seeded by 0023 and never deleted).
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration.
select pg_advisory_xact_lock(7241000101);

create table if not exists workspace_self_connections (
  workspace_id uuid not null references workspaces (id),
  gatekeeper_object_id uuid not null,
  connector text not null references connectors (name),
  target text not null,
  endpoint text not null,
  connected_by uuid,
  connected_at timestamptz not null default now(),
  suspended_at timestamptz,
  -- The platform user who suspended it (`users.id`); no foreign key, so purging a user later is
  -- not blocked — the `suspend_self_connection` audit row is the durable record.
  suspended_by_user_id uuid,
  suspension_reason text check (suspension_reason is null or length(suspension_reason) <= 500),
  primary key (workspace_id, gatekeeper_object_id),
  foreign key (workspace_id, gatekeeper_object_id) references objects (workspace_id, id),
  foreign key (workspace_id, connected_by) references principals (workspace_id, id),
  check ((suspended_at is null) = (suspended_by_user_id is null)),
  check (suspended_at is not null or suspension_reason is null)
);
create index if not exists workspace_self_connections_connector_idx
  on workspace_self_connections (connector);

alter table workspace_self_connections enable row level security;
alter table workspace_self_connections force row level security;

drop policy if exists workspace_self_connections_workspace_read on workspace_self_connections;
create policy workspace_self_connections_workspace_read on workspace_self_connections
  for select using (workspace_id = app_workspace());
drop policy if exists workspace_self_connections_workspace_insert on workspace_self_connections;
create policy workspace_self_connections_workspace_insert on workspace_self_connections
  for insert with check (
    workspace_id = app_workspace()
    and suspended_at is null and suspended_by_user_id is null and suspension_reason is null
  );
drop policy if exists workspace_self_connections_workspace_delete on workspace_self_connections;
create policy workspace_self_connections_workspace_delete on workspace_self_connections
  for delete using (workspace_id = app_workspace() and suspended_at is null);
drop policy if exists workspace_self_connections_platform_admin on workspace_self_connections;
create policy workspace_self_connections_platform_admin on workspace_self_connections
  for all using (app_platform()) with check (app_platform());

grant select, insert, update, delete on workspace_self_connections to nexttime_app;

do $$
declare
  backfilled integer;
  skipped integer;
begin
  insert into workspace_self_connections
    (workspace_id, gatekeeper_object_id, connector, target, endpoint, connected_by, connected_at)
  select o.workspace_id,
         o.id,
         o.properties ->> 'transportKind',
         coalesce(o.properties ->> 'target', ''),
         coalesce(o.properties ->> 'endpoint', ''),
         null,
         o.created_at
    from objects o
    join connectors c on c.name = o.properties ->> 'transportKind'
   where o.object_type = 'Gatekeeper'
     and not exists (
       select 1 from workspace_gate_links l
        where l.workspace_id = o.workspace_id and l.gatekeeper_object_id = o.id
     )
  on conflict (workspace_id, gatekeeper_object_id) do nothing;
  get diagnostics backfilled = row_count;

  select count(*) into skipped
    from objects o
   where o.object_type = 'Gatekeeper'
     and not exists (select 1 from connectors c where c.name = o.properties ->> 'transportKind')
     and not exists (
       select 1 from workspace_gate_links l
        where l.workspace_id = o.workspace_id and l.gatekeeper_object_id = o.id
     );
  raise notice 'core 0045: recorded % self-connected Gatekeeper(s); % left out (no connector for their transport kind)',
    backfilled, skipped;
end
$$;
