-- module: governance, version: 0022
--
-- 0022_action_request_step_run (S11 GO1: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §3.2 `ActionRequest raised_in StepRun`, §3.3 I-G4 / I-G9). An ActionRequest raised by a Worker
-- whose Task executes a StepRun — the step's own attempt or a nested child Task of it — records
-- that StepRun. `request_action` copies it from the caller's Task when it creates the row
-- (`application/gateway/request-action-handler.ts`); it never changes afterwards.
--
-- This is what lets a step's actions be withdrawn in the same transaction as the step's own
-- transition (I-G9, GO3) and deduplicated per step (I-G4, GO3), and lets the advancer split a step
-- by its actions' `status` and `failure_kind` columns alone (§4.7). The execution side keeps
-- reading only the request's own row: nothing in `governance/approval` reads `step_runs`.
--
-- Nullable, no backfill: every existing request, every request outside a goal and every human
-- request carries NULL. Reversibility: the previous release inserts with an explicit column list
-- and never sees this column.
--
-- Runner ordering: `goal` sorts before `governance`, so goal/0001's `step_runs` exists when this
-- runs. Cross-process bootstrap lock: same governance-module key as every other file in this module.
select pg_advisory_xact_lock(7241000201);

alter table action_requests add column if not exists step_run_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'action_requests_step_run_fkey') then
    alter table action_requests
      add constraint action_requests_step_run_fkey
      foreign key (workspace_id, step_run_id) references step_runs (workspace_id, id);
  end if;
end
$$;

create index if not exists action_requests_step_run_idx
  on action_requests (workspace_id, step_run_id)
  where step_run_id is not null;

-- The requests a WorkerRun raised: I-G9's step check walks from a step's Task to its WorkerRuns
-- and on to their requests (substrate/audit/goal-invariant-checks.ts).
create index if not exists action_requests_parent_worker_run_idx
  on action_requests (workspace_id, parent_worker_run_id)
  where parent_worker_run_id is not null;

create or replace function action_requests_step_run_immutable() returns trigger
language plpgsql as $$
begin
  if new.step_run_id is distinct from old.step_run_id then
    raise exception 'action_requests: the step a request was raised in never changes';
  end if;
  return new;
end;
$$;

create or replace trigger action_requests_step_run_immutable
  before update of step_run_id on action_requests
  for each row execute function action_requests_step_run_immutable();
