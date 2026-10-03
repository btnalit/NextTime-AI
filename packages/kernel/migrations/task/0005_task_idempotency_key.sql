-- module: task, version: 0005
--
-- `tasks.idempotency_key` (2026-10-02 review R-54, maintainer decision D-12). `invoke_worker` had
-- no idempotency key: when the client timed out and the model invoked again, a second Worker ran
-- the same job, and any auto-approved low-risk operation inside it ran twice.
-- `application/gateway/handlers.ts`'s `invokeWorkerHandler` now always passes a key, of the same
-- two kinds `request_action` uses (governance/0014_action_request_idempotency_window.sql):
--   - `explicit:<on_behalf_of>:<sid>:<key>` — the caller passed `idempotencyKey`: one Task per key,
--     whatever its status;
--   - `auto:<sid|principal>:<definitionId>@<version>:<hash of input and gates>` — derived when it
--     did not: dedupes only against a Task that is not yet terminal (`created`, `queued`, `running`,
--     `waiting_approval`). Once the Task is `completed` / `failed` / `cancelled`, an identical call
--     starts a new one.
-- `application/task/invoke.ts` looks up with the same conditions, under the per-principal advisory
-- lock it already takes for the I18 quota checks; these indexes are the database-side guarantee.
--
-- Nullable, no backfill: existing Tasks, and every Task created without a key (direct
-- `invokeWorker` callers, the previous release's code), carry NULL, which neither index covers.
--
-- Cross-process bootstrap lock: same `task`-module key as 0001–0004 (locks are per-module, not
-- per-file).
select pg_advisory_xact_lock(7241000401);

alter table tasks add column if not exists idempotency_key text;

create unique index if not exists tasks_idempotency_key_uidx
  on tasks (workspace_id, idempotency_key)
  where idempotency_key is not null and idempotency_key not like 'auto:%';

create unique index if not exists tasks_derived_idempotency_key_inflight_uidx
  on tasks (workspace_id, idempotency_key)
  where idempotency_key like 'auto:%'
    and status in ('created', 'queued', 'running', 'waiting_approval');
