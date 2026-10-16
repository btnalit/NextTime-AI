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
--     checked by the guard below: an accepted revision of the same GoalRun, never decreasing).
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
-- every pair with the shared tables) and enforced by `*_status_guard` triggers: a row is created in
-- its initial status only and moves along an edge only. These are new tables that no earlier
-- release reads or writes, so the full guard costs no reversibility (unlike `action_requests`,
-- where governance/0021 guards only the new `withdrawn` edge). Sub-states are columns, each set
-- exactly while its status holds (CHECKs): `pause_reason`, `waiting_reason`, `failure_category`,
-- `outcome` + `outcome_basis` (I-G5: only `verified_by_check` / `requester` / `reviewer_assessed`).
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

-- goal_runs: created `proposed`; moves along an edge only; `current_revision` names an accepted
-- revision of this GoalRun, never decreases and is never cleared (the fencing number, I-G2); the
-- requester and the originating Turn never change.
create or replace function goal_runs_status_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' then
      raise exception 'goal_runs: a goal run is created proposed, not %', new.status;
    end if;
  else
    if new.status is distinct from old.status
       and not goal_run_transition_allowed(old.status, new.status) then
      raise exception 'goal_runs: illegal transition % -> %', old.status, new.status;
    end if;
    if new.on_behalf_of is distinct from old.on_behalf_of
       or new.originated_in_turn_id is distinct from old.originated_in_turn_id
       or new.created_at is distinct from old.created_at then
      raise exception 'goal_runs: the requester, the originating turn and created_at never change';
    end if;
    if old.current_revision is not null
       and (new.current_revision is null or new.current_revision < old.current_revision) then
      raise exception 'goal_runs: the current revision never goes back (% -> %) (I-G2)',
        old.current_revision, new.current_revision;
    end if;
  end if;

  if new.current_revision is not null
     and (tg_op = 'INSERT' or new.current_revision is distinct from old.current_revision)
     and not exists (
       select 1 from plan_revisions pr
        where pr.workspace_id = new.workspace_id
          and pr.goal_run_id = new.id
          and pr.revision = new.current_revision
          and pr.status = 'accepted'
     ) then
    raise exception 'goal_runs: revision % is not an accepted revision of this goal run (I-G2)',
      new.current_revision;
  end if;

  return new;
end;
$$;

create or replace trigger goal_runs_status_guard
  before insert or update on goal_runs
  for each row execute function goal_runs_status_guard();

-- plan_revisions: created `proposed` with a well-formed step list; content never changes
-- (`validation` only while proposed); decided once; accepted only when based on the GoalRun's
-- current revision (I-G3's optimistic concurrency — a revision proposed against an older plan is
-- refused, so two concurrent revisions cannot both take effect).
create or replace function plan_revisions_guard() returns trigger
language plpgsql as $$
declare
  current_rev int;
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
    return new;
  end if;

  if new.goal_run_id is distinct from old.goal_run_id
     or new.revision is distinct from old.revision
     or new.based_on_revision is distinct from old.based_on_revision
     or new.plan is distinct from old.plan
     or new.proposed_by is distinct from old.proposed_by
     or new.reason is distinct from old.reason
     or new.created_at is distinct from old.created_at then
    raise exception 'plan_revisions: a revision''s content never changes';
  end if;
  if new.validation is distinct from old.validation and old.status <> 'proposed' then
    raise exception 'plan_revisions: validation is recorded before the revision is decided';
  end if;

  if new.status is distinct from old.status then
    if not plan_revision_transition_allowed(old.status, new.status) then
      raise exception 'plan_revisions: illegal transition % -> %', old.status, new.status;
    end if;
    if new.status = 'accepted' then
      -- Locks the GoalRun row: a second revision accepted concurrently against the same base
      -- waits here, then reads the revision the first one made current, and is refused.
      select g.current_revision into current_rev
        from goal_runs g
       where g.workspace_id = new.workspace_id and g.id = new.goal_run_id
         for update;
      if new.based_on_revision is distinct from current_rev then
        raise exception 'plan_revisions: revision % is based on %, but the current revision is % (I-G3)',
          new.revision, coalesce(new.based_on_revision::text, 'none'), coalesce(current_rev::text, 'none');
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

-- step_runs: created `pending`, under an accepted revision whose plan has that step; moves along
-- an edge only; superseded only by a later accepted revision of the same GoalRun; its identity
-- (GoalRun, key, introducing revision) never changes.
create or replace function step_runs_status_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'step_runs: a step run is created pending, not %', new.status;
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

  if new.goal_run_id is distinct from old.goal_run_id
     or new.step_key is distinct from old.step_key
     or new.introduced_in_revision is distinct from old.introduced_in_revision
     or new.created_at is distinct from old.created_at then
    raise exception 'step_runs: a step run''s identity never changes';
  end if;
  if new.attempt_count < old.attempt_count then
    raise exception 'step_runs: attempts are never uncounted (I-G1)';
  end if;
  if new.status is distinct from old.status
     and not step_run_transition_allowed(old.status, new.status) then
    raise exception 'step_runs: illegal transition % -> %', old.status, new.status;
  end if;
  if new.superseded_in_revision is not null
     and new.superseded_in_revision is distinct from old.superseded_in_revision
     and not exists (
       select 1 from plan_revisions pr
        where pr.workspace_id = new.workspace_id
          and pr.goal_run_id = new.goal_run_id
          and pr.revision = new.superseded_in_revision
          and pr.status = 'accepted'
     ) then
    raise exception 'step_runs: revision % is not an accepted revision of this goal run',
      new.superseded_in_revision;
  end if;

  return new;
end;
$$;

create or replace trigger step_runs_status_guard
  before insert or update on step_runs
  for each row execute function step_runs_status_guard();
