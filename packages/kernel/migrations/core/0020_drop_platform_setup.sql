-- module: core, version: 0020
--
-- S4.1 revision (2026-09-11): the one-time setup-token flow (0019's `platform_setup`, the
-- `POST /api/platform/setup` route and the web "initialize platform" page) is replaced by a
-- pre-created `admin` user with a random temporary password written to the host
-- (application/identity/setup.ts `ensureInitialAdmin`). Nothing reads this table any more.
select pg_advisory_xact_lock(7241000101);

drop table if exists platform_setup;
