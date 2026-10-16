-- module: goal, version: 0001
--
-- 0001_goal_runs (S11 GO1: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1–§3.4,
-- §7.2 item 1). The goal-level execution state: a GoalRun (an accepted goal, its budget and its
-- objective outcome), its PlanRevisions (immutable versions of the plan) and its StepRuns (the
-- business steps of the plan, each run by 0..N Tasks — one per attempt). Owned by
-- `application/goal`; the advancer that moves these rows (GO2) and the capabilities that create
-- them (GO5) come later — this file fixes their shape and what the database refuses.
--
-- Relations (§3.2), all real foreign keys with `workspace_id` in them:
--   * GoalRun `on_behalf_of` Principal (the requester); `originated_in` Turn (0..1 — a Turn starts
--     at most one GoalRun, a partial unique index); `current_revision` → PlanRevision (by number,
--     checked by the guard below: an accepted revision of the same GoalRun, based on the previous
--     current one).
--   * PlanRevision `belongs_to` GoalRun; `based_on` PlanRevision (0..1, same GoalRun).
--   * StepRun `belongs_to` GoalRun; `introduced_in` PlanRevision; `superseded_in` PlanRevision
--     (0..1, a later revision of the same GoalRun).
--   Task `executes` StepRun and ActionRequest `raised_in` StepRun are columns on those tables
--   (task/0007, governance/0022): this module sorts before both, so their foreign keys can point
--   here; nothing here points at them.
--
-- `current_revision` is a number checked by trigger rather than a foreign key on purpose: with a
-- foreign key from goal_runs to plan_revisions and back, the two tables would form a cycle, and
-- `application/platform/purge-workspace.ts` refuses to compute a deletion order for a cycle.
--
-- State machines: packages/shared transitions.ts `GOAL_RUN_EDGES`, `PLAN_REVISION_EDGES`,
-- `STEP_RUN_EDGES`, reproduced as `*_transition_allowed(from, to)` below (a kernel test compares
-- every pair with the shared tables) and enforced by each table's guard trigger: a row is created in
-- its initial status only and moves along an edge only. Beyond the edges the guards freeze a row's
-- identity and a final row whole, tie each sub-state to the transition into its status, and keep
-- the accepted revisions one chain ending at `current_revision` (see "Guards" below). These are
-- new tables that no earlier release reads or writes, so the full guard costs no reversibility
-- (unlike `action_requests`, where governance/0021 guards only the new `withdrawn` edge). Sub-states
-- are columns, each set exactly while its status holds (CHECKs): `pause_reason`, `waiting_reason`,
-- `failure_category`, `outcome` + `outcome_basis` (I-G5: only `verified_by_check` / `requester` /
-- `reviewer_assessed`).
--
-- StepRun identity (I-G2): a StepRun's definition is its entry in the plan of the revision that
-- introduced it, for its whole life. A revision that drops or changes a step supersedes it; a
-- changed step comes back as a new StepRun under the same `step_key` (one live StepRun per key, a
-- partial unique index). So a live StepRun always belongs to the current plan, and the result of a
-- Task that executes it is the step's result, whichever revision is current.
--
-- Plan content: `plan` is a JSON object with a `steps` array whose elements carry a unique `key`
-- — the only part of its shape this file relies on (StepRun `step_key` must name a step of the
-- revision that introduced it). The rest of a step (Worker source, dependencies, input bindings,
-- output schema, acceptance checks) is validated by the code that proposes plans (GO2, GO5).
--
-- Budget (I-G6): four limits, all required. Usage is derived, never stored twice: tokens are the
-- sum of the GoalRun's Tasks' `tokens_used`, steps the advancer's attempts (Tasks with a
-- `step_attempt`), revisions the accepted ones after the first, wall clock from `confirmed_at`.
--
-- Not here: `next_tick_at` and the advancer's lease (GO2), acceptance checks (GO4), idempotency
-- keys for `propose_goal` / `confirm_goal` (GO5).
--
-- Cross-process bootstrap lock: a new module, so a new key (core 7241000101, governance
-- 7241000201, llm-usage 7241000301, task 7241000401, worker 7241000501, linkage 7241000601);
-- core/0001_identity.sql's header comment has the rationale.
select pg_advisory_xact_lock(7241000701);

-- ---------------------------------------------------------------------------------------------
-- goal_runs
-- ---------------------------------------------------------------------------------------------

