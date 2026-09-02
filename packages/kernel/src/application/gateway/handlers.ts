import type { PoolClient } from 'pg';
import {
  type ChatMessageRow,
  chatMessageText,
  currentPrincipalId,
  findRunningTurn,
  getChatHistory,
  listChats,
  newChat,
  requireChatAccess,
  sendChatMessage,
} from '../../application/chat/index.js';
import type { AgentRuntime } from '../../application/host-bridge/index.js';
import type { AuditQueryFilter } from '../../substrate/audit/index.js';
import { queryAudit, reconstruct } from '../../substrate/audit/index.js';
import { explainByNodeId } from '../../substrate/epistemic/index.js';
import type { SearchInput, TraverseInput } from '../../substrate/graph/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';

/**
 * application/gateway/handlers: the real handlers wired for the S1.3 capability set (`get_object`
 * / `traverse` / `search` / `state_at` / `explain` / `audit_query` / `reconstruct` —
 * docs/development-tasks.md S1.3, item 3) plus the S1.4 chat set (`list_chats` / `new_chat` /
 * `send_chat_message` / `stop_agent` / `get_chat_history` / `subscribe_chat`) and the S1.4
 * entry-agent bootstrap/write-back pair (`get_entry_context` / `report_turn`,
 * docs/development-tasks.md S1.4 deliverables 2 and 6). Every other registry capability has no
 * entry in `CAPABILITY_HANDLERS` and falls through to dispatch.ts's `CapabilityNotImplementedError`
 * (HTTP 501).
 *
 * Each handler receives an already-open `PoolClient` inside dispatch.ts's `withWorkspace()`
 * transaction (the same one `writeAudit` appends to — I11) and already-`paramsSchema`-validated
 * params (`unknown` here only because `Capability.paramsSchema` is `z.ZodType`, not a per-name
 * generic — dispatch.ts is what ties a name to its schema before calling in).
 *
 * Caller identity for the chat handlers below: `CapabilityHandler`'s signature is `(client,
 * workspaceId, params)` — dispatch.ts already knows the caller's `on_behalf_of` (it is exactly
 * what `withWorkspace()` scoped this transaction's RLS session variables to) but this task's
 * ownership only permits *adding* to this file, not changing dispatch.ts's handler signature —
 * see application/chat/service.ts's `currentPrincipalId` doc comment for how it is recovered
 * instead (reading back the `app.principal_id` session variable, the same value RLS itself reads).
 *
 * `stop_agent` and the `AgentRuntime`: this handler needs to call `AgentRuntime.stopTurn`, but an
 * `AgentRuntime` instance is constructed at composition-root time (packages/kernel/src/index.ts),
 * not available to a capability handler any other way — `setAgentRuntimeForHandlers` below is the
 * seam the composition root uses to wire it in, once, at startup (the same "module-level singleton
 * set once by the composition root" shape this file already uses for `graphStore`). A handler
 * invoked before that call (e.g. a unit test exercising `dispatchCapability` directly with no
 * runtime wired) simply finds no runtime to call `stopTurn` on, which is a safe no-op — there is
 * nothing to stop from that test's point of view anyway.
 */

export interface CapabilityHandlerResult {
  readonly result: unknown;
  readonly resourceType?: string;
  readonly resourceId?: string;
}

export type CapabilityHandler = (
  client: PoolClient,
  workspaceId: string,
  params: unknown,
) => Promise<CapabilityHandlerResult>;

const graphStore = new SqlGraphStore();

const getObjectHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { objectId } = params as { objectId: string };
  const result = await graphStore.getObject(client, workspaceId, objectId);
  return { result, resourceType: 'object', resourceId: objectId };
};

const traverseHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const input = params as TraverseInput;
  const result = await graphStore.traverse(client, workspaceId, input);
  return { result, resourceType: 'object', resourceId: input.fromId };
};

const searchHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const input = params as SearchInput;
  const result = await graphStore.search(client, workspaceId, input);
  return { result };
};

const stateAtHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { objectId, at } = params as { objectId: string; at: string };
  const result = await graphStore.stateAt(client, workspaceId, { objectId, at: new Date(at) });
  return { result, resourceType: 'object', resourceId: objectId };
};

const explainHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { nodeId } = params as { nodeId: string };
  const result = await explainByNodeId(client, workspaceId, nodeId);
  return { result, resourceType: result.nodeType, resourceId: nodeId };
};

