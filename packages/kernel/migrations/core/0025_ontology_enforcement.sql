-- 0025_ontology_enforcement (S5.1 — docs/development-tasks.md §5b "S5.1 本体约束在写入点强制";
-- design §5.4 I2 "Link 符合 LinkType 的 domain / range", STATUS leftover 37).
--
-- Until S5.1, I2 was only *checkable* (the `validate` capability) — `SqlGraphStore.assertFact` /
-- `supersedeFact` wrote any `link_type` between any two Objects. From S5.1 on the store validates
-- every Link write against the workspace's *published* ontology (substrate/graph/ontology-guard.ts)
-- and this column says what a violation does:
--   'reject'  the write fails with `ontology_violation` (400) — the invariant holds by construction;
--   'warn'    the write goes through, an `ontology_violation` audit row is written, and the
--             I-S5-1 invariant check counts the row — the rollout mode for a host whose existing
--             collectors / Workers have not been checked against the ontology yet.
--
-- Two defaults on purpose (the S5.1 rollout plan): rows that exist when this migration runs — a
-- host's live workspaces, whose writers were never validated — are backfilled 'warn', so applying
-- the release cannot start rejecting a collector's next run; the column default for rows created
-- afterwards is 'reject' (tests and CI always run 'reject'; `createWorkspaceWithOwner` lets
-- `ONTOLOGY_ENFORCEMENT` override that for new workspaces on a host mid-rollout). The
-- administrator switches a workspace to 'reject' with `update_workspace` once
-- `nexttime_invariant_violations{invariant="I-S5-1"}` reads 0.

alter table workspaces
  add column ontology_enforcement text not null default 'warn'
    check (ontology_enforcement in ('reject', 'warn'));

alter table workspaces alter column ontology_enforcement set default 'reject';

-- Same column-limited grant shape as 0022 (the platform plane's `update_workspace` runs as
-- `nexttime_app`; inserts stay on the bootstrap path).
grant update (ontology_enforcement) on workspaces to nexttime_app;
