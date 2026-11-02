-- module: governance, version: 0032
--
-- 0032_change_plans (S11 AA3b: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1–
-- §3.3, §5.4, I-A4–I-A8; the AA3 default plan, F4 / F5 / F9–F12). A ChangePlan is what a platform
-- administrator's admin agent proposes from its trial workspace (I-A6, core 0050) for people to
-- apply elsewhere; a ChangePlanSegment is the part of it one authority decides. Owned by
-- `application/change-plan/proposals.ts`.
--
-- Scope of this cut (AA3b): workspace segments only — the owner of the target workspace decides
-- one (AA3b-2: preview, apply, reject; rolling back what was applied). The platform segment, and a
-- workspace segment's dependency on it, are AA3c's: `authority` is a column from the start, with
-- one value until then.
--
-- Where the rows live. A plan belongs to the trial workspace it was proposed in: `workspace_id` on
-- both tables is that workspace (never the target), so the plan is that workspace's data — RLS,
-- the purge (`application/platform/purge-workspace.ts` deletes every table with a `workspace_id`,
-- children first), the audit — like any other. Two more readers:
--   * the target workspace reads the one segment addressed to it (`target_workspace_id`) and the
--     head of its plan (title, description, who proposed it) — never another workspace's segment
--     (F4: "目标工作区只能读发给自己的那一段");
--   * the platform plane (`app_platform()`) reads every plan.
-- Nothing else crosses tenants: what the target workspace's dry run finds (its own objects, the
-- classification, the digest) is computed in the owner's session and never written here. The
-- reason an owner gives when rejecting is the one text that comes back to the agent.
--
-- Relations:
--   * ChangePlan `proposed_in` Workspace (`workspace_id`, a trial workspace: the insert policy
--     requires `purpose = 'admin_trial'`); `proposed_by` that workspace's Principal of the
--     administrator, whose platform user is `proposed_by_user`; drafted in `session_id`, an
--     `admin_agent` session (core 0049) — `origin = 'agent'` (I-A7, the vocabulary of core 0051 /
--     worker 0013).
--   * ChangePlanSegment `belongs_to` ChangePlan (`plan_id`, same `workspace_id`), `addressed_to`
--     Workspace (`target_workspace_id`): one segment per target workspace in a plan.
--   * Never: a segment addressed to a trial workspace (§3.2 self-reference — checked by the kernel
--     when the plan is proposed and when a segment is applied, and here on insert); a segment
--     whose plan was proposed outside a trial workspace; a segment added to a plan after the
--     transaction that proposed it.
--
-- Lifecycle (packages/shared transitions.ts `CHANGE_PLAN_SEGMENT_EDGES`, reproduced as
-- `change_plan_segment_transition_allowed` below and compared pair by pair in
-- `application/change-plan/proposals.integration.test.ts`):
--
--     proposed ──apply──▶ applied ──roll_back──▶ rolled_back
--        ├──reject(reason)──▶ rejected
--        └──withdraw──────▶ withdrawn
--
--   * applied / rejected / rolled_back are decided in the target workspace (its owner, AA3b-2):
--     `decided_by` / `rolled_back_by` are that workspace's Principals, `applied_segment_id` the
--     `change_segments` row the apply recorded there;
--   * withdrawn is decided by a platform user — the administrator through their agent, in the
--     trial workspace, or a platform administrator on the platform plane — `withdrawn_by_user`;
--     `withdrawn_origin` is where it was decided, set by the guard from the transaction, never
--     by the caller: `agent` in the trial workspace, `human` on the platform plane;
--   * rejected, withdrawn and rolled_back are final. The plan's own status is derived from its
--     segments' (`proposed` / `partially_applied` / `applied` / `closed`), never stored.
--
-- Guards (`change_plans_guard`, `change_plan_segments_guard`):
--   * a plan never changes (no UPDATE or DELETE grant either); its proposer is a person of the
--     trial workspace whose platform user is `proposed_by_user`;
--   * a segment is created `proposed` with its plan, in the plan's transaction, and what it
--     proposes (target, items, digest) never changes; it moves along an edge only, from the
--     workspace that may decide that edge, and each decision's time is the database's.
--
-- F11 (anti-flooding): `change_plans_proposed_today()` counts what the transaction's own platform
-- user proposed since 00:00 UTC across every trial workspace — `security definer`, since RLS shows
-- a workspace transaction its own plans only; it takes no argument and answers only for the
-- transaction's own Principal (core 0042's rule for definer helpers). The kernel takes the
-- `changePlanQuota` advisory lock (src/adapters/db/advisory-lock-namespaces.ts) for that user
-- before counting, so two proposals cannot both pass at the limit.
--
-- New tables that no earlier release reads or writes: rolling back the code leaves rows nothing
-- reads. To remove them too (docs/runbooks/release.md §6): `drop table change_plan_segments,
-- change_plans`, the functions below, then `delete from schema_migrations where module =
-- 'governance' and version = 32`.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

