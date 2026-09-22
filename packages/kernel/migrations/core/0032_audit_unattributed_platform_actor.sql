-- module: core, version: 0032
--
-- 遗留 54 (docs/STATUS.md §4): the bootstrap CLI's `purge-workspace` / `purge-expired-workspaces`
-- / `delete-workspace` (packages/kernel/src/cli/bootstrap.ts) resolve the acting administrator
-- for the `platform.workspace_purged` audit row from `--actor <login>` or, failing that, the
-- first login in `NEXTTIME_PLATFORM_ADMINS`. When neither resolves to a real user, the cascade
-- (application/platform/purge-workspace.ts's `purgeWorkspace`) used to skip `writeAudit`
-- entirely — the CLI still purged (usability: it must not refuse just because nobody could be
-- named), but left only a terminal warning, never a durable row. "隔离与审计只增不减" (公开仓库红
-- 线) means a purge must never leave *no* audit trail, attributed or not.
--
-- `audit_records_actor_shape` (0019) currently forces every platform row (`workspace_id is
-- null`) to carry a real `actor_user_id` — there is no legal shape for "this was a platform
-- action, and no user could be named for it". This migration widens exactly that: a platform row
-- may now have `actor_user_id is null` too. The workspace-scoped branch (capability-dispatch
-- audit rows, which always have an authenticated `context.platformUser`) is untouched. Widening
-- only — every row that satisfied the old constraint still satisfies this one, so no backfill.
--
-- `purgeWorkspace` now always calls `writeAudit` for `platform.workspace_purged`; the payload's
-- `attributedActor: false` marks the rows this widening exists for (application/platform/
-- purge-workspace.ts's own doc comment has the detail).
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table audit_records drop constraint if exists audit_records_actor_shape;
alter table audit_records add constraint audit_records_actor_shape check (
  (workspace_id is not null and actor_principal_id is not null)
  or (workspace_id is null and actor_principal_id is null)
);
