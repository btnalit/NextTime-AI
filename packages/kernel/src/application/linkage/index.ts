/**
 * application/linkage: chat ↔ Task/ActionRequest linkage (design doc §8.2 "Task 终态或审批状态变化时
 * ... chat 模块推送卡片 ... 用户下一次发言时，context 事件把 Task 结果注入", §8.5 审批路由; docs/
 * development-tasks.md S2.11). Three things live here:
 *
 *   1. Outbox consumers that turn `TaskUpdated` / `ActionRequestPending` / `ActionRequestUpdated` /
 *      `BudgetWarning` domain events into persisted `chat_messages` system-message rows (via
 *      `application/chat`'s public `insertChatMessage`) plus live pushes (`application/chat`'s
 *      `publishChatPushEvent` for the persisted message, `publishPrincipalPushEvent` for the S2.11
 *      wire frames `action.pending`/`action.updated`/`task.updated`).
 *   2. `pending_context_items` (migrations/linkage/0001_pending_context_items.sql) — the "deliver
 *      once" store `get_entry_context` (application/gateway/handlers.ts) drains from.
 *   3. Nothing else — this module owns no Task/ActionRequest/Chat *state* of its own beyond that
 *      one delivery-tracking table; it is pure orchestration over three other modules' public
 *      surfaces.
 *
 * **Why this is not `application/chat` itself**, even though the S2.11 task brief's own prose
 * describes it as "outbox consumers in application/chat": `.dependency-cruiser.cjs`'s
 * `chat-and-host-bridge-must-not-import-approval-or-task` rule matches *any* path under
 * `governance/approval/` or `application/task/`, including their `index.ts` — there is no "public
 * reads are exempt" carve-out in the tooling, and this repo's own CI treats a depcruise violation
 * as a hard failure ("approval → chat dependency direction must remain one-way"). Building an
 * ActionRequest's card (holder list beyond what the event already carries, `awaitDecision`,
 * `blastRadius`) and a Task's owning Chat (`onBehalfOf`) both require reading those two modules'
 * public surfaces — reads `application/chat` is contractually forbidden from performing. This
 * module is a sibling `application/*` module instead (not `chat`, not `host-bridge`), so it is
 * free to import both `governance/approval` and `application/task` — and, symmetrically, the same
 * depcruise rule is extended (see `.dependency-cruiser.cjs`'s own comment on that rule) to also
 * forbid `chat`/`host-bridge` from reaching `governance/approval`/`application/task`
 * *transitively* through this module, so it can never become a backdoor around the very
 * restriction it exists to respect.
 *
 * Every consumer here follows the same two-phase read/write shape `application/task/reaper.ts`'s
 * `registerActionRequestRoutingConsumer` already established for this exact problem: the Task/
 * ActionRequest tables' own RLS policies are workspace-only (not principal-scoped), so the first
 * read opens `withWorkspace` with the subject's own id as a syntactically-valid, otherwise-inert
 * `principalId` placeholder; every subsequent write (a Chat, `chat_messages`, or
 * `pending_context_items`, all of which *are* principal-scoped) re-opens `withWorkspace` under the
 * real target principal.
 */

export { registerTaskUpdatedConsumer } from './task-consumer.js';
export type { TaskUpdatedSource } from './task-consumer.js';

export { registerActionRequestConsumers } from './action-request-consumer.js';
export type { ActionRequestEventSource } from './action-request-consumer.js';

export { registerBudgetWarningConsumer } from './budget-consumer.js';
export type { BudgetWarningSource } from './budget-consumer.js';

export { drainPendingContextItems, insertPendingContextItem } from './store.js';
export type { DrainedContextItems, InsertPendingContextItemInput } from './store.js';

export { CONTEXT_ITEM_KIND_VALUES, contextItemBucket } from './types.js';
export type { ContextItemKind, PendingContextItemRow } from './types.js';

export type { LinkageDeps } from './deps.js';

import type { DomainEvent } from '../../substrate/outbox/index.js';
import type { OutboxDeliveryMeta } from '../outbox/index.js';
import { registerActionRequestConsumers } from './action-request-consumer.js';
import { registerBudgetWarningConsumer } from './budget-consumer.js';
import type { LinkageDeps } from './deps.js';
import { registerTaskUpdatedConsumer } from './task-consumer.js';

/** The union of every event type this module's consumers subscribe to. */
type LinkageEventType =
  | 'TaskUpdated'
  | 'ActionRequestPending'
  | 'ActionRequestUpdated'
  | 'BudgetWarning';

/**
 * A single *generic* `subscribe<T>` method (not four separate non-generic overloads merged via
 * `interface X extends A, B, C, D` — that shape does not typecheck: assigning a real
 * `OutboxDispatcher`'s own generic `subscribe<T extends PlatformEventName>` to a target with
 * several *non-generic* overloads only checks against the target's first overload, instantiating
 * `T` at its full `PlatformEventName` bound instead of the literal being called with). Exactly the
 * same shape `application/task/reaper.ts`'s own `ActionRequestEventSource` already uses for the
 * identical reason — that module's doc comment has the full explanation ("TypeScript's
 * overload-vs-generic-method assignability is stricter than its generic-vs-generic one"). A real
 * `OutboxDispatcher` remains structurally assignable here, and `LinkageEventSource` (this type) is
 * in turn assignable to each of the four `register*Consumer` functions' own narrower single/
 * double-overload `*Source` types below (that direction — generic source, few-overload target —
 * is the one that already works, per the same precedent).
 */
export interface LinkageEventSource {
  subscribe<T extends LinkageEventType>(
    eventType: T,
    consumer: (
      event: Extract<DomainEvent, { type: T }>,
      meta: OutboxDeliveryMeta,
    ) => Promise<void> | void,
  ): () => void;
}

/**
 * Registers every consumer this module owns onto `dispatcher` (a real `OutboxDispatcher`,
 * `application/outbox/dispatcher.ts` — its generic `subscribe<T>` structurally satisfies this
 * narrower three-method interface). Call once from the composition root
 * (`packages/kernel/src/index.ts`), alongside `registerTurnStartedConsumer` and
 * `registerActionRequestRoutingConsumer`. Returns a combined unsubscribe function.
 */
export function registerLinkageConsumers(
  dispatcher: LinkageEventSource,
  deps: LinkageDeps,
): () => void {
  const unsubscribeTask = registerTaskUpdatedConsumer(dispatcher, deps);
  const unsubscribeActionRequests = registerActionRequestConsumers(dispatcher, deps);
  const unsubscribeBudget = registerBudgetWarningConsumer(dispatcher, deps);
  return () => {
    unsubscribeTask();
    unsubscribeActionRequests();
    unsubscribeBudget();
  };
}
