-- module: goal, version: 0017
--
-- 0017_pause_model_refused (legacy 589). A step's Task now fails `model_refused` when every model
-- call its Worker made was refused by llm-proxy because the workspace's daily budget was spent
-- (migrations/llm-usage/0003). Retrying the step cannot help until the budget resets (the next
-- UTC midnight) or an owner raises it, and each retry spawns a Worker for nothing — so the
-- advancer pauses the run `model_refused`, the same way it pauses `budget_exhausted` for the
-- goal's own budget (application/goal/advance.ts `judgeFinishedAttempt`). The requester resumes it
-- once the model answers again.
--
-- This widens 0001's column CHECK on `goal_runs.pause_reason` (Postgres named it
-- `goal_runs_pause_reason_check`) by that one value, the values of `GOAL_RUN_PAUSE_REASON_VALUES`
-- (packages/shared/src/enums.ts). Added `not valid` and validated in the same transaction:
-- validation reads `goal_runs` under SHARE UPDATE EXCLUSIVE and every existing row already holds.
--
-- Rolling back (docs/runbooks/release.md §6). The previous release's kernel never writes
-- `model_refused`. A run already paused `model_refused` reads there as a pause it has no text
-- for, and its resume works as for any advancer pause. To drop the schema too, no run may be
-- paused `model_refused` (`select count(*) from goal_runs where pause_reason = 'model_refused'` is
-- 0; have the requester resume or end each one first) — then, with the kernel stopped, in one
-- transaction: restore the CHECK without the value (the statements below with 0001's list) and
-- `delete from schema_migrations where module = 'goal' and version = 17`.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0016.
select pg_advisory_xact_lock(7241000701);

alter table goal_runs drop constraint if exists goal_runs_pause_reason_check;
alter table goal_runs add constraint goal_runs_pause_reason_check check (
  pause_reason in (
    'requested', 'budget_exhausted', 'no_progress', 'authority_lost', 'needs_decision',
    'awaiting_reconcile', 'model_refused'
  )
) not valid;
alter table goal_runs validate constraint goal_runs_pause_reason_check;
