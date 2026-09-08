-- module: core, version: 0015
--
-- `principals.disabled_at` (S3.11, docs/development-tasks.md "中台控制面" — `disable_principal`).
-- Nullable, unset by default: a disabled Principal's API key stops authenticating
-- (`application/gateway/auth.ts`'s `lookupPrincipalByApiKeyHash` excludes it) and its Handles
-- stop verifying (`application/gateway/handle-auth.ts`'s `authenticateHandle` rejects any Handle
-- whose on_behalf_of principal is disabled, on top of `disable_principal`'s own
-- `revokeEntrySessionHandles` call) — the same two-layer "revoke now, and also refuse the
-- credential going forward" belt-and-suspenders shape `capability_handles.revoked_at` already
-- established for Handles themselves.
--
-- No CHECK/trigger enforcing "a disabled principal can never be re-enabled" — `disable_principal`
-- has no companion `enable_principal` capability yet (out of this task's own scope; S3.11 lists
-- only the five member-management capabilities named in its own dispatch), so the column is
-- simply set once, timestamptz, same "when did this become true" shape as `sessions.expires_at`.
--
-- Cross-process bootstrap lock: same `core`-module key as every other file in this module (locks
-- are per-module, not per-file) — see migrations/core/0001_identity.sql's own header comment for
-- why every file in this module takes it first.
select pg_advisory_xact_lock(7241000101);

alter table principals add column if not exists disabled_at timestamptz;
