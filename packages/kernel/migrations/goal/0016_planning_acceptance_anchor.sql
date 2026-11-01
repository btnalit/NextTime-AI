-- module: goal, version: 0016
--
-- 0016_planning_acceptance_anchor (S11 GO10b; plan §4.6, §4.9; project plan s11-w2/go10b-default-plan.md).
-- Until now the goal planner had one kind of judgment point: the failed attempt of a step the
-- platform does not retry on its own (goal/0014). A goal whose every step succeeded but whose own
-- acceptance did not pass — the plan's idea was wrong — paused `needs_decision` and the planner did
-- nothing for it. GO10b gives that pause a planning round too: a verification round of the goal
-- (`goal_acceptance_checks.round`, goal/0005) with a check the platform made that `failed` is the
-- judgment point, and the planner proposes a revision the requester decides on, as for a step.
--
--   `goal_planning_rounds.acceptance_round` — the verification round a round is for. A round has
--   exactly one anchor: the failed attempt of a step (`step_run_id`, `step_attempt`,
--   `failure_category`, which become nullable here), or a verification round (`acceptance_round`).
--   At most one round per verification round (I-P4: a round belongs to one pause; resuming
--   verifies again in a new verification round, which may get its own).
--
--   I-P6: a round for a verification round is a `proposal` round — the platform never changes the
--   plan on its own after the goal's acceptance did not pass (an `apply_minor` leave included: the
--   run is paused for it already). The constraint below holds it; the guard checks, besides
--   goal/0015's conditions for a proposal round (paused `needs_decision`, no owner's hold, on the
--   revision in force, the requester's leave), that the round is the run's latest verification
--   round, on the revision in force, with at least one check `failed` — a round of only
--   `unavailable` checks is no judgment point: the platform could not look, a revision would not
--   help.
--
-- No backfill: every existing round is a step's.
--
-- Rolling back (docs/runbooks/release.md §6; review #488 on #872). Code without this migration
-- (v0.54.0 and earlier, or a build with GO10 and not GO10b) reads a round's step through an inner
-- join, so it does not see a round anchored on a verification round:
--   - one left `running` is never settled — its planner's result never lands — and once its
--     planner Task ends, the advance's due query, which does not join steps, still sees it: the
--     run is advanced every tick for nothing until a person acts on it (a resume, end, cancel,
--     revision of the plan or an owner's hold abandons it `run_left_pause`, which this guard
--     takes);
--   - a settled one is harmless to it: the planner card leaves it out (a revision it proposed is
--     still offered for the requester's decision); and in a build with GO10 the planner rounds
--     `maxRevisions` caps no longer count it (`usage.plannerRounds` still does), so such a goal
--     may run that many more planner rounds for a failed step (v0.54.0 has no such cap).
-- Code only may therefore roll back while none runs —
--   `select count(*) from goal_planning_rounds where acceptance_round is not null and status = 'running'`
-- is 0; otherwise let each finish, or have its run's requester resume or end the run, first. To
-- drop the schema too, no such round may be left at all (the same count without `status` is 0;
-- step 3's `set not null` refuses otherwise) — with the kernel stopped, in one transaction:
--   1. restore goal/0015's `goal_planning_rounds_guard` (re-run its `create or replace` from 0015),
--      first: this guard reads `acceptance_round`;
--   2. drop the constraints `goal_planning_rounds_anchor`, `goal_planning_rounds_acceptance_kind`
--      and the index `goal_planning_rounds_acceptance_uidx`;
--   3. `alter table goal_planning_rounds drop column acceptance_round`, then `alter column ... set
--      not null` for `step_run_id`, `step_attempt`, `failure_category`;
--   4. `delete from schema_migrations where module = 'goal' and version = 16`.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0015.
select pg_advisory_xact_lock(7241000701);

alter table goal_planning_rounds alter column step_run_id drop not null;
alter table goal_planning_rounds alter column step_attempt drop not null;
alter table goal_planning_rounds alter column failure_category drop not null;
alter table goal_planning_rounds add column if not exists acceptance_round int;

-- One anchor: a step's failed attempt, or a verification round of the goal.
alter table goal_planning_rounds drop constraint if exists goal_planning_rounds_anchor;
alter table goal_planning_rounds add constraint goal_planning_rounds_anchor check (
  (step_run_id is not null and step_attempt is not null and failure_category is not null
   and acceptance_round is null)
  or (step_run_id is null and step_attempt is null and failure_category is null
      and acceptance_round is not null and acceptance_round >= 1)
);

-- I-P6: the planner only proposes for a goal whose acceptance did not pass.
alter table goal_planning_rounds drop constraint if exists goal_planning_rounds_acceptance_kind;
alter table goal_planning_rounds add constraint goal_planning_rounds_acceptance_kind
  check (acceptance_round is null or kind = 'proposal');

-- One round per verification round (the step's index, goal/0014, is one per failed attempt).
create unique index if not exists goal_planning_rounds_acceptance_uidx
  on goal_planning_rounds (workspace_id, goal_run_id, acceptance_round)
  where acceptance_round is not null;

-- goal/0015's guard, with the verification-round anchor at INSERT and `acceptance_round` among what
-- a round was opened for (never changes).
create or replace function goal_planning_rounds_guard() returns trigger
language plpgsql as $$
declare
  goal record;
  step record;
  leave text;
  latest int;
begin
  if tg_op = 'INSERT' then
    select g.status, g.pause_reason, g.paused_by_authority, g.current_revision into goal
      from goal_runs g
     where g.workspace_id = new.workspace_id and g.id = new.goal_run_id
       for no key update;
    select d.mode into leave
      from goal_planner_delegations d
     where d.workspace_id = new.workspace_id and d.goal_run_id = new.goal_run_id;
    if leave is null then
      raise exception 'goal_planning_rounds: the requester did not let the planner propose revisions of this goal run';
    end if;
    if new.kind = 'proposal' then
      if goal.status is distinct from 'paused' or goal.pause_reason is distinct from 'needs_decision'
         or goal.paused_by_authority is not distinct from 'owner' then
        raise exception 'goal_planning_rounds: a round opens while its goal run is paused for a decision and no owner holds it';
      end if;
    else
      -- goal/0015: an autonomous round, while the run keeps running under an apply_minor leave.
      if goal.status is distinct from 'running' then
        raise exception 'goal_planning_rounds: an autonomous round opens while its goal run is running, not %',
          coalesce(goal.status, 'missing');
      end if;
      if leave <> 'apply_minor' then
        raise exception 'goal_planning_rounds: an autonomous round needs the requester''s apply_minor leave (this run has %)',
          leave;
      end if;
    end if;
    if new.based_on_revision is distinct from goal.current_revision then
      raise exception 'goal_planning_rounds: a round is based on the revision in force (%), not %',
        coalesce(goal.current_revision::text, 'none'), new.based_on_revision;
    end if;
    if new.acceptance_round is not null then
      -- goal/0016: the run's latest verification round, on the revision in force, a check of it
      -- failed (I-P6's kind is the constraint's).
      select max(c.round) into latest
        from goal_acceptance_checks c
       where c.workspace_id = new.workspace_id and c.goal_run_id = new.goal_run_id;
      if latest is distinct from new.acceptance_round then
        raise exception 'goal_planning_rounds: a round is for the latest verification round of its goal run (%), not %',
          coalesce(latest::text, 'none'), new.acceptance_round;
      end if;
      if exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.goal_run_id
              and c.round = new.acceptance_round
              and c.plan_revision is distinct from goal.current_revision) then
        raise exception 'goal_planning_rounds: a round is for a verification round of the revision in force';
      end if;
      if not exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.goal_run_id
              and c.round = new.acceptance_round and c.status = 'failed') then
        raise exception 'goal_planning_rounds: a round is for a verification round with a check that failed';
      end if;
    else
      select s.status, s.attempt_count, s.failure_category, s.superseded_in_revision into step
        from step_runs s
       where s.workspace_id = new.workspace_id and s.goal_run_id = new.goal_run_id
         and s.id = new.step_run_id;
      if step.status is distinct from 'failed' or step.superseded_in_revision is not null
         or step.attempt_count is distinct from new.step_attempt
         or step.failure_category is distinct from new.failure_category then
        raise exception 'goal_planning_rounds: a round is for the failed attempt of a live step, with its failure category';
      end if;
    end if;
    if new.revision_class is not null or new.class_reasons <> '[]'::jsonb then
      raise exception 'goal_planning_rounds: a round is classed when it settles, not when it opens';
    end if;
    if new.status = 'running' then
      if new.revision is not null or new.outcome_reason is not null or new.detail is not null
         or new.settled_at is not null then
        raise exception 'goal_planning_rounds: a running round has no result yet';
      end if;
      return new;
    end if;
    -- No planner can run for this judgment point: the round is recorded as failed, with why.
    if new.status <> 'failed' or new.outcome_reason not in (
         'revision_budget_exhausted', 'token_budget_exhausted', 'planner_unavailable',
         'requester_cannot_start', 'step_keeps_failing') then
      raise exception 'goal_planning_rounds: a round is opened running, or recorded failed because no planner could run for it';
    end if;
    if new.outcome_reason = 'step_keeps_failing' and new.kind <> 'autonomous' then
      raise exception 'goal_planning_rounds: only the platform''s own planning stops for a step that keeps failing';
    end if;
    return new;
  end if;

  if (new.workspace_id, new.id, new.goal_run_id, new.based_on_revision, new.step_run_id,
      new.step_attempt, new.failure_category, new.acceptance_round, new.kind, new.created_at)
     is distinct from
     (old.workspace_id, old.id, old.goal_run_id, old.based_on_revision, old.step_run_id,
      old.step_attempt, old.failure_category, old.acceptance_round, old.kind, old.created_at) then
    raise exception 'goal_planning_rounds: what a round was opened for never changes';
  end if;
  if old.status <> 'running' then
    if (new.status, new.revision, new.outcome_reason, new.detail, new.settled_at,
        new.revision_class, new.class_reasons)
       is distinct from
       (old.status, old.revision, old.outcome_reason, old.detail, old.settled_at,
        old.revision_class, old.class_reasons) then
      raise exception 'goal_planning_rounds: a round settles once (it is %)', old.status;
    end if;
    return new;
  end if;
  if new.status = 'proposed' and not exists (
       select 1 from plan_revisions r
        where r.workspace_id = new.workspace_id and r.goal_run_id = new.goal_run_id
          and r.revision = new.revision and r.status = 'proposed'
          and r.based_on_revision = new.based_on_revision
          and goal_planner_principal(r.workspace_id, r.proposed_by)) then
    raise exception 'goal_planning_rounds: a round proposes a revision the planner proposed on the round''s base';
  end if;
  if new.status = 'applied' then
    if old.kind <> 'autonomous' then
      raise exception 'goal_planning_rounds: only an autonomous round has its revision applied by the platform';
    end if;
    select d.mode into leave
      from goal_planner_delegations d
     where d.workspace_id = new.workspace_id and d.goal_run_id = new.goal_run_id;
    if leave is distinct from 'apply_minor' then
      raise exception 'goal_planning_rounds: the platform applies a planner revision only under the requester''s apply_minor leave';
    end if;
    if not exists (
         select 1 from plan_revisions r
          where r.workspace_id = new.workspace_id and r.goal_run_id = new.goal_run_id
            and r.revision = new.revision and r.status = 'accepted'
            and r.based_on_revision = new.based_on_revision
            and goal_planner_principal(r.workspace_id, r.proposed_by)) then
      raise exception 'goal_planning_rounds: an applied round''s revision is the planner''s, on the round''s base, accepted';
    end if;
  end if;
  if new.status = 'failed' and new.outcome_reason not in ('task_failed', 'invalid_revision') then
    raise exception 'goal_planning_rounds: a running round fails because its Task gave no usable result (task_failed, invalid_revision)';
  end if;
  -- An autonomous round is abandoned `run_not_running` by this release's code; `run_left_pause` is
  -- still taken for it, because code rolled back to GO9a's (which knows no kind) writes that for
  -- every round — refusing it would leave such a run's advance failing and its cancel refused
  -- (review #488 on #866).
  if new.status = 'abandoned' and new.outcome_reason not in ('plan_revised', 'run_left_pause')
     and not (old.kind = 'autonomous' and new.outcome_reason = 'run_not_running') then
    raise exception 'goal_planning_rounds: a % round is abandoned because %', old.kind,
      case old.kind when 'autonomous' then 'its run stopped running (run_not_running) or its plan was revised'
                    else 'its run left the pause (run_left_pause) or its plan was revised' end;
  end if;
  return new;
end;
$$;
