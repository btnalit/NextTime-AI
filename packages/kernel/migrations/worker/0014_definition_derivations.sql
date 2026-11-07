-- module: worker, version: 0014
--
-- 0014_definition_derivations (S11 GO16b; docs/global-roadmap-2026-10-16.md W4 GO16, GO16 forks
-- F1–F7 = A, coordinator 2026-11-07). A person turns a combination that kept working — a
-- published worker-kind WorkerDefinition version run with one goal step's WorkerSpec — into the
-- first draft of a new WorkerDefinition family (`propose_definition_from_combination`,
-- `@nexttime/shared` `combination.ts`). This table says where such a family came from, so a
-- reviewer and a later reader can answer "why does the platform think this definition is good"
-- without searching the audit:
--
--   `worker_definition_derivations` — one row per derived family (`definition_id`), written by
--   the kernel in the transaction that writes the family's version 1, never changed or deleted:
--     - `base_definition_id` / `base_version`: the published version the combination ran on;
--     - `spec_digest`: the WorkerSpec's digest, as the step attempts' run configuration keeps it
--       (`workerSpecDigest`: sha256, hex);
--     - `evidence`: what the combination had behind it when proposed (achieved, notAchieved,
--       goals, rate, windowDays);
--     - `derived_by`: the person who proposed it.
--   Kept per family, not on a version: the console edits a draft by proposing the next version,
--   and a discarded draft's row is deleted — the family's origin outlives both.
--
-- The guard (`worker_definition_derivations_guard`, BEFORE INSERT): the base version is a
-- published worker-kind version of another family; the derived family's version 1 is a worker-kind
-- draft its deriver wrote as a person (`origin` human); the evidence is an object. With no UPDATE
-- or DELETE grant to `nexttime_app`, a row cannot change once written (a workspace's purge runs
-- as the platform). The content of the draft and its review are `worker_definitions`' own — this
-- table grants nothing.
--
-- Rolling back (docs/runbooks/release.md §6): code only. The previous release never reads or
-- writes this table; a family derived under this release stays an ordinary WorkerDefinition
-- there (it only stops saying where it came from). To drop the schema too: `drop table
-- worker_definition_derivations` (its trigger with it), `drop function
-- worker_definition_derivations_guard()`, then `delete from schema_migrations where module =
-- 'worker' and version = 14`. Dropping it loses the derivations (their audit records stay).
--
-- Advisory lock: same module key as 0001–0013.
select pg_advisory_xact_lock(7241000501);

create table if not exists worker_definition_derivations (
  workspace_id uuid not null,
  definition_id uuid not null,
  base_definition_id uuid not null,
  base_version int not null,
  spec_digest text not null,
  evidence jsonb not null,
  derived_by uuid not null,
  derived_at timestamptz not null default now(),
  primary key (workspace_id, definition_id),
  foreign key (workspace_id, base_definition_id, base_version)
    references worker_definitions (workspace_id, id, version),
  foreign key (workspace_id, derived_by) references principals (workspace_id, id),
  constraint worker_definition_derivations_not_self
    check (definition_id <> base_definition_id),
  constraint worker_definition_derivations_spec_digest check (spec_digest ~ '^[0-9a-f]{64}$'),
  constraint worker_definition_derivations_evidence check (jsonb_typeof(evidence) = 'object')
);

-- The candidates' lookup: the families derived from one base family's combinations.
create index if not exists worker_definition_derivations_base_idx
  on worker_definition_derivations (workspace_id, base_definition_id, base_version, spec_digest);

alter table worker_definition_derivations enable row level security;
drop policy if exists worker_definition_derivations_workspace_isolation
  on worker_definition_derivations;
create policy worker_definition_derivations_workspace_isolation on worker_definition_derivations
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- Written once, never changed: no update and no delete grant.
grant select, insert on worker_definition_derivations to nexttime_app;

create or replace function worker_definition_derivations_guard() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from worker_definitions d
     where d.workspace_id = new.workspace_id and d.id = new.base_definition_id
       and d.version = new.base_version and d.kind = 'worker' and d.status = 'published') then
    raise exception 'worker_definition_derivations: the base % v% is not a published worker-kind version',
      new.base_definition_id, new.base_version
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from worker_definitions d
     where d.workspace_id = new.workspace_id and d.id = new.definition_id and d.version = 1
       and d.kind = 'worker' and d.status = 'draft' and d.origin = 'human'
       and d.proposed_by = new.derived_by) then
    raise exception 'worker_definition_derivations: % has no worker-kind version 1 draft its deriver wrote',
      new.definition_id
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from worker_definitions d
     where d.workspace_id = new.workspace_id and d.id = new.definition_id and d.version > 1) then
    raise exception 'worker_definition_derivations: % already has later versions — a derivation is recorded with the family''s first',
      new.definition_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists worker_definition_derivations_guard on worker_definition_derivations;
create trigger worker_definition_derivations_guard
  before insert on worker_definition_derivations
  for each row execute function worker_definition_derivations_guard();
