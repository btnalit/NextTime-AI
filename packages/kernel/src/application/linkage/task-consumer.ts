import { withWorkspace } from '../../adapters/db/pool.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import {
  insertChatMessage,
  publishChatPushEvent,
  publishPrincipalPushEvent,
} from '../chat/index.js';
import type { OutboxDeliveryMeta } from '../outbox/index.js';
import { readTask } from '../task/index.js';
import { resolveTaskChat } from './chat-targets.js';
import { buildTaskUpdateContent } from './content.js';
import type { LinkageDeps } from './deps.js';
import { insertPendingContextItem } from './store.js';
import type { ContextItemKind } from './types.js';

/**
 * application/linkage/task-consumer: the `TaskUpdated` outbox consumer (docs/development-tasks.md
 * S2.11 deliverable 1 "on TaskUpdated → a system message into the on_behalf_of user's Chat that
 * generated the Task"; deliverable 2 "task.updated ... pushed to the connected sessions of ...
 * task owner"). See `application/linkage/index.ts`'s module doc comment for why this lives here
 * and not in `application/chat` (depcruise forbids chat from importing `application/task`, even
 * via its public `readTask`).
 *
 * Two-phase read/write, same pattern `application/task/reaper.ts`'s
 * `registerActionRequestRoutingConsumer` already establishes for this exact problem ("`tasks` RLS
 * is workspace-only — `principalId` is inert for read authorization here, pass a real,
 * syntactically-valid uuid already on hand"): the *first* read (to learn `onBehalfOf`) opens
 * `withWorkspace` with the Task's own id as a syntactically-valid but otherwise-inert
 * `principalId` placeholder; every subsequent write re-opens `withWorkspace` scoped to the real
 * `onBehalfOf`, which both `chats`/`chat_messages` and `pending_context_items` RLS require.
 *
 * At-least-once dedupe (lane-4 P1 fix, docs/development-tasks.md): `seenOutboxIds` is only
 * populated *after* the write below has actually committed — never before. Marking an outboxId
 * "seen" before doing the work (the previous shape of this function) meant a mid-write failure
 * (the dispatcher's own row transaction rolling back and redelivering the event —
 * `application/outbox/dispatcher.ts`'s own doc comment) would find the id already in the Set on
 * retry and return immediately, permanently dropping the system message/context item this event
 * was supposed to produce. Both writes below are also now durably idempotent in their own right
 * (`insertChatMessage`'s `sourceOutboxId`, migrations/core/
 * 0009_chat_messages_source_outbox_id.sql; `insertPendingContextItem`'s existing
 * `pending_context_items_dedupe_uidx`) — the in-memory Set is still worth keeping as a fast path
 * that avoids a redundant DB round trip for the common case (this same process seeing the same
 * outboxId twice with nothing in between), but is no longer the only thing standing between a
 * redelivery and data loss.
 */

type TaskUpdatedEvent = Extract<DomainEvent, { type: 'TaskUpdated' }>;

export interface TaskUpdatedSource {
  subscribe(
    eventType: 'TaskUpdated',
    consumer: (event: TaskUpdatedEvent, meta: OutboxDeliveryMeta) => Promise<void> | void,
  ): () => void;
}

/** Only these Task statuses are worth a persisted chat message + context item — `queued`/
 *  `running` are not outcomes an entry agent or a human needs narrated (docs/development-tasks.md
 *  S2.11 build-order note: "queued→running fires too — filter"). `task.updated` itself still
 *  pushes over WS for every status (see below) — cheap, and S2.10 can filter client-side. */
const TASK_STATUS_TO_CONTEXT_KIND: Partial<Record<TaskUpdatedEvent['status'], ContextItemKind>> = {
  waiting_approval: 'task_waiting_approval',
  completed: 'task_completed',
  failed: 'task_failed',
  cancelled: 'task_cancelled',
};

/** Best-effort extraction of a human-readable summary from a Task's `result` (S2.9's result
 *  contract — `{summary, findings, ...}`, not yet guaranteed to exist for every Task) — never
 *  throws on an unexpected shape. */
function extractResultSummary(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const summary = (result as { summary?: unknown }).summary;
  return typeof summary === 'string' ? summary : null;
}

/** Registers the `TaskUpdated` consumer on `dispatcher`. Returns an unsubscribe function. */
export function registerTaskUpdatedConsumer(
  dispatcher: TaskUpdatedSource,
  deps: LinkageDeps,
): () => void {
  // Process-lifetime fast-path dedupe against a redelivered outbox row — see this module's own
  // doc comment above for why entries are only added *after* a successful write, and why the
  // durable unique indexes below are what actually prevent data loss/duplication on a crash.
  const seenOutboxIds = new Set<string>();

  return dispatcher.subscribe('TaskUpdated', async (event, meta) => {
    if (seenOutboxIds.has(meta.outboxId)) return;

    const task = await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: event.taskId },
      (client) => readTask(client, event.workspaceId, event.taskId),
    );
    if (!task) return;

    // task.updated pushes for every status change (S2.10 consumes it as a generic
    // "refresh this Task's view" signal) — cheap, no DB write required beyond the read above.
    publishPrincipalPushEvent(task.onBehalfOf, {
      type: 'task.updated',
      taskId: event.taskId,
      status: event.status,
    });

    const kind = TASK_STATUS_TO_CONTEXT_KIND[event.status];
    if (!kind) return;

    await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: task.onBehalfOf },
      async (client) => {
        const chat = await resolveTaskChat(client, event.workspaceId, task);
        const content = buildTaskUpdateContent({
          taskId: event.taskId,
          status: event.status,
          failureReason: task.failureReason,
          summary: extractResultSummary(task.result),
        });

        const message = await insertChatMessage(client, event.workspaceId, {
          chatId: chat.id,
          turnId: null,
          role: 'system',
          content: content as unknown as Record<string, unknown>,
          sourceOutboxId: meta.outboxId,
        });
        publishChatPushEvent({
          type: 'chat.message',
          chatId: chat.id,
          message: {
            id: message.id,
            role: 'system',
            text: content.text,
            createdAt: message.createdAt.toISOString(),
            sequence: message.sequence,
            kind: content.kind,
            content: content as unknown as Record<string, unknown>,
          },
        });

        await insertPendingContextItem(client, event.workspaceId, {
          principalId: task.onBehalfOf,
          kind,
          subjectId: event.taskId,
          payload: content as unknown as Record<string, unknown>,
          sourceOutboxId: meta.outboxId,
        });
      },
    );

    // Marked seen only once the durable write above has actually committed — see this module's
    // own doc comment for why (a throw anywhere above this line leaves the id un-added, so a
    // redelivery retries the write in full rather than silently no-op'ing).
    seenOutboxIds.add(meta.outboxId);
  });
}
