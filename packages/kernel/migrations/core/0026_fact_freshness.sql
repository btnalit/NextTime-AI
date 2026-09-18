-- module: core, version: 0026
--
-- S5.2 新鲜度与失效 (docs/development-tasks.md §5b S5.2; STATUS leftovers 28 / 38; design §5.1.3
-- Epistemic Model "Fact 新增 last_confirmed_by Observation、Object 新增 last_observed_at").
--
-- 0018 gave a Fact its *origin* Observation (`observation_id`). Nothing recorded that the same
-- Source saw the same Fact again: `submit_observations`' idempotent re-assertion (a collector
-- re-submitting an unchanged edge) was a true no-op, so "when was this last confirmed?" had no
-- answer and a Fact whose subject had disappeared (leftover 28's phantom Container) stayed
-- `recorded` forever.
--
-- `links.last_observation_id` / `links.last_observed_at`: the most recent same-origin Observation
-- that re-confirmed this Fact with identical content, and when. Set together with `observation_id`
-- on insert (a fresh Fact's last confirmation is its origin) and advanced by the no-op path of
-- `SqlGraphStore.assertFact` (substrate/graph/sql-store.ts). Nullable: pre-0026 rows and writers
-- that name no Observation (`assert_fact` by a human or agent — their provenance deliberately
-- stops at the Activity and Principal). A *different* Source agreeing with the Fact never
-- advances these — corroboration is not re-observation, and the observation window below keys
-- on the Fact's own Source.
--
-- `objects.last_observed_at`: when a Source last observed this Object at all (advanced by every
-- `submit_observations` upsert). An Object is never invalidated by absence — its identity still
-- exists (design "Object 不删除") — its clock simply stops advancing.
--
-- The invalidation half (`invalidation_reason = 'not_reobserved'`) needs no new column: 0007's
-- `invalidation_reason` carries it, and I4's content trigger (0002) never named `invalidated_at` /
-- `invalidation_reason`, nor these three columns.
select pg_advisory_xact_lock(7241000101);

alter table links add column if not exists last_observation_id uuid;
alter table links add column if not exists last_observed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'links_last_observation_id_fkey'
  ) then
    alter table links
      add constraint links_last_observation_id_fkey
      foreign key (workspace_id, last_observation_id) references observations (workspace_id, id);
  end if;
end
$$;

alter table objects add column if not exists last_observed_at timestamptz;

-- The observation window (`submit_observations` with `window.complete`) selects "active Facts of
-- this Source whose source Object has one of these types and which this run did not re-observe":
-- it walks links → source object (type) and links → observations (source) and orders by the
-- freshness clock. `(workspace_id, source_object_id)` is what the walk starts from.
create index if not exists links_source_object_active_idx
  on links (workspace_id, source_object_id)
  where superseded_at is null and invalidated_at is null;
