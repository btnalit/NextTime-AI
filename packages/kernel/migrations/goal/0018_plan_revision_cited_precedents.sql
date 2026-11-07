-- module: goal, version: 0018
--
-- 0018_plan_revision_cited_precedents (S11 GO17b: docs/goal-orchestration-and-admin-agent-plan-
-- 2026-10-16.md §4, the 先例 paragraph; s11-w4/go17-default-plan.md F4 A). Whoever writes a plan —
-- the entry agent proposing a goal (`propose_goal`), the goal planner revising one (its report) —
-- reads the requester's earlier goals of the same kind first (GO17a, `application/goal/
-- precedents.ts`). A revision now records which of them its plan built on, so a goal's page can say
-- 「参考了先例：…」 and a person can open the goal it learned from:
--
--   * `cited_precedents`: the ids of those goals, in the order given; `null` when none was cited
--     (every revision before this one, a person's own revision, a plan that cited nothing).
--
-- What may be cited is fixed here, not by the writer: each id names a goal of the same workspace,
-- requested by the same person (`on_behalf_of`) and `completed` — so with an outcome (goal/0001
-- `goal_runs_outcome`), which no later change takes away (`completed` is final) — never the goal
-- itself, each once, at most 10 (`@nexttime/shared` `GOAL_PRECEDENT_MAX_LIMIT`, what one
-- `find_goal_precedents` returns). The kernel checks the same before it writes and answers with
-- the place that does not pass (`application/goal/cited-precedents.ts` `citedPrecedentProblems`); a
-- planner's report may cite only the precedents its round's input gave it (`planner.ts`), which
-- the database cannot see. Whoever can read the revision can read the goals it cites: both are
-- the same requester's (`views.ts` `goalVisibleTo`).
--
-- A citation says what the plan was written from; it authorizes nothing, and a cited plan is
-- checked like any other (I-G8 unchanged). It never changes after the insert —
-- `plan_revisions_guard` (goal/0001) lets only the columns it lists change, and this is not among
-- them.
--
-- Nullable, no backfill. The previous release's code neither reads nor writes the column (its
-- reads name their columns, `PLAN_REVISION_ROW_COLUMNS`), and its writes leave it `null`.
--
-- Rolling back (docs/runbooks/release.md §6): nothing to do for the previous release's kernel. To
-- drop the schema too, with the kernel stopped, in one transaction: `drop trigger
-- plan_revisions_cited_precedents on plan_revisions`, `drop function
-- plan_revisions_cited_precedents_guard()`, `alter table plan_revisions drop column
-- cited_precedents` (its CHECK goes with it) and `delete from schema_migrations where module =
-- 'goal' and version = 18`. What the dropped column held is also in each revision's
-- `plan_revision.propose` / `goal_run.propose` audit payload (`citedPrecedents`).
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0017.
select pg_advisory_xact_lock(7241000701);

alter table plan_revisions add column if not exists cited_precedents uuid[];

-- What a row can say without reading another one. `array_position(…, null)` finds a null element
-- (it compares with IS NOT DISTINCT FROM); the conjunction is false, not unknown, when one is
-- there, so the `any` below never decides alone on a null.
alter table plan_revisions drop constraint if exists plan_revisions_cited_precedents_shape;
alter table plan_revisions add constraint plan_revisions_cited_precedents_shape check (
  cited_precedents is null or (
    array_ndims(cited_precedents) = 1
    and cardinality(cited_precedents) between 1 and 10
    and array_position(cited_precedents, null) is null
    and not (goal_run_id = any (cited_precedents))
  )
);

-- What it can say only by reading other rows: each cited goal once, each a completed goal of the
-- same requester in this workspace. Read as the inserting session: goal_runs' row-level security
-- is the workspace's, and the revision is written in its workspace.
create or replace function plan_revisions_cited_precedents_guard() returns trigger
language plpgsql as $$
declare
  requester goal_runs.on_behalf_of%type;
  refused uuid;
begin
  -- Nothing to read; or a shape `plan_revisions_cited_precedents_shape` refuses, which Postgres
  -- checks after this trigger — let it name the row's own fault.
  if new.cited_precedents is null
     or array_ndims(new.cited_precedents) is distinct from 1
     or cardinality(new.cited_precedents) not between 1 and 10
     or array_position(new.cited_precedents, null) is not null
     or new.goal_run_id = any (new.cited_precedents) then
    return new;
  end if;
  if cardinality(new.cited_precedents)
     <> (select count(distinct cited.goal_id) from unnest(new.cited_precedents) as cited(goal_id)) then
    raise exception 'plan_revisions: a revision cites each precedent once (plan_revisions_cited_precedents)';
  end if;
  select g.on_behalf_of into requester
    from goal_runs g
   where g.workspace_id = new.workspace_id and g.id = new.goal_run_id;
  select cited.goal_id into refused
    from unnest(new.cited_precedents) as cited(goal_id)
   where not exists (
           select 1 from goal_runs p
            where p.workspace_id = new.workspace_id
              and p.id = cited.goal_id
              and p.status = 'completed'
              and p.on_behalf_of = requester
         )
   limit 1;
  if refused is not null then
    raise exception 'plan_revisions: precedent % is not a completed goal of the same requester (plan_revisions_cited_precedents)',
      refused;
  end if;
  return new;
end;
$$;

create or replace trigger plan_revisions_cited_precedents
  before insert on plan_revisions
  for each row execute function plan_revisions_cited_precedents_guard();
