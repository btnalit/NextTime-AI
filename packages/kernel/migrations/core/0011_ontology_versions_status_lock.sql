-- module: core, version: 0011
--
-- ontology_versions status-transition lock (I12; lane-1 P2 fix): 0002_substrate.sql's own
-- `ontology_versions_block_published_definition_update()` trigger only ever blocked `definition`
-- from changing once `status = 'published'` — it never constrained `status` itself, so nothing
-- stopped a published row from being walked straight back to `draft` (or forward to any other
-- value). `worker_definitions`/`skills`/`procedures` (migrations/worker/0001, 0002) already gate
-- their own `status` column this way; this migration copies that same status-transition branch
-- onto `ontology_versions` (`create or replace function` — the existing `before update` trigger
-- from 0002 already dispatches by function name, so redefining the function is enough; no trigger
-- DDL needs to change).
--
-- Shape, matching `PUBLISHABLE_TRANSITIONS` (packages/shared/src/transitions.ts): `draft ->
-- published -> deprecated`, both non-draft states terminal except the single `published ->
-- deprecated` edge.
select pg_advisory_xact_lock(7241000101);

create or replace function ontology_versions_block_published_definition_update() returns trigger
language plpgsql as $$
begin
  if old.status = 'published' and new.definition is distinct from old.definition then
    raise exception 'ontology_versions: definition is immutable once published (I12)';
  end if;

  if old.status = 'published' then
    if new.status is distinct from old.status and new.status <> 'deprecated' then
      raise exception
        'ontology_versions: a published row may only transition to deprecated (I12)';
    end if;
  elsif old.status = 'deprecated' then
    if new.status is distinct from old.status then
      raise exception 'ontology_versions: a deprecated row is terminal (I12)';
    end if;
  end if;

  return new;
end;
$$;
