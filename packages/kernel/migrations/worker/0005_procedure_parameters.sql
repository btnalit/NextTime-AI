-- module: worker, version: 0005
--
-- 0005_procedure_parameters (S11 GO5d-2: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §4.3 "Procedure 成为计划模板"). A published Procedure is also a template a goal's plan is made
-- from (`propose_goal`'s `fromProcedure`, `application/goal/from-procedure.ts`):
--
--   * `procedures.parameters` — the parameters a goal made from it is proposed with, as the
--     bounded JSON Schema subset a step's output contract uses (`@nexttime/shared`
--     `output-schema.ts`); what its steps' `$params` bindings read. NULL: it takes none. The steps'
--     own template fields (key, dependsOn, input, bindings, outputSchema, maxAttempts; a verify
--     step's check) live in the `steps` jsonb they belong to.
--   * `procedures_block_published_mutation` — the immutability trigger (worker/0002) now holds
--     `parameters` too: a published version's parameters are part of its content.
--   * the foreign key goal/0009 leaves to this module: a revision made from a Procedure names an
--     existing version of it. Only published versions are ever named (`propose_goal` resolves
--     `status = 'published'`), and worker/0003's trigger lets the application role delete only
--     drafts, so the key never blocks a discard.
--
-- Nullable, no backfill: every existing Procedure takes no parameters. The previous release's
-- code never writes the column (a Procedure it proposes has NULL) and the trigger's extra
-- comparison is a no-op for it, so it runs on this schema unchanged.
--
-- Advisory lock: same module key as 0001–0004.
select pg_advisory_xact_lock(7241000501);

alter table procedures add column if not exists parameters jsonb;

alter table procedures drop constraint if exists procedures_parameters_object;
alter table procedures add constraint procedures_parameters_object
  check (parameters is null or jsonb_typeof(parameters) = 'object');

create or replace function procedures_block_published_mutation() returns trigger
language plpgsql as $$
begin
  if old.status in ('published', 'deprecated') then
    if new.name is distinct from old.name
       or new.description is distinct from old.description
       or new.steps is distinct from old.steps
       or new.parameters is distinct from old.parameters then
      raise exception 'procedures: content is immutable once published (I12)';
    end if;
  end if;

  if old.status = 'published' then
    if new.status is distinct from old.status and new.status <> 'deprecated' then
      raise exception 'procedures: a published row may only transition to deprecated (I12)';
    end if;
  elsif old.status = 'deprecated' then
    if new.status is distinct from old.status then
      raise exception 'procedures: a deprecated row is terminal (I12)';
    end if;
  end if;

  return new;
end;
$$;

alter table plan_revisions drop constraint if exists plan_revisions_source_procedure_fk;
alter table plan_revisions add constraint plan_revisions_source_procedure_fk
  foreign key (workspace_id, source_procedure_id, source_procedure_version)
  references procedures (workspace_id, id, version);

create index if not exists plan_revisions_source_procedure_idx
  on plan_revisions (workspace_id, source_procedure_id, source_procedure_version)
  where source_procedure_id is not null;
