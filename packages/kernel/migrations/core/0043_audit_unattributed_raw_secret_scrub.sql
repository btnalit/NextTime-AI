-- module: core, version: 0043
--
-- STATUS legacy 183–187: `scrub-raw-secrets` (packages/kernel/src/cli/scrub-raw-secrets.ts,
-- mechanism in application/platform/scrub-raw-secrets.ts) rewrites the agent-written copies stored
-- before those fixes with their secret-looking values masked, counts the rows it may not rewrite,
-- and writes ONE platform audit row per executing run (`cli.raw_secrets_scrubbed`, counts and row
-- ids only). Like `cli.observations_compacted` (0040), `scripts/apply-release.sh` runs it unattended
-- after the release backup, where no operator may resolve; the row must still be written then, as
-- an unattributed host-operator action: `actor_user_id` null and `payload.attributedActor` the JSON
-- boolean `false`.
--
-- This widens `audit_records_actor_shape` (0040) by exactly `cli.raw_secrets_scrubbed`, under the
-- same marker; every other actor-less platform row is still rejected. Widening only: every row that
-- satisfied the 0040 constraint satisfies this one, so re-adding it validates existing rows without
-- a backfill, and code from before this migration never writes the new action.
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
                          'cli.observations_compacted',
                          'cli.raw_secrets_scrubbed')
               and (payload -> 'attributedActor') is not distinct from 'false'::jsonb)))
);
