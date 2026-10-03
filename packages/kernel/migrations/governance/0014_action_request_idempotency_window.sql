-- module: governance, version: 0014
--
-- 0014_action_request_idempotency_window (2026-10-02 review R-53, maintainer decision D-12).
--
-- `request_action` stores one of two kinds of key in `action_requests.idempotency_key`
-- (application/gateway/action-executor.ts):
--   - `explicit:<on_behalf_of>:<sid>:<key>` — the caller passed `idempotencyKey`;
--   - `auto:<sid|principal>:<gatekeeperId>:<operation>:<params hash>` — derived when it did not.
-- 0003's `action_requests_idempotency_key_uidx` made every key unique for ever, and the lookup
-- matched a row in any status. The derived key therefore turned the first terminal row into a
-- permanent answer: a retry after `failed` / `rejected` / `expired` replayed that row, and a
-- legitimate repeat (restart, check, restart) got the first run's `executed` result with no `apply`.
--
-- D-12: a derived key dedupes only against a row that is still in flight; once that row is
-- terminal, a repeat is a new intent. An explicit key keeps its 0003 meaning: one row per key,
-- whatever its status. So the one index becomes two:
--   - `action_requests_idempotency_key_uidx` (same name, so code that recognises the conflict by
--     constraint name keeps working): every key that is not derived, in every status;
--   - `action_requests_derived_idempotency_key_inflight_uidx`: derived keys, only while the row is
--     in flight. `governance/approval/request-action.ts` looks up with the same condition.
-- The in-flight statuses are the non-terminal ones of ACTION_REQUEST_TRANSITIONS
-- (packages/shared/src/transitions.ts): `proposed`, `policy_evaluated`, `auto_approved`,
-- `pending_approval`, `approved`, `executing`. `executed` counts as terminal here even though
-- `verify` can follow it: the operation has run.
--
-- Safe on existing data: under 0003's index every existing key is already unique per workspace, so
-- each subset is too and neither CREATE can fail. The DROP and both CREATEs run in this file's one
-- transaction (adapters/db/migrate.ts), so no moment exists without a uniqueness guarantee.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

drop index if exists action_requests_idempotency_key_uidx;

create unique index if not exists action_requests_idempotency_key_uidx
  on action_requests (workspace_id, idempotency_key)
  where idempotency_key is not null and idempotency_key not like 'auto:%';

create unique index if not exists action_requests_derived_idempotency_key_inflight_uidx
  on action_requests (workspace_id, idempotency_key)
  where idempotency_key like 'auto:%'
    and status in (
      'proposed', 'policy_evaluated', 'auto_approved', 'pending_approval', 'approved', 'executing'
    );