/** Picks the recognized `AuditQueryFilter` fields out of the capability's opaque `jsonRecord`. */
function toAuditQueryFilter(filter: Record<string, unknown> | undefined): AuditQueryFilter {
  if (!filter) return {};
  const result: { -readonly [K in keyof AuditQueryFilter]?: AuditQueryFilter[K] } = {};
  if (typeof filter.actorPrincipalId === 'string')
    result.actorPrincipalId = filter.actorPrincipalId;
  if (typeof filter.action === 'string') result.action = filter.action;
  if (typeof filter.resourceType === 'string') result.resourceType = filter.resourceType;
  if (typeof filter.resourceId === 'string') result.resourceId = filter.resourceId;
  if (typeof filter.limit === 'number') result.limit = filter.limit;
  return result;
}

const auditQueryHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { filter } = params as { filter?: Record<string, unknown> };
  const result = await queryAudit(client, workspaceId, toAuditQueryFilter(filter));
  return { result };
};

const reconstructHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { entityId } = params as { entityId: string };
  const result = await reconstruct(client, workspaceId, { objectId: entityId });
  return { result, resourceType: 'object', resourceId: entityId };
};

// -------------------------------------------------------------------------------------------
// S1.4 chat handlers (docs/development-tasks.md S1.4 deliverable 2). Wired for
// `list_chats`/`new_chat`/`send_chat_message`/`stop_agent`/`get_chat_history`/`subscribe_chat` —
// every one of these is HTTP-reachable through this same `CAPABILITY_HANDLERS` map
// (`POST /api/cap/<name>`); `interfaces/ws` additionally reaches every one of them through
// `dispatchCapability` directly for the WS transport (§9.4).
// -------------------------------------------------------------------------------------------

/** See this file's module doc comment: the seam `packages/kernel/src/index.ts` (composition root)
 *  uses to wire in the real `AgentRuntime` after constructing it. */
let agentRuntime: AgentRuntime | undefined;

export function setAgentRuntimeForHandlers(runtime: AgentRuntime): void {
  agentRuntime = runtime;
}

const listChatsHandler: CapabilityHandler = async (client, workspaceId) => {
  const principalId = await currentPrincipalId(client);
  const result = await listChats(client, workspaceId, principalId);
  return { result };
};

const newChatHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { title } = params as { title?: string };
  const principalId = await currentPrincipalId(client);
  const chat = await newChat(client, workspaceId, principalId, { title });
  return { result: chat, resourceType: 'chat', resourceId: chat.id };
};

const sendChatMessageHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { chatId, text } = params as { chatId: string; text: string };
  const principalId = await currentPrincipalId(client);
  const { message, turnId } = await sendChatMessage(client, workspaceId, principalId, {
    chatId,
    text,
  });
  return {
    result: { messageId: message.id, sequence: message.sequence, turnId },
    resourceType: 'chat',
    resourceId: chatId,
  };
};

const stopAgentHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { chatId } = params as { chatId: string };
  await requireChatAccess(client, workspaceId, chatId);
  const running = await findRunningTurn(client, workspaceId, chatId);
  if (running) {
    // Fire-and-acknowledge: the actual end-of-turn (status='interrupted') is reported back
    // asynchronously through the AgentRuntimeEventSink, same as any other turnEnded — see
    // application/chat/event-sink.ts. A handler with no runtime wired (e.g. a unit test) simply
    // has nothing to signal, which is a safe no-op (see this file's module doc comment).
    await agentRuntime?.stopTurn(running.id);
  }
  return { result: { stopped: running !== null }, resourceType: 'chat', resourceId: chatId };
};

/** The wire shape `get_chat_history` returns, and what `interfaces/ws/server.ts`'s
 *  `subscribe_chat` replay reuses this same capability call for (see that file's own
 *  `ChatHistoryResult` type, kept in sync with this one by hand — both are narrow, local read-side
 *  types, not a shared exported contract). */
function toWireChatMessage(message: ChatMessageRow) {
  return {
    id: message.id,
    role: message.role,
    text: chatMessageText(message.content),
    createdAt: message.createdAt.toISOString(),
    sequence: message.sequence,
  };
}

const getChatHistoryHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { chatId, cursor, limit } = params as {
    chatId: string;
    cursor?: string;
    limit?: number;
  };
  const page = await getChatHistory(client, workspaceId, { chatId, cursor, limit });
  const result =
    page.nextCursor === undefined
      ? { messages: page.messages.map(toWireChatMessage) }
      : { messages: page.messages.map(toWireChatMessage), nextCursor: page.nextCursor };
  return { result, resourceType: 'chat', resourceId: chatId };
};

