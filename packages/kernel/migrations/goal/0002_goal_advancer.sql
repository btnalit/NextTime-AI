-- module: goal, version: 0002
--
-- 0002_goal_advancer (S11 GO2: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §4.2,
-- docs/global-roadmap-2026-10-16.md GO2). When the deterministic advancer next looks at a GoalRun.
--
-- `next_tick_at` is the only scheduling state, and it lives on the row it schedules — no queue
-- table, no in-process timer that a restart loses:
--   * due = `next_tick_at <= now()`. The advancer claims due rows with `for no key update skip
--     locked` and pushes `next_tick_at` one lease ahead in the claiming transaction, so a crashed
--     advance is retried when the lease runs out (by this kernel after a restart, or another);
--   * the advance itself ends by writing the next time it must look again (the earliest retry
--     backoff, the wall-clock deadline, a quota retry) or null when only an event can move the run;
--   * an outbox consumer (`TaskUpdated`, `ActionRequestUpdated`) and the periodic reconcile scan set
--     it to `now()` in their own short transactions — they never advance anything themselves.
-- A wake that lands while an advance holds the row waits for it, then sets the row due again, so
-- the advance's own final write never swallows a wake it did not see.
--
-- A final GoalRun is never due (CHECK): the transition into completed / cancelled / failed clears
-- it in the same statement, and the guard keeps a final row frozen.
--
-- Guard: `goal_runs_status_guard` lists the columns that may change at all (goal/0001); a column
-- added later is frozen until its migration lists it. Replaced here with `next_tick_at` added to
-- that list and nothing else changed — compare with goal/0001 (the goal-schema integration test
-- does). goal/0001 is already applied wherever this runs, so its file stays as it was.
--
-- Index: the claim reads due rows in `next_tick_at` order across every workspace; the partial
-- index holds only the scheduled ones (live runs waiting on a timer or a wake).
--
-- Reversibility: an added nullable column and a guard that allows one more column to change. The
-- previous release neither reads nor writes `next_tick_at`, and it never writes a final status
-- with `next_tick_at` set (it does not advance goal runs at all).
--
-- Cross-process bootstrap lock: the goal module's key (goal/0001).
select pg_advisory_xact_lock(7241000701);

alter table goal_runs add column if not exists next_tick_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'goal_runs_next_tick') then
    alter table goal_runs add constraint goal_runs_next_tick check (
      status not in ('completed', 'cancelled', 'failed') or next_tick_at is null
    );
  end if;
end
$$;

create index if not exists goal_runs_next_tick_idx
  on goal_runs (next_tick_at)
  where next_tick_at is not null;

-- goal_runs_status_guard as in goal/0001, with `next_tick_at` among the columns that may change.
create or replace function goal_runs_status_guard() returns trigger
language plpgsql as $$
declare
  changed text;
  new_base int;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' then
      raise exception 'goal_runs: a goal run is created proposed, not %', new.status;
    end if;
    return new;
  end if;

  changed := goal_changed_columns(to_jsonb(new), to_jsonb(old), array[
    'status', 'pause_reason', 'cleanup_pending', 'outcome', 'outcome_basis', 'current_revision',
    'budget_max_tokens', 'budget_max_steps', 'budget_max_revisions',
    'budget_max_wall_clock_seconds', 'updated_at', 'confirmed_at', 'ended_at', 'next_tick_at']);
  if changed is not null then
    raise exception 'goal_runs: the requester, the originating turn, the statement and created_at never change (%)',
      changed;
  end if;
  if new.status is distinct from old.status
     and not goal_run_transition_allowed(old.status, new.status) then
    raise exception 'goal_runs: illegal transition % -> %', old.status, new.status;
  end if;

  if old.status in ('completed', 'cancelled', 'failed') then
    changed := goal_changed_columns(to_jsonb(new), to_jsonb(old), array['updated_at', 'cleanup_pending']);
    if changed is not null then
      raise exception 'goal_runs: a % goal run is final; % cannot change', old.status, changed;
    end if;
    if new.cleanup_pending and not old.cleanup_pending then
      raise exception 'goal_runs: cleanup_pending is set by the transition into cancelled and only clears afterwards';
    end if;
    return new;
  end if;

  if old.status = 'paused' and new.status = 'paused'
     and new.pause_reason is distinct from old.pause_reason then
    raise exception 'goal_runs: the pause reason is set by the transition into paused (% -> %)',
      old.pause_reason, new.pause_reason;
  end if;

  if new.current_revision is distinct from old.current_revision then
    if new.current_revision is null or new.current_revision < old.current_revision then
      raise exception 'goal_runs: the current revision never goes back (% -> %) (I-G2)',
        old.current_revision, new.current_revision;
    end if;
    if old.status not in ('proposed', 'running', 'paused') or new.status not in ('running', 'paused') then
      raise exception 'goal_runs: a revision takes effect only while the goal run is proposed, running or paused (% -> %)',
        old.status, new.status;
    end if;
    select pr.based_on_revision into new_base
      from plan_revisions pr
     where pr.workspace_id = new.workspace_id
       and pr.goal_run_id = new.id
       and pr.revision = new.current_revision
       and pr.status = 'accepted';
    if not found then
      raise exception 'goal_runs: revision % is not an accepted revision of this goal run (I-G2)',
        new.current_revision;
    end if;
    if new_base is distinct from old.current_revision then
      raise exception 'goal_runs: revision % is based on %, not on the current revision % (I-G3)',
        new.current_revision, coalesce(new_base::text, 'none'), coalesce(old.current_revision::text, 'none');
    end if;
  end if;

  if old.confirmed_at is not null and new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'goal_runs: confirmed_at is written once';
  end if;

  if (new.budget_max_tokens, new.budget_max_steps, new.budget_max_revisions, new.budget_max_wall_clock_seconds)
       is distinct from
     (old.budget_max_tokens, old.budget_max_steps, old.budget_max_revisions, old.budget_max_wall_clock_seconds)
     and old.status <> 'proposed'
     and new.current_revision is not distinct from old.current_revision then
    raise exception 'goal_runs: the budget changes before confirmation or with the revision that takes effect (I-G6)';
  end if;

  return new;
end;
$$;

create or replace trigger goal_runs_status_guard
  before insert or update on goal_runs
  for each row execute function goal_runs_status_guard();
