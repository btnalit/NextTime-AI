-- module: task, version: 0003
--
-- Adds the columns `invoke_worker`/the reaper/the budget hook (docs/development-tasks.md S2.7)
-- need on top of 0001_tasks.sql's `tasks`/`worker_runs` — every column here is additive (`alter
-- table ... add column if not exists`), never touching an already-applied column's type or
-- constraint, per the "no edits to applied migrations" rule.
--
-- Cross-process bootstrap lock: same `task`-module key as 0001/0002 (locks are per-module, not
-- per-file).
select pg_advisory_xact_lock(7241000401);

-- worker_runs: I18 depth + lineage + egress attribution -----------------------------------------
--
-- `depth`: denormalized rather than walked recursively via `parent_worker_run_id` on every
-- `invoke_worker` call (§5.4 I18 "派生链深度 ≤ 3") — 0 for a WorkerRun spawned directly by an
-- entry (or other non-WorkerRun) Handle, N+1 for one spawned by a WorkerRun already at depth N.
-- Computed once at INSERT time (`application/task/invoke.ts`) and never updated afterward, so a
-- depth check is one indexed row read (`select depth from worker_runs where session_id = $1`),
-- not a recursive CTE.
--
-- `activity_id`: the `kind='worker_run'` Activity `invoke_worker` creates on spawn (design doc
-- §5.1.3 Activity; docs/development-tasks.md S2.7 "an activities row of kind worker_run ... so a
-- Worker's egress lands in the graph like a Turn's") — `application/host-bridge/
-- egress-observations.ts`'s `worker:<workspaceId>:<workerRunId>` parsing resolves this column to
-- know which Activity to append `metadata.egress[]` entries to, the same role `chat`'s Turn
-- Activity plays for `entry:` sourceIds. Nullable only because it is set in the same statement
-- that creates the row (no window where it is legitimately absent) — kept nullable rather than
-- `not null` regardless, since `startActivity` (a separate INSERT) must run first to obtain the
-- id and this migration cannot enforce "these two inserts happen together" at the DB level.
--
-- `attempt`: 1 for the first WorkerRun of a Task, 2 for the one requeue `invoke.ts`'s "non-zero
-- exit → requeue once" performs (docs/development-tasks.md S2.7) — never more than 2, enforced in
-- application code (the DB CHECK only bounds it to a sane range, not the exact business rule).
alter table worker_runs add column if not exists depth int not null default 0;
alter table worker_runs add column if not exists activity_id uuid;
alter table worker_runs add column if not exists attempt int not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'worker_runs_depth_check'
  ) then
    alter table worker_runs add constraint worker_runs_depth_check check (depth >= 0 and depth <= 3);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'worker_runs_attempt_check'
  ) then
    alter table worker_runs add constraint worker_runs_attempt_check check (attempt >= 1 and attempt <= 2);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'worker_runs_activity_id_fkey'
  ) then
    alter table worker_runs
      add constraint worker_runs_activity_id_fkey
      foreign key (workspace_id, activity_id) references activities (workspace_id, id);
  end if;
end
$$;

-- Reaper/attribution read pattern: "find the WorkerRun for this session" (I18 depth lookup) and
-- "find the WorkerRun for this workerRunId" (egress attribution, terminate, status polling) are
-- both already covered by the table's existing primary key / a unique `session_id` per row in
-- practice — no new index added here beyond what the PK already gives `id`-keyed lookups; a
-- `session_id` index is added since that lookup (unlike `id`) has no existing index.
create index if not exists worker_runs_session_id_idx on worker_runs (workspace_id, session_id);

-- tasks: budget + duration limits + failure reason + retry bookkeeping --------------------------
--
-- `token_budget`/`duration_limit_sec`: resolved once at `invoke_worker` time from the workspace's
-- quotas (`quotas` table, 0002_quotas.sql, falling back to compiled-in defaults) and recorded on
-- the Task itself (docs/development-tasks.md S2.7 "每 Task 的 token 与时长限制记录在 Task 上") —
-- read back by the reaper and the llm-usage budget hook rather than re-resolving workspace policy
-- on every check, and so a later `set_quota` change never retroactively changes an
-- already-running Task's own limits. `token_budget` nullable = unlimited (mirrors
-- `governance/llm-usage`'s own `LLM_DAILY_TOKEN_BUDGET` "unset = unlimited" convention).
--
-- `tokens_used`: accumulated by `interfaces/http/internal/llm-usage.ts`'s per-record hook into
-- `application/task`'s `recordWorkerRunUsage` every time a `worker_run`-kind session's usage is
-- reported (input+output+cache tokens, matching `governance/llm-usage/service.ts`'s own
-- `sumTodayTokens` token accounting).
--
-- `budget_warned_at`: edge-trigger guard so the 80% `BudgetWarning` (design doc I18) fires at most
-- once per Task, mirroring `governance/llm-usage/service.ts`'s own before/after-sum crossing
-- check at the workspace level.
--
-- `failure_reason`: free-text (no shared enum — same reasoning migrations/llm-usage/0001's header
-- comment gives for `llm_usage.status`: the vocabulary this column carries
-- (`no_result`/`timeout`/`budget_exhausted`/`worker_failed`/`quota_exceeded`/`cancelled`) is
-- documented in `application/task/service.ts`, not enumerated in the DB, since it is diagnostic
-- text for the entry agent/operator, not a value any transition table branches on.
--
-- `retry_count`: 0 until the reaper's "non-zero exit → requeue once" fires (docs/development-
-- tasks.md S2.7), then 1; a second failure with `retry_count = 1` already goes straight to
-- `failed`, never requeued twice.
alter table tasks add column if not exists token_budget bigint;
alter table tasks add column if not exists duration_limit_sec int;
alter table tasks add column if not exists tokens_used bigint not null default 0;
alter table tasks add column if not exists budget_warned_at timestamptz;
alter table tasks add column if not exists failure_reason text;
alter table tasks add column if not exists retry_count int not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_retry_count_check'
  ) then
    alter table tasks add constraint tasks_retry_count_check check (retry_count >= 0 and retry_count <= 1);
  end if;
end
$$;
