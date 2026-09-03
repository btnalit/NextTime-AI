-- module: linkage, version: 0001
--
-- pending_context_items (design doc §8.2 "Task 终态或审批状态变化时...用户下一次发言时，context 事件把
-- Task 结果注入"; docs/development-tasks.md S2.11 deliverable 3). One row per (principal, thing that
-- happened) the next `get_entry_context` call for that principal should mention exactly once —
-- Task outcomes (completed/failed/cancelled/waiting_approval), budget warnings, and ActionRequest
-- status changes relevant to the requester. `application/linkage`'s outbox consumers insert rows as
-- `TaskUpdated`/`BudgetWarning`/`ActionRequestUpdated` domain events arrive;
-- `application/gateway/handlers.ts`'s `get_entry_context` handler reads undelivered rows for the
-- calling principal and marks them delivered in the same call — see that module's own doc comment
-- for the full design.
--
-- Deliberately its own table, not additive columns on `tasks`/`action_requests`: this is a
-- delivery-tracking concern the `linkage` module owns end-to-end, not a fact about a Task or
-- ActionRequest itself — and it avoids any migration-file collision with the concurrently-developed
-- S2.9 branch, which also touches `application/task`.
--
-- `subject_id` is deliberately not a foreign key: it names a `tasks.id` or `action_requests.id`
-- depending on `kind`, i.e. it is polymorphic — a single FK column cannot reference two different
-- tables, and this module does not otherwise need to join against either row (the payload captured
-- at event time is self-contained, see below).
--
-- Module ordering (docs/development-tasks.md S2.1's own note on this, repeated here for this
-- module): packages/kernel/src/adapters/db/migrate.ts's `discoverMigrations` sorts module
-- directories lexicographically — core < governance < linkage < llm-usage < task < worker (`"linkage"
-- < "llm-usage"` because `'i' < 'l'` at the second character). `principals` (core) already exists by
-- the time this file runs, so a real FK to it is used below; `linkage` runs *before* `task`, which is
-- exactly why `subject_id` above cannot be a real FK to `tasks` either way.
--
-- Cross-process bootstrap lock: same mechanism every other module's first migration file uses
-- (core/0001_identity.sql's header comment has the full rationale). This key (7241000601) is a new,
-- arbitrary bigint distinct from every other module's key so far (core: 7241000101, governance:
-- 7241000201, llm-usage: 7241000301, task: 7241000401, worker: 7241000501).
select pg_advisory_xact_lock(7241000601);

create table if not exists pending_context_items (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  principal_id uuid not null,
  kind text not null check (kind in (
    'task_completed', 'task_failed', 'task_cancelled', 'task_waiting_approval',
    'budget_warning', 'action_request_update'
  )),
  subject_id uuid not null,
  -- Self-contained snapshot captured at event time (the task/action-request row it was read from
  -- may since have changed further) — `get_entry_context` never re-reads `tasks`/`action_requests`,
  -- it only reads this table. Shape is `kind`-dependent; see `application/linkage`'s own doc comment.
  payload jsonb not null default '{}'::jsonb,
  -- The outbox row (`outbox.id`) this item was produced from — the dedupe key that makes a
  -- redelivered event (dispatcher crash between this INSERT's COMMIT and the outbox row's own
  -- `dispatched_at` UPDATE, application/outbox/dispatcher.ts's own doc comment) a no-op rather than
  -- a duplicate context item, via the unique index below. One outbox event can fan out to several
  -- principals (e.g. ActionRequestPending's holder list) — each gets its own row, deduped
  -- independently by (principal_id, source_outbox_id).
  source_outbox_id bigint not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id)
);

alter table pending_context_items enable row level security;

drop policy if exists pending_context_items_visibility on pending_context_items;

-- Principal-scoped, not merely workspace-scoped (unlike most S2 governance tables) — this table's
-- entire purpose is "what should this one principal's next get_entry_context call see", so there is
-- no legitimate reason for principal B's transaction to ever see principal A's rows here.
create policy pending_context_items_visibility on pending_context_items
  for all
  using (workspace_id = app_workspace() and principal_id = app_principal())
  with check (workspace_id = app_workspace() and principal_id = app_principal());

grant select, insert, update on pending_context_items to nexttime_app;

create unique index if not exists pending_context_items_dedupe_uidx
  on pending_context_items (workspace_id, principal_id, source_outbox_id);

-- get_entry_context's own read pattern: undelivered rows for one principal, oldest first.
create index if not exists pending_context_items_undelivered_idx
  on pending_context_items (workspace_id, principal_id)
  where delivered_at is null;
