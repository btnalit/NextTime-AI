-- module: core, version: 0053
--
-- 0053_chat_agent_kind (S11 AA4c: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §5.9;
-- the AA4 plan's F2, decided by the coordinating thread 2026-11-02). A Chat is held by one of two
-- agents: the person's entry agent (`entry`, every Chat until now) or the platform administrator's
-- admin agent (`admin_agent`). An admin agent's Chat runs its Turns through an `admin_agent` session
-- (core 0049) and its own container; it is never mixed with the entry agent's.
--
-- 1. `chats.agent_kind`, `entry` or `admin_agent`, default `entry` (every existing row).
-- 2. `chats_admin_agent_private` (CHECK): an admin agent's Chat is always private. `chats_visibility`
--    (0003) then lets only the person who started it read or write it; making it workspace-visible
--    would let the trial workspace's other members read what the administrator asked of the agent
--    and what it read of the platform.
-- 3. `chats_agent_kind_guard` (BEFORE INSERT OR UPDATE, every role):
--    - a Chat's kind never changes: turning an entry Chat into an admin one would hand the admin
--      agent a conversation it did not have, and the other way round would put what the admin agent
--      read of the platform in front of the entry agent;
--    - an admin agent's Chat is started only in a trial workspace (`workspaces.purpose =
--      'admin_trial'`, core 0050, which never changes afterwards). That the person is an effective
--      platform administrator and the switch is on is the kernel's check
--      (`application/admin-agent/identity.ts`), re-run on every message: those change over time,
--      the workspace's purpose does not.
--
-- Rolling back (docs/runbooks/release.md §6). Older code never writes `agent_kind` and reads Chats
-- with an explicit column list, so code alone may roll back; an admin agent's Chat then reads as an
-- ordinary private Chat of its owner, and older code starts its Turns with the entry agent. Before
-- rolling back while `select count(*) from chats where agent_kind = 'admin_agent'` is not 0, archive
-- those Chats. To remove the migration as well: drop the trigger and its function, drop the two
-- constraints and the column, then `delete from schema_migrations where module = 'core' and
-- version = 53`.
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table chats add column if not exists agent_kind text not null default 'entry';

alter table chats drop constraint if exists chats_agent_kind_check;
alter table chats add constraint chats_agent_kind_check
  check (agent_kind in ('entry', 'admin_agent'));

alter table chats drop constraint if exists chats_admin_agent_private;
alter table chats add constraint chats_admin_agent_private
  check (agent_kind <> 'admin_agent' or visibility = 'private');

create or replace function chats_agent_kind_guard() returns trigger
language plpgsql as $$
declare
  purpose text;
begin
  if tg_op = 'UPDATE' then
    if new.agent_kind is distinct from old.agent_kind then
      raise exception 'chats: a Chat''s agent kind never changes (% -> %)', old.agent_kind, new.agent_kind
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.agent_kind = 'admin_agent' then
    select w.purpose into purpose from workspaces w where w.id = new.workspace_id;
    if purpose is distinct from 'admin_trial' then
      raise exception 'chats: an admin agent''s Chat is started only in a trial workspace'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists chats_agent_kind_guard on chats;
create trigger chats_agent_kind_guard
  before insert or update on chats
  for each row execute function chats_agent_kind_guard();
