-- module: goal, version: 0013
--
-- 0013_step_trial_approvals (S11 GO8b; plan §3.1, I-G8; after GO8a's WorkerSpec admission). A
-- step whose WorkerSpec names Skills that are only drafts does not start by itself: its first
-- attempt's admission says `needs_approval` (`application/task/step-attempt.ts`), and the goal
-- pauses there. A person who could publish those drafts approves one trial of the step
-- (`approve_step_trial`, human channel, a person only): the step's first attempt then mounts the
-- draft versions approved, and the retries of that attempt mount the same ones while each is
-- unchanged (the attempt's RunConfigSnapshot records them, task/0007 keeps it immutable).
--
--   `goal_step_trial_approvals` — one row per approval, written by `application/goal/
--   trial-approvals.ts` and never deleted. What it approves: the step (`step_key`) of the plan
--   revision the person read (`plan_revision`), its WorkerSpec (`spec_digest`, the digest a
--   snapshot keeps) and every draft the trial mounts (`drafts`: id, version, content digest, and
--   the name and proposer as approved). Who: `approved_by`, a person (I-G8: a draft runs in a
--   Worker before it is published only on a person's word). For which StepRun (`step_run_id`): one
--   trial is one StepRun, so an approval is for exactly one, ever —
--     - approved on a paused run: the StepRun of that key in the revision in force that has not
--       started an attempt, named when the approval is made;
--     - approved on a proposal (revision 1, before anyone confirmed it): no StepRun exists yet; the
--       one its confirmation creates for that key is named when its first attempt runs with the
--       approval (the advancer, in the transaction that inserts that attempt's Task).
--   The guard: created only while the run is `proposed` (no StepRun named, revision 1 still the
--   proposal and holding the step) or `paused` (the StepRun named, live, of that key, untried, and
--   the revision its plan entry is read from the one in force), by a person of the workspace who
--   is not disabled, with a WorkerSpec digest and at least one well-formed draft; then frozen, but
--   for naming the StepRun of an approval made on a proposal — once, while the run runs, a StepRun
--   of that key introduced by that revision that has not started an attempt. So an approval never
--   admits a second StepRun, and the WorkerSpec it was made for is fixed with it.
--
-- Whether an approval is still good when the attempt starts — the step's WorkerSpec and drafts the
-- ones it names, each draft's content unchanged — is the advancer's check (`step-attempt.ts`): a
-- content digest is the kernel's (`skillDraftDigest`), not something SQL recomputes. A stale one
-- stays as it was, and a read says so (`views.ts`).
--
-- No backfill: no release before this one admits a draft Skill (GO8a refuses it, `needs_approval`).
--
-- Rolling back (docs/runbooks/release.md §6): code only. Code without this migration never reads or
-- writes the new table and never mounts a draft Skill (with GO8a, its admission refuses one,
-- `needs_approval`; before GO8a a step has no WorkerSpec — see GO8a's own rollback note), so a step
-- approved here and not started yet never mounts its drafts after a code-only rollback. One whose
-- attempt already started under this release keeps running, and its retries are refused there:
-- that code mounts only published Skill versions from a snapshot (`resolvePinnedSkillsInline`),
-- and its strict snapshot parser does not know the snapshot's new `trial` field, so it reads such
-- an attempt's snapshot as unreadable and pauses the run `needs_decision` for a person. The
-- table's foreign keys point at `goal_runs`, `step_runs` and `principals` only (nothing points at
-- it), so purging a workspace orders it before them. To drop the schema too: `drop table
-- goal_step_trial_approvals` (its trigger with it), then `drop function
-- goal_step_trial_approvals_guard()`.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0012.
select pg_advisory_xact_lock(7241000701);

create table if not exists goal_step_trial_approvals (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  goal_run_id uuid not null,
  step_key text not null,
  plan_revision int not null,
  step_run_id uuid,
  spec_digest text not null,
  drafts jsonb not null,
  approved_by uuid not null,
  approved_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, goal_run_id) references goal_runs (workspace_id, id),
  foreign key (workspace_id, step_run_id) references step_runs (workspace_id, id),
  foreign key (workspace_id, approved_by) references principals (workspace_id, id),
  constraint goal_step_trial_approvals_step_key
    check (step_key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint goal_step_trial_approvals_plan_revision check (plan_revision >= 1),
  -- A WorkerSpec's digest as a RunConfigSnapshot keeps it (`workerSpecDigest`: sha256, hex).
  constraint goal_step_trial_approvals_spec_digest check (spec_digest ~ '^[0-9a-f]{64}$'),
  constraint goal_step_trial_approvals_drafts
    check (jsonb_typeof(drafts) = 'array' and jsonb_array_length(drafts) between 1 and 64)
);

-- The advancer's and the reads' lookup: a run's approvals, a step's newest first.
create index if not exists goal_step_trial_approvals_run_idx
  on goal_step_trial_approvals (workspace_id, goal_run_id, step_key, approved_at);

alter table goal_step_trial_approvals enable row level security;
drop policy if exists goal_step_trial_approvals_workspace_isolation on goal_step_trial_approvals;
create policy goal_step_trial_approvals_workspace_isolation on goal_step_trial_approvals
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant, like goal_runs: an approval is part of the run's history.
grant select, insert, update on goal_step_trial_approvals to nexttime_app;

create or replace function goal_step_trial_approvals_guard() returns trigger
language plpgsql as $$
declare
  goal record;
  step record;
begin
  select g.status, g.current_revision into goal
    from goal_runs g
   where g.workspace_id = new.workspace_id and g.id = new.goal_run_id;

  if tg_op = 'INSERT' then
    if not exists (
      select 1 from principals p
       where p.workspace_id = new.workspace_id and p.id = new.approved_by
         and p.kind = 'human' and p.disabled_at is null) then
      raise exception 'goal_step_trial_approvals: a trial is approved by a person of the workspace';
    end if;
    if exists (
      select 1 from jsonb_array_elements(new.drafts) d
       where jsonb_typeof(d) <> 'object'
          or jsonb_typeof(d -> 'skillId') <> 'string'
          or (d ->> 'skillId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          or jsonb_typeof(d -> 'version') <> 'number'
          or (d ->> 'version') !~ '^[1-9][0-9]*$'
          or jsonb_typeof(d -> 'draftDigest') <> 'string'
          or (d ->> 'draftDigest') !~ '^sha256:[0-9a-f]{64}$'
          or jsonb_typeof(d -> 'name') <> 'string'
          or jsonb_typeof(d -> 'proposedBy') <> 'string') then
      raise exception 'goal_step_trial_approvals: each draft is a Skill id, a version, its content digest, its name and its proposer';
    end if;
    if (select count(*) from jsonb_array_elements(new.drafts) d)
       <> (select count(distinct d ->> 'skillId') from jsonb_array_elements(new.drafts) d) then
      raise exception 'goal_step_trial_approvals: a trial mounts one version of a Skill';
    end if;
    if goal.status = 'proposed' then
      if new.step_run_id is not null or new.plan_revision <> 1 or not exists (
        select 1 from plan_revisions r, jsonb_array_elements(r.plan -> 'steps') s
         where r.workspace_id = new.workspace_id and r.goal_run_id = new.goal_run_id
           and r.revision = 1 and r.status = 'proposed' and s ->> 'key' = new.step_key) then
        raise exception 'goal_step_trial_approvals: on a proposal, a trial is approved for a step of its revision 1, before any StepRun exists';
      end if;
      return new;
    end if;
    if goal.status is distinct from 'paused' then
      raise exception 'goal_step_trial_approvals: a trial is approved while its goal run is proposed or paused';
    end if;
    select s.goal_run_id, s.step_key, s.status, s.attempt_count, s.superseded_in_revision
      into step
      from step_runs s
     where s.workspace_id = new.workspace_id and s.id = new.step_run_id;
    if new.step_run_id is null or step.goal_run_id is distinct from new.goal_run_id
       or step.step_key is distinct from new.step_key
       or step.superseded_in_revision is not null or step.attempt_count <> 0
       or step.status not in ('pending', 'ready') then
      raise exception 'goal_step_trial_approvals: on a paused run, a trial is approved for the live StepRun of the step that has not started an attempt';
    end if;
    if new.plan_revision is distinct from goal.current_revision or not exists (
      select 1 from plan_revisions r, jsonb_array_elements(r.plan -> 'steps') s
       where r.workspace_id = new.workspace_id and r.goal_run_id = new.goal_run_id
         and r.revision = new.plan_revision and s ->> 'key' = new.step_key) then
      raise exception 'goal_step_trial_approvals: on a paused run, a trial is approved for a step of the revision in force';
    end if;
    return new;
  end if;

  if (new.workspace_id, new.id, new.goal_run_id, new.step_key, new.plan_revision,
      new.spec_digest, new.drafts, new.approved_by, new.approved_at)
     is distinct from
     (old.workspace_id, old.id, old.goal_run_id, old.step_key, old.plan_revision,
      old.spec_digest, old.drafts, old.approved_by, old.approved_at) then
    raise exception 'goal_step_trial_approvals: what an approval approves, and who approved it, never change';
  end if;
  if old.step_run_id is not null then
    if new.step_run_id is distinct from old.step_run_id then
      raise exception 'goal_step_trial_approvals: an approval is for one StepRun, ever';
    end if;
    return new;
  end if;
  if new.step_run_id is null then
    return new;
  end if;
  select s.goal_run_id, s.step_key, s.status, s.attempt_count, s.superseded_in_revision,
         s.introduced_in_revision
    into step
    from step_runs s
   where s.workspace_id = new.workspace_id and s.id = new.step_run_id;
  if goal.status is distinct from 'running'
     or step.goal_run_id is distinct from new.goal_run_id
     or step.step_key is distinct from new.step_key
     or step.introduced_in_revision is distinct from new.plan_revision
     or step.superseded_in_revision is not null or step.attempt_count <> 0
     or step.status not in ('pending', 'ready') then
    raise exception 'goal_step_trial_approvals: an approval made on a proposal names, once, the StepRun of its step that the proposal''s confirmation created, as that StepRun''s first attempt starts';
  end if;
  return new;
end;
$$;

create or replace trigger goal_step_trial_approvals_guard
  before insert or update on goal_step_trial_approvals
  for each row execute function goal_step_trial_approvals_guard();
