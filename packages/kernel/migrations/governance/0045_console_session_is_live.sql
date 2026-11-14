-- module: governance, version: 0045
--
-- Legacy 712: a Handle issued for a person's own request is issued only while the credential that
-- request was authenticated with is still live. A request is authenticated once, when it arrives
-- (application/gateway/resolve-caller.ts); `issueHandle` then waits for the authority locks
-- (governance 0043). A password reset (`reset_user_password`), a disable or a removal revokes the
-- user's credentials under the user's lock taken exclusive (`revokeUserCredentials`) — so an issue
-- that had to wait for one went on to issue a Handle on a cookie or API key revoked a moment
-- before, and nothing revoked it after. `issueHandle` now re-checks the credential under its
-- shared locks (governance/capability/handles.ts, `PresentedCredential`), refusing
-- `credential_revoked`.
--
-- An API key is re-checked on `principals`, which the issuer reads in its workspace transaction. A
-- console session is a `user_sessions` row, which the application role reads only on the platform
-- plane (core 0019 / 0021); this function answers the one question the issuer asks of it — is
-- this session of this user still signed in — and nothing else: no column of the row leaves it.
-- `security definer`, owned by the migration role, with a fixed body and search_path; execute is
-- revoked from public and granted to `nexttime_app` only.
--
-- A logout (one console session, no authority lock) that commits before the issuer re-reads is
-- seen and refused too; one that commits after leaves the Handle valid, as a logout leaves every
-- Handle the person already holds.
--
-- Pure addition. Rolling back: `drop function console_session_is_live(uuid, uuid)`, then
-- `delete from schema_migrations where module = 'governance' and version = 45` — code without
-- this migration never calls it.
--
-- Runner ordering / advisory lock: same module (`governance`), same key as every other governance
-- migration.
select pg_advisory_xact_lock(7241000201);

create or replace function console_session_is_live(p_user_id uuid, p_console_session_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from user_sessions
     where id = p_console_session_id
       and user_id = p_user_id
       and revoked_at is null
       and expires_at > now()
  );
$$;

revoke all on function console_session_is_live(uuid, uuid) from public;
grant execute on function console_session_is_live(uuid, uuid) to nexttime_app;
