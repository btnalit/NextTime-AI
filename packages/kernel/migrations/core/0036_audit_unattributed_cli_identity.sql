-- module: core, version: 0036
--
-- Review 2026-10-02 R-28 / P3 L1-14: the operator CLI's identity and credential mutations
-- (`create-workspace`, `add-principal`, `issue-service-handle`, `create-platform-admin`,
-- `set-password` in packages/kernel/src/cli/bootstrap.ts) wrote no audit row at all. They now write
-- a platform row (`workspace_id is null`) each, attributed to the operator the CLI resolves —
-- `--actor <login>`, else the first login of `NEXTTIME_PLATFORM_ADMINS` — exactly as the CLI's
-- purge does. When neither resolves to a user the row is still written, as an unattributed
-- host-operator action: `actor_user_id` null and `payload.attributedActor` the JSON boolean
-- `false`.
--
-- `audit_records_actor_shape` (0019, widened by 0032) admits an actor-less platform row only for
-- `platform.workspace_purged`. This widens it by exactly the five CLI actions, under the same
-- marker; every other actor-less platform row is still rejected. The actions carry a `cli.` prefix
-- so the exception cannot reach a capability's own audit action. The R-28 rows written by the
-- application (`principal.user_rebound`, `user.identity_claimed`) always have a real
-- `actor_user_id` and need nothing here.
--
-- Widening only: every row that satisfied the 0032 constraint satisfies this one, so re-adding
-- the constraint validates existing rows without a backfill, and code from before this migration
-- never writes the new actions.
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table audit_records drop constraint if exists audit_records_actor_shape;
alter table audit_records add constraint audit_records_actor_shape check (
  (workspace_id is not null and actor_principal_id is not null)
  or (workspace_id is null and actor_principal_id is null
      and (actor_user_id is not null
           or (action in ('platform.workspace_purged',
                          'cli.workspace_created',
                          'cli.principal_added',
                          'cli.service_handle_issued',
                          'cli.platform_admin_created',
                          'cli.password_set')
               and (payload -> 'attributedActor') is not distinct from 'false'::jsonb)))
);
