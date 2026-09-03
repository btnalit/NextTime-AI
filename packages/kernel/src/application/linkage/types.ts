/**
 * application/linkage/types: `ContextItemKind` (migrations/linkage/0001_pending_context_items.sql
 * CHECK) and the row shape `store.ts` reads/writes. Split out per this codebase's own file-size
 * convention (design doc §7.10 "单文件 ≤ 600 行...超过即拆，不等重构").
 */

export const CONTEXT_ITEM_KIND_VALUES = [
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_waiting_approval',
  'budget_warning',
  'action_request_update',
] as const;
export type ContextItemKind = (typeof CONTEXT_ITEM_KIND_VALUES)[number];

/** The two `get_entry_context` buckets a `ContextItemKind` maps into (`application/gateway/
 *  handlers.ts`'s `getEntryContextHandler`): `action_request_update` → `pendingApprovals`
 *  (requester-side: "is this user blocked on someone else's approval"), everything else → `tasks`
 *  (Task outcomes and budget warnings — S1's `EntryContextResult.tasks` bucket, `packages/
 *  platform-extension/src/modes/entry.ts`'s "Running tasks" section, reused rather than renamed:
 *  it already renders any JSON-shaped item generically). */
export function contextItemBucket(kind: ContextItemKind): 'tasks' | 'pendingApprovals' {
  return kind === 'action_request_update' ? 'pendingApprovals' : 'tasks';
}

export interface PendingContextItemRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly principalId: string;
  readonly kind: ContextItemKind;
  readonly subjectId: string;
  readonly payload: Record<string, unknown>;
  readonly sourceOutboxId: string;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
}
