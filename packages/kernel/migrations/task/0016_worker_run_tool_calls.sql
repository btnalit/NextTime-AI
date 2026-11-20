-- module: task, version: 0016
--
-- 0016_worker_run_tool_calls (legacy 155): the tool calls a Worker made in its run, as its runtime
-- reports them (`report_tool_calls`, packages/shared/src/worker-tool-calls.ts). A chat Turn's tool
-- calls are kept as `role = 'tool'` chat messages (#520, core 0008's `chat_messages`); a Worker has
-- no Chat, so its records belong to its WorkerRun — one row per call, the record exactly as a
-- Turn's is stored (`content`: `ToolCallMessageContent`, redacted and cut to a preview by the
-- kernel before it is written).
--
-- What holds, by construction here rather than by the handler alone:
--   - a record belongs to exactly one WorkerRun of the same workspace (the foreign key), and a
--     WorkerRun has at most one record per call id (the primary key): the first write is kept, a
--     report repeating an id stores nothing (`on conflict do nothing`);
--   - a run keeps at most 200 records (`sequence` 1–200, unique per run) — the bound a chat Turn
--     has; the handler counts what it cannot store;
--   - a record's `content` is a tool-call record whose id is the row's;
--   - written once: the application role may read and insert, never update or delete (no grant),
--     as for `tasks` and `worker_runs`, whose history this is part of. A workspace's purge removes
--     them with the rest of its rows (application/platform/purge-workspace.ts finds the table by its
--     `workspace_id` column and its foreign key).
--
-- Visibility: workspace isolation, as `tasks` and `worker_runs` (task/0001). Who of the workspace
-- may read a Task's records is `get_task`'s rule (`taskVisibleTo`), applied by the one capability
-- that reads them (`get_task_tool_calls`).
--
-- No backfill: runs before this have no records (their tool calls are in their session files
-- only). Reversibility (docs/runbooks/release.md §6): the previous release never reads or writes
-- the table, so code alone may roll back. To remove it as well: `drop table worker_run_tool_calls`,
-- then `delete from schema_migrations where module = 'task' and version = 16`.
--
-- Cross-process bootstrap lock: same `task`-module key as 0001–0015.
select pg_advisory_xact_lock(7241000401);

create table if not exists worker_run_tool_calls (
  workspace_id uuid not null,
  worker_run_id uuid not null,
  -- At most 256 characters are sent; each U+0000 in them is stored as the five characters `\u{0}`.
  tool_call_id text not null check (char_length(tool_call_id) between 1 and 1280),
  sequence int not null check (sequence between 1 and 200),
  content jsonb not null check (
    jsonb_typeof(content) = 'object'
    and content->>'kind' = 'tool_call'
    and content->>'toolCallId' = tool_call_id
  ),
  reported_at timestamptz not null default now(),
  primary key (workspace_id, worker_run_id, tool_call_id),
  unique (workspace_id, worker_run_id, sequence),
  foreign key (workspace_id, worker_run_id) references worker_runs (workspace_id, id)
);

alter table worker_run_tool_calls enable row level security;

drop policy if exists worker_run_tool_calls_workspace_isolation on worker_run_tool_calls;

create policy worker_run_tool_calls_workspace_isolation on worker_run_tool_calls
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert on worker_run_tool_calls to nexttime_app;
