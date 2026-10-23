-- module: governance, version: 0028
--
-- 0028_decision_subjects (STATUS legacy 421): a Decision is shown only to whoever may see what it
-- is about. Until now every Decision with no Source read as workspace-visible (core/0002), so
-- `query_decisions`, `find_precedents`, `causal_chain`, `decision_impact`, `explain`, `export_prov`
-- and the Explorer showed any member
--   - an approval or reconcile Decision (its summary, the approver's reason, the request's scope)
--     for a request `get_action` hides from them;
--   - a goal run's outcome and reconcile Decisions for a run `get_goal` hides from them;
--   - an agent's `record_decision` from someone else's private conversation, whose Turn
--     `activities_visibility` hides (I15 — the owner does not read other people's conversations);
--   - a conflict ruling (its reason, both Fact ids) for a Conflict `conflicts_visibility` hides
--     (core/0017: only someone who sees both Facts sees the Conflict).
--
-- 1. The subject, on the row. Five columns say what a Decision is about:
--      - `chat_id`: its Activity's conversation (a Turn's, for `record_decision`; null otherwise);
--      - `action_request_id`: the request an approval (`governance.approval_decision`) or reconcile
--        (`governance.reconcile_decision`) Decision is about;
--      - `goal_run_id`: the run an outcome Decision (`goal.outcome_decision`) is about, and the run
--        a reconcile Decision's request belongs to (through its step);
--      - `conflict_id`: the Conflict a ruling (`epistemic.conflict_resolution`) is about;
--      - `subject_unresolved`: a Decision of one of those four kinds whose subject does not
--        resolve, or any Decision whose `rationale` names an `actionRequestId`, `goalRunId` or
--        `conflictId` while no subject resolved. Such a row is read conservatively: by the
--        workspace owner only (on the human channel).
--    The database sets all five, on every insert and on every update that names one of them or
--    what they are read from (`decisions_subject` trigger), and here for the rows already written
--    — one function, `decision_subject`, for both, so a backfilled row and a new one can never be
--    told apart, and no update can move a Decision off its subject (an update that sets
--    `goal_run_id` to null gets it back). Only the platform updates a Decision (the workspace
--    plane holds no UPDATE on `decisions`, core/0035); its one update today, scrub-raw-secrets'
--    `summary`, names none of these columns and does not fire it. The function reads the subject
--    from the Decision's Activity: the kind and metadata the platform's own writers record
--    (decide.ts, reconcile.ts, acceptance.ts, epistemic-handlers.ts) — never from what a
--    `rationale` claims, which for `record_decision` holds what an agent passed. A subject only
--    ever narrows who sees a row, so the kind is trusted in the safe direction. Whatever an
--    inserter or updater puts in these columns is overwritten. A write whose Activity the writer
--    cannot see is refused: a Decision is recorded on an Activity its recorder sees (every
--    writer's own, or the caller's own Turn), so this only stops a Decision being hung on someone
--    else's conversation where nobody else would read it.
--    `action_request_id` and `goal_run_id` have no foreign key: `action_requests.
--    approval_decision_id` and `goal_runs.outcome_decision_id` already point back at `decisions`,
--    and the workspace purge (application/platform/purge-workspace.ts) refuses a foreign-key cycle.
--    The function only writes an id it found, and neither table deletes a row outside the purge.
-- 2. Who reads. Two rules live here, in `decisions_visibility`, because they need no channel: a
--    Decision of a conversation is read like the conversation (`activities_visibility`'s chat
--    rule), and a ruling like its Conflict (`conflict_visible_to_caller`). The other two need the
--    channel — the workspace owner sees every goal run only on the human channel (application/goal
--    `seesEveryRun`), which RLS cannot see — so the epistemic reads apply them
--    (substrate/epistemic/decision-visibility.ts): a run's Decisions to the owner (human channel)
--    and the requester; a request's to whoever `get_action`'s visibility predicate admits (the
--    owner, a holder of a matching scope, the requester — without its channel and role floor);
--    both set → the run's rule.
-- 3. A NOTICE counts, per kind, the rows that got their subject and the ones that did not.
--
-- Reversibility (release.md §6): the previous release never reads the new columns, and the
-- trigger fills them on its inserts too, so a rollback and a later re-upgrade leave no Decision
-- without its subject. Its Decision reads become narrower by the two RLS rules only — Decisions of
-- other people's private conversations and rulings on Conflicts the reader cannot see; its own
-- writers all record on Activities their recorder sees.
--
-- Runner ordering: `core` and `goal` sort before `governance`; `decisions`, `activities`, `chats`,
-- `conflicts` (core), `goal_runs`, `step_runs` (goal) and `action_requests` (0003) exist here.
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table decisions add column if not exists chat_id uuid;
alter table decisions add column if not exists goal_run_id uuid;
alter table decisions add column if not exists action_request_id uuid;
alter table decisions add column if not exists conflict_id uuid;
alter table decisions add column if not exists subject_unresolved boolean not null default false;

