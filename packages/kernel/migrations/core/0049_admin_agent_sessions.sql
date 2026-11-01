-- module: core, version: 0049
--
-- 0049_admin_agent_sessions (S11 AA1: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §5.2, I-A1–I-A3). A platform administrator's admin agent runs under a session of the new kind
-- `admin_agent` — the administrator's own human Principal in that workspace, as an entry session
-- is its person's (`@nexttime/shared` `SESSION_KIND_VALUES`). Every Handle issued under it is
-- container-held and held to the code constant `ADMIN_AGENT_CEILING_CAPABILITIES`; every call
-- through it re-checks the user's platform role and is audited with this kind (kernel
-- `application/admin-agent`).
--
-- This widens 0001's `sessions.kind` CHECK by exactly that one value. Widening only: every row
-- that satisfied the old constraint satisfies this one, so re-adding it validates existing rows
-- without a backfill, and code from before this migration never writes the new kind.
--
-- Rolling back (docs/runbooks/release.md §6). Code without this migration never writes
-- `admin_agent`, so code alone may roll back at any time; the admin agent is off unless the host
-- sets `ADMIN_AGENT_ENABLED`, and nothing in this release starts one. To drop the schema too:
-- revoke and delete any `admin_agent` session first (`update capability_handles set revoked_at =
-- now() …`, then the session rows), re-add the constraint with 0001's five values, then
-- `delete from schema_migrations where module = 'core' and version = 49`.
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table sessions drop constraint if exists sessions_kind_check;
alter table sessions add constraint sessions_kind_check
  check (kind in ('web', 'entry', 'worker_run', 'mcp_session', 'service', 'admin_agent'));
