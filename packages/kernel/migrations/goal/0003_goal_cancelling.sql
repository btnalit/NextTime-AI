-- module: goal, version: 0003
--
-- 0003_goal_cancelling (S11 GO3a: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.4,
-- §4.8; docs/global-roadmap-2026-10-16.md GO3). A step of a cancelling GoalRun only ends.
--
-- Cancelling a GoalRun cancels every live step in the same transaction (application/goal
-- `cancelGoalRun`); what `cancelling` then waits for is the run's Tasks and its `executing`
-- ActionRequests, never a step. goal/0001 already let a step of a final GoalRun only end; this
-- adds `cancelling` to that list, so no step of a cancelled goal returns to `running` or `waiting`
-- (the question GO1's review left to GO3): an action that was executing when the goal was
-- cancelled ends the R-48 way and its result is audited, and a step resuming for it would be new
-- work under a goal nobody wants run any more.
--
-- Guard: `step_runs_status_guard` as in goal/0001 with `cancelling` added to that one condition and
-- nothing else changed — compare with goal/0001 (the goal-schema integration test does). goal/0001
-- is already applied wherever this runs, so its file stays as it was.
--
-- Reversibility: a guard that refuses one more case. The previous release never cancels a goal run
-- (it has no cancel path), so it never meets the refusal.
--
-- Cross-process bootstrap lock: the goal module's key (goal/0001).
select pg_advisory_xact_lock(7241000701);

-- step_runs_status_guard as in goal/0001, with `cancelling` among the GoalRun statuses whose steps
-- only end.
create or replace function step_runs_status_guard() returns trigger
language plpgsql as $$
declare
  goal_status text;
  current_rev int;
  changed text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'step_runs: a step run is created pending, not %', new.status;
    end if;
    if new.attempt_count <> 0 then
      raise exception 'step_runs: a step run is created with no attempts, not % (I-G1)', new.attempt_count;
    end if;
    select g.status, g.current_revision into goal_status, current_rev
      from goal_runs g
     where g.workspace_id = new.workspace_id and g.id = new.goal_run_id
       for no key update;
    if goal_status not in ('running', 'paused') then
      raise exception 'step_runs: a % goal run takes no new step', goal_status;
    end if;
    if new.introduced_in_revision is distinct from current_rev then
      raise exception 'step_runs: step % is introduced in revision %, but the current revision is % (I-G2)',
        new.step_key, new.introduced_in_revision, coalesce(current_rev::text, 'none');
    end if;
    if not exists (
         select 1
           from plan_revisions pr, jsonb_array_elements(pr.plan -> 'steps') as step
          where pr.workspace_id = new.workspace_id
            and pr.goal_run_id = new.goal_run_id
            and pr.revision = new.introduced_in_revision
            and pr.status = 'accepted'
            and step ->> 'key' = new.step_key
       ) then
      raise exception 'step_runs: step % is not in accepted revision % of this goal run',
        new.step_key, new.introduced_in_revision;
    end if;
    return new;
  end if;

  changed := goal_changed_columns(to_jsonb(new), to_jsonb(old), array[
    'status', 'waiting_reason', 'failure_category', 'attempt_count', 'superseded_in_revision',
    'updated_at', 'ended_at']);
  if changed is not null then
    raise exception 'step_runs: a step run''s identity never changes (%)', changed;
  end if;
  if new.status is distinct from old.status
     and not step_run_transition_allowed(old.status, new.status) then
    raise exception 'step_runs: illegal transition % -> %', old.status, new.status;
  end if;

  if old.status in ('succeeded', 'superseded', 'cancelled', 'skipped') then
    changed := goal_changed_columns(to_jsonb(new), to_jsonb(old), array['updated_at']);
    if changed is not null then
      raise exception 'step_runs: a % step run is final; % cannot change', old.status, changed;
    end if;
    return new;
  end if;

  if old.status = 'waiting' and new.status = 'waiting'
     and new.waiting_reason is distinct from old.waiting_reason then
    raise exception 'step_runs: the waiting reason is set by the transition into waiting (% -> %)',
      old.waiting_reason, new.waiting_reason;
  end if;
  if old.status = 'failed' and new.status = 'failed'
     and new.failure_category is distinct from old.failure_category then
    raise exception 'step_runs: the failure category is set by the transition into failed (% -> %)',
      old.failure_category, new.failure_category;
  end if;
  if old.status = 'ready' and new.status = 'running' then
    if new.attempt_count <> old.attempt_count + 1 then
      raise exception 'step_runs: each start (ready -> running) is one new attempt, not % -> % (I-G1)',
        old.attempt_count, new.attempt_count;
    end if;
  elsif new.attempt_count <> old.attempt_count then
    raise exception 'step_runs: attempts are counted only when a step starts (ready -> running), not % -> % (I-G1)',
      old.attempt_count, new.attempt_count;
  end if;

  if new.status is distinct from old.status
     and new.status in ('ready', 'running', 'waiting', 'superseded') then
    select g.status, g.current_revision into goal_status, current_rev
      from goal_runs g
     where g.workspace_id = new.workspace_id and g.id = new.goal_run_id
       for no key update;
    if new.status = 'ready' and goal_status not in ('running', 'paused') then
      raise exception 'step_runs: a step becomes ready only while its goal run is running or paused, not %',
        goal_status;
    end if;
    if old.status = 'ready' and new.status = 'running' and goal_status <> 'running' then
      raise exception 'step_runs: an attempt starts only while its goal run is running, not %', goal_status;
    end if;
    if new.status in ('running', 'waiting') and goal_status in ('cancelling', 'completed', 'cancelled', 'failed') then
      raise exception 'step_runs: a step of a % goal run only ends', goal_status;
    end if;
    if new.status = 'superseded' and new.superseded_in_revision is distinct from current_rev then
      raise exception 'step_runs: a step is superseded by the current revision %, not by % (I-G2)',
        coalesce(current_rev::text, 'none'), coalesce(new.superseded_in_revision::text, 'none');
    end if;
  end if;

  return new;
end;
$$;
