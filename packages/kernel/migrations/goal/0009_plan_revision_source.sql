-- module: goal, version: 0009
--
-- 0009_plan_revision_source (S11 GO5d-2: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §4.3 "Procedure 成为计划模板"). `propose_goal` may make a goal's plan from a published Procedure
-- (`fromProcedure`) instead of taking it written out: `application/goal/from-procedure.ts` expands
-- the Procedure's version into revision 1's plan, which is then checked exactly as a written one.
-- The revision records which version it was made from, so a goal's page can say 「由流程 X vN 生成」
-- and the evolution loop can count the goals a Procedure version made:
--
--   * `source_procedure_id`, `source_procedure_version` — both or neither, and only on revision 1
--     (a later revision is the requester's own edit of a paused run, made from nothing but the plan
--     before it).
--
-- The foreign key to `procedures (workspace_id, id, version)` is worker/0005's: on a fresh
-- database this module runs before `worker`, so the table it references does not exist yet.
--
-- Nullable, no backfill: every existing revision was written out. The columns never change after
-- the insert — `plan_revisions_guard` (goal/0001) lets only the columns it lists change, and
-- these are not among them. The previous release's code neither reads nor writes them.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0008.
select pg_advisory_xact_lock(7241000701);

alter table plan_revisions add column if not exists source_procedure_id uuid;
alter table plan_revisions add column if not exists source_procedure_version int;

alter table plan_revisions drop constraint if exists plan_revisions_source_procedure_pair;
alter table plan_revisions add constraint plan_revisions_source_procedure_pair
  check ((source_procedure_id is null) = (source_procedure_version is null));

alter table plan_revisions drop constraint if exists plan_revisions_source_procedure_first;
alter table plan_revisions add constraint plan_revisions_source_procedure_first
  check (source_procedure_id is null or revision = 1);
