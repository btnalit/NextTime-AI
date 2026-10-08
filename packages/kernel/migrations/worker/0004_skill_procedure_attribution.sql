-- module: worker, version: 0004
--
-- S10 E1 结果归因 (docs/s10-evolution-plan-2026-10-04.md §3.1 / §3.2 / §5.3): the two Skill /
-- Procedure usage records the evolution loop's attribution step needs — "which Skill / Procedure
-- version did this work use". Both are governance records (who used which published version),
-- not graph Facts, and both are append-only: a usage that happened is never edited or withdrawn.
--
--   * `worker_run_skills` — `WorkerRun loaded SkillVersion` (N:M). Written by the kernel, never by
--     an agent: `application/task/spawn.ts` inserts the rows in the transaction that creates the
--     WorkerRun, from the published Skills `resolveSkillsInline` mounted into its container. A
--     requeue re-resolves (a Skill may have been deprecated or superseded in between), so the
--     grain is the WorkerRun, not the Task. Authoritative (the kernel did the loading).
--   * `turn_procedure_claims` — `Turn followed ProcedureVersion` (0..1 per Turn). Self-reported by
--     the entry agent (`record_procedure_followed`) — a claim, not an observation: the kernel
--     cannot see which Procedure a model followed, the same footing as the Turn id the caller
--     reports (§5.3 "标 claimed"). Hung on the Turn, not a Task, because one Procedure usually
--     spans several `invoke_worker` calls.
--
-- Runner ordering: `worker` sorts after `core` and `task` (task/0001's header comment), so real
-- FKs reach `worker_runs`, `activities`, `principals` and this module's own `skills` /
-- `procedures`. Only published (or later deprecated) versions are ever referenced — the write
-- paths resolve against `status = 'published'` — and worker/0003's trigger lets the application
-- role delete only `draft` rows, so these FKs never block a draft discard or expiry.
--
-- Advisory lock: same module key as 0001–0003.
select pg_advisory_xact_lock(7241000501);

create table if not exists worker_run_skills (
  workspace_id uuid not null,
  worker_run_id uuid not null,
  skill_id uuid not null,
  skill_version int not null,
  recorded_at timestamptz not null default now(),
  -- One version of a Skill family per run: `resolvePublishedSkills` picks the newest published
  -- version per id, so a run never mounts two versions of one Skill.
  primary key (workspace_id, worker_run_id, skill_id),
  foreign key (workspace_id, worker_run_id) references worker_runs (workspace_id, id),
  foreign key (workspace_id, skill_id, skill_version) references skills (workspace_id, id, version)
);

-- E2's `skill_version_stats` reads usage per Skill version.
create index if not exists worker_run_skills_skill_idx
  on worker_run_skills (workspace_id, skill_id, skill_version);

alter table worker_run_skills enable row level security;

drop policy if exists worker_run_skills_workspace_isolation on worker_run_skills;

-- Workspace-only, like `worker_runs` (task/0001): read through `get_task`, which applies
-- `taskVisibleTo` first.
create policy worker_run_skills_workspace_isolation on worker_run_skills
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert on worker_run_skills to nexttime_app;

create table if not exists turn_procedure_claims (
  workspace_id uuid not null,
  turn_id uuid not null,
  procedure_id uuid not null,
  procedure_version int not null,
  claimed_by uuid not null,
  claimed_at timestamptz not null default now(),
  primary key (workspace_id, turn_id),
  foreign key (workspace_id, turn_id) references activities (workspace_id, id),
  foreign key (workspace_id, procedure_id, procedure_version)
    references procedures (workspace_id, id, version),
  foreign key (workspace_id, claimed_by) references principals (workspace_id, id)
);

create index if not exists turn_procedure_claims_procedure_idx
  on turn_procedure_claims (workspace_id, procedure_id, procedure_version);

alter table turn_procedure_claims enable row level security;

drop policy if exists turn_procedure_claims_workspace_isolation on turn_procedure_claims;

-- Workspace-only — same reasoning as `turn_outcomes` (task/0006).
create policy turn_procedure_claims_workspace_isolation on turn_procedure_claims
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- Append-only: the first claim for a Turn stands (`record_procedure_followed` inserts
-- `on conflict do nothing` and reports what is on record).
grant select, insert on turn_procedure_claims to nexttime_app;
