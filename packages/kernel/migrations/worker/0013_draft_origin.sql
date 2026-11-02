-- module: worker, version: 0013
--
-- 0013_draft_origin (S11 AA3a: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §5.2;
-- STATUS legacy 293). `skills`, `procedures` and `worker_definitions` say who wrote each version:
--
--   * `origin` — `human` (a person: over the human channel, or by installing a pack or applying a
--     change segment they reviewed), `agent` (an agent session through its Handle: an entry agent,
--     a Worker's proposed Skill, an admin agent) or `platform` (the kernel's own template with no
--     caller: a new workspace's entry agent, the goal planner's definition). The kernel derives it
--     from how it writes the row (a capability call's channel), never from what the caller sends
--     (`@nexttime/shared` `DRAFT_ORIGIN_VALUES`). `proposed_by` stays the Principal
--     the version is for: an entry or admin agent drafts on its person's behalf, so the
--     Principal alone cannot tell the two apart — what the reviewer of an admin agent's draft
--     needs to know.
--   * `<table>_origin_fixed` (BEFORE UPDATE OF origin, every role): written once, never changed —
--     whoever wrote a version stays who wrote it, whatever happens to its status.
--
-- Nullable, no backfill: a row written before this has no recorded writer (unknown), and the
-- reads leave the field out for it. Every write path of this release sets it.
--
-- Rolling back (docs/runbooks/release.md §6). The previous release never reads or writes `origin`
-- (its inserts leave it NULL, its reads name their columns), so code alone may roll back and keep
-- the column. To remove it as well: drop the three triggers and their functions, then
-- `alter table <t> drop column origin` on each table, then
-- `delete from schema_migrations where module = 'worker' and version = 13`.
--
-- Advisory lock: same module key as 0001–0012.
select pg_advisory_xact_lock(7241000501);

alter table skills add column if not exists origin text;
alter table skills drop constraint if exists skills_origin_value;
alter table skills add constraint skills_origin_value
  check (origin is null or origin in ('human', 'agent', 'platform'));

alter table procedures add column if not exists origin text;
alter table procedures drop constraint if exists procedures_origin_value;
alter table procedures add constraint procedures_origin_value
  check (origin is null or origin in ('human', 'agent', 'platform'));

alter table worker_definitions add column if not exists origin text;
alter table worker_definitions drop constraint if exists worker_definitions_origin_value;
alter table worker_definitions add constraint worker_definitions_origin_value
  check (origin is null or origin in ('human', 'agent', 'platform'));

create or replace function worker_draft_origin_fixed() returns trigger
language plpgsql as $$
begin
  if new.origin is distinct from old.origin then
    raise exception '%: origin is fixed once the version is written (% -> %)',
      tg_table_name, coalesce(old.origin, 'null'), coalesce(new.origin, 'null')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists skills_origin_fixed on skills;
create trigger skills_origin_fixed
  before update of origin on skills
  for each row execute function worker_draft_origin_fixed();

drop trigger if exists procedures_origin_fixed on procedures;
create trigger procedures_origin_fixed
  before update of origin on procedures
  for each row execute function worker_draft_origin_fixed();

drop trigger if exists worker_definitions_origin_fixed on worker_definitions;
create trigger worker_definitions_origin_fixed
  before update of origin on worker_definitions
  for each row execute function worker_draft_origin_fixed();