create table if not exists goal_runs (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  status text not null default 'proposed'
    check (status in ('proposed', 'running', 'paused', 'verifying', 'completed', 'cancelling', 'cancelled', 'failed')),
  pause_reason text
    check (pause_reason in ('requested', 'budget_exhausted', 'no_progress', 'authority_lost', 'needs_decision', 'awaiting_reconcile')),
  -- `cancelled(cleanup_pending)` (§3.4): the cancel deadline passed with a Task not yet terminated
  -- or an executing action not yet terminal; those are listed from the rows themselves.
  cleanup_pending boolean not null default false,
  outcome text check (outcome in ('achieved', 'not_achieved')),
  outcome_basis text check (outcome_basis in ('verified_by_check', 'requester', 'reviewer_assessed')),
  on_behalf_of uuid not null,
  originated_in_turn_id uuid,
  statement text not null check (length(statement) > 0),
  current_revision int check (current_revision >= 1),
  budget_max_tokens bigint not null check (budget_max_tokens > 0),
  budget_max_steps int not null check (budget_max_steps > 0),
  budget_max_revisions int not null check (budget_max_revisions >= 0),
  budget_max_wall_clock_seconds int not null check (budget_max_wall_clock_seconds > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  ended_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, on_behalf_of) references principals (workspace_id, id),
  foreign key (workspace_id, originated_in_turn_id) references activities (workspace_id, id),
  constraint goal_runs_pause_reason check ((status = 'paused') = (pause_reason is not null)),
  constraint goal_runs_cleanup_pending check (not cleanup_pending or status = 'cancelled'),
  constraint goal_runs_outcome check (
    (status = 'completed') = (outcome is not null)
    and (outcome is null) = (outcome_basis is null)
  ),
  -- Confirmed exactly when a plan revision is in force: from `running` on, and possibly on a
  -- `cancelled` / `failed` row (which may or may not have been confirmed first).
  constraint goal_runs_confirmed check (
    (current_revision is null) = (confirmed_at is null)
    and (status not in ('running', 'paused', 'verifying', 'completed', 'cancelling') or current_revision is not null)
    and (status <> 'proposed' or current_revision is null)
  ),
  constraint goal_runs_ended check ((status in ('completed', 'cancelled', 'failed')) = (ended_at is not null))
);

create unique index if not exists goal_runs_one_per_turn
  on goal_runs (workspace_id, originated_in_turn_id)
  where originated_in_turn_id is not null;

create index if not exists goal_runs_requester
  on goal_runs (workspace_id, on_behalf_of, created_at desc);

create index if not exists goal_runs_active
  on goal_runs (workspace_id, status)
  where status not in ('completed', 'cancelled', 'failed');

alter table goal_runs enable row level security;
drop policy if exists goal_runs_workspace_isolation on goal_runs;
create policy goal_runs_workspace_isolation on goal_runs
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant: a GoalRun's history stays reconstructable for as long as its Tasks and
-- ActionRequests are (mirrors tasks / action_requests).
grant select, insert, update on goal_runs to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- plan_revisions
-- ---------------------------------------------------------------------------------------------

create table if not exists plan_revisions (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  goal_run_id uuid not null,
  revision int not null check (revision >= 1),
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected')),
  based_on_revision int,
  plan jsonb not null,
  proposed_by uuid not null,
  reason text,
  -- The platform's validation result (I-G3: acyclic, references resolvable, within budget);
  -- writable only while the revision is still proposed.
  validation jsonb,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, goal_run_id, revision),
  foreign key (workspace_id, goal_run_id) references goal_runs (workspace_id, id),
  foreign key (workspace_id, goal_run_id, based_on_revision)
    references plan_revisions (workspace_id, goal_run_id, revision),
  foreign key (workspace_id, proposed_by) references principals (workspace_id, id),
  foreign key (workspace_id, decided_by) references principals (workspace_id, id),
  constraint plan_revisions_based_on check (
    (revision = 1) = (based_on_revision is null)
    and (based_on_revision is null or based_on_revision < revision)
  ),
  constraint plan_revisions_decided check (
    (status = 'proposed') = (decided_at is null)
    and (decided_by is null or decided_at is not null)
  ),
  constraint plan_revisions_plan_shape check (
    jsonb_typeof(plan) = 'object' and jsonb_typeof(plan -> 'steps') = 'array'
  )
);

