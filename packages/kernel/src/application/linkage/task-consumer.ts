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
  // Best-effort, process-lifetime dedupe against a redelivered outbox row — same documented
  // precedent/limitation as application/host-bridge/turn-started-consumer.ts's own `seenOutboxIds`
  // (its doc comment has the full rationale: this protects against *this process* seeing the same
  // outboxId twice, not against a crash between commit and the outbox row's own dispatched_at
  // update — `pending_context_items`'s unique index below covers that harder case for the context
  // item; the chat message write has no equivalent durable guard, a documented known gap).
  const seenOutboxIds = new Set<string>();

  return dispatcher.subscribe('TaskUpdated', async (event, meta) => {
    if (seenOutboxIds.has(meta.outboxId)) return;
    seenOutboxIds.add(meta.outboxId);

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
  });
}
