-- module: core, version: 0029
--
-- S5.5 遗留 24 (docs/development-tasks.md §5b S5.5 实现说明): `assertFact`'s no-prior-row path
-- (`find_active_fact_for_identity`, 0017/0027) takes a per-identity advisory lock and re-reads once
-- when the first lookup finds nothing — closing the two-transaction race PR #140 (leftover 17)
-- documented (T2 blocks on T1's `for update` row, T1 commits a supersede, T2's *original* statement
-- rechecks only that one row under EvalPlanQual and excludes it, but the *re-read* is a fresh
-- statement/snapshot that sees T1's successor).
--
-- A third transaction interleaved between T2 taking the advisory lock and T2's re-read can make
-- that re-read itself block: the re-read's `for update` locks the (now-active) successor row, a
-- third transaction T3 is concurrently superseding that same row, T2 blocks on T3, T3 commits, and
-- T2's re-read wakes up to the same EvalPlanQual recheck — the one row it was blocked on now fails
-- `superseded_at is null`, and T3's own successor (inserted a moment before T3's commit) is outside
-- the re-read statement's own snapshot (taken when *that* statement started, before T3 committed).
-- So the re-read can *also* come back with 0 rows even though a successor now exists — leftover 24's
-- "第二个等锁者的重读又阻塞在第三个事务的 supersede 上仍可能插入一条多余的活跃 Fact".
--
-- `sql-store.ts`'s `assertFact` now loops the re-read a bounded number of times, deciding whether to
-- loop again by asking this function: is the identity's newest row (by `recorded_at`, *any*
-- lifecycle state — unlike `find_active_fact_for_identity`, which only ever returns still-active
-- rows) `invalidated`? Checking `invalidated_at`, not `superseded_at`, deliberately: with a *second*
-- concurrent supersede in flight (T3 above superseding T1's successor into a further row), by the
-- time this function runs T3 has already committed, so the identity's newest row is T3's own new
-- row — itself un-superseded (it is the current active Fact) — not the row T2 was blocked on. A
-- check of `superseded_at is not null` on the newest row would misread that as "no successor,
-- nothing to retry for" and stop one re-read short of finding it. `invalidated_at` does not have
-- this gap: a Fact's lifecycle is `recorded → superseded | invalidated`, mutually exclusive and
-- terminal (`FACT_LIFECYCLE_TRANSITIONS`, `@nexttime/shared`) — supersession always keeps producing
-- a newer *active* row to eventually find, however many hops deep, whereas invalidation ends the
-- chain with no successor at all. So: newest row invalidated, or no row for the identity at all →
-- retrying is pointless, a fresh insert is correct (this function returns `true`, or SQL `null` for
-- "no row" — `language sql` returns `null` when its query yields zero rows, same convention
-- `find_active_fact_for_identity`'s caller already relies on for "no row" via an empty result set;
-- both `true` and `null` mean "stop" to the caller). Newest row exists and is *not* invalidated
-- (`recorded` or `superseded`) → this function returns `false`, and the caller re-reads
-- `find_active_fact_for_identity` once more: if `recorded`, that fresh read finds it directly; if
-- `superseded`, its own successor may or may not be visible yet, and the bounded loop tries again.
--
-- `security definer`, same escape hatch as `find_active_fact_for_identity` (0017) and
-- `link_visible_to_caller` (0013): the newest row can belong to a private Source the calling
-- principal does not own, and `links_visibility` RLS (0010/0013) would otherwise hide it from a
-- plain `select` here exactly the way it hides it from an ordinary read — under-reporting "not
-- invalidated" (or over-reporting "no row") for a caller who cannot see the successor, stopping the
-- retry loop early and reproducing the very bug this migration exists to close. Returns only a
-- boolean (or null), never row data — no broader read access than the single yes/no this decision
-- needs, same contract as `link_visible_to_caller`/`conflict_visible_to_caller`.
select pg_advisory_xact_lock(7241000101);

create or replace function latest_fact_invalidated_for_identity(
  p_workspace_id uuid, p_link_type text, p_source_object_id uuid, p_target_object_id uuid
)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select invalidated_at is not null
  from links
  where workspace_id = p_workspace_id
    and link_type = p_link_type
    and source_object_id = p_source_object_id
    and target_object_id = p_target_object_id
  order by recorded_at desc
  limit 1
$$;

grant execute on function latest_fact_invalidated_for_identity(uuid, text, uuid, uuid) to nexttime_app;
