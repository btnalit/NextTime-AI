-- module: core, version: 0040
--
-- STATUS leftover 103: `compact-observations` (packages/kernel/src/cli/compact-observations.ts,
-- mechanism in application/platform/compact-observations.ts) deletes redundant ingest
-- Observations older than the age gate and writes ONE platform audit row per executing run
-- (`cli.observations_compacted`, per-workspace counts and the parameters in the payload). It is
-- attributed like every operator-CLI row — `--actor <login>`, else the first login of
-- `NEXTTIME_PLATFORM_ADMINS` — but `scripts/apply-release.sh` runs it unattended after the release
-- backup, where neither may resolve. The row must still be written then (audit only grows), as an
-- unattributed host-operator action: `actor_user_id` null and `payload.attributedActor` the JSON
-- boolean `false`.
--
-- `audit_records_actor_shape` (0019, widened by 0032 and 0036) admits an actor-less platform row
-- only for `platform.workspace_purged` and the five `cli.*` identity actions. This widens it by
-- exactly `cli.observations_compacted`, under the same marker; every other actor-less platform row
-- is still rejected.
--
-- Widening only: every row that satisfied the 0036 constraint satisfies this one, so re-adding the
-- constraint validates existing rows without a backfill, and code from before this migration never
-- writes the new action.
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
                          'cli.password_set',
                          'cli.observations_compacted')
               and (payload -> 'attributedActor') is not distinct from 'false'::jsonb)))
);
