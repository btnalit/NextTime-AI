-- module: governance, version: 0006
--
-- Adds `action_requests.executing_at` (P1-3 fix, review job 652a4abc: "crash/DB failure between
-- apply success and markActionRequestExecuted leaves row `executing` forever; not drainable, no
-- reaper, no event, parent Task never resumes"). `application/gateway/action-executor.ts`'s new
-- `reapStaleExecutingActionRequests` needs a reliable "how long has this row actually been
-- `executing`" signal to scan for stuck rows across every workspace, on an interval
-- (`packages/kernel/src/index.ts` wires it the same way as the S2.3 approval-expiry reaper).
--
-- `requested_at` (already on the row) is not usable for this: a `pending_approval` row can
-- legitimately sit for up to the approval timeout (S2.3 default 24h) *before* ever reaching
-- `executing` — using `requested_at` as the staleness anchor would make the reaper sweep a row
-- the instant a slow-to-approve request finally starts executing, re-`apply`-ing it against a
-- gate that is still actively working on it. `executing_at` is set only by `execution.ts`'s
-- `startActionRequestExecution` (`auto_approved|approved -> executing`), so it marks the actual
-- moment execution began, not when the row was first created.
--
-- Nullable, not backfilled: no row can be sitting `executing` before this migration ever runs
-- (the column did not exist to set it), and every future `executing` row goes through
-- `startActionRequestExecution`, which this same PR updates to always set it.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table action_requests add column if not exists executing_at timestamptz;

-- Partial index — only `executing` rows are ever scanned by the staleness sweep, and the table
-- otherwise carries every terminal ActionRequest a workspace has ever created.
create index if not exists action_requests_stale_executing_idx
  on action_requests (executing_at)
  where status = 'executing';
