import type { PoolClient } from 'pg';
import type { ChatRow } from '../chat/index.js';
import { listChats, newChat, requireChatAccess } from '../chat/index.js';

/**
 * application/linkage/chat-targets: "which Chat does this system message go into" — the two rules
 * `application/linkage`'s consumers need (docs/development-tasks.md S2.11 deliverable 1: "a system
 * message into the on_behalf_of user's Chat that generated the Task (find the chat via the Task's
 * originating Turn)"; "into each holder's most recent (or a new) Chat").
 *
 * Reads `activities.chat_id` directly with parameterized SQL rather than adding a new
 * `substrate/epistemic` read method — the same precedent `application/host-bridge/
 * turn-attribution.ts`'s own doc comment documents ("`activities` is owned by `core`... this file
 * reads it directly... matching the existing precedent") and `application/chat/service.ts`'s own
 * `findRunningTurn` already establishes for this exact table.
 */

/** The most recently created Chat `principalId` owns, or a newly created one if they have none
 *  yet. Used both as the ActionRequest-holder target and as the Task-chat fallback below. */
export async function resolveDefaultChat(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<ChatRow> {
  const chats = await listChats(client, workspaceId, principalId); // ordered created_at desc
  const mostRecent = chats[0];
  if (mostRecent) return mostRecent;
  return newChat(client, workspaceId, principalId, {});
}

/**
 * The Chat a Task "belongs to" for chat-linkage purposes: the Chat of the Turn that invoked it
 * (`tasks.created_by_activity_id → activities.chat_id`), falling back to `resolveDefaultChat` when
 * the Task carries no Turn attribution (e.g. invoked from the human channel with no running Turn —
 * `invoke.ts`'s own doc comment on when that column is null).
 *
 * Caller contract: `client`'s transaction must already be scoped to `onBehalfOf` (i.e. opened via
 * `withWorkspace(pool, {workspaceId, principalId: onBehalfOf}, ...)`) — both `activities` and
 * `chats` RLS require it to see the row at all.
 */
export async function resolveTaskChat(
  client: PoolClient,
  workspaceId: string,
  task: { readonly onBehalfOf: string; readonly createdByActivityId: string | null },
): Promise<ChatRow> {
  if (task.createdByActivityId) {
    const result = await client.query<{ chat_id: string | null }>(
      'select chat_id from activities where workspace_id = $1 and id = $2',
      [workspaceId, task.createdByActivityId],
    );
    const chatId = result.rows[0]?.chat_id;
    if (chatId) return requireChatAccess(client, workspaceId, chatId);
  }
  return resolveDefaultChat(client, workspaceId, task.onBehalfOf);
}