alter table plan_revisions enable row level security;
drop policy if exists plan_revisions_workspace_isolation on plan_revisions;
create policy plan_revisions_workspace_isolation on plan_revisions
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on plan_revisions to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- step_runs
-- ---------------------------------------------------------------------------------------------

create table if not exists step_runs (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  goal_run_id uuid not null,
  step_key text not null,
  introduced_in_revision int not null,
  superseded_in_revision int,
  status text not null default 'pending'
    check (status in ('pending', 'ready', 'running', 'waiting', 'succeeded', 'failed', 'superseded', 'cancelled', 'skipped')),
  waiting_reason text check (waiting_reason in ('approval', 'reconcile', 'external')),
  failure_category text
    check (failure_category in ('transient', 'authority_lost', 'contract_violation', 'verification_failed', 'outcome_unknown', 'action_refused')),
  -- Attempts started so far: each is one Task with `step_attempt` = 1..attempt_count (I-G1).
  attempt_count int not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  primary key (workspace_id, id),
  unique (workspace_id, goal_run_id, id),
  foreign key (workspace_id, goal_run_id) references goal_runs (workspace_id, id),
  foreign key (workspace_id, goal_run_id, introduced_in_revision)
    references plan_revisions (workspace_id, goal_run_id, revision),
  foreign key (workspace_id, goal_run_id, superseded_in_revision)
    references plan_revisions (workspace_id, goal_run_id, revision),
  constraint step_runs_step_key check (step_key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint step_runs_superseded check (
    (status = 'superseded') = (superseded_in_revision is not null)
    and (superseded_in_revision is null or superseded_in_revision > introduced_in_revision)
  ),
  constraint step_runs_waiting_reason check ((status = 'waiting') = (waiting_reason is not null)),
  constraint step_runs_failure_category check ((status = 'failed') = (failure_category is not null)),
  constraint step_runs_ended check (
    (status in ('succeeded', 'superseded', 'cancelled', 'skipped')) = (ended_at is not null)
  )
);

create unique index if not exists step_runs_one_live_per_key
  on step_runs (workspace_id, goal_run_id, step_key)
  where status <> 'superseded';

alter table step_runs enable row level security;
drop policy if exists step_runs_workspace_isolation on step_runs;
create policy step_runs_workspace_isolation on step_runs
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on step_runs to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- Transition tables (packages/shared transitions.ts; compared pair by pair in
-- application/goal/goal-schema.integration.test.ts)
-- ---------------------------------------------------------------------------------------------

create or replace function goal_run_transition_allowed(from_status text, to_status text)
returns boolean language sql immutable as $$
  select exists (
    select 1
      from (values
        ('proposed', 'running'),
        ('proposed', 'cancelled'),
        ('running', 'paused'),
        ('verifying', 'paused'),
        ('paused', 'running'),
        ('running', 'verifying'),
        ('verifying', 'completed'),
        ('paused', 'completed'),
        ('running', 'cancelling'),
        ('paused', 'cancelling'),
        ('verifying', 'cancelling'),
        ('cancelling', 'cancelled'),
        ('proposed', 'failed'),
        ('running', 'failed'),
        ('paused', 'failed'),
        ('verifying', 'failed'),
        ('cancelling', 'failed')
      ) as edge (from_status, to_status)
     where edge.from_status = $1 and edge.to_status = $2
  )
$$;

create or replace function plan_revision_transition_allowed(from_status text, to_status text)
returns boolean language sql immutable as $$
  select exists (
    select 1
      from (values ('proposed', 'accepted'), ('proposed', 'rejected')) as edge (from_status, to_status)
     where edge.from_status = $1 and edge.to_status = $2
  )
$$;

create or replace function step_run_transition_allowed(from_status text, to_status text)
returns boolean language sql immutable as $$
  select exists (
    select 1
      from (values
        ('pending', 'ready'),
        ('ready', 'running'),
        ('running', 'waiting'),
        ('waiting', 'running'),
        ('running', 'succeeded'),
        ('waiting', 'succeeded'),
        ('running', 'failed'),
        ('waiting', 'failed'),
        ('failed', 'ready'),
        ('pending', 'superseded'),
        ('ready', 'superseded'),
        ('running', 'superseded'),
        ('waiting', 'superseded'),
        ('failed', 'superseded'),
        ('pending', 'cancelled'),
        ('ready', 'cancelled'),
        ('running', 'cancelled'),
        ('waiting', 'cancelled'),
        ('failed', 'cancelled'),
        ('pending', 'skipped'),
        ('ready', 'skipped')
      ) as edge (from_status, to_status)
     where edge.from_status = $1 and edge.to_status = $2
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------
--
-- Each table's guard has the same parts:
--   * the columns that may change at all are listed; every other column (and any column added
--     later, until its migration lists it) never changes once the row exists;
--   * a final status freezes the whole row (`updated_at` aside);
--   * a sub-state column changes only with the transition into its status;
--   * what the GoalRun must be for a change under it. A guard that reads the GoalRun locks its row
--     (`for no key update`), so a decision on the GoalRun and a change under it are serialized —
--     whichever commits second sees the first. Writers lock the GoalRun row before they touch its
--     revisions or steps (the guards take the same lock); a writer that locks a step first and the
--     GoalRun second can deadlock with one that cancels the GoalRun.

-- The columns of `new_row` outside `allowed` whose value differs in `old_row`, comma-separated, or
-- null when there is none.
create or replace function goal_changed_columns(new_row jsonb, old_row jsonb, allowed text[])
returns text language sql immutable as $$
  select string_agg(n.key, ', ' order by n.key)
    from jsonb_each(new_row - allowed) as n
   where n.value is distinct from old_row -> n.key
$$;

-- goal_runs: created `proposed`; moves along an edge only.
--   * Never changes: the requester, the originating Turn, the statement (changing the goal is a
--     revision a person proposes, §4.6) and created_at.
--   * Final once completed / cancelled / failed: nothing changes but `updated_at`, and
--     `cleanup_pending` clearing once the leftovers are gone. So the outcome (I-G5) is written by
--     the transition into `completed` and never rewritten, and a final run adopts no revision.
--   * `pause_reason` does not change while paused; `confirmed_at` is written once.
--   * `current_revision` (the fencing number, I-G2) is never cleared and moves only while the run is
--     proposed (its confirmation), running or paused, onto an accepted revision based on the
--     current one: the accepted revisions form one chain (I-G3).
--   * The budget changes before confirmation, or with the revision that takes effect (a revision
--     that widens it is one the requester confirms, §4.6).
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
    'budget_max_wall_clock_seconds', 'updated_at', 'confirmed_at', 'ended_at']);
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

