-- module: core, version: 0003
--
-- chats (§5.1.3, §9.2 DDL sketch, §5.6): one user's conversation thread with their entry agent —
-- private by default. Also wires up the `activities.chat_id` foreign key and replaces
-- activities' workspace-only RLS policy from 0002 with the chat-visibility-aware version, now
-- that `chats` exists (docs/development-tasks.md S1.1 dispatch: "0003_chat.sql — FK from
-- activities.chat_id").
create table chats (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  owner_principal_id uuid not null,
  title text,
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, owner_principal_id) references principals (workspace_id, id)
);

alter table chats enable row level security;

create policy chats_visibility on chats
  for all
  using (
    workspace_id = app_workspace()
    and (visibility = 'workspace' or owner_principal_id = app_principal())
  )
  with check (
    workspace_id = app_workspace()
    and (visibility = 'workspace' or owner_principal_id = app_principal())
  );

grant select, insert, update, delete on chats to nexttime_app;

alter table activities
  add constraint activities_chat_id_fkey
  foreign key (workspace_id, chat_id) references chats (workspace_id, id);

drop policy activities_workspace_isolation on activities;

create policy activities_visibility on activities
  for all
  using (
    workspace_id = app_workspace()
    and (
      chat_id is null
      or exists (
        select 1 from chats c
        where c.workspace_id = activities.workspace_id
          and c.id = activities.chat_id
          and (c.visibility = 'workspace' or c.owner_principal_id = app_principal())
      )
    )
  )
  with check (
    workspace_id = app_workspace()
    and (
      chat_id is null
      or exists (
        select 1 from chats c
        where c.workspace_id = activities.workspace_id
          and c.id = activities.chat_id
          and (c.visibility = 'workspace' or c.owner_principal_id = app_principal())
      )
    )
  );