-- What a Decision is about, from its Activity (header §1). `activity_found` is false when the
-- caller cannot see the Activity (RLS) — the trigger refuses that insert; the backfill runs on the
-- login role and always finds it.
create or replace function decision_subject(
  p_workspace_id uuid,
  p_activity_id uuid,
  p_rationale jsonb,
  out chat_id uuid,
  out goal_run_id uuid,
  out action_request_id uuid,
  out conflict_id uuid,
  out subject_unresolved boolean,
  out activity_found boolean
)
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  activity_kind text;
  activity_metadata jsonb;
  reference text;
  reference_id uuid;
begin
  subject_unresolved := false;
  select a.kind, a.metadata, a.chat_id
    into activity_kind, activity_metadata, chat_id
    from activities a
   where a.workspace_id = p_workspace_id and a.id = p_activity_id;
  activity_found := found;

  reference := case activity_kind
    when 'governance.approval_decision' then activity_metadata ->> 'actionRequestId'
    when 'governance.reconcile_decision' then activity_metadata ->> 'actionRequestId'
    when 'goal.outcome_decision' then activity_metadata ->> 'goalRunId'
    when 'epistemic.conflict_resolution' then activity_metadata ->> 'conflictId'
  end;
  -- Only a uuid-shaped value is looked up; anything else resolves nothing.
  if reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    reference_id := reference::uuid;
  end if;

  if activity_kind in ('governance.approval_decision', 'governance.reconcile_decision') then
    select ar.id, case when activity_kind = 'governance.reconcile_decision' then sr.goal_run_id end
      into action_request_id, goal_run_id
      from action_requests ar
      left join step_runs sr on sr.workspace_id = ar.workspace_id and sr.id = ar.step_run_id
     where ar.workspace_id = p_workspace_id and ar.id = reference_id;
    subject_unresolved := action_request_id is null;
  elsif activity_kind = 'goal.outcome_decision' then
    select g.id into goal_run_id
      from goal_runs g
     where g.workspace_id = p_workspace_id and g.id = reference_id;
    subject_unresolved := goal_run_id is null;
  elsif activity_kind = 'epistemic.conflict_resolution' then
    select c.id into conflict_id
      from conflicts c
     where c.workspace_id = p_workspace_id and c.id = reference_id;
    subject_unresolved := conflict_id is null;
  end if;

  -- A rationale naming a subject while none resolved: the conservative reading (header §1).
  if not subject_unresolved
     and goal_run_id is null and action_request_id is null and conflict_id is null
     and jsonb_typeof(p_rationale) = 'object'
     and p_rationale ?| array['actionRequestId', 'goalRunId', 'conflictId'] then
    subject_unresolved := true;
  end if;
end
$$;

grant execute on function decision_subject(uuid, uuid, jsonb) to nexttime_app;

-- Existing rows (header §1). The login role sees every Activity, so every row gets its subject.
update decisions d
   set (chat_id, goal_run_id, action_request_id, conflict_id, subject_unresolved) = (
     select s.chat_id, s.goal_run_id, s.action_request_id, s.conflict_id, s.subject_unresolved
       from decision_subject(d.workspace_id, d.activity_id, d.rationale) s
   );

alter table decisions drop constraint if exists decisions_chat_fkey;
alter table decisions add constraint decisions_chat_fkey
  foreign key (workspace_id, chat_id) references chats (workspace_id, id);
alter table decisions drop constraint if exists decisions_conflict_fkey;
alter table decisions add constraint decisions_conflict_fkey
  foreign key (workspace_id, conflict_id) references conflicts (workspace_id, id);