-- plan_revisions: created `proposed` with a well-formed step list, for a GoalRun that is neither
-- final nor winding down; content never changes (only the status, `validation` while proposed, and
-- the decision do); decided once. Accepted (I-G3) only while its GoalRun is proposed, running or
-- paused, only when based on the GoalRun's current revision, and only when no other accepted
-- revision is still waiting to take effect; `plan_revisions_adopted` below then requires the
-- GoalRun to adopt it in the same transaction. So the accepted revisions form one chain ending at
-- `current_revision`, and of two revisions proposed on the same base the second is refused —
-- accepted in one transaction or in two concurrent ones (the GoalRun lock orders those).
create or replace function plan_revisions_guard() returns trigger
language plpgsql as $$
declare
  goal_status text;
  current_rev int;
  waiting_rev int;
  changed text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' then
      raise exception 'plan_revisions: a revision is created proposed, not %', new.status;
    end if;
    -- The CHECK holds the same; tested here first, so the step checks below never meet a plan
    -- they cannot read.
    if jsonb_typeof(new.plan) is distinct from 'object'
       or jsonb_typeof(new.plan -> 'steps') is distinct from 'array' then
      raise exception 'plan_revisions: a plan is an object with a steps array (plan_revisions_plan_shape)';
    end if;
    if exists (
         select 1 from jsonb_array_elements(new.plan -> 'steps') as step
          where jsonb_typeof(step) <> 'object'
             or jsonb_typeof(step -> 'key') is distinct from 'string'
             or (step ->> 'key') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
       ) then
      raise exception 'plan_revisions: every step is an object with a key of 1-64 letters, digits, "_", "." or "-"';
    end if;
    if (select count(*) from jsonb_array_elements(new.plan -> 'steps'))
       <> (select count(distinct step ->> 'key') from jsonb_array_elements(new.plan -> 'steps') as step) then
      raise exception 'plan_revisions: step keys are unique within a plan';
    end if;
    select g.status into goal_status
      from goal_runs g
     where g.workspace_id = new.workspace_id and g.id = new.goal_run_id
       for no key update;
    if goal_status in ('cancelling', 'completed', 'cancelled', 'failed') then
      raise exception 'plan_revisions: a % goal run takes no new revision', goal_status;
    end if;
    return new;
  end if;

  changed := goal_changed_columns(to_jsonb(new), to_jsonb(old),
    array['status', 'validation', 'decided_by', 'decided_at']);
  if changed is not null then
    raise exception 'plan_revisions: a revision''s content never changes (%)', changed;
  end if;
  if new.validation is distinct from old.validation and old.status <> 'proposed' then
    raise exception 'plan_revisions: validation is recorded before the revision is decided';
  end if;

  if new.status is distinct from old.status then
    if not plan_revision_transition_allowed(old.status, new.status) then
      raise exception 'plan_revisions: illegal transition % -> %', old.status, new.status;
    end if;
    if new.status = 'accepted' then
      select g.status, g.current_revision into goal_status, current_rev
        from goal_runs g
       where g.workspace_id = new.workspace_id and g.id = new.goal_run_id
         for no key update;
      if goal_status not in ('proposed', 'running', 'paused') then
        raise exception 'plan_revisions: a % goal run accepts no revision (I-G3)', goal_status;
      end if;
      if new.based_on_revision is distinct from current_rev then
        raise exception 'plan_revisions: revision % is based on %, but the current revision is % (I-G3)',
          new.revision, coalesce(new.based_on_revision::text, 'none'), coalesce(current_rev::text, 'none');
      end if;
      select max(pr.revision) into waiting_rev
        from plan_revisions pr
       where pr.workspace_id = new.workspace_id
         and pr.goal_run_id = new.goal_run_id
         and pr.status = 'accepted'
         and (current_rev is null or pr.revision > current_rev);
      if waiting_rev is not null then
        raise exception 'plan_revisions: revision % is accepted but not yet current, so revision % cannot be accepted beside it (I-G3)',
          waiting_rev, new.revision;
      end if;
    end if;
  elsif new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at then
    raise exception 'plan_revisions: a revision is decided once';
  end if;

  return new;
