-- module: governance, version: 0015
--
-- Monotonic revocation (R-29, review 2026-10-02 — the governance half of core 0035, which cannot
-- touch these tables: every core file runs before governance 0001 creates them). Until now
-- nothing in the database stopped an UPDATE from un-revoking a Handle (`revoked_at = null`) or
-- reactivating a revoked or expired grant; only the absence of such a code path did.
--
--   - `capability_handles.revoked_at` goes from null to a timestamp once. Clearing it raises. A
--     second revocation of an already-revoked Handle is not an error — `revokeHandle`,
--     `revokeSession` and the purge cascade filter on `revoked_at is null`, a future bulk
--     revocation need not — and keeps the first revocation time, which the llm-proxy revocation
--     sync (`/internal/handle-revocations`) pages by.
--   - `capability_grants.status`: `active -> revoked | expired`, both terminal (design §5.5
--     CapabilityGrant). `revoked_at` follows the Handle rule: I14's audit check
--     (substrate/audit/invariant-checks.ts) judges every past approval against it.
--
-- For every role, not only `nexttime_app`: un-revoking is never legitimate and nothing does it.
-- The purge cascade only sets `revoked_at` where it is null and then deletes the rows, which an
-- update trigger does not see. Same posture as the `links` / `audit_records` triggers (core 0002,
-- 0004). Revocation itself is untouched.
--
-- Runner ordering / advisory lock: same module (`governance`), same key as every other
-- governance migration.
select pg_advisory_xact_lock(7241000201);

create or replace function capability_handles_block_unrevoke() returns trigger
language plpgsql as $$
begin
  if old.revoked_at is not null then
    if new.revoked_at is null then
      raise exception 'capability_handles: a revoked Handle cannot be un-revoked (R-29)';
    end if;
    new.revoked_at := old.revoked_at;
  end if;
  return new;
end;
$$;

create or replace trigger capability_handles_monotonic_revocation
  before update on capability_handles
  for each row execute function capability_handles_block_unrevoke();

create or replace function capability_grants_block_unrevoke() returns trigger
language plpgsql as $$
begin
  if old.status in ('revoked', 'expired') and new.status is distinct from old.status then
    raise exception 'capability_grants: a % grant is terminal (R-29)', old.status;
  end if;
  if old.revoked_at is not null then
    if new.revoked_at is null then
      raise exception 'capability_grants: a revoked grant cannot be un-revoked (R-29)';
    end if;
    new.revoked_at := old.revoked_at;
  end if;
  return new;
end;
$$;

create or replace trigger capability_grants_monotonic_revocation
  before update on capability_grants
  for each row execute function capability_grants_block_unrevoke();
