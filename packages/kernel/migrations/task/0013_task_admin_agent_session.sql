-- module: task, version: 0013
--
-- 0013_task_admin_agent_session (S11 AA5a-1: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §5.2 I-A7, §5.8 step 4; the AA5 plan's F2). An admin agent may now start a Worker with
-- `invoke_worker`, in its trial workspace only, to try out what it drafted there. The Task acts for
-- the administrator's own human Principal (`on_behalf_of`) — the admin agent acts as its person — so
-- the Principal alone cannot tell the agent's trial run from the person's own Task. This records the
-- session it came through:
--
--   * `admin_agent_session_id` — the admin agent session (`sessions.kind = 'admin_agent'`) whose
--     `invoke_worker` created the Task; NULL for every other Task (a person's, an entry agent's, a
--     Worker's own child, a goal step's attempt, an evaluation or planning Task).
--
-- What the database holds to, whoever writes (`tasks_admin_agent_session_guard`):
--   * on insert, a recorded session is an `admin_agent` session of this workspace, acting for the
--     Task's own `on_behalf_of`, and the workspace is a trial workspace (`purpose = 'admin_trial'`,
--     core 0050) — the same rule the dispatcher and `invoke_worker`'s handler hold (I-A6), so no
--     code path can file an admin agent's Task anywhere else;
--   * it never changes after the insert — whoever started a Task stays who started it.
-- A foreign key to `sessions` as well (session rows are never deleted but by a workspace purge, whose
-- delete order follows foreign keys — `purge-workspace.ts`).
--
-- Nullable, no backfill: no Task before this one was started by an admin agent (it could not call
-- `invoke_worker`). Reversibility (docs/runbooks/release.md §6): the previous release names its
-- columns on every insert and select of `tasks` and never writes this one, so its inserts pass the
-- guard (NULL) and code alone may roll back. A Task an admin agent started stays recorded; the
-- previous release simply does not show it. To remove the column as well: `drop trigger
-- tasks_admin_agent_session_guard on tasks`, `drop function tasks_admin_agent_session_guard()`,
-- `alter table tasks drop column admin_agent_session_id` (drops its foreign key too), then
-- `delete from schema_migrations where module = 'task' and version = 13`.
--
-- Cross-process bootstrap lock: same `task`-module key as 0001–0012.
select pg_advisory_xact_lock(7241000401);

alter table tasks add column if not exists admin_agent_session_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_admin_agent_session_fk') then
    alter table tasks add constraint tasks_admin_agent_session_fk
      foreign key (workspace_id, admin_agent_session_id) references sessions (workspace_id, id);
  end if;
end
$$;

create or replace function tasks_admin_agent_session_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.admin_agent_session_id is distinct from old.admin_agent_session_id then
      raise exception 'tasks: the admin agent session a Task was started through is written when it is created and never changes'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.admin_agent_session_id is null then
    return new;
  end if;
  if not exists (
    select 1 from sessions s
     where s.workspace_id = new.workspace_id
       and s.id = new.admin_agent_session_id
       and s.kind = 'admin_agent'
       and s.on_behalf_of = new.on_behalf_of
  ) then
    raise exception 'tasks: admin_agent_session_id must name an admin_agent session of this workspace acting for the Task''s on_behalf_of'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from workspaces w
     where w.id = new.workspace_id and w.purpose = 'admin_trial'
  ) then
    raise exception 'tasks: an admin agent starts a Task only in a trial workspace (purpose admin_trial)'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_admin_agent_session_guard on tasks;
create trigger tasks_admin_agent_session_guard
  before insert or update of admin_agent_session_id on tasks
  for each row execute function tasks_admin_agent_session_guard();
