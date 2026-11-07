-- module: governance, version: 0041
--
-- 0041_one_active_grant_per_scope (legacy 647). A Principal holds at most one active
-- CapabilityGrant for one scope: one `(resource_type, resource_id)` pair, a null `resource_id` (a
-- historical wildcard row) counting as one value. Before this, granting what was already held
-- (`grant_capability`, `connect_gatekeeper`) wrote a second active row. Revoking one of them left
-- the access in force through the other, and the console listed both.
--
-- The kernel now answers a repeated grant with the grant held, unchanged
-- (governance/capability/grants.ts `ensureCapabilityGrant`). This index is the guard behind that
-- answer: two grants of one scope racing (two owners at once) cannot both commit an active row.
-- The kernel's insert names it as its `on conflict` arbiter, so the one that loses returns the
-- winner's grant.
--
-- Partial (`status = 'active'`): revoked and expired grants are history and stay as many as there
-- were — a scope granted, revoked and granted again has one row per grant. An active row whose
-- `expires_at` has passed still counts here, since an index cannot read the clock. The kernel marks
-- such a row `expired` before granting its scope again (active → expired, design §5.5; 0015's
-- trigger allows it).
--
-- Rows already written are refused, not merged. A database that holds two active grants of one
-- scope (a grant repeated before this release) stops this migration with their count, and nothing
-- is changed. Merging them means revoking all but one, which 0015 makes terminal, so it is a data
-- change for a person to decide (legacy 647), not one a migration makes on its own. The index would
-- refuse to build on such rows anyway; the check says why, in words.
--
-- Reversibility: an index, nothing else; no row is changed. Rolling back the code alone: an earlier
-- release's grant of a scope already held inserts a second active row, which the index refuses
-- (23505), so that call fails (500) instead of writing a duplicate; every other call is unaffected.
-- To take the migration out: `drop index capability_grants_one_active_per_scope;` then
-- `delete from schema_migrations where module = 'governance' and version = 41`.
--
-- Runner ordering / advisory lock: same module (`governance`), same key as every other governance
-- migration.
select pg_advisory_xact_lock(7241000201);

do $$
declare
  duplicated bigint;
begin
  select count(*) into duplicated
  from (
    select 1
    from capability_grants
    where status = 'active'
    group by workspace_id, principal_id, resource_type, resource_id
    having count(*) > 1
  ) held_twice;
  if duplicated > 0 then
    raise exception 'capability_grants: % scope(s) held by one Principal through more than one active grant; nothing was changed — decide which grant of each to keep before upgrading (legacy 647)', duplicated;
  end if;
end;
$$;

create unique index if not exists capability_grants_one_active_per_scope
  on capability_grants (workspace_id, principal_id, resource_type, resource_id) nulls not distinct
  where status = 'active';
