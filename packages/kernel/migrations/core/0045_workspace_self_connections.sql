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
-- the administrator deciding on a cut-off needs to see what the connection points at. A landing
-- never copies a credential (`create_connection` and `registerGatekeeper` refuse one, legacy 186).
--
-- Who may write what (RLS, forced like 0023): a workspace transaction inserts its own rows (the
-- landing) and may delete an unsuspended one once the Gatekeeper has a `workspace_gate_links` row
-- (the landing converts a self-connected Gatekeeper into a catalog link when its owner enables the
-- platform instance at the same address, writing the link first) — so no workspace-side delete
-- leaves a Gatekeeper with no origin, out of the platform's sight. Only a platform transaction
-- updates a row — suspends or resumes it — so no workspace-side code path, buggy or injected, can
-- lift the platform's cut-off, and a suspended row cannot be deleted from the workspace side
-- either. The purge cascade runs on the superuser login role and is unaffected.
--
-- Backfill: every existing Gatekeeper with no `workspace_gate_links` row — connected with
-- `create_connection`, or registered with the removed `register-gatekeeper` CLI — gets its origin
-- row, attributed to nobody (`connected_by` null: the old paths did not record it here) and dated
-- by the Gatekeeper Object's own `created_at`. A Gatekeeper whose transport kind names no
-- connector row is left out and counted in a NOTICE (none is expected: the four generic connectors
-- are seeded by 0023 and never deleted).
--
-- A Gatekeeper written before legacy 186 can still carry a credential in its address, and a
-- database that never ran `scrub-raw-secrets` has not even counted it (#620 review M2). The backfill
-- copies such an address with the credential cut out, judged by the scrub preflight's patterns
-- (`scrub-raw-secrets.preflight.sql`; the two URL patterns are @nexttime/shared's
-- `ADDRESS_CREDENTIAL_SQL`, an upper bound of the kernel's rule): an endpoint loses its userinfo,
-- query and fragment; a target loses the password in its userinfo and its query and fragment, and
-- is masked whole (`[redacted]`) when what is left still looks like a secret. The NOTICE counts
-- them. `scrub-raw-secrets`, which apply-release.sh runs after the migration, then holds this
-- table to the exact rule (`selfConnectionAddresses`). The Gatekeeper Object itself is left as it
-- is: its endpoint is where the gate is called, and the scrub counts it for its owner to fix
-- (`gatekeeperAddresses`).
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
  for delete using (
    workspace_id = app_workspace()
    and suspended_at is null
    and exists (
      select 1 from workspace_gate_links l
       where l.workspace_id = workspace_self_connections.workspace_id
         and l.gatekeeper_object_id = workspace_self_connections.gatekeeper_object_id
    )
  );
drop policy if exists workspace_self_connections_platform_admin on workspace_self_connections;
create policy workspace_self_connections_platform_admin on workspace_self_connections
  for all using (app_platform()) with check (app_platform());

grant select, insert, update, delete on workspace_self_connections to nexttime_app;

do $$
declare
  backfilled integer;
  redacted integer;
  skipped integer;
begin
  with candidates as (
    select o.workspace_id,
           o.id,
           o.properties ->> 'transportKind' as connector,
           coalesce(o.properties ->> 'target', '') as target,
           coalesce(o.properties ->> 'endpoint', '') as endpoint,
           o.created_at
      from objects o
      join connectors c on c.name = o.properties ->> 'transportKind'
     where o.object_type = 'Gatekeeper'
       and not exists (
         select 1 from workspace_gate_links l
          where l.workspace_id = o.workspace_id and l.gatekeeper_object_id = o.id
       )
  ), judged as (
    select candidates.*,
           (endpoint ~ '://[^/]*@' or strpos(endpoint, '?') > 0 or strpos(endpoint, '#') > 0)
             as endpoint_carries,
           (target ~* '^[a-z][a-z0-9+.-]*://[^/?#@]*:[^/?#@]+@'
             or target ~* '[?#&;]([^=&#;?]*(password|passwd|passphrase|secret|credential|authori[sz]ation|api[_-]?key|private[_-]?key|access[_-]?key|token|cookie|bearer|handle)[^=&#;?]*|sig|signature|x-amz-signature|x-goog-signature|key|pwd|pass|auth)=[^&#;]'
             or target ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |-----begin)')
             as target_carries
      from candidates
  ), copied as (
    select judged.*,
           case when endpoint_carries
             then regexp_replace(regexp_replace(endpoint, '^([^/?#@]*//)[^/?#]*@', '\1'), '[?#].*$', '')
             else endpoint end as endpoint_copy,
           case when target_carries
             then regexp_replace(
                    regexp_replace(target, '^([a-z][a-z0-9+.-]*://[^/?#@:]*):[^/?#@]*@', '\1@', 'i'),
                    '[?#].*$', '')
             else target end as target_cut
      from judged
  ), inserted as (
    insert into workspace_self_connections
      (workspace_id, gatekeeper_object_id, connector, target, endpoint, connected_by, connected_at)
    select workspace_id,
           id,
           connector,
           case when target_carries and target_cut ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |-----begin)'
             then '[redacted]' else target_cut end,
           endpoint_copy,
           null,
           created_at
      from copied
    on conflict (workspace_id, gatekeeper_object_id) do nothing
    returning workspace_id, gatekeeper_object_id
  )
  select count(*), count(*) filter (where j.endpoint_carries or j.target_carries)
    into backfilled, redacted
    from inserted i
    join judged j on j.workspace_id = i.workspace_id and j.id = i.gatekeeper_object_id;

  select count(*) into skipped
    from objects o
   where o.object_type = 'Gatekeeper'
     and not exists (select 1 from connectors c where c.name = o.properties ->> 'transportKind')
     and not exists (
       select 1 from workspace_gate_links l
        where l.workspace_id = o.workspace_id and l.gatekeeper_object_id = o.id
     );
  raise notice 'core 0045: recorded % self-connected Gatekeeper(s), % of them with a credential cut out of the copied address; % left out (no connector for their transport kind)',
    backfilled, redacted, skipped;
end
$$;
