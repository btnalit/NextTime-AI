-- module: core, version: 0056
--
-- 0056_ontology_families (legacy 706). An ontology family is `ontology_versions.id` in its workspace;
-- until now nothing kept its name. A pack's or an admin proposal's family had its name only in the
-- ChangePlan item that last installed it (`change_items.target.family`), and the platform-meta
-- ontology, a family seeded from the command line and one published from a console draft had none —
-- so legacy 303's refusal and rollback preview said "family: null" for them, and legacy 705's rule
-- (a pack's LinkType ends name the families it requires) had no name to say which family a type is
-- in.
--
-- 1. `ontology_families (workspace_id, id, name)`: the name of each named family. Only a named
--    family has a row: a family published from a console draft (`propose_ontology_change`, a fresh
--    id) has none and is still a family. Invariants:
--      F1 — a name is unique in its workspace and never changes (`unique (workspace_id, name)`; no
--           UPDATE or DELETE grant for `nexttime_app`, and the trigger below refuses an UPDATE for
--           every role). A retired family (every version deprecated, legacy 303) keeps its row, so
--           its name stays taken: the same pack installed again derives the same id and finds it.
--      F2 — a family named by a pack, the command line or an admin proposal has the id derived
--           from its name (`deriveOntologyPackId`, substrate/ontology/loader.ts), so one name never
--           has two ids; the writers keep it, and the unique name is the guard behind them.
--      F3 — `platform-meta` is the platform-meta ontology's (a fresh id in each workspace). A pack,
--           an admin proposal and the command line are refused that name where they name a family;
--           the unique name refuses it here should one get through.
--    The name has a pack name's shape (`PACK_NAME_PATTERN`, application/packs/manifest.ts;
--    `ADMIN_PROPOSAL_ONTOLOGY_FAMILY_PATTERN`, @nexttime/shared), at most 64 characters.
--    Written in the transaction that publishes a family's version (`publishOntologyVersion`), as
--    `insert … on conflict (workspace_id, id) do nothing`.
-- 2. Names for the families that already exist, where this migration can know them:
--      - the platform-meta ontology: in each workspace, the one family whose latest published
--        version declares the ObjectType `WorkerDefinition` (I-P1: no two families declare one
--        name). A workspace where not exactly one does is left unnamed and reported (NOTICE);
--      - a family a ChangePlan item installed: the last item's `target.family`;
--      - a family the command line seeded (`seed-domain-pack`) that no item installed: only the
--        ontology library's own `ops-assets`, by its derived id written out below (the test
--        `ontology-families.integration.test.ts` checks it is `deriveOntologyPackId('ops-assets')`).
--        Any other name is not guessed: the next seed or install names it.
--
-- Additive: a new table, filled once. Reversibility (release.md §6): the previous release's code
-- does not read or write the table; its refusals keep saying what they said.
select pg_advisory_xact_lock(7241000101);

create table if not exists ontology_families (
  workspace_id uuid not null references workspaces (id),
  id uuid not null,
  name text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  constraint ontology_families_name_unique unique (workspace_id, name),
  constraint ontology_families_name_shape
    check (char_length(name) <= 64 and name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$')
);

alter table ontology_families enable row level security;
drop policy if exists ontology_families_workspace_isolation on ontology_families;
create policy ontology_families_workspace_isolation on ontology_families
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- Written once with its family's first named publish, never changed or deleted (F1).
grant select, insert on ontology_families to nexttime_app;

create or replace function ontology_families_name_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'ontology_families: a family''s name never changes (F1)';
end;
$$;

create or replace trigger ontology_families_name_immutable
  before update on ontology_families
  for each row execute function ontology_families_name_immutable();

-- 2. Names already known.

-- The platform-meta ontology: the family whose latest published version declares WorkerDefinition.
do $$
declare
  v record;
begin
  for v in
    with heads as (
      select t.workspace_id, t.id, t.definition
        from ontology_versions t
       where t.status = 'published'
         and t.version = (select max(t2.version) from ontology_versions t2
                           where t2.workspace_id = t.workspace_id and t2.id = t.id
                             and t2.status = 'published')
    ),
    meta as (
      select h.workspace_id, h.id
        from heads h
       where exists (select 1 from jsonb_array_elements(h.definition -> 'objectTypes') o
                      where o ->> 'name' = 'WorkerDefinition')
    )
    select w.id as workspace_id,
           (select count(*) from meta m where m.workspace_id = w.id) as found,
           (select m.id from meta m where m.workspace_id = w.id limit 1) as meta_id
      from workspaces w
  loop
    if v.found = 1 then
      insert into ontology_families (workspace_id, id, name)
      values (v.workspace_id, v.meta_id, 'platform-meta')
      on conflict do nothing;
    else
      raise notice 'ontology_families: workspace % has % families declaring WorkerDefinition; its platform-meta ontology is left unnamed',
        v.workspace_id, v.found;
    end if;
  end loop;
end;
$$;

-- A family a ChangePlan item installed: the last item's name for it. `change_items` is the
-- governance module's (0025), which runs after this one on a fresh database — where no item exists
-- yet, so there is nothing to read; on a database being upgraded it is there.
do $$
begin
  if to_regclass('change_items') is null then
    return;
  end if;
  execute $sql$
    insert into ontology_families (workspace_id, id, name)
    select distinct on (ci.workspace_id, ci.target ->> 'ontologyId')
           ci.workspace_id, (ci.target ->> 'ontologyId')::uuid, ci.target ->> 'family'
      from change_items ci
     where ci.kind = 'ontology_version'
       and ci.target ->> 'family' <> 'platform-meta'
       and char_length(ci.target ->> 'family') <= 64
       and ci.target ->> 'family' ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
       and exists (select 1 from ontology_versions v
                    where v.workspace_id = ci.workspace_id
                      and v.id::text = ci.target ->> 'ontologyId')
     order by ci.workspace_id, ci.target ->> 'ontologyId', ci.created_at desc
    on conflict do nothing
  $sql$;
end;
$$;

-- The ontology library's own family, seeded from the command line: deriveOntologyPackId('ops-assets').
insert into ontology_families (workspace_id, id, name)
select distinct v.workspace_id, v.id, 'ops-assets'
  from ontology_versions v
 where v.id = 'a848ca8d-7703-5a01-9906-4fea6e942463'::uuid
on conflict do nothing;
