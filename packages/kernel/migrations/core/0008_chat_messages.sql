-- module: core, version: 0008
--
-- chat_messages (§5.1.3 Chat/Turn, §9.4 chat WebSocket protocol; docs/development-tasks.md S1.4):
-- the persisted transcript of a Chat — one row per user/assistant/tool/system message.
-- `sequence` is the monotonic-per-chat history cursor `get_chat_history`/`subscribe_chat` page
-- and replay against (§9.4 "client rule: subscribe_chat(chatId, startAfter) first, then
-- get_chat_history"); `chat.stream` deltas (textDelta/toolCallStarted/toolCallEnded) are
-- deliberately never written here — only `chat.message`-worthy content (the user's own message,
-- and the agent's final assistant/tool messages) is persisted, per §9.4's event vocabulary.
--
-- turn_id decision (nullable, not NOT NULL): every row S1.4's own write paths ever produce *does*
-- carry a turn_id — application/chat's sendChatMessage inserts the user's message and starts its
-- Turn (`activities`, kind='agent_turn') in the same transaction (§8.1 sendChatMessage), so even
-- the triggering user message already knows its own turn_id by the time it is written; the
-- agent's assistant/tool messages are written while that same Turn is still running. Nullable is
-- still the right column constraint, not merely the cautious default, for two reasons: (1) it
-- mirrors `activities.chat_id` itself (0002_substrate.sql) being nullable for the same
-- forward-compatibility reason — a future kind of persisted chat message genuinely outside any
-- Turn (e.g. a system-injected notice, §5.1.3's Chat/Turn split does not rule this out) should not
-- require a fabricated Activity just to satisfy a NOT NULL constraint; (2) `role='system'` is
-- already reserved in the CHECK below for exactly that future case, so the schema would be
-- internally inconsistent if it allowed a `system` role but forced every row through a Turn.
-- Application-level: S1.4's handlers always pass a turn_id for `user`/`assistant`/`tool` rows.
--
-- `sequence bigint` (not `int`): the same column-width reasoning 0005_outbox.sql gives for
-- `outbox.id bigserial` — cheap to over-provision, expensive to retrofit. It is a plain `bigint`
-- here, not `bigserial`: `application/chat` allocates the next value itself (advisory-lock-guarded
-- `coalesce(max(sequence),0)+1` scoped to `(workspace_id, chat_id)`, not scoped to the whole
-- table the way a `bigserial`'s underlying sequence object would be), because the cursor must be
-- monotonic *per chat*, not globally.
--
-- Cross-process bootstrap lock: see 0001_identity.sql's comment for the full rationale — the
-- same `pg_advisory_xact_lock` call is the first statement of every file in this module.
select pg_advisory_xact_lock(7241000101);

create table if not exists chat_messages (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  chat_id uuid not null,
  turn_id uuid,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content jsonb not null default '{}'::jsonb,
  sequence bigint not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, chat_id) references chats (workspace_id, id),
  foreign key (workspace_id, turn_id) references activities (workspace_id, id),
  unique (workspace_id, chat_id, sequence)
);

alter table chat_messages enable row level security;

drop policy if exists chat_messages_visibility on chat_messages;

-- Mirrors `activities_visibility` (0003_chat.sql) exactly: a Chat's messages are visible under
-- the same rule as the Chat itself (workspace-visible, or owned by the current principal).
create policy chat_messages_visibility on chat_messages
  for all
  using (
    workspace_id = app_workspace()
    and exists (
      select 1 from chats c
      where c.workspace_id = chat_messages.workspace_id
        and c.id = chat_messages.chat_id
        and (c.visibility = 'workspace' or c.owner_principal_id = app_principal())
    )
  )
  with check (
    workspace_id = app_workspace()
    and exists (
      select 1 from chats c
      where c.workspace_id = chat_messages.workspace_id
        and c.id = chat_messages.chat_id
        and (c.visibility = 'workspace' or c.owner_principal_id = app_principal())
    )
  );

-- Append-only transcript: no UPDATE/DELETE grant at all (unlike `links`/`audit_records`, no
-- trigger belt-and-suspenders is added here — every write path in this module runs under the
-- non-superuser `nexttime_app` role via `withWorkspace()`, so the missing grant alone is
-- sufficient; see writer.ts/service.ts for the one insert path).
grant select, insert on chat_messages to nexttime_app;

-- One running Turn per Chat (§9.4 "一个 Chat 同时只允许一个进行中的 Turn"; docs/development-tasks.md
-- S1.4 deliverable 1): a partial unique index, not an application-level check-then-insert, is the
-- actual enforcement mechanism — `application/chat`'s sendChatMessage attempts to insert the new
-- Turn's Activity row in the same transaction as the user's message, and a second concurrent
-- attempt for the same Chat collides on this index and is turned into a clean, single error
-- (caught and re-raised as a domain-specific TurnAlreadyRunning error) instead of two Turns ever
-- running for one Chat at once.
create unique index if not exists activities_one_running_turn_per_chat_uidx
  on activities (workspace_id, chat_id)
  where kind = 'agent_turn' and status = 'running';