-- ---------------------------------------------------------------------------------------------
-- change_plans
-- ---------------------------------------------------------------------------------------------

create table if not exists change_plans (
  -- The trial workspace the plan was proposed in (see the header).
  workspace_id uuid not null references workspaces (id),
  id uuid not null default gen_random_uuid(),
  proposed_by uuid not null,
  proposed_by_user uuid not null references users (id),
  -- The administrator's display name when they proposed it: the target workspace's owner sees who
  -- proposed the change, and may not read a user who is not one of its members (core 0021).
  proposer_display_name text not null check (length(proposer_display_name) between 1 and 200),
  session_id uuid not null,
  -- I-A7: who drafted it. An admin agent always (`propose_change_plan` is `adminAgentOnly`).
  origin text not null check (origin = 'agent'),
  title text not null check (length(title) between 1 and 200),
  description text not null default '' check (length(description) <= 4000),
  -- The name the plan's new Skill and Worker families are derived under in a target workspace
  -- (`derivePackComponentId(source_name, …)`, AA3b-2) — a pack name, so the plan exported as a
  -- pack keeps their ids.
  source_name text not null
    check (source_name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and length(source_name) <= 64),
  -- `sha256:` of what was proposed: title, description, source name and each segment's digest.
  content_digest text not null check (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (id),
  foreign key (workspace_id, proposed_by) references principals (workspace_id, id),
  foreign key (workspace_id, session_id) references sessions (workspace_id, id)
);

-- F11: a user's plans of the day, across trial workspaces.
create index if not exists change_plans_user_day on change_plans (proposed_by_user, created_at);
create index if not exists change_plans_workspace_time on change_plans (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- change_plan_segments
-- ---------------------------------------------------------------------------------------------

create table if not exists change_plan_segments (
  -- The plan's trial workspace (see the header) — not the target.
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  plan_id uuid not null,
  ordinal int not null check (ordinal >= 1),
  -- packages/shared enums.ts `CHANGE_PLAN_SEGMENT_AUTHORITY_VALUES`; `platform` is AA3c's.
  authority text not null check (authority in ('workspace')),
  -- The workspace whose owner decides a workspace segment. Purging that workspace deletes the
  -- segments addressed to it (the guard lets exactly that delete through): the change it was
  -- offered can no longer be made anywhere, and what it decided went with it.
  target_workspace_id uuid references workspaces (id) on delete cascade,
  -- The intents, as proposed (packages/shared `ChangePlanItemIntentSchema`): workspace-agnostic —
  -- a Skill or Worker by name, an ontology family by name, an Operation by gate instance and name
  -- — resolved in the target workspace's own dry run (F5).
  items jsonb not null
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 50),
  content_digest text not null check (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text not null default 'proposed'
    check (status in ('proposed', 'applied', 'rejected', 'withdrawn', 'rolled_back')),
  -- applied / rejected: the target workspace's Principal who decided it, and when.
  decided_by uuid,
  decided_at timestamptz,
  -- withdrawn: the platform user who withdrew it, and through which channel (the guard derives
  -- it from where the transaction runs): `agent` — their admin agent, in the trial workspace;
  -- `human` — a platform administrator on the platform plane (the console).
  withdrawn_by_user uuid references users (id),
  withdrawn_origin text check (withdrawn_origin in ('human', 'agent')),
  -- rejected: why (required); withdrawn: why, when one was given.
  reason text check (reason is null or length(reason) between 1 and 2000),
  -- applied: the segment the apply recorded in the target workspace.
  applied_segment_id uuid,
  rolled_back_by uuid,
  rolled_back_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (id),
  unique (plan_id, ordinal),
  unique (plan_id, target_workspace_id),
  foreign key (workspace_id, plan_id) references change_plans (workspace_id, id),
  -- `decided_by`, `rolled_back_by` and `applied_segment_id` are the target workspace's rows, and
  -- have no foreign key on purpose: a key from this table (the trial workspace's) into another
  -- workspace's rows is one the purge cannot satisfy by construction, and it refuses to run with
  -- one in the catalog (`findForeignKeysOutsideCascade`). The guard checks each against the
  -- target workspace when it is written; purging the target deletes the segment
  -- (`target_workspace_id … on delete cascade`), so none outlives the rows it names.
  constraint change_plan_segments_target check (
    (authority = 'workspace') = (target_workspace_id is not null)
  ),
  -- Each status with exactly the decision fields it has (see the header).
  constraint change_plan_segments_decision check (
    case status
      when 'proposed' then
        decided_by is null and decided_at is null and withdrawn_by_user is null
        and withdrawn_origin is null and reason is null and applied_segment_id is null
      when 'applied' then
        decided_by is not null and decided_at is not null and withdrawn_by_user is null
        and withdrawn_origin is null and reason is null and applied_segment_id is not null
      when 'rolled_back' then
        decided_by is not null and decided_at is not null and withdrawn_by_user is null
        and withdrawn_origin is null and reason is null and applied_segment_id is not null
      when 'rejected' then
        decided_by is not null and decided_at is not null and withdrawn_by_user is null
        and withdrawn_origin is null and reason is not null and applied_segment_id is null
      when 'withdrawn' then
        decided_by is null and decided_at is not null and withdrawn_by_user is not null
        and withdrawn_origin is not null and applied_segment_id is null
    end
  ),
  constraint change_plan_segments_rolled_back check (
    (status = 'rolled_back') = (rolled_back_at is not null)
    and (rolled_back_by is null) = (rolled_back_at is null)
  )
);

create index if not exists change_plan_segments_target
  on change_plan_segments (target_workspace_id, status, created_at desc);
create index if not exists change_plan_segments_plan on change_plan_segments (workspace_id, plan_id);

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------

alter table change_plans enable row level security;
alter table change_plans force row level security;

-- The trial workspace reads its own plans, the platform plane every plan, and a target workspace
-- the head of a plan with a segment addressed to it (the segment policy below decides which).
drop policy if exists change_plans_read on change_plans;
create policy change_plans_read on change_plans
  for select
  using (
    app_platform()
    or workspace_id = app_workspace()
    or exists (
      select 1 from change_plan_segments s
       where s.plan_id = change_plans.id and s.target_workspace_id = app_workspace()
    )
  );

-- Proposed only in a trial workspace that is active, by its own transaction.
drop policy if exists change_plans_propose on change_plans;
create policy change_plans_propose on change_plans
  for insert
  with check (
    workspace_id = app_workspace()
    and exists (
      select 1 from workspaces w
       where w.id = change_plans.workspace_id and w.purpose = 'admin_trial' and w.status = 'active'
    )
  );

-- No update or delete: a plan, once proposed, is what was proposed.
grant select, insert on change_plans to nexttime_app;

alter table change_plan_segments enable row level security;
alter table change_plan_segments force row level security;

-- No subquery here (the plan policy above reads this table): the trial workspace, the target
-- workspace, the platform plane.
drop policy if exists change_plan_segments_read on change_plan_segments;
create policy change_plan_segments_read on change_plan_segments
  for select
  using (app_platform() or workspace_id = app_workspace() or target_workspace_id = app_workspace());

drop policy if exists change_plan_segments_propose on change_plan_segments;
create policy change_plan_segments_propose on change_plan_segments
  for insert
  with check (workspace_id = app_workspace());

-- Who may move which edge is the guard's (below); the policy only says who may touch a row.
drop policy if exists change_plan_segments_decide on change_plan_segments;
create policy change_plan_segments_decide on change_plan_segments
  for update
  using (app_platform() or workspace_id = app_workspace() or target_workspace_id = app_workspace())
  with check (
    app_platform() or workspace_id = app_workspace() or target_workspace_id = app_workspace()
  );

grant select, insert, update on change_plan_segments to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- Transition table (packages/shared transitions.ts `CHANGE_PLAN_SEGMENT_EDGES`)
-- ---------------------------------------------------------------------------------------------

create or replace function change_plan_segment_transition_allowed(from_status text, to_status text)
returns boolean language sql immutable as $$
  select exists (
    select 1
      from (values
        ('proposed', 'applied'),
        ('proposed', 'rejected'),
        ('proposed', 'withdrawn'),
        ('applied', 'rolled_back')
      ) as edge (from_status, to_status)
     where edge.from_status = $1 and edge.to_status = $2
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------

create or replace function change_plans_guard() returns trigger
language plpgsql as $$
declare
  proposer_kind text;
  proposer_user uuid;
begin
  if tg_op <> 'INSERT' then
    raise exception 'change_plans: a proposed plan never changes';
  end if;
  select p.kind, p.user_id into proposer_kind, proposer_user
    from principals p
   where p.workspace_id = new.workspace_id and p.id = new.proposed_by;
  if proposer_kind is distinct from 'human' or proposer_user is distinct from new.proposed_by_user then
    raise exception 'change_plans: the proposer is a person of the trial workspace whose platform user is proposed_by_user';
  end if;
  -- I-A1: an admin agent acts for a platform administrator only (the kernel refuses anyone else
  -- with `not_platform_admin` first). The user is a member here, so the workspace transaction sees
  -- the row (core 0021 `users_workspace_members`).
  if not exists (
    select 1 from users u where u.id = new.proposed_by_user and u.platform_role = 'admin'
  ) then
    raise exception 'change_plans: the proposer is a platform administrator';
  end if;
  -- The proposing transaction's time, whatever the writer passed: the segment guard below relies
  -- on `created_at = now()` to tell the proposing transaction from a later one.
  new.created_at := now();
  return new;
end;
$$;

create or replace trigger change_plans_guard
  before insert or update or delete on change_plans
  for each row execute function change_plans_guard();

create or replace function change_plan_segments_guard() returns trigger
language plpgsql as $$
declare
  plan_created timestamptz;
  target_purpose text;
  changed text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' then
      raise exception 'change_plan_segments: a segment is created proposed, not %', new.status;
    end if;
    select c.created_at into plan_created
      from change_plans c
     where c.workspace_id = new.workspace_id and c.id = new.plan_id;
    if not found then
      raise exception 'change_plan_segments: plan % does not exist in this workspace', new.plan_id;
    end if;
    -- `now()` is the transaction's start time, the `created_at` of a plan this transaction
    -- proposed: a segment cannot be added to a plan proposed earlier.
    if plan_created <> now() then
      raise exception 'change_plan_segments: segments are written by the transaction that proposes their plan';
    end if;
    -- §3.2: never addressed to a trial workspace (the kernel refuses it first, with a reason).
    if new.target_workspace_id is not null then
      select w.purpose into target_purpose from workspaces w where w.id = new.target_workspace_id;
      if target_purpose = 'admin_trial' then
        raise exception 'change_plan_segments: a segment is never addressed to a trial workspace (self-reference)'
          using errcode = 'check_violation';
      end if;
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- The one delete: `on delete cascade` from purging the target workspace, whose row is gone by
    -- the time the cascade reaches here. (Purging the trial workspace deletes its segments under
    -- `session_replication_role = replica`, where this trigger does not fire.)
    if old.target_workspace_id is not null
       and not exists (select 1 from workspaces w where w.id = old.target_workspace_id) then
      return old;
    end if;
    raise exception 'change_plan_segments: a proposed segment is never removed';
  end if;

  changed := change_changed_columns(to_jsonb(new), to_jsonb(old), array[
    'status', 'decided_by', 'decided_at', 'withdrawn_by_user', 'withdrawn_origin', 'reason',
    'applied_segment_id', 'rolled_back_by', 'rolled_back_at', 'updated_at']);
  if changed is not null then
    raise exception 'change_plan_segments: what a segment proposes, and to whom, never changes (%)',
      changed;
  end if;

  if old.status in ('rejected', 'withdrawn', 'rolled_back') then
    raise exception 'change_plan_segments: a % segment is final', old.status;
  end if;
  if new.status is not distinct from old.status then
    changed := change_changed_columns(to_jsonb(new), to_jsonb(old), array['updated_at']);
    if changed is not null then
      raise exception 'change_plan_segments: % changes only with a transition', changed;
    end if;
    return new;
  end if;
  if not change_plan_segment_transition_allowed(old.status, new.status) then
    raise exception 'change_plan_segments: illegal transition % -> %', old.status, new.status;
  end if;

  -- Who decides which edge: the target workspace decides a workspace segment; the trial workspace
  -- (the administrator's agent) or the platform plane withdraws one.
  if new.status in ('applied', 'rejected', 'rolled_back') then
    if app_platform() or app_workspace() is distinct from old.target_workspace_id then
      raise exception 'change_plan_segments: a workspace segment is % in its target workspace', new.status;
    end if;
  elsif new.status = 'withdrawn' then
    if not (app_platform() or app_workspace() is not distinct from old.workspace_id) then
      raise exception 'change_plan_segments: a segment is withdrawn by its proposer or on the platform plane';
    end if;
  end if;

  -- What a decision names is the target workspace's own (see the table's foreign keys).
  if new.decided_by is distinct from old.decided_by and not exists (
    select 1 from principals p
     where p.workspace_id = old.target_workspace_id and p.id = new.decided_by and p.kind = 'human'
  ) then
    raise exception 'change_plan_segments: decided_by is a person of the target workspace';
  end if;
  if new.rolled_back_by is distinct from old.rolled_back_by and not exists (
    select 1 from principals p
     where p.workspace_id = old.target_workspace_id and p.id = new.rolled_back_by and p.kind = 'human'
  ) then
    raise exception 'change_plan_segments: rolled_back_by is a person of the target workspace';
  end if;
  if new.applied_segment_id is distinct from old.applied_segment_id and not exists (
    select 1 from change_segments c
     where c.workspace_id = old.target_workspace_id and c.id = new.applied_segment_id
  ) then
    raise exception 'change_plan_segments: applied_segment_id is a change segment of the target workspace';
  end if;
  -- Who withdrew it is the transaction's own platform user: the platform plane's acting
  -- administrator (`app.user_id`, adapters/db/platform-context.ts), or the user of the trial
  -- workspace's Principal; and the channel is where the transaction runs.
  if new.status = 'withdrawn' then
    if app_platform() then
      if new.withdrawn_by_user is distinct from nullif(current_setting('app.user_id', true), '')::uuid then
        raise exception 'change_plan_segments: withdrawn on the platform plane by its acting administrator';
      end if;
      new.withdrawn_origin := 'human';
    else
      if not exists (
        select 1 from principals p
         where p.workspace_id = old.workspace_id and p.id = app_principal()
           and p.user_id = new.withdrawn_by_user
      ) then
        raise exception 'change_plan_segments: withdrawn in the trial workspace by its own user';
      end if;
      new.withdrawn_origin := 'agent';
    end if;
  end if;

  -- Each decision at the deciding transaction's time; an apply's decision stays its own.
  if new.status in ('applied', 'rejected', 'withdrawn') then
    new.decided_at := now();
  elsif new.decided_at is distinct from old.decided_at or new.decided_by is distinct from old.decided_by then
    raise exception 'change_plan_segments: rolling back keeps who applied it and when';
  end if;
  if new.status = 'rolled_back' then
    new.rolled_back_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger change_plan_segments_guard
  before insert or update or delete on change_plan_segments
  for each row execute function change_plan_segments_guard();

-- ---------------------------------------------------------------------------------------------
-- F11: the transaction's own platform user's plans since 00:00 UTC
-- ---------------------------------------------------------------------------------------------

create or replace function change_plans_proposed_today() returns integer
language sql stable security definer
set search_path = public, pg_temp
as $$
  select count(*)::int
    from change_plans c
   where c.proposed_by_user = (
           select p.user_id from principals p
            where p.workspace_id = app_workspace() and p.id = app_principal()
         )
     and c.created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
$$;
revoke all on function change_plans_proposed_today() from public;
grant execute on function change_plans_proposed_today() to nexttime_app;
