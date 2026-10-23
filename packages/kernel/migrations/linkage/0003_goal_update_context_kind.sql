-- module: linkage, version: 0003
--
-- S11 GO5e-2 (docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §4.14 "对话：发起目标的
-- 对话里，里程碑以系统消息出现"): a goal's milestones — the requester confirmed it, it paused and why,
-- it finished and whether it was achieved — reach the entry agent of the chat the goal was proposed
-- from the way a Task's outcome does: as a `pending_context_items` row its next Turn leases
-- (`application/linkage/goal-consumer.ts`). One more `kind`, `goal_update`, whose `subject_id` is the
-- GoalRun and whose `payload` is the `system.goal_update` chat message content.
--
-- Widening the CHECK is the whole change. The previous release's code never writes the new kind;
-- reading a row of it, its `get_entry_context` puts the payload in the `tasks` bucket (everything
-- but `action_request_update` goes there, `store.ts`'s `toEntryContextItems`), which is where this
-- release puts it too. Rolling back needs no data change.
--
-- Cross-process bootstrap lock: same `linkage`-module key as 0001–0002.
select pg_advisory_xact_lock(7241000601);

alter table pending_context_items drop constraint if exists pending_context_items_kind_check;
alter table pending_context_items add constraint pending_context_items_kind_check
  check (kind in (
    'task_completed', 'task_failed', 'task_cancelled', 'task_waiting_approval',
    'budget_warning', 'action_request_update', 'goal_update'
  ));
