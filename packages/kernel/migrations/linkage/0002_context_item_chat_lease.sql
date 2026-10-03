-- module: linkage, version: 0002
--
-- 2026-10-02 review R-57 (maintainer decision D-23): `get_entry_context` used to mark every
-- undelivered `pending_context_items` row of the calling principal delivered on read. pi's
-- `context` event fires before every LLM call and its injection is not persisted, so the second
-- LLM call of a Turn (and a provider-error retry) saw nothing; an interactive session on the same
-- principal drained the queue; and a Task result started from chat A was handed to whichever chat
-- read first. Two additive, nullable columns move delivery to "per Turn, acknowledged on
-- `report_turn`" and scope items to the Chat that started them (`application/linkage/store.ts`):
--
-- `chat_id`: the Chat the item belongs to — the Chat whose Turn invoked the Task (or whose Task's
-- Worker raised the ActionRequest), falling back to the Chat the matching system message went to.
-- Only a Turn of that Chat leases the item. Null on rows written before this migration: those stay
-- principal-wide (any of the principal's Turns may lease them), exactly as before.
--
-- `lease_turn_id`: the Turn the item was last shown to (`get_entry_context` with a `turnId`). Every
-- call for that Turn returns the same items until `report_turn` for it sets `delivered_at` (now:
-- "acknowledged at"). A later Turn of the same Chat takes over an unacknowledged lease (the earlier
-- Turn ended without reporting — a crash or an interrupt), so an item is shown again rather than
-- lost. A read without a `turnId` is a peek and writes nothing.
--
-- Both are plain nullable columns, safe on existing rows; the previous release's code never names
-- them (`insertPendingContextItem` / `drainPendingContextItems` use explicit column lists) and
-- keeps its drain-on-read behaviour on this schema. Real foreign keys: `chats` and `activities` are
-- `core` tables and exist before this module runs (module order core < governance < linkage, see
-- 0001's own header). A composite key with a null member is not checked, so legacy rows pass.
--
-- Cross-process bootstrap lock: same `linkage`-module key as 0001.
select pg_advisory_xact_lock(7241000601);

alter table pending_context_items add column if not exists chat_id uuid;
alter table pending_context_items add column if not exists lease_turn_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pending_context_items_chat_id_fkey'
  ) then
    alter table pending_context_items
      add constraint pending_context_items_chat_id_fkey
      foreign key (workspace_id, chat_id) references chats (workspace_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'pending_context_items_lease_turn_id_fkey'
  ) then
    alter table pending_context_items
      add constraint pending_context_items_lease_turn_id_fkey
      foreign key (workspace_id, lease_turn_id) references activities (workspace_id, id);
  end if;
end
$$;

-- No new index: every read and write filters on (workspace_id, principal_id) among unacknowledged
-- rows first, which 0001's `pending_context_items_undelivered_idx` already serves.
