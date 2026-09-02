-- module: core, version: 0005
--
-- outbox (§7.10 "领域事件与 outbox", §9.2, S1.4): state transitions and business writes append a
-- row here in the same transaction (transactional outbox pattern); a dispatcher (S1.4) delivers
-- each row to in-process subscribers and stamps `dispatched_at`, replaying anything still
-- undispatched after a restart. `id` is `bigserial` — sequential and cheap to index/order by —
-- inside the same `(workspace_id, id)` composite primary key every other table in this module
-- uses, so cross-workspace references into the outbox (none exist yet, but consistency matters
-- more than the savings from a plain PK here) stay possible.
create table outbox (
  workspace_id uuid not null,
  id bigserial not null,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  attempts int not null default 0,
  primary key (workspace_id, id)
);

-- Partial index on the undispatched tail — the only slice the dispatcher scans.
create index outbox_undispatched_idx on outbox (workspace_id, id) where dispatched_at is null;

alter table outbox enable row level security;

create policy outbox_workspace_isolation on outbox
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update, delete on outbox to nexttime_app;
grant usage, select on outbox_id_seq to nexttime_app;
