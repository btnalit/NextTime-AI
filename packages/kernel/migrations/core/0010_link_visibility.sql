-- module: core, version: 0010
--
-- Fact (=links) visibility inherits Source visibility (design doc §5.1.3 "Fact 与 Decision 继承其
-- Source 的可见性", §5.6) — closes the gap 0002_substrate.sql's own `links` table comment already
-- flagged ("RLS here is workspace-only ... see PR body 假设"): a Fact has no direct `source_id`
-- column (it points at an Activity, not a Source), so visibility must be derived by walking
-- `activity_id -> observations -> sources`, the same join `observations_visibility` (0002) already
-- performs for its own table.
--
-- Concretely, this closes the S1.9 lane-1 P1 finding: a Worker's `factsToAssert` (`application/
-- task/result.ts`'s `postWorkerResult`) shares its Activity's id with the private `worker_session`
-- Source/Observation pair written for `sessionJsonlPath` (`registerPrivateSource` +
-- `recordSourceObservation`, same activity) — so without this policy, a Fact produced from one
-- principal's private session content was readable by every other workspace member via
-- `listRecentFacts`/`traverse`/`neighbors`/`stateAt` despite `sources`/`observations` themselves
-- already being correctly visibility-scoped.
--
-- Rule: a Fact is hidden from the current principal only when at least one Observation feeding its
-- Activity comes from a `private` Source the caller does not own. An Activity with no Observations
-- at all (the common case — most Facts are asserted with no Source ever recorded against their
-- Activity, e.g. `writeObservedFacts`'s Gatekeeper-observed Facts) stays workspace-visible,
-- matching the pre-existing default; an Activity fed by only `workspace`-visibility Sources (or
-- private Sources the caller itself owns) also stays visible. This mirrors `decisions_visibility`'s
-- shape (0002_substrate.sql) one hop further out.
select pg_advisory_xact_lock(7241000101);

drop policy if exists links_workspace_isolation on links;
drop policy if exists links_visibility on links;

create policy links_visibility on links
  for all
  using (
    workspace_id = app_workspace()
    and not exists (
      select 1
      from observations o
      join sources s on s.workspace_id = o.workspace_id and s.id = o.source_id
      where o.workspace_id = links.workspace_id
        and o.activity_id = links.activity_id
        and s.visibility = 'private'
        and s.owner_principal_id <> app_principal()
    )
  )
  with check (
    workspace_id = app_workspace()
    and not exists (
      select 1
      from observations o
      join sources s on s.workspace_id = o.workspace_id and s.id = o.source_id
      where o.workspace_id = links.workspace_id
        and o.activity_id = links.activity_id
        and s.visibility = 'private'
        and s.owner_principal_id <> app_principal()
    )
  );
