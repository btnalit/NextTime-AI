-- module: task, version: 0004
--
-- `worker_runs.agent_principal_id` — the (workspace, WorkerDefinition) agent principal
-- (`migrations/core/0014_worker_agent_principals.sql`,
-- `application/task/agent-principal.ts`'s `ensureWorkerAgentPrincipal`) resolved once at
-- `spawnWorkerRun` time and persisted on the row it was resolved for, so
-- `application/task/result.ts`'s `postWorkerResult` can read it straight off the WorkerRun instead
-- of re-deriving it from the Task's `worker_definition_id` on every result post. Nullable only
-- because it is set in the same statement that creates the row (no window where it is legitimately
-- absent for a WorkerRun spawned after this migration) — kept nullable rather than `not null`
-- regardless, mirroring `activity_id`'s own reasoning one migration up
-- (migrations/task/0003_task_worker_run_lineage.sql): this migration cannot enforce "the agent
-- principal was resolved before this INSERT" at the DB level.
--
-- Real FK this time (unlike `principals.worker_definition_id`'s own migration, core/0014, which
-- cannot FK to `worker_definitions`): `task` sorts after `core` in `discoverMigrations`' module
-- order, so `principals` — agent principal rows included — already exists by the time this file
-- runs, and `principals`' own primary key is the ordinary `(workspace_id, id)` this FK needs.
--
-- Cross-process bootstrap lock: same `task`-module key as 0001–0003 (locks are per-module, not
-- per-file).
select pg_advisory_xact_lock(7241000401);

alter table worker_runs add column if not exists agent_principal_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'worker_runs_agent_principal_id_fkey'
  ) then
    alter table worker_runs
      add constraint worker_runs_agent_principal_id_fkey
      foreign key (workspace_id, agent_principal_id) references principals (workspace_id, id);
  end if;
end
$$;
