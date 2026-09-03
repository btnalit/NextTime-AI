import { withWorkspace } from '../../adapters/db/pool.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import type { OutboxDeliveryMeta } from '../outbox/index.js';
import { readTask } from '../task/index.js';
import type { LinkageDeps } from './deps.js';
import { insertPendingContextItem } from './store.js';

/**
 * application/linkage/budget-consumer: the `BudgetWarning` outbox consumer (docs/development-
 * tasks.md S2.11 deliverable 3 "get_entry_context returns ... any budget warning (≥80%)"). Context
 * injection only — `BudgetWarning` is deliberately not one of deliverable 1's three chat-message
 * `kind`s (`system.task_update`/`system.action_pending`/`system.action_update`) nor one of
 * deliverable 2's three WS push frames (`action.pending`/`action.updated`/`task.updated`); it only
 * ever needs to reach the calling entry agent's next `get_entry_context`, not a live chat card.
 *
 * Only `scope: 'task'` warnings carry a `taskId` to attribute to a principal (`packages/shared/src/
 * events.ts`'s `BudgetWarningEvent`) — `turn`/`workspace_daily` scope warnings are not emitted by
 * any code path yet (`application/task/invoke.ts`'s S2.7 I18 budget check is `scope: 'task'` only,
 * per that task's own implementation notes) and are silently ignored here rather than guessed at.
 */

type BudgetWarningEvent = Extract<DomainEvent, { type: 'BudgetWarning' }>;

export interface BudgetWarningSource {
  subscribe(
    eventType: 'BudgetWarning',
    consumer: (event: BudgetWarningEvent, meta: OutboxDeliveryMeta) => Promise<void> | void,
  ): () => void;
}

/** Registers the `BudgetWarning` consumer on `dispatcher`. Returns an unsubscribe function. */
export function registerBudgetWarningConsumer(
  dispatcher: BudgetWarningSource,
  deps: LinkageDeps,
): () => void {
  const seenOutboxIds = new Set<string>();

  return dispatcher.subscribe('BudgetWarning', async (event, meta) => {
    if (seenOutboxIds.has(meta.outboxId)) return;
    seenOutboxIds.add(meta.outboxId);
    if (event.scope !== 'task' || !event.taskId) return;

    const taskId = event.taskId;
    const task = await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: taskId },
      (client) => readTask(client, event.workspaceId, taskId),
    );
    if (!task) return;

    await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: task.onBehalfOf },
      (client) =>
        insertPendingContextItem(client, event.workspaceId, {
          principalId: task.onBehalfOf,
          kind: 'budget_warning',
          subjectId: taskId,
          payload: {
            taskId,
            percent: event.percent,
            text: `Task ${taskId} has used ${event.percent}% of its token budget`,
          },
          sourceOutboxId: meta.outboxId,
        }),
    );
  });
}