/** `subscribe_chat` is the one WS-only capability (§9.4) — this handler is the "no-op access-check
 *  handler" docs/development-tasks.md S1.4 deliverable 4 calls for: it exists purely so
 *  `dispatchCapability` has something to authorize against and audit; the actual socket
 *  registration and history replay are interfaces/ws/server.ts's job, run *after* this handler's
 *  transaction has already committed. */
const subscribeChatHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { chatId } = params as { chatId: string };
  await requireChatAccess(client, workspaceId, chatId);
  return { result: { subscribed: true }, resourceType: 'chat', resourceId: chatId };
};

// -------------------------------------------------------------------------------------------
// S1.4 entry-agent handlers (docs/development-tasks.md S1.4 deliverable 6). Both are
// Handle-channel — the S1.3 authorization (`authorizeCapabilityCall`, this module's caller) has
// already narrowed by the Handle's own scope by the time either handler runs.
// -------------------------------------------------------------------------------------------

/** S1 scope (design doc §7.4 `context` injection row): pending approvals and running tasks are
 *  always empty — governance/approval and application/task do not exist yet (S2). `facts` is the
 *  one real piece of context S1 can offer: `GraphStore.listRecentFacts` (an S1.4 additive method,
 *  see substrate/graph/store.ts's own doc comment on it), capped at its default limit. */
const getEntryContextHandler: CapabilityHandler = async (client, workspaceId) => {
  const facts = await graphStore.listRecentFacts(client, workspaceId);
  return {
    result: { pendingApprovals: [], tasks: [], facts, precedents: [] },
  };
};

export class TurnNotFoundError extends Error {
  constructor(workspaceId: string, turnId: string) {
    super(`Turn not found: workspace ${workspaceId}, id ${turnId}`);
    this.name = 'TurnNotFoundError';
  }
}

/**
 * §7.2 "扩展每轮把 turn_id 写入会话条目...回传 Turn 结果". Ends the Turn Activity (idempotent — a
 * second `report_turn` for an already-ended Turn re-merges the same metadata rather than erroring,
 * matching entry.ts's own retry-tolerant `agent_settled` handler) and records `summary`/
 * `decisions` in `activities.metadata`. Written as a direct parameterized query rather than
 * extending `substrate/epistemic/activities.ts`'s `endActivity` — this task's ownership permits
 * adding to gateway/handlers.ts but not modifying substrate/epistemic (unlike substrate/graph,
 * which has an explicit carve-out for a small additive method); see the PR body "假设与偏离".
 * Visibility/ownership is enforced by `activities`' own RLS policy (`activities_visibility`,
 * migrations/core/0003_chat.sql) — a `turnId` outside the caller's own chats simply matches no
 * row, indistinguishable from a nonexistent one, same masking convention as
 * application/chat/service.ts's `requireChatAccess`.
 */
const reportTurnHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { turnId, summary, decisions } = params as {
    turnId: string;
    summary: string;
    decisions?: string[];
  };
  const metadataPatch: Record<string, unknown> = { summary };
  if (decisions !== undefined) metadataPatch.decisions = decisions;

  const result = await client.query<{ id: string; status: string }>(
    `update activities
     set status = case when status = 'running' then 'completed' else status end,
         ended_at = coalesce(ended_at, now()),
         metadata = metadata || $3::jsonb
     where workspace_id = $1 and id = $2 and kind = 'agent_turn'
     returning id, status`,
    [workspaceId, turnId, JSON.stringify(metadataPatch)],
  );
  const row = result.rows[0];
  if (!row) throw new TurnNotFoundError(workspaceId, turnId);

  return {
    result: { turnId: row.id, status: row.status },
    resourceType: 'activity',
    resourceId: turnId,
  };
};

/** capability name → handler, for every S1.3-wired capability. */
export const CAPABILITY_HANDLERS: ReadonlyMap<string, CapabilityHandler> = new Map([
  ['get_object', getObjectHandler],
  ['traverse', traverseHandler],
  ['search', searchHandler],
  ['state_at', stateAtHandler],
  ['explain', explainHandler],
  ['audit_query', auditQueryHandler],
  ['reconstruct', reconstructHandler],
  ['list_chats', listChatsHandler],
  ['new_chat', newChatHandler],
  ['send_chat_message', sendChatMessageHandler],
  ['stop_agent', stopAgentHandler],
  ['get_chat_history', getChatHistoryHandler],
  ['subscribe_chat', subscribeChatHandler],
  ['get_entry_context', getEntryContextHandler],
  ['report_turn', reportTurnHandler],
]);
