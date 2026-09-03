import type { ActionRequestStatus, SystemMessageContent } from '@nexttime/shared';
import { withWorkspace } from '../../adapters/db/pool.js';
import { computeActionRequestHolders, getActionRequest } from '../../governance/approval/index.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import {
  insertChatMessage,
  publishChatPushEvent,
  publishPrincipalPushEvent,
} from '../chat/index.js';
import type { OutboxDeliveryMeta } from '../outbox/index.js';
import { resolveDefaultChat } from './chat-targets.js';
import { buildActionPendingContent, buildActionUpdateContent } from './content.js';
import type { LinkageDeps } from './deps.js';
import { insertPendingContextItem } from './store.js';

/**
 * application/linkage/action-request-consumer: the `ActionRequestPending`/`ActionRequestUpdated`
 * outbox consumers (docs/development-tasks.md S2.11 deliverable 1 "on ActionRequestPending → a
 * system message with the card payload into each holder's ... Chat and a status-only system
 * message into the requester's Chat; on ActionRequestUpdated → status update messages"; deliverable
 * 2 "action.pending, action.updated ... pushed to the connected sessions of the principals
 * concerned (holders / requester)"). See `application/linkage/index.ts`'s module doc comment for
 * why this lives here and not in `application/chat` (depcruise forbids chat from importing
 * `governance/approval`, even via its public `getActionRequest`/`computeActionRequestHolders`).
 *
 * Two-phase read/write per target principal, same pattern as `task-consumer.ts` and the
 * established `application/task/reaper.ts` precedent: `action_requests` RLS is workspace-only, so
 * the first read uses `event.actionRequestId` itself as a syntactically-valid, otherwise-inert
 * `principalId` placeholder; every write below re-opens `withWorkspace` scoped to the real target
 * principal, which `chats`/`chat_messages`/`pending_context_items` RLS all require.
 *
 * `pendingApprovals` context injection (`get_entry_context`) is requester-side only — an entry
 * Handle can never call `approve`/`reject` itself (I11: Handle-channel Approval is a "永不允许存在的
 * 关系", §5.3 item 9), so a holder's own next-turn context has nothing useful to say about an
 * ActionRequest they can only act on through the web queue; only the requester (who is "blocked
 * on" someone else's decision) gets a `pending_context_items` row here (assumption — see PR body
 * "假设与偏离").
 */

type ActionRequestEventType = 'ActionRequestPending' | 'ActionRequestUpdated';

/**
 * Single *generic* `subscribe<T>` (not two non-generic overloads) — same shape, same reason, as
 * `application/task/reaper.ts`'s own `ActionRequestEventSource` (that module's doc comment has the
 * full explanation) and `application/linkage/index.ts`'s `LinkageEventSource`: a generic method is
 * what stays structurally assignable both *from* a real `OutboxDispatcher`'s own generic
 * `subscribe<T>` and *from* this module's `LinkageEventSource`, which is exactly how this
 * interface is actually used (`registerLinkageConsumers` passes a `LinkageEventSource` in, never
 * an `OutboxDispatcher` directly).
 */
export interface ActionRequestEventSource {
  subscribe<T extends ActionRequestEventType>(
    eventType: T,
    consumer: (
      event: Extract<DomainEvent, { type: T }>,
      meta: OutboxDeliveryMeta,
    ) => Promise<void> | void,
  ): () => void;
}

/** Statuses worth narrating to a human on an already-`pending_approval`-notified ActionRequest —
 *  `proposed`/`policy_evaluated`/`pending_approval` are never independently observable here
 *  (governance/approval/request-action.ts inserts straight to a resolved status in one INSERT, per
 *  its own doc comment) and `executing`/`verified` are internal plumbing, not outcomes (assumption
 *  — see PR body "假设与偏离"). */
const NOTABLE_UPDATE_STATUSES: ReadonlySet<ActionRequestStatus> = new Set([
  'auto_approved',
  'approved',
  'rejected',
  'expired',
  'denied',
  'executed',
  'failed',
  'compensated',
]);

