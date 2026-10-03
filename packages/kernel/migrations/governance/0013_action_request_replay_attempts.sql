-- module: governance, version: 0013
--
-- Adds `action_requests.replay_attempts` (2026-10-02 review R-48, follow-up to STATUS leftover 104).
-- An `apply` whose outcome is unknown (the gate call timed out) leaves its row `executing`, and
-- `application/gateway/action-executor.ts`'s stale-executing reaper replays it through the gate's
-- idempotency store under the same `actionRequestId`. A replay can get no answer either — the gate
-- is still applying (409), unreachable, or timing out again — and before this column such a row was
-- replayed on every reaper tick, forever. The reaper now counts each replay here (only while the
-- row is still `executing`) and, once the count reaches its cap without an answer, marks the row
-- `failed` with an `outcome_unknown` reason for a person to reconcile against the target system.
--
-- Counted on the row itself rather than in reaper memory so the bound survives a kernel restart.
-- Not part of the ActionRequest wire shape: only the reaper reads and writes it.
--
-- `not null default 0`: existing rows start at zero replays, which is exact for every terminal row
-- and conservative for a row currently `executing` (it gets the full number of replays).
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table action_requests
  add column if not exists replay_attempts integer not null default 0;
