-- module: governance, version: 0005
--
-- connection_requests (design doc §5.1.4 Connection "建立"; §9.3 `request_connection` /
-- `create_connection`; docs/development-tasks.md S2.13). `request_connection(kind, target)`
-- inserts one `requested` row and produces a card a human resolves; `create_connection` (this
-- repo's implementation of the task brief's `complete_connection` — governance/connections/
-- service.ts's own doc comment has the crosswalk) registers the Gatekeeper and transitions the
-- row to `completed`, recording which Gatekeeper Object it produced.
--
-- Own table, not additive columns anywhere else (docs/development-tasks.md S2.13: "decide the
-- storage"): a ConnectionRequest is a governance-layer concept end-to-end — proposed over the
-- Handle channel, resolved over the human channel — with no natural home on an existing table
-- (`objects` is the *result* of completion, not the request itself; a registered Gatekeeper's own
-- properties have no room for "who asked for this and when, before it existed").
--
-- `gatekeeper_id` has no foreign key (deliberate, same reasoning as
-- migrations/governance/0003_action_requests.sql's own `gatekeeper_id` column): design doc §9.2's
-- increment-comment sketch and §5.1.2/S2.4 both establish a registered Gatekeeper as an `objects`
-- row (platform meta-ontology), not a dedicated relational table — so this column, when set,
-- names an `objects(workspace_id, id)` row and a real composite FK is possible (unlike
-- `action_requests.gatekeeper_id`, `objects` — core module — sorts before `governance` in the
-- migration runner, see the ordering note in 0003_action_requests.sql for the mechanism), and one
-- is used below.
--
-- No `cancelled_at`/other per-terminal-status timestamp columns, matching `action_requests`'s own
-- choice of only `executed_at`/`failed_at` (not one per every status in that machine's larger
-- vocabulary): `completed_at` is the one timestamp application code in this task actually needs to
-- read/write; `cancelled`/`cancel` remain valid states/transitions
-- (packages/shared/src/transitions.ts `CONNECTION_REQUEST_TRANSITIONS`) that a future task can
-- wire a `cancel_connection_request` capability onto without a further migration.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

create table if not exists connection_requests (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  status text not null default 'requested' check (status in ('requested', 'completed', 'cancelled')),
  kind text not null check (kind in ('http', 'mcp', 'cli', 'ssh')),
  target text not null,
  requested_by uuid not null,
  gatekeeper_id uuid,
  completed_by uuid,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, requested_by) references principals (workspace_id, id),
  foreign key (workspace_id, completed_by) references principals (workspace_id, id),
  foreign key (workspace_id, gatekeeper_id) references objects (workspace_id, id),
  -- Mirrors action_requests's own I6-support CHECK: a row only carries the fields its own
  -- transition produces — `completed` always has both `gatekeeper_id` and `completed_at`;
  -- `requested`/`cancelled` never do (a cancelled request never registered a Gatekeeper).
  check (status = 'completed' or (gatekeeper_id is null and completed_at is null)),
  check (status <> 'completed' or (gatekeeper_id is not null and completed_at is not null))
);

create index if not exists connection_requests_status_idx
  on connection_requests (workspace_id, status, requested_at);

alter table connection_requests enable row level security;

drop policy if exists connection_requests_workspace_isolation on connection_requests;

-- Workspace-only, not owner-narrowed (same choice as action_requests, migrations/governance/
-- 0003_action_requests.sql's own RLS comment: "an owner-only RLS predicate would be actively
-- wrong here" reasoning applies in spirit — `request_connection` itself is Handle-channel, issued
-- by a `member`, so the row must be visible to at least that requester too, not only owners; "谁
-- 能看见这张卡片" is `list_connection_requests`'s `minRole: 'owner'` capability gate, an
-- application-level concern, not a row-visibility one).
create policy connection_requests_workspace_isolation on connection_requests
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on connection_requests to nexttime_app;
