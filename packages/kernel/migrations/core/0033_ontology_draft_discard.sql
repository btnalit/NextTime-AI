-- module: core, version: 0033
--
-- discard_draft for ontology proposals (leftover 99; sibling of migrations/worker/0003_draft_discard.sql):
-- an `ontology_versions` draft (I16 "提议者私有", visible only where `proposed_by = caller`) had
-- `draft -> published` as its only exit. `discard_draft{kind:'ontology_version'}` now deletes the
-- row outright — a real deletion, not a fourth status — and the AuditRecord written in the same
-- transaction (I11) is the durable record that the proposal once existed.
--
-- Safety (checked, not assumed): 0002 granted `nexttime_app` only SELECT/INSERT/UPDATE here, so no
-- existing path deletes a published/deprecated row. Write-point ontology enforcement
-- (`substrate/graph/ontology-guard.ts`) reads only the **published** ontology, so no graph
-- Object/Fact/Link can depend on a draft type, and no migration declares a foreign key that
-- references `ontology_versions`. Deleting a draft row therefore orphans nothing. The trigger
-- below still enforces "only ever a draft row" at the database layer for the application role
-- (defense in depth, same convention as worker 0003), rather than trusting the application's own
-- `status = 'draft'` guard alone.
--
-- Scope of the trigger: only `nexttime_app`. The workspace purge cascade runs with `skipRoleSwitch`
-- on the login role and must still delete every row of a purged workspace, published included.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration.
select pg_advisory_xact_lock(7241000101);

grant delete on ontology_versions to nexttime_app;

create or replace function ontology_versions_block_non_draft_delete() returns trigger
language plpgsql as $$
begin
  if current_user = 'nexttime_app' and old.status <> 'draft' then
    raise exception
      'ontology_versions: only a draft row may be deleted, not % (I16/I12)', old.status;
  end if;
  return old;
end;
$$;

create or replace trigger ontology_versions_only_draft_delete
  before delete on ontology_versions
  for each row execute function ontology_versions_block_non_draft_delete();
