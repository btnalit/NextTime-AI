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
-- `audit_records_actor_shape` (0019) forces every platform row (`workspace_id is null`) to carry
-- a real `actor_user_id` — there is no legal shape for "this was a platform action, and no user
-- could be named for it". This migration widens the constraint for **exactly that one case**,
-- not for platform rows in general: `actor_user_id is null` is legal only when
-- `action = 'platform.workspace_purged'` *and* the row's own `payload.attributedActor` is the
-- JSON boolean `false` (`purgeWorkspace`'s own marker for "no operator resolved"). Any other
-- actor-less platform row — a different action, or `attributedActor` missing/true — is still
-- rejected exactly as before. Narrow on purpose (2026-09-22 review of PR #221): a blanket
-- `actor_user_id is null` for every platform row would silently admit an actor-less row from any
-- *future* bug in an unrelated write path, not just this one, deliberate, marked case — the
-- 0019 invariant ("every platform row is attributable") should only bend exactly as far as this
-- one documented exception, not further. `platform.user_purged` (`purge_user`) does **not** get
-- the same allowance: it has no CLI path — only the `purge_user` capability writes it, which
-- always runs inside an authenticated platform transaction (`actingUser(context)` in
-- `application/gateway/platform-handlers.ts` never returns without a real user) — so it can never
-- actually need to write itself actor-less, and admitting it here would just widen the hole for
-- no real caller.
--
-- The workspace-scoped branch (capability-dispatch audit rows, which always have an
-- authenticated `context.platformUser`) is untouched. Widening only — every row that satisfied
-- the old constraint still satisfies this one, so no backfill.
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table audit_records drop constraint if exists audit_records_actor_shape;
alter table audit_records add constraint audit_records_actor_shape check (
  (workspace_id is not null and actor_principal_id is not null)
  or (workspace_id is null and actor_principal_id is null
      and (actor_user_id is not null
           or (action = 'platform.workspace_purged' and payload ->> 'attributedActor' = 'false')))
);
