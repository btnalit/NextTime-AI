-- module: goal, version: 0010
--
-- 0010_plan_revision_source_parameters (legacy 454, after S11 GO5d-2's goal/0009): a goal made from
-- a published Procedure was proposed with the Procedure's start parameters (`propose_goal`'s
-- `fromProcedure.parameters`), but the revision kept only which version it was made from — the
-- values were merged into the steps' inputs and could not be read back, so a goal's page could not
-- say what the goal was started with. One more column on the revision that records the source:
--
--   * `source_procedure_parameters` — the parameters as given, an object; only with
--     `source_procedure_id` (so only on revision 1), and `null` when none were given or the
--     Procedure takes none.
--
-- Read through the same masking as a step's input (`application/goal/views.ts`): the values were
-- refused at proposal for a suspected credential or a `[redacted]` mark, like the plan they fill.
--
-- Nullable, no backfill: a revision made before this keeps `null` (its values are only in its
-- steps' inputs). Never changes after the insert — `plan_revisions_guard` (goal/0001) lets only the
-- columns it lists change, and this is not among them. The previous release's code neither reads
-- nor writes it; rolling back needs no data change.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0009.
select pg_advisory_xact_lock(7241000701);

alter table plan_revisions add column if not exists source_procedure_parameters jsonb;

alter table plan_revisions drop constraint if exists plan_revisions_source_procedure_parameters;
alter table plan_revisions add constraint plan_revisions_source_procedure_parameters
  check (
    source_procedure_parameters is null
    or (source_procedure_id is not null and jsonb_typeof(source_procedure_parameters) = 'object')
  );
