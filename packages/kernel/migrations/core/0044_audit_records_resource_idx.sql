-- module: core, version: 0044
--
-- Index for reading one resource's audit trail (legacy 338, review #493 on #609). `audit_records`
-- carries only its primary key and `(workspace_id, created_at)` (0019), so every read by resource
-- walked the whole workspace's audit trail — the table that grows with every governed write and
-- every audited capability call, console polling included:
--
--   audit_records (workspace_id, resource_id, created_at) where resource_id is not null
--     `readActionRequestFailureReasons` (legacy 329) and `readActionRequestsInDoubt` (legacy 287)
--     in governance/approval/waiting-state.ts — one `resource_id = any(page of ids)` probe per
--     listed or single ActionRequest read, newest / oldest row per id from `created_at`;
--     `request_action`'s terminal read-back (`readTerminalOutcome`, via `queryAudit`) and every
--     other `queryAudit` / `queryAuditPage` call filtered by `resourceId` (audit reconstruction,
--     the console's audit view for one object); and I11's `not exists` check over every
--     ActionRequest (`substrate/audit/invariant-checks.ts`). Partial, like 0039's `links_last_observation_id_idx`:
--     a call audited with no resource (most reads) leaves `resource_id` null, and no reader looks
--     those rows up by resource — each of the reads above has an equality on `resource_id`, which
--     implies the predicate.
--
-- Additive only: no data, constraint or grant changes, and no query changes meaning — the planner
-- simply has a cheaper path. The previous release runs unchanged on it (it never names the index).
--
-- Lock time: the runner applies each file in one transaction, so `create index concurrently` is
-- not available here. A plain `create index` takes a SHARE lock on `audit_records` until this file
-- commits: reads go on, but every INSERT waits — and `scripts/apply-release.sh` migrates while the
-- previous release's kernel is still serving, which audits each governed write and each capability
-- call in the same transaction, so those calls queue (they do not fail) for the build. The build is
-- one sequential scan of `audit_records` plus a sort of the rows that name a resource; measure the
-- table first (release.md §3.30 already asks for `select count(*) from audit_records;`).
--
-- Where that is too long for the window, the index can be built ahead without blocking writes,
-- outside a transaction, while the previous release runs (same name and definition as below):
--
--   create index concurrently if not exists audit_records_resource_idx
--     on audit_records (workspace_id, resource_id, created_at) where resource_id is not null;
--
-- and this file then finds it and builds nothing. A concurrent build that fails or is cancelled
-- leaves an invalid index under that name, which `if not exists` alone would keep (and the planner
-- never uses); the block below drops such a leftover first, so the file always ends with a valid
-- index.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration
-- (see 0001_identity.sql's own comment for the rationale).
select pg_advisory_xact_lock(7241000101);

do $$
begin
  if exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where i.indrelid = 'audit_records'::regclass
       and c.relname = 'audit_records_resource_idx'
       and not i.indisvalid
  ) then
    drop index audit_records_resource_idx;
  end if;
end;
$$;

create index if not exists audit_records_resource_idx
  on audit_records (workspace_id, resource_id, created_at)
  where resource_id is not null;