end;
$$;

create or replace trigger plan_revisions_guard
  before insert or update on plan_revisions
  for each row execute function plan_revisions_guard();

-- An accepted revision takes effect in the transaction that accepts it: by commit its GoalRun's
-- current revision has reached it (I-G3). Deferred so the acceptance and the GoalRun's update can
-- be two statements (the acceptance first: the GoalRun guard adopts accepted revisions only).
create or replace function plan_revisions_adopted() returns trigger
language plpgsql as $$
begin
  if not exists (
       select 1 from goal_runs g
        where g.workspace_id = new.workspace_id
          and g.id = new.goal_run_id
          and g.current_revision >= new.revision
     ) then
    raise exception 'plan_revisions: revision % was accepted, but its goal run did not adopt it in the same transaction (I-G3)',
      new.revision;
  end if;
  return null;
end;
$$;

-- A constraint trigger cannot be created `or replace`.
drop trigger if exists plan_revisions_adopted on plan_revisions;
create constraint trigger plan_revisions_adopted
  after update of status on plan_revisions
  deferrable initially deferred
  for each row
  when (new.status = 'accepted')
  execute function plan_revisions_adopted();

-- step_runs: created `pending` with no attempts, while the GoalRun is running or paused, under its
-- current revision and for a step that revision's plan holds — so no step is ever created under a
-- superseded revision (I-G2); moves along an edge only.
--   * Never changes: the GoalRun, the key, the introducing revision and created_at.
--   * Final once succeeded / superseded / cancelled / skipped: nothing changes but `updated_at`.
--   * `waiting_reason` does not change while waiting, nor `failure_category` while failed.
--   * `attempt_count` (I-G1) goes up by exactly one at each start (`ready → running`) and at no
--     other time.
--   * New work needs a live GoalRun: a step becomes `ready` only while the GoalRun is running or
--     paused, and an attempt starts (`ready → running`) only while it is running — a paused run
--     starts nothing (I-G6, I-G7); a step of a final GoalRun only ends.
--   * Superseded only by the GoalRun's current revision.
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
    if new.status in ('running', 'waiting') and goal_status in ('completed', 'cancelled', 'failed') then
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

create or replace trigger step_runs_status_guard
  before insert or update on step_runs
  for each row execute function step_runs_status_guard();
