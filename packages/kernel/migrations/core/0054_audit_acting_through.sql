-- module: core, version: 0054
--
-- 0054_audit_acting_through (batch D3, docs/test-coverage-gaps-2026-11-06.md G11; decided by the
-- coordinating thread 2026-11-07). `actor_principal_id` says which Principal answers for an audited
-- act (I13: for a Handle, its `on_behalf_of`), and stays so. It cannot say whether that Principal
-- acted by hand or through one of its agents: an administrator's admin agent writes rows whose actor
-- is the administrator, the same as the administrator's own console clicks, told apart until now
-- only by `payload.channel` and `payload.sessionKind`. Two first-class columns say it:
--
-- 1. `acting_through` (nullable): `person` | `admin_agent_session` | `entry_agent` |
--    `worker_handle` | `service_handle` | `member_handle` | `system` (`@nexttime/shared`
--    `AUDIT_ACTING_THROUGH_VALUES` has what each means). The kernel derives it from the caller of
--    the capability call a row is written in (application/gateway/dispatch.ts, through
--    substrate/audit `acting-context.ts`) — a handler never chooses it — and writes `system` for its
--    own background loops. `null` on every row from before this migration, and on a row written
--    outside every capability call and background loop (sign-in and identity routes, the llm-proxy's
--    administrator reports, the operator CLI), whose `actor_user_id` says who acted.
-- 2. `acting_session_id` (nullable uuid): the session the acting Handle was issued under — set only
--    with an `acting_through` that names one (`audit_records_acting_session_shape`). No foreign key:
--    a platform row has no workspace to join a session on, and an audit row outlives its session.
--
-- Additive only: two nullable columns and two CHECKs that every existing row passes (both columns
-- null). No data, grant, policy or trigger changes — `audit_records_block_mutation` (0004) still
-- refuses every UPDATE and DELETE, so a row's `acting_through` is never filled in or changed later.
-- `nexttime_app`'s table-level `insert` (0004) covers the new columns.
--
-- Lock: `add column` without a default is catalog-only, but its ACCESS EXCLUSIVE lock is held until
-- this file commits, and every audited capability call of the previous release (still serving while
-- `scripts/apply-release.sh` migrates) waits on it. So the two CHECKs are added `not valid` and left
-- so: validating would read the whole of `audit_records` — the table that grows with every audited
-- call — under that lock, only to re-prove what holds by construction (both columns were added just
-- above, so every existing row is null in both and passes either CHECK). Every row inserted from
-- here on is checked all the same, and no row is ever updated (0004).
--
-- Rolling back (docs/runbooks/release.md §6). The previous release never names the two columns (its
-- writer inserts and reads an explicit column list), so code alone may roll back: its rows carry
-- `null` in both. To remove the migration as well: drop the two constraints and the two columns,
-- then `delete from schema_migrations where module = 'core' and version = 54` — that loses what the
-- columns recorded; `payload.channel` / `payload.sessionKind` / `payload.sessionId` still carry the
-- admin agent's share of it.
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table audit_records add column if not exists acting_through text;
alter table audit_records add column if not exists acting_session_id uuid;

alter table audit_records drop constraint if exists audit_records_acting_through_check;
alter table audit_records add constraint audit_records_acting_through_check
  check (
    acting_through is null
    or acting_through in (
      'person',
      'admin_agent_session',
      'entry_agent',
      'worker_handle',
      'service_handle',
      'member_handle',
      'system'
    )
  ) not valid;

-- A session only with a channel that has one: a person's own session and the kernel's background
-- work name none, and a session id with no `acting_through` would say "some session" and not whose
-- (`is not null` spelled out: `null in (…)` is null, which a CHECK lets through).
alter table audit_records drop constraint if exists audit_records_acting_session_shape;
alter table audit_records add constraint audit_records_acting_session_shape
  check (
    acting_session_id is null
    or acting_through is not null and acting_through in (
      'admin_agent_session',
      'entry_agent',
      'worker_handle',
      'service_handle',
      'member_handle'
    )
  ) not valid;
