-- module: task, version: 0008
--
-- 0008_task_output_contract (S11 GO5d-1: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §4.5 "步骤之间的数据交接", §4.7 "契约不合格 → 返工一次"; STATUS legacy 358). An attempt Task of a goal
-- step carries the step's output contract and what became of the reports held to it:
--
--   * `output_schema` — the step's `outputSchema` (`@nexttime/shared` `output-schema.ts`), copied
--     from the plan entry of the revision that introduced the StepRun when the advancer creates the
--     attempt (`application/task/step-attempt.ts`), as `input` is. `report_task_result` holds the
--     result's `output` to it. Only on an attempt Task; written once.
--   * `rejected_output` — the last report the contract refused: `{output, problems, problemCount,
--     at}`, written by the kernel in its own transaction after the refused call rolled back
--     (`application/gateway/dispatch.ts`). Only on a Task with an `output_schema`. Replaced by each
--     later refusal while the Task runs.
--   * `rework_of` — when the attempt redoes the step's previous attempt, which ended without an
--     accepted result (`no_result`): `{taskId, attempt, rejectedOutput}`, that attempt's Task, its
--     number and its last refused report (or null), copied when the attempt is created — what the
--     Worker is told to fix (`get_task`). Only on an attempt after the first; written once.
--
-- Nullable, no backfill: every existing Task and every Task outside a goal carries NULL in all
-- three. Reversibility: the previous release names its columns on every insert and select of
-- `tasks` and never sees these; the CHECKs hold for its rows (all NULL), and its updates of a Task
-- (status, result, tokens) name none of the columns the trigger guards.
--
-- Cross-process bootstrap lock: same `task`-module key as 0001–0007.
select pg_advisory_xact_lock(7241000401);

alter table tasks add column if not exists output_schema jsonb;
alter table tasks add column if not exists rejected_output jsonb;
alter table tasks add column if not exists rework_of jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_output_schema') then
    alter table tasks add constraint tasks_output_schema check (
      output_schema is null
      or (jsonb_typeof(output_schema) = 'object' and step_attempt is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_rejected_output') then
    alter table tasks add constraint tasks_rejected_output check (
      rejected_output is null
      or (jsonb_typeof(rejected_output) = 'object' and output_schema is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_rework_of') then
    alter table tasks add constraint tasks_rework_of check (
      rework_of is null
      or (jsonb_typeof(rework_of) = 'object' and step_attempt > 1)
    );
  end if;
end
$$;

-- The contract an attempt runs under, and what it redoes, are written once, when its Task is
-- created; only `rejected_output` moves after that.
create or replace function tasks_output_contract_immutable() returns trigger
language plpgsql as $$
begin
  if new.output_schema is distinct from old.output_schema
     or new.rework_of is distinct from old.rework_of then
    raise exception 'tasks: the output schema of an attempt and the attempt it redoes never change';
  end if;
  return new;
end;
$$;

create or replace trigger tasks_output_contract_immutable
  before update of output_schema, rework_of on tasks
  for each row execute function tasks_output_contract_immutable();
