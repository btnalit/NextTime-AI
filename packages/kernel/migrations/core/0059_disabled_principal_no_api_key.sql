-- module: core, version: 0059
--
-- Legacy 738 (#1204 review O1): a disabled Principal holds no API key, and the database keeps
-- it so, not only the code paths that disable one.
--
-- A disabled Principal's key never authenticated (`lookupPrincipalByApiKeyHash` skips a disabled
-- Principal, core 0015), but until legacy 734 `disable_principal` left `api_key_hash` on the row: a
-- service account disabled before that still holds one, and the console read it as issued. Legacy
-- 734 made `disable_principal` clear the key and `rotate_api_key` refuse a disabled target;
-- `remove_membership` clears a person's key through `revokeUserCredentials` after it disables the
-- membership. Each of those is one code path, and the next writer of `disabled_at` could forget.
-- This migration:
--
--   1. clears the key left on every disabled Principal, with one audit record per Principal
--      (`principal.disabled_api_key_cleared`, the Principal as actor and resource, saying it was
--      this migration). The key could not sign in before; nothing that worked stops working.
--   2. adds `principals_disabled_no_api_key` (`disabled_at is null or api_key_hash is null`). A
--      write that gives a disabled Principal a key, or inserts one disabled with a key, is refused.
--   3. adds the BEFORE UPDATE trigger `principals_disabled_clears_api_key`: the update that disables
--      a Principal clears its key in the same row write, the way governance 0043's
--      `principals_disabled_revokes_sessions` revokes its sessions. Disabling is never refused for
--      the key it carries: `remove_membership`, which clears a person's key only after it disables
--      the membership, and the previous release's `disable_principal`, which never cleared it, both
--      keep working. Only the disabling write itself (`disabled_at` going from null to a time) that
--      leaves the key as it was is rewritten; any other write that would leave a disabled Principal
--      with a key — one that sets a key on a disabled Principal, or one that disables a Principal
--      and sets a new key in the same statement (#1210 review) — is refused by the constraint,
--      never silently dropped.
--
-- The table is locked for the whole migration first (#1210 review): the previous release may still
-- be running while it applies, and its `disable_principal` leaves the key on the row; one landing
-- between step 1 and step 2 would make adding the constraint fail. ACCESS EXCLUSIVE, the lock step 2
-- takes anyway, from the start: taking a weaker one first and upgrading it at step 2 could deadlock
-- with a transaction that read `principals` and then waits to write it. The migration's writes are
-- a few rows; readers wait for them, as they would for step 2 alone.
--
-- Rolling back (release.md §6): the previous release runs on this schema. The trigger clears the
-- key its `disable_principal` leaves; its `rotate_api_key` on a disabled service account, the bug
-- legacy 734 fixed, is refused by the constraint (a 500 instead of a key that never worked). To
-- remove all of it: `drop trigger principals_disabled_clears_api_key on principals`,
-- `drop function principals_disabled_clears_api_key()`,
-- `alter table principals drop constraint principals_disabled_no_api_key`, then
-- `delete from schema_migrations where module = 'core' and version = 59`. The cleared keys are not
-- restored: only their hashes were stored, and none of them could authenticate.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration.
select pg_advisory_xact_lock(7241000101);

lock table principals in access exclusive mode;

-- ---------------------------------------------------------------------------------------------
-- 1. Remediation: keys left on disabled Principals
-- ---------------------------------------------------------------------------------------------

insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
select
  p.workspace_id,
  p.id,
  'principal.disabled_api_key_cleared',
  'principal',
  p.id,
  jsonb_build_object(
    'by', 'migration core/0059_disabled_principal_no_api_key',
    'reason', 'a disabled Principal holds no API key from this release on; the key a disable left on this one, which could not sign in, is cleared'
  )
from principals p
where p.disabled_at is not null
  and p.api_key_hash is not null;

update principals
   set api_key_hash = null
 where disabled_at is not null
   and api_key_hash is not null;

-- ---------------------------------------------------------------------------------------------
-- 2. The invariant
-- ---------------------------------------------------------------------------------------------

alter table principals drop constraint if exists principals_disabled_no_api_key;
alter table principals add constraint principals_disabled_no_api_key
  check (disabled_at is null or api_key_hash is null);

-- ---------------------------------------------------------------------------------------------
-- 3. Disabling clears the key
-- ---------------------------------------------------------------------------------------------

create or replace function principals_disabled_clears_api_key() returns trigger
  language plpgsql
as $$
begin
  new.api_key_hash := null;
  return new;
end;
$$;
revoke all on function principals_disabled_clears_api_key() from public;

create or replace trigger principals_disabled_clears_api_key
  before update of disabled_at on principals
  for each row
  when (
    old.disabled_at is null
    and new.disabled_at is not null
    and new.api_key_hash is not null
    and new.api_key_hash is not distinct from old.api_key_hash
  )
  execute function principals_disabled_clears_api_key();
