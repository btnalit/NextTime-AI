-- module: core, version: 0018
--
-- W5 收口 (docs/STATUS.md 遗留 1; docs/retrospective-2026-09-09.md §5.1 "溯源粒度停在 Activity 级"):
-- a Fact only carried `activity_id`, so `explain(factId)` walked Fact → Activity → *every*
-- Observation recorded under that Activity. A collector's three phases share one Activity and one
-- ingest records hundreds of Observations, so explaining one `depends_on` Fact returned the whole
-- batch (>400KB) and could only answer "this ingest", never "this observation".
--
-- `observation_id`: the single Observation that fed this Fact, when the writer knows it —
-- `submit_observations` (application/gateway/ingest-handlers.ts) records one Observation per
-- submitted item and now threads its id into every Link that item produces. Nullable: ad-hoc
-- `assert_fact` calls and every pre-0018 row have no single Observation to point at, and `explain`
-- falls back to the Activity-level list for them exactly as before. Activity-level provenance is
-- untouched (I3 still holds; `activity_id` stays NOT NULL) — this is a narrower pointer alongside
-- it, not a replacement.
--
-- `find_active_fact_for_identity` (0017) is `returns setof links`, so the new column flows through
-- it without redefinition. RLS on `links` is unaffected (its predicate never touches this column).
select pg_advisory_xact_lock(7241000101);

alter table links add column if not exists observation_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'links_observation_id_fkey'
  ) then
    alter table links
      add constraint links_observation_id_fkey
      foreign key (workspace_id, observation_id) references observations (workspace_id, id);
  end if;
end
$$;

create index if not exists links_observation_id_idx
  on links (workspace_id, observation_id)
  where observation_id is not null;
