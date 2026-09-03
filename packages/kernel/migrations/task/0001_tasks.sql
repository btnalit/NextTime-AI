-- module: task, version: 0001
--
-- tasks / worker_runs (design doc §5.1.4, §5.2, §5.4 I13, §5.5, §9.2; docs/development-tasks.md
-- S2.1, S2.7). Task = the unit `invoke_worker` creates and a Turn `generated`s (§5.2 relationship
-- diagram: `T -->|generated| TK`); WorkerRun = one running instance assigned to a Task
-- (`TK -->|assigned_to| WR`), which may itself spawn child WorkerRuns up to I18's depth-3 limit
-- (`WorkerRun parent WorkerRun`, 0..1).
--
-- §7.10 module ownership: the `application` layer's `task` module owns Task/WorkerRun *runtime*
-- state; the sibling `worker` module owns WorkerDefinition *registry* state
-- (worker/0001_worker_definitions.sql) — "application | chat、task、host-bridge、worker（定义与
-- find_*）". This file is `task`'s deliverable; `worker`'s is separate on purpose, not a naming
-- accident.
--
-- Runner ordering (docs/development-tasks.md S2.1: "decide based on the actual migration ORDER
-- migrate.ts uses"): packages/kernel/src/adapters/db/migrate.ts's `discoverMigrations` sorts
-- module directories lexicographically — core < governance < llm-usage < task < worker. So
-- `principals`/`activities` (core) and `sessions` (core) already exist by the time this file
-- runs, and real FKs to them are used below. `worker_definitions` (the `worker` module) does
-- **not** exist yet — `worker` sorts *after* `task` — so `tasks.worker_definition_id` /
-- `worker_definition_version` below are bare columns with no FK, mirroring exactly the same
-- ordering constraint governance/0003_action_requests.sql documents for
-- `action_requests.parent_worker_run_id → worker_runs` (this table). The referential check ("does
-- this WorkerDefinition version exist and is it published?") is an application-level concern for
-- whichever service writes `tasks` (S2.7's `task/{service,invoke,reaper}.ts`), documented here
-- rather than silently omitted — never reorder these two module directories to make the FK
-- possible, since `governance`/`llm-usage` migrations already applied in production would have to
-- run before either regardless.
--
-- Cross-process bootstrap lock: the same empirically-required fix documented at length in
-- core/0001_identity.sql's header comment applies here too — `pg_advisory_xact_lock`
-- (transaction-scoped, released automatically at this file's own COMMIT/ROLLBACK) as the very
-- first statement. The key below (7241000401) is a new, arbitrary bigint distinct from every
-- other module's key so far (core: 7241000101, governance: 7241000201, llm-usage: 7241000301,
-- worker: 7241000501 — see worker/0001_worker_definitions.sql) — advisory lock keys only need to
-- be unique within one Postgres cluster.
select pg_advisory_xact_lock(7241000401);

-- tasks (§5.5 `created → queued → running ⇄ waiting_approval → completed | failed | cancelled`,
-- packages/shared/src TASK_STATUS_VALUES/TASK_TRANSITIONS). `on_behalf_of` is I13's anchor for a
-- Task the same way `sessions.on_behalf_of` is for a session — every Handle a WorkerRun assigned
-- to this Task holds must trace back to this same principal. `created_by_activity_id` is nullable:
-- §5.2 shows `Turn --generated--> Task` as the normal path (S2.11 wires the write), but nothing in
-- §5.5's state machine makes a Task-generating Turn mandatory for every future caller of
-- `create_task`/`invoke_worker` (assumption — see PR body "假设").
create table if not exists tasks (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  status text not null default 'created'
    check (status in ('created', 'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  on_behalf_of uuid not null,
  created_by_activity_id uuid,
  -- No FK — see the runner-ordering note above; `worker_definitions` does not exist when this
  -- file runs.
  worker_definition_id uuid not null,
  worker_definition_version int not null,
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, on_behalf_of) references principals (workspace_id, id),
  foreign key (workspace_id, created_by_activity_id) references activities (workspace_id, id)
);

alter table tasks enable row level security;

drop policy if exists tasks_workspace_isolation on tasks;

-- Workspace-only (assumption — see PR body "假设", same reasoning as links/activities in
-- core/0002_substrate.sql and action_requests in governance/0003_action_requests.sql): no visibility
-- rule for Task is spelled out in §5.6 the way Chat/Source/private-Fact visibility is, and a
-- Task's own ActionRequests are independently routed by I14 to whichever Principals hold the
-- matching scope — not necessarily `on_behalf_of`. A stricter, owner-only policy can be layered on
-- in a later migration if a future task's acceptance criteria require it; nothing here forecloses
-- that.
create policy tasks_workspace_isolation on tasks
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant: a Task's history must remain reconstructable via `explain`/audit for as long as
-- the ActionRequests and Facts it generated do (mirrors action_requests/capability_grants).
grant select, insert, update on tasks to nexttime_app;

-- worker_runs (§5.5 `provisioning → running → suspended → terminated`, packages/shared/src
-- WORKER_RUN_STATUS_VALUES/WORKER_RUN_TRANSITIONS; §5.2 `WorkerRun parent WorkerRun` 0..1, I18
-- depth-3 cap enforced in application code, not here — a self-FK cannot express "at most 3 deep").
-- `session_id` is nullable: it is set once the WorkerRun's `worker_run`-kind Session
-- (`sessions.kind`, core/0001_identity.sql) and Handle are issued, which is a step after the row
-- itself is created (`provisioning`) — mirroring why `capability_handles.session_id` is set at
-- issuance rather than at container-request time.
create table if not exists worker_runs (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  status text not null default 'provisioning'
    check (status in ('provisioning', 'running', 'suspended', 'terminated')),
  task_id uuid not null,
  parent_worker_run_id uuid,
  session_id uuid,
  container_id text,
  started_at timestamptz not null default now(),
  terminated_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, task_id) references tasks (workspace_id, id),
  foreign key (workspace_id, parent_worker_run_id) references worker_runs (workspace_id, id),
  foreign key (workspace_id, session_id) references sessions (workspace_id, id)
);

alter table worker_runs enable row level security;

drop policy if exists worker_runs_workspace_isolation on worker_runs;

-- Workspace-only — same reasoning as `tasks` above.
create policy worker_runs_workspace_isolation on worker_runs
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant — same reasoning as `tasks` above; `terminated` is the row's terminal state, not
-- a deletion.
grant select, insert, update on worker_runs to nexttime_app;
