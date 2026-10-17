-- module: goal, version: 0004
--
-- 0004_goal_revision_hold (S11 GO3b: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §3.4, §4.3, §4.8; docs/global-roadmap-2026-10-16.md GO3). Three facts the GoalRun rows did not
-- hold yet:
--
--   * Who paused a run, and the authority that pause carries (`paused_by`, `paused_by_authority`).
--     A person's pause names them and whether they paused as the requester or as a workspace
--     owner; the advancer's pauses (budget, authority lost, a decision needed) name nobody. An
--     owner's pause of someone else's run is a hold: the requester cannot resume it until a
--     workspace owner lifts the hold. An owner may also place a hold on a run that is already
--     paused for another reason, and lift it again; nothing else changes who paused while the run
--     stays paused, and leaving `paused` clears both (a CHECK).
--   * How often in a row the advance of a run failed (`advance_failures`, legacy 356): reset by an
--     advance that commits, counted by the advancer after one that throws; a running run that
--     keeps failing is paused for a person instead of being retried every lease forever.
--   * What a revision decided about the steps it removes (`plan_revisions.removals`): per removed
--     step the person decided about, whether its Tasks are terminated (the default, also for every
--     removed step not listed) or let to finish, and which of its submitted requests the person
--     released — those keep their status and are decided and run as usual; every other request of
--     the step was withdrawn when the revision was accepted (§4.8, I-G9). Part of the revision's
--     immutable content like its plan, so the revision row is the whole decision: the advance
--     reads it to know which Tasks to terminate, and the I-G9 monitor to tell a released request
--     from a breach. Shape:
--     `{"<stepKey>": {"mode": "terminate" | "let_finish", "release": ["<actionRequestId>", …]}}`,
--     checked by the code that accepts revisions (`application/goal/revise.ts`); the database
--     holds it to an object, empty on revision 1.
--
-- Guard: `goal_runs_status_guard` as in goal/0002 with the three columns listed as changeable and
-- one block added after the pause-reason check (who paused, see above) — compare with goal/0002
-- (the goal-schema integration test does). `plan_revisions_guard` needs no change: a column it
-- does not list is frozen after insert, which is what `removals` must be. goal/0002 is already
-- applied wherever this runs, so its file stays as it was.
--
-- Reversibility: added columns with defaults the previous release never writes, and a guard that
-- refuses only changes of those columns. The previous release's pauses and resumes leave both
-- `paused_by` columns null, which the guard and the CHECK accept.
--
-- Cross-process bootstrap lock: the goal module's key (goal/0001).
select pg_advisory_xact_lock(7241000701);

alter table goal_runs add column if not exists paused_by uuid;
alter table goal_runs add column if not exists paused_by_authority text;
alter table goal_runs add column if not exists advance_failures int not null default 0;
alter table plan_revisions add column if not exists removals jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'goal_runs_paused_by_fk') then
    alter table goal_runs add constraint goal_runs_paused_by_fk
      foreign key (workspace_id, paused_by) references principals (workspace_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'goal_runs_paused_by') then
    alter table goal_runs add constraint goal_runs_paused_by check (
      (paused_by_authority is null or paused_by_authority in ('requester', 'owner'))
      and (paused_by is null) = (paused_by_authority is null)
      and (paused_by is null or status = 'paused')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'goal_runs_advance_failures') then
    alter table goal_runs add constraint goal_runs_advance_failures check (advance_failures >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plan_revisions_removals') then
    alter table plan_revisions add constraint plan_revisions_removals check (
      jsonb_typeof(removals) = 'object' and (revision > 1 or removals = '{}'::jsonb)
    );
  end if;
end
$$;

-- goal_runs_status_guard as in goal/0002, with `paused_by`, `paused_by_authority` and
-- `advance_failures` among the columns that may change, and the hold rules after the pause-reason
-- check.
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
    'budget_max_wall_clock_seconds', 'updated_at', 'confirmed_at', 'ended_at', 'next_tick_at',
    'paused_by', 'paused_by_authority', 'advance_failures']);
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

  -- goal/0004: while paused, who paused changes only to place a workspace owner's hold or to lift
  -- one; a run an owner holds does not resume until an owner lifts the hold. (`is not distinct
  -- from`: an advancer's pause names nobody, and a null must not make a refusal pass.)
  if old.status = 'paused' and new.status = 'paused'
     and (new.paused_by, new.paused_by_authority) is distinct from (old.paused_by, old.paused_by_authority)
     and not (new.paused_by_authority is not distinct from 'owner'
              and old.paused_by_authority is distinct from 'owner')
     and not (old.paused_by_authority is not distinct from 'owner' and new.paused_by is null) then
    raise exception 'goal_runs: while paused, who paused changes only to place an owner''s hold or to lift it (% -> %)',
      coalesce(old.paused_by_authority, 'advancer'), coalesce(new.paused_by_authority, 'advancer');
  end if;
  if old.status = 'paused' and new.status = 'running' and old.paused_by_authority = 'owner' then
    raise exception 'goal_runs: a workspace owner holds this goal run; it resumes only after an owner lifts the hold';
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