alter table decisions drop constraint if exists decisions_subject_unresolved_check;
alter table decisions add constraint decisions_subject_unresolved_check
  check (
    not subject_unresolved
    or (goal_run_id is null and action_request_id is null and conflict_id is null)
  );

create or replace function decisions_subject_guard() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  subject record;
begin
  select * into subject from decision_subject(new.workspace_id, new.activity_id, new.rationale);
  if not subject.activity_found then
    raise exception 'decisions: Activity % is not visible to whoever records this Decision', new.activity_id
      using errcode = '42501';
  end if;
  new.chat_id := subject.chat_id;
  new.goal_run_id := subject.goal_run_id;
  new.action_request_id := subject.action_request_id;
  new.conflict_id := subject.conflict_id;
  new.subject_unresolved := subject.subject_unresolved;
  return new;
end
$$;

drop trigger if exists decisions_subject on decisions;
create trigger decisions_subject
  before insert
  or update of activity_id, rationale, chat_id, goal_run_id, action_request_id, conflict_id,
    subject_unresolved
  on decisions
  for each row execute function decisions_subject_guard();

-- core/0002's rule (a Decision resting on a Source reads like the Source), plus header §2's two.
-- Those two are uncorrelated `in (select …)` sets (a row's `workspace_id` is already
-- `app_workspace()`, and both foreign keys keep the subject in the row's workspace): Postgres
-- builds each set once per query. A correlated `exists` plans the same hashed lookup but is costed
-- per row, which on a large workspace crosses `jit_above_cost` — about half a second of JIT
-- compile on every read of 200k Decisions, for a scan that itself takes a fraction of that.
drop policy if exists decisions_visibility on decisions;
create policy decisions_visibility on decisions
  for all
  using (
    workspace_id = app_workspace()
    and (
      source_id is null
      or exists (
        select 1 from sources s
        where s.workspace_id = decisions.workspace_id
          and s.id = decisions.source_id
          and (s.visibility = 'workspace' or s.owner_principal_id = app_principal())
      )
    )
    and (
      chat_id is null
      or chat_id in (
        select c.id from chats c
        where c.workspace_id = app_workspace()
          and (c.visibility = 'workspace' or c.owner_principal_id = app_principal())
      )
    )
    and (
      conflict_id is null
      or conflict_id in (
        select c.id from conflicts c
        where c.workspace_id = app_workspace()
          and conflict_visible_to_caller(c.workspace_id, c.link_a_id, c.link_b_id)
      )
    )
  )
  with check (
    workspace_id = app_workspace()
    and (
      source_id is null
      or exists (
        select 1 from sources s
        where s.workspace_id = decisions.workspace_id
          and s.id = decisions.source_id
          and (s.visibility = 'workspace' or s.owner_principal_id = app_principal())
      )
    )
    and (
      chat_id is null
      or chat_id in (
        select c.id from chats c
        where c.workspace_id = app_workspace()
          and (c.visibility = 'workspace' or c.owner_principal_id = app_principal())
      )
    )
    and (
      conflict_id is null
      or conflict_id in (
        select c.id from conflicts c
        where c.workspace_id = app_workspace()
          and conflict_visible_to_caller(c.workspace_id, c.link_a_id, c.link_b_id)
      )
    )
  );

-- Header §3.
do $$
declare
  report text;
  unresolved integer;
begin
  select string_agg(
           format('%s: %s with their subject, %s without', k.kind, k.resolved, k.unresolved),
           '; ' order by k.kind)
    into report
    from (
      select a.kind,
             count(*) filter (where not d.subject_unresolved) as resolved,
             count(*) filter (where d.subject_unresolved) as unresolved
        from decisions d
        join activities a on a.workspace_id = d.workspace_id and a.id = d.activity_id
       where a.kind in ('governance.approval_decision', 'governance.reconcile_decision',
                        'goal.outcome_decision', 'epistemic.conflict_resolution')
       group by a.kind
    ) k;
  select count(*) into unresolved from decisions where subject_unresolved;
  raise notice 'governance 0028: %; % Decision(s) in all read by the workspace owner only (a request, goal run or conflict they name does not resolve); % Decision(s) of a conversation',
    coalesce(report, 'no approval, reconcile, goal outcome or conflict ruling Decisions'),
    unresolved,
    (select count(*) from decisions where chat_id is not null);
end
$$;
