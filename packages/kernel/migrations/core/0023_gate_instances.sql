-- 0023_gate_instances (P-B1 — docs/platform-admin-design.md §6.3 集成; development-tasks.md P-B
-- "拆分与决定"). The integration catalog as platform objects:
--
--   * `connectors`            — one row per 接入包: a packaged gate's `GATE_CONNECTOR` (`docker`,
--                                `ragflow`, …) or one of the four generic kinds. Carries the design's
--                                three-state `mode` (cloudflare-os `ambientGatekeeperModes`) and the
--                                per-Operation deny list (`setResourceEnabled` analogue).
--   * `gate_instances`        — one row per running gate that announced itself
--                                (`POST /internal/gates/announce`, keyed by its stable `GATE_ID`), with
--                                the manifest it described, its status / trust / last heartbeat.
--   * `workspace_gate_links`  — "workspace W enabled instance G as Gatekeeper object X": the join the
--                                approval decision follows to read `trust` live, and what "enabled by
--                                n workspaces" counts.
--
-- Access model: the first two are platform-global configuration (like `workspaces` and
-- `platform_settings`): every workspace transaction may read them (the catalog, the deny list and
-- the trust mark are consulted per call), only a platform transaction (`app_platform()`) may write.
-- The link table is workspace data: workspace-isolation policy for the workspace plane plus the
-- platform policy for cross-workspace reads (counts) — the same pair `principals` / `sessions` use
-- (0019). Everything stays `nexttime_app`; credentials never appear in any of these rows (design
-- §7: announce carries endpoints and manifests only).

create table if not exists connectors (
  name text primary key check (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  kind text not null check (kind in ('http', 'mcp', 'cli', 'ssh')),
  packaged boolean not null default false,
  mode text not null default 'self_serve'
    check (mode in ('disabled', 'self_serve', 'platform_preset')),
  disabled_operations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- The four generic kinds exist from the start in today's behaviour (`self_serve`: a workspace
-- owner may connect their own instance through the wizard). Packaged connectors are created by
-- their first announcement, as `platform_preset`.
insert into connectors (name, kind, packaged, mode) values
  ('http', 'http', false, 'self_serve'),
  ('mcp', 'mcp', false, 'self_serve'),
  ('cli', 'cli', false, 'self_serve'),
  ('ssh', 'ssh', false, 'self_serve')
on conflict (name) do nothing;

create table if not exists gate_instances (
  gate_id text primary key check (gate_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  connector text not null references connectors (name),
  display_name text not null,
  transport_kind text not null check (transport_kind in ('http', 'mcp', 'cli', 'ssh')),
  target text not null default '',
  endpoint text not null,
  health_endpoint text,
  operations jsonb not null default '[]'::jsonb,
  status text not null default 'discovered'
    check (status in ('discovered', 'enabled', 'disabled', 'lost')),
  trust text not null default 'byo' check (trust in ('byo', 'vetted')),
  health text not null default 'unknown'
    check (health in ('ok', 'unreachable', 'unauthorized', 'unknown')),
  last_seen_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_gate_links (
  workspace_id uuid not null references workspaces (id),
  gate_id text not null references gate_instances (gate_id),
  gatekeeper_object_id uuid not null,
  enabled_by uuid not null,
  enabled_at timestamptz not null default now(),
  primary key (workspace_id, gate_id),
  foreign key (workspace_id, enabled_by) references principals (workspace_id, id)
);
create index if not exists workspace_gate_links_gatekeeper_idx
  on workspace_gate_links (workspace_id, gatekeeper_object_id);

alter table connectors enable row level security;
alter table connectors force row level security;
drop policy if exists connectors_read_all on connectors;
create policy connectors_read_all on connectors for select using (true);
drop policy if exists connectors_platform_admin on connectors;
create policy connectors_platform_admin on connectors
  for all using (app_platform()) with check (app_platform());

alter table gate_instances enable row level security;
alter table gate_instances force row level security;
drop policy if exists gate_instances_read_all on gate_instances;
create policy gate_instances_read_all on gate_instances for select using (true);
drop policy if exists gate_instances_platform_admin on gate_instances;
create policy gate_instances_platform_admin on gate_instances
  for all using (app_platform()) with check (app_platform());

alter table workspace_gate_links enable row level security;
alter table workspace_gate_links force row level security;
drop policy if exists workspace_gate_links_workspace_isolation on workspace_gate_links;
create policy workspace_gate_links_workspace_isolation on workspace_gate_links
  for all using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
drop policy if exists workspace_gate_links_platform_admin on workspace_gate_links;
create policy workspace_gate_links_platform_admin on workspace_gate_links
  for all using (app_platform()) with check (app_platform());

grant select, insert, update on connectors to nexttime_app;
grant select, insert, update on gate_instances to nexttime_app;
grant select, insert, delete on workspace_gate_links to nexttime_app;
