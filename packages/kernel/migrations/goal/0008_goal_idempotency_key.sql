-- module: goal, version: 0008
--
-- 0008_goal_idempotency_key (S11 GO5c: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §4.3, §7.2 item 2, scenario S3). `propose_goal` is the entry agent's call: when its client times
-- out and the model calls again, a second GoalRun would wait on the requester's confirmation card
-- next to the first. `goal_runs.idempotency_key` takes the same two kinds of key `request_action`
-- (governance/0014) and `invoke_worker` (task/0005) take — `application/gateway/goal-handlers.ts`'s
-- `proposeGoalHandler` always passes one:
--   - `explicit:<on_behalf_of>:<sid>:<key>` — the caller passed `idempotencyKey`: one GoalRun per
--     key, whatever its status since;
--   - `auto:<sid|principal>:<hash of statement, plan and budget>` — derived when it did not:
--     dedupes only against a run still `proposed`. Once it was confirmed, rejected or ended, the
--     same proposal again is a new goal.
-- `application/goal/service.ts`'s `createGoalRun` looks up with the same conditions first; these
-- indexes are the database-side guarantee — two concurrent proposals with one key insert one row,
-- and the second replays it (the insert runs in a savepoint, as `requestAction`'s does).
--
-- Nullable, no backfill: existing runs, and every run created without a key (direct
-- `createGoalRun` callers, the previous release's code), carry NULL, which neither index covers.
-- The key never changes: `goal_runs_status_guard` lets only the columns it lists change, and this
-- one is not among them.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0007 (locks are per-module, not
-- per-file).
select pg_advisory_xact_lock(7241000701);

alter table goal_runs add column if not exists idempotency_key text;

create unique index if not exists goal_runs_idempotency_key_uidx
  on goal_runs (workspace_id, idempotency_key)
  where idempotency_key is not null and idempotency_key not like 'auto:%';

create unique index if not exists goal_runs_derived_idempotency_key_proposed_uidx
  on goal_runs (workspace_id, idempotency_key)
  where idempotency_key like 'auto:%' and status = 'proposed';
