-- module: core, version: 0051
--
-- 0051_ontology_version_origin (S11 AA3a: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §5.2; STATUS legacy 293). `ontology_versions` says who wrote each version, as worker/0013 does for
-- Skills, Procedures and WorkerDefinitions:
--
--   * `origin` — `human` (a person: over the human channel, a module or pack they install, the CLI),
--     `agent` (`propose_ontology_change` through a Handle) or `platform` (the platform-meta
--     ontology a new workspace starts with). The kernel derives it from how it writes the row,
--     never from the caller (`@nexttime/shared` `DRAFT_ORIGIN_VALUES`). The proposer's Principal kind cannot say it: an entry or admin agent
--     proposes for its person, whose Principal is `human`.
--   * `ontology_versions_origin_fixed` (BEFORE UPDATE OF origin, every role): written once, never
--     changed.
--
-- Nullable, no backfill: a row written before this has no recorded writer (unknown), and the reads
-- leave the field out for it.
--
-- Rolling back (docs/runbooks/release.md §6). The previous release never reads or writes `origin`,
-- so code alone may roll back and keep the column. To remove it as well: drop the trigger and its
-- function, `alter table ontology_versions drop column origin`, then
-- `delete from schema_migrations where module = 'core' and version = 51`.
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table ontology_versions add column if not exists origin text;
alter table ontology_versions drop constraint if exists ontology_versions_origin_value;
alter table ontology_versions add constraint ontology_versions_origin_value
  check (origin is null or origin in ('human', 'agent', 'platform'));

create or replace function ontology_versions_origin_fixed() returns trigger
language plpgsql as $$
begin
  if new.origin is distinct from old.origin then
    raise exception 'ontology_versions: origin is fixed once the version is written (% -> %)',
      coalesce(old.origin, 'null'), coalesce(new.origin, 'null')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists ontology_versions_origin_fixed on ontology_versions;
create trigger ontology_versions_origin_fixed
  before update of origin on ontology_versions
  for each row execute function ontology_versions_origin_fixed();