async function writeActionMessage(
  deps: LinkageDeps,
  workspaceId: string,
  principalId: string,
  content: SystemMessageContent,
  contextItem: { readonly subjectId: string; readonly sourceOutboxId: string } | undefined,
): Promise<void> {
  await withWorkspace(deps.pool, { workspaceId, principalId }, async (client) => {
    const chat = await resolveDefaultChat(client, workspaceId, principalId);
    const message = await insertChatMessage(client, workspaceId, {
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
    if (contextItem) {
      await insertPendingContextItem(client, workspaceId, {
        principalId,
        kind: 'action_request_update',
        subjectId: contextItem.subjectId,
        payload: content as unknown as Record<string, unknown>,
        sourceOutboxId: contextItem.sourceOutboxId,
      });
    }
  });
}

/** Registers both consumers on `dispatcher`. Returns a combined unsubscribe function. */
export function registerActionRequestConsumers(
  dispatcher: ActionRequestEventSource,
  deps: LinkageDeps,
): () => void {
  const seenPendingOutboxIds = new Set<string>();
  const seenUpdatedOutboxIds = new Set<string>();

  const unsubscribePending = dispatcher.subscribe('ActionRequestPending', async (event, meta) => {
    if (seenPendingOutboxIds.has(meta.outboxId)) return;
    seenPendingOutboxIds.add(meta.outboxId);

    const actionRequest = await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: event.actionRequestId },
      (client) => getActionRequest(client, event.workspaceId, event.actionRequestId),
    );
    if (!actionRequest) return;

    const holderIds = new Set(event.holderPrincipalIds);
    const targets = new Set([...holderIds, actionRequest.onBehalfOf]);

    for (const principalId of targets) {
      const isHolder = holderIds.has(principalId);

      publishPrincipalPushEvent(principalId, {
        type: 'action.pending',
        actionRequestId: event.actionRequestId,
        gatekeeperId: event.gatekeeperId,
        title: `Approval needed: ${event.actionKind}`,
        description: event.resourceScope
          ? `${event.actionKind} on ${event.resourceScope} (via ${event.gatekeeperId})`
          : `${event.actionKind} (via ${event.gatekeeperId})`,
        actionKind: {
          tag: event.actionKind,
          label: event.actionKind.replace(/[._-]+/g, ' ').trim(),
        },
        awaitDecision: actionRequest.awaitDecision,
      });

      const content = buildActionPendingContent({
        actionRequestId: event.actionRequestId,
        gatekeeperId: event.gatekeeperId,
        actionKind: event.actionKind,
        resourceScope: event.resourceScope,
        blastRadius: actionRequest.blastRadius,
        awaitDecision: actionRequest.awaitDecision,
        isHolder,
      });
      await writeActionMessage(
        deps,
        event.workspaceId,
        principalId,
        content,
        isHolder ? undefined : { subjectId: event.actionRequestId, sourceOutboxId: meta.outboxId },
      );
    }
  });

  const unsubscribeUpdated = dispatcher.subscribe('ActionRequestUpdated', async (event, meta) => {
    if (seenUpdatedOutboxIds.has(meta.outboxId)) return;
    seenUpdatedOutboxIds.add(meta.outboxId);
    if (!NOTABLE_UPDATE_STATUSES.has(event.status)) return;

    const actionRequest = await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: event.actionRequestId },
      (client) => getActionRequest(client, event.workspaceId, event.actionRequestId),
    );
    if (!actionRequest) return;

    const holderIds = new Set(
      await withWorkspace(
        deps.pool,
        { workspaceId: event.workspaceId, principalId: event.actionRequestId },
        (client) =>
          computeActionRequestHolders(client, event.workspaceId, {
            actionKind: actionRequest.actionKind,
            resourceScope: actionRequest.resourceScope,
          }),
      ),
    );
    const targets = new Set([...holderIds, actionRequest.onBehalfOf]);

    for (const principalId of targets) {
      const isHolder = holderIds.has(principalId);

      publishPrincipalPushEvent(principalId, {
        type: 'action.updated',
        actionRequestId: event.actionRequestId,
        status: event.status,
      });

      const content = buildActionUpdateContent({
        actionRequestId: event.actionRequestId,
        actionKind: actionRequest.actionKind,
        status: event.status,
        isHolder,
      });
      await writeActionMessage(
        deps,
        event.workspaceId,
        principalId,
        content,
        isHolder ? undefined : { subjectId: event.actionRequestId, sourceOutboxId: meta.outboxId },
      );
    }
  });

  return () => {
    unsubscribePending();
    unsubscribeUpdated();
  };
}
