import type { HandleClaims, Role, WorkerDefinitionKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type ChatMessageRow,
  chatMessageKind,
  chatMessageText,
  currentPrincipalId,
  endUnknownRuntimeTurn,
  findRunningTurn,
  getChatHistory,
  listChats,
  newChat,
  requireChatAccess,
  sendChatMessage,
} from '../../application/chat/index.js';
import type { AgentRuntime } from '../../application/host-bridge/index.js';
import { findAttributableTurn } from '../../application/host-bridge/index.js';
import { drainPendingContextItems } from '../../application/linkage/index.js';
import {
  type InvokeWorkerInput,
  type InvokeWorkerResult,
  type TaskRow,
  type WorkerRunRow,
  findOperations,
  findProcedures,
  findWorkers,
  getConfiguredTaskRuntime,
  getTaskWithWorkerRuns,
  invokeWorkerCreate,
  listQuotas,
  listTasksForPrincipal,
  resolveParentAuthority,
  resolveWaitTimeoutMs,
  setQuotaValue,
  terminateTask,
  waitForOutcome,
} from '../../application/task/index.js';
import {
  type WorkerDefinitionRow,
  deprecateWorkerDefinition,
  listWorkerDefinitions,
  proposeWorkerDefinition,
  publishWorkerDefinition,
} from '../../application/worker/index.js';
import { readAgentProfile } from '../../governance/agent-profile/index.js';
import {
  ActionRequestNotFoundError,
  approveActionRequest,
  getActionRequest,
  listPendingForApprover,
  rejectActionRequest,
} from '../../governance/approval/index.js';
import {
  grantCapability,
  hasAnyActiveGrant,
  listGrants,
  revokeCapabilityGrant,
} from '../../governance/capability/index.js';
import {
  listPolicies,
  parseSetPolicyPayload,
  setAutoApprovedActionKind,
  setPolicy,
} from '../../governance/policy/index.js';
import type { AuditQueryFilter } from '../../substrate/audit/index.js';
import { queryAudit, reconstruct } from '../../substrate/audit/index.js';
import { explainByNodeId } from '../../substrate/epistemic/index.js';
import type { SearchInput, TraverseInput } from '../../substrate/graph/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { toWireActionRequest } from './action-request-wire.js';
import {
  getAgentPolicyHandler,
  getAgentProfileHandler,
  setAgentPolicyHandler,
  setAgentProfileHandler,
} from './agent-profile-handlers.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import {
  connectGatekeeperHandler,
  createConnectionHandler,
  listConnectionRequestsHandler,
  requestConnectionHandler,
} from './connection-handlers.js';
import { assertFactHandler, invalidateFactHandler, supersedeFactHandler } from './fact-handlers.js';
import {
  causalChainHandler,
  decisionImpactHandler,
  findPrecedentsHandler,
  listConflictsHandler,
  queryDecisionsHandler,
  resolveConflictHandler,
  verifyFactHandler,
} from './epistemic-handlers.js';
import {
  getGatekeeperHandler,
  getOperationStatsHandler,
  listGatekeepersHandler,
  listOperationsHandler,
} from './gatekeeper-read-handlers.js';
import { registerSourceHandler, submitObservationsHandler } from './ingest-handlers.js';
import {
  createPrincipalHandler,
  disablePrincipalHandler,
  getWorkspaceHandler,
  listPrincipalsHandler,
  rotateApiKeyHandler,
  setPrincipalRoleHandler,
} from './members-handlers.js';
import { listModelsHandler } from './models-catalog-handler.js';
import {
  getTypeHandler,
  listTypesHandler,
  proposeOntologyChangeHandler,
  publishOntologyVersionHandler,
  validateHandler,
} from './ontology-handlers.js';
import {
  deprecateOperationHandler,
  proposeOperationHandler,
  publishManifestHandler,
  publishOperationHandler,
} from './operation-manifest-handlers.js';
import { observeOperationHandler, requestActionHandler } from './request-action-handler.js';
import {
  toWireAuditRecord,
  toWireChat,
  toWireFact,
  toWireGrant,
  toWireObject,
  toWirePolicy,
  toWireQuota,
} from './resource-wire.js';
import {
  deprecateProcedureHandler,
  deprecateSkillHandler,
  listProceduresHandler,
  listSkillsHandler,
  proposeProcedureHandler,
  proposeSkillHandler,
  publishProcedureHandler,
  publishSkillHandler,
} from './skill-procedure-handlers.js';
import { listAllowedOperationsHandler, reportTaskResultHandler } from './worker-result-handler.js';

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

export type {
  CapabilityHandler,
  CapabilityHandlerContext,
  CapabilityHandlerResult,
} from './capability-handler.js';

const graphStore = new SqlGraphStore();

const getObjectHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { objectId } = params as { objectId: string };
  const object = await graphStore.getObject(client, workspaceId, objectId);
  return {
    result: object ? toWireObject(object) : null,
    resourceType: 'object',
    resourceId: objectId,
  };
};

const traverseHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const input = params as TraverseInput;
  const result = await graphStore.traverse(client, workspaceId, input);
  return { result, resourceType: 'object', resourceId: input.fromId };
};

// S3.7 wire fix (see PR body): previously a bare `GraphObject[]` — docs/wire-contract-
// conventions.md §3 "不返回裸数组".
const searchHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const input = params as SearchInput;
  const objects = await graphStore.search(client, workspaceId, input);
  return { result: { items: objects.map(toWireObject) } };
};

const stateAtHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { objectId, at } = params as { objectId: string; at: string };
  const state = await graphStore.stateAt(client, workspaceId, { objectId, at: new Date(at) });
  return {
    result: {
      object: state.object ? toWireObject(state.object) : null,
      facts: state.facts.map(toWireFact),
    },
    resourceType: 'object',
    resourceId: objectId,
  };
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

// S3.7 wire fix (see PR body): previously a bare `AuditRecordRow[]` — §3 "不返回裸数组".
const auditQueryHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { filter } = params as { filter?: Record<string, unknown> };
  const rows = await queryAudit(client, workspaceId, toAuditQueryFilter(filter));
  return { result: { items: rows.map(toWireAuditRecord) } };
};

const reconstructHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { entityId } = params as { entityId: string };
  const result = await reconstruct(client, workspaceId, { objectId: entityId });
  return {
    result: {
      object: result.object ? toWireObject(result.object) : null,
      facts: result.facts.map(toWireFact),
      auditRecords: result.auditRecords.map(toWireAuditRecord),
    },
    resourceType: 'object',
    resourceId: entityId,
  };
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
  const rows = await listChats(client, workspaceId, principalId);
  return { result: { items: rows.map(toWireChat) } };
};

const newChatHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { title } = params as { title?: string };
  const principalId = await currentPrincipalId(client);
  const chat = await newChat(client, workspaceId, principalId, { title });
  return { result: toWireChat(chat), resourceType: 'chat', resourceId: chat.id };
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
    //
    // lane-4 hookup (`application/chat/turn-recovery.ts`'s own doc comment): `stopTurn` returning
    // exactly `false` (not `void`/`undefined` — see `AgentRuntime.stopTurn`'s own contract) means
    // the runtime has no record of this Turn at all (e.g. a kernel/agent-host restart abandoned
    // it before this call) and will never independently emit the `turnEnded` that would otherwise
    // end it — end it here instead, so the Chat is not wedged behind
    // `activities_one_running_turn_per_chat_uidx` forever.
    const runtimeKnowsTurn = await agentRuntime?.stopTurn(running.id);
    if (runtimeKnowsTurn === false) {
      await endUnknownRuntimeTurn(client, workspaceId, chatId, running.id);
    }
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
    // S2.12 host run: a `system.*` card (application/linkage/content.ts — `kind`, `actionRequestId`,
    // `taskId`, …) collapsed to its `text` here, so nothing reading history could tell a card from
    // prose or re-render it after a reload; the live `chat.message` push already carries the full
    // content (application/chat/event-sink.ts). Additive — `text` stays as-is for every client.
    content: message.content,
    // Review fix (code-review finding "chat.message payload drift"): previously omitted here —
    // every live `chat.message` push already carried this for a system message
    // (application/linkage's two push call sites), but a client loading the same row through
    // `get_chat_history`/`subscribe_chat` replay (this function) never saw it, so a system card
    // rendered live would silently stop rendering after a reload. `chatMessageKind` derives it the
    // same way those push call sites already do — `undefined` for every ordinary user/assistant/
    // tool message, unchanged.
    kind: chatMessageKind(message.content),
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
      ? { items: page.messages.map(toWireChatMessage) }
      : { items: page.messages.map(toWireChatMessage), nextCursor: page.nextCursor };
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

/**
 * S1 scope was: pending approvals and running tasks always empty, `facts` the one real piece of
 * context (`GraphStore.listRecentFacts`). S2.11 addition (design doc §7.4 `context` injection row,
 * §8.2 "用户下一次发言时，context 事件把 Task 结果注入"; docs/development-tasks.md S2.11 deliverable 3):
 * `tasks`/`pendingApprovals` are now populated from `application/linkage`'s
 * `drainPendingContextItems` — every undelivered Task outcome, budget warning (≥80%), or
 * `waiting_approval` notice for this principal (`tasks` bucket), and every undelivered ActionRequest
 * status change this principal is the requester of (`pendingApprovals` bucket) — marked delivered
 * in the same call so nothing repeats on the next Turn (`application/linkage/store.ts`'s own doc
 * comment has the full "why a table, not a column" rationale). `precedents` remains S3 scope (no
 * Procedure/Skill graph content exists yet to precedent-match against).
 *
 * Field names deliberately unchanged from the S1 stub (`tasks`/`pendingApprovals`, not new keys) —
 * `packages/platform-extension/src/modes/entry.ts`'s `EntryContextResult`/`renderSection` already
 * render any JSON-shaped array under these two keys generically; inventing new top-level keys would
 * need a platform-extension change, which is out of this task's ownership (S2.9's area).
 */
const getEntryContextHandler: CapabilityHandler = async (client, workspaceId) => {
  const principalId = await currentPrincipalId(client);
  const [facts, drained] = await Promise.all([
    graphStore.listRecentFacts(client, workspaceId),
    drainPendingContextItems(client, workspaceId, principalId),
  ]);
  return {
    result: {
      pendingApprovals: drained.pendingApprovals,
      tasks: drained.tasks,
      facts: facts.map(toWireFact),
      precedents: [],
    },
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

/** Thrown by `record_decision` when the caller has no currently-`running` Turn to attribute the
 *  Decision to (`findAttributableTurn`'s recency-window fallback is deliberately *not* accepted
 *  here — see `recordDecisionHandler`'s own doc comment for why). Not mapped in interfaces/ws/
 *  rpc.ts or interfaces/http/capability-route.ts (falls through to a generic 500/INTERNAL_ERROR),
 *  matching this same handler group's existing `TurnNotFoundError` above, which has never had a
 *  dedicated mapping either. */
export class NoActiveTurnError extends Error {
  constructor() {
    super('record_decision: no currently-running Turn to attribute this Decision to');
    this.name = 'NoActiveTurnError';
  }
}

/**
 * `record_decision` (design doc §5.2 `Turn --generated--> Decision`; docs/development-tasks.md
 * S2.11 deliverable 4). `decisions.activity_id` *is* the edge — the same relational-FK-as-edge
 * convention `tasks.created_by_activity_id` already uses for `Turn --generated--> Task`
 * (`invokeWorkerHandler`'s own doc comment has the parallel reasoning), not a `links` row: neither
 * a Turn nor a Decision is a graph Object (`objects`/`links`' `source_object_id`/`target_object_id`
 * are `objects` FKs — migrations/core/0002_substrate.sql — and no ontology YAML in this repo
 * projects either one as one), so there is no `generated` LinkType to add anywhere today; if a
 * future task ever projects Turn/Decision as graph Objects, that YAML addition belongs with that
 * projection work, not here.
 *
 * Only `wasRunning === true` is accepted (mirrors `invokeWorkerHandler`'s identical choice, same
 * reasoning: "generated" means *during*, not *shortly after*) — safe to require unconditionally
 * because `record_decision` is entry-only (`governance/capability/handles.ts`'s
 * `ENTRY_CEILING_EXTRA_CAPABILITY_NAMES`, not in `WORKER_CEILING_EXTRA_CAPABILITY_NAMES`), so every
 * legitimate caller already has a Turn in progress by construction.
 *
 * Starts `proposed` (`packages/shared`'s `DECISION_TRANSITIONS`) — `decided_by`/`decided_at` stay
 * null; nothing in this codebase transitions an entry-agent-recorded Decision onward yet (S2.3's
 * own Approval Decisions, `governance/approval/decide.ts`, are a separate, already-resolved write
 * path). `relatedFactIds`/`relatedTaskId` (the capability's own `paramsSchema`, `packages/shared/
 * src/capabilities.ts`) have no dedicated `decisions` columns — S2.3's own implementation notes
 * flag this exact gap ("关联语义...本任务不代为决定") without resolving it; stashed in the existing
 * free-form `rationale` jsonb here rather than a new migration column speculatively adding a query
 * shape nothing yet needs.
 */
const recordDecisionHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { summary, relatedFactIds, relatedTaskId } = params as {
    summary: string;
    relatedFactIds?: string[];
    relatedTaskId?: string;
  };
  const principalId = await currentPrincipalId(client);
  const attributedTurn = await findAttributableTurn(client, {
    workspaceId,
    principalId,
    at: new Date(),
  });
  if (!attributedTurn?.wasRunning) throw new NoActiveTurnError();

  const result = await client.query<{ id: string; status: string }>(
    `insert into decisions (workspace_id, status, activity_id, summary, rationale)
     values ($1, 'proposed', $2, $3, $4::jsonb)
     returning id, status`,
    [
      workspaceId,
      attributedTurn.id,
      summary,
      JSON.stringify({
        relatedFactIds: relatedFactIds ?? [],
        relatedTaskId: relatedTaskId ?? null,
      }),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('record_decision: INSERT ... RETURNING produced no row');

  return {
    result: { id: row.id, status: row.status, turnId: attributedTurn.id },
    resourceType: 'decision',
    resourceId: row.id,
  };
};

// -------------------------------------------------------------------------------------------
// S2.6 worker-definition-registry handlers (docs/development-tasks.md S2.6 deliverable 3). Date
// fields are projected to ISO strings for the wire, same convention as `toWireChatMessage` above.
// -------------------------------------------------------------------------------------------

function toWireWorkerDefinition(row: WorkerDefinitionRow) {
  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    status: row.status,
    definition: row.definition,
    proposedBy: row.proposedBy,
    publishedBy: row.publishedBy,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

const proposeWorkerDefinitionHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { definitionId, kind, definition } = params as {
    definitionId?: string;
    kind: WorkerDefinitionKind;
    definition: Record<string, unknown>;
  };
  const principalId = await currentPrincipalId(client);
  const row = await proposeWorkerDefinition(client, workspaceId, principalId, {
    definitionId,
    kind,
    definition,
  });
  return {
    result: toWireWorkerDefinition(row),
    resourceType: 'worker_definition',
    resourceId: row.id,
  };
};

const publishWorkerDefinitionHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { definitionId, version } = params as { definitionId: string; version: number };
  const principalId = await currentPrincipalId(client);
  const row = await publishWorkerDefinition(client, workspaceId, principalId, {
    definitionId,
    version,
  });
  return {
    result: toWireWorkerDefinition(row),
    resourceType: 'worker_definition',
    resourceId: row.id,
  };
};

const deprecateWorkerDefinitionHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { definitionId, version } = params as { definitionId: string; version: number };
  const row = await deprecateWorkerDefinition(client, workspaceId, { definitionId, version });
  return {
    result: toWireWorkerDefinition(row),
    resourceType: 'worker_definition',
    resourceId: row.id,
  };
};

const listWorkerDefinitionsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { kind } = params as { kind?: WorkerDefinitionKind };
  const rows = await listWorkerDefinitions(client, workspaceId, kind);
  return { result: { items: rows.map(toWireWorkerDefinition) } };
};

// -------------------------------------------------------------------------------------------
// S3.3: `assert_fact`/`supersede_fact`/`invalidate_fact` are now real handlers
// (`fact-handlers.ts`, imported above) — the I16 meta-ontology guard they apply is unchanged from
// the S2.6 stub this replaced (`meta-ontology-guard.ts`'s own doc comment still describes it).
// -------------------------------------------------------------------------------------------
// S2.2/S2.3 governance handlers (docs/development-tasks.md S2.2/S2.3). Every one of these is
// human-channel-only (packages/shared/src/capabilities.ts `channel: 'human'`) — `authorizeCapabilityCall`
// has already checked the caller's `role` against the capability's `minRole` before any of these
// run; `approve`/`reject`/`list_pending` additionally need the caller's *role value itself* (not
// just "does it satisfy minRole") for I14, which `currentPrincipalRole` below resolves the same
// way `currentPrincipalId` does (reading back the RLS session variable dispatch.ts already set),
// plus one lookup into `principals` for the `role` column.
//
// `request_action` (S2.4): wired via `requestActionHandler` (request-action-handler.ts) — its own
// module doc comment carries the full decision table; it is registered in `CAPABILITY_HANDLERS`
// below, alongside `propose_operation`/`publish_operation`/`deprecate_operation`.
// -------------------------------------------------------------------------------------------

async function currentPrincipalRole(
  client: PoolClient,
  workspaceId: string,
): Promise<{ id: string; role: Role }> {
  const principalId = await currentPrincipalId(client);
  const result = await client.query<{ role: Role }>(
    'select role from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const role = result.rows[0]?.role;
  if (!role) {
    throw new Error(
      `currentPrincipalRole: principal ${principalId} not found in workspace ${workspaceId}`,
    );
  }
  return { id: principalId, role };
}

const approveHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { actionRequestId } = params as { actionRequestId: string };
  const caller = await currentPrincipalRole(client, workspaceId);
  const result = await approveActionRequest(client, workspaceId, {
    actionRequestId,
    approverPrincipalId: caller.id,
    approverRole: caller.role,
  });
  return {
    result: toWireActionRequest(result),
    resourceType: 'action_request',
    resourceId: result.id,
  };
};

const rejectHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { actionRequestId, reason } = params as { actionRequestId: string; reason?: string };
  const caller = await currentPrincipalRole(client, workspaceId);
  const result = await rejectActionRequest(client, workspaceId, {
    actionRequestId,
    approverPrincipalId: caller.id,
    approverRole: caller.role,
    reason,
  });
  return {
    result: toWireActionRequest(result),
    resourceType: 'action_request',
    resourceId: result.id,
  };
};

/** `list_pending`: the caller's own I14-scoped queue (`governance/approval/reads.ts`'s
 *  `listPendingForApprover`). §3 envelope — `{items}`, never a bare array. */
const listPendingHandler: CapabilityHandler = async (client, workspaceId) => {
  const caller = await currentPrincipalRole(client, workspaceId);
  const rows = await listPendingForApprover(client, workspaceId, {
    principalId: caller.id,
    role: caller.role,
  });
  return { result: { items: rows.map(toWireActionRequest) } };
};

/** `get_action`: workspace-scoped read, not I14-narrowed (§9.3 "get_action returns one
 *  (workspace-scoped)") — any `operator`+ role may read any single ActionRequest by id. */
const getActionHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { actionRequestId } = params as { actionRequestId: string };
  const result = await getActionRequest(client, workspaceId, actionRequestId);
  if (!result) throw new ActionRequestNotFoundError(workspaceId, actionRequestId);
  return {
    result: toWireActionRequest(result),
    resourceType: 'action_request',
    resourceId: actionRequestId,
  };
};

/** "总是批准此类" — writes/upserts a workspace auto-approval rule for one action_kind (§9.3,
 *  design doc S2.10 card action). See `governance/policy/policies.ts`'s own doc comment for why
 *  the I8 high-blast-radius guard can only fire here when a prior `set_policy` call already
 *  recorded this action_kind's `blast_radius` (S2.6's graph-stored Operation metadata, the only
 *  other source of truth, does not exist yet). */
// Item 5 fix (review job 652a4abc lane2 P1: "operator flips I8 workspace signal for medium
// action_kind across all gates, no I14 scope check"): `minRole:'operator'` only gates *entry* to
// this capability (`authorize.ts`) — a non-owner operator must additionally hold an active grant
// covering `actionKind` (`hasAnyActiveGrant`, any `resourceScope`: this writes one workspace-wide
// rule, not a per-gate one, so the check cannot narrow to a single gate either — see that
// function's own doc comment). `owner` bypasses, the same "workspace owner counts as holding
// every scope" convention I14 already uses elsewhere.
const setAutoApprovedActionKindHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { actionKindTag } = params as { actionKindTag: string };
  const caller = await currentPrincipalRole(client, workspaceId);
  if (caller.role !== 'owner') {
    const covered = await hasAnyActiveGrant(client, workspaceId, {
      principalId: caller.id,
      resourceType: actionKindTag,
    });
    if (!covered) {
      throw new ForbiddenError(
        `set_auto_approved_action_kind: principal ${caller.id} holds no active grant for ` +
          `action_kind "${actionKindTag}" (I14)`,
      );
    }
  }
  const result = await setAutoApprovedActionKind(client, workspaceId, {
    actionKind: actionKindTag,
    setBy: caller.id,
  });
  return { result: toWirePolicy(result), resourceType: 'policy', resourceId: result.id };
};

const setPolicyHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { policy } = params as { policy: unknown };
  const payload = parseSetPolicyPayload(policy);
  const setBy = await currentPrincipalId(client);
  const result = await setPolicy(client, workspaceId, {
    actionKind: payload.actionKindTag,
    blastRadius: payload.blastRadius,
    autoApprove: payload.autoApprove,
    requesterCanApprove: payload.requesterCanApprove,
    setBy,
  });
  return { result: toWirePolicy(result), resourceType: 'policy', resourceId: result.id };
};

const grantCapabilityHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { principalId, resourceType, resourceId, scope } = params as {
    principalId: string;
    resourceType: string;
    resourceId?: string;
    scope?: Record<string, unknown>;
  };
  const grantedBy = await currentPrincipalId(client);
  const result = await grantCapability(client, workspaceId, {
    principalId,
    resourceType,
    resourceId,
    scope,
    grantedBy,
  });
  return { result: toWireGrant(result), resourceType: 'capability_grant', resourceId: result.id };
};

const revokeCapabilityHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { grantId } = params as { grantId: string };
  const result = await revokeCapabilityGrant(client, workspaceId, grantId);
  return { result: toWireGrant(result), resourceType: 'capability_grant', resourceId: result.id };
};

/** `list_grants` (S3.11, docs/development-tasks.md "中台控制面"): every CapabilityGrant, optionally
 *  narrowed to one Principal — `governance/capability/grants.ts`'s own wire shape (resourceType/
 *  resourceId/scope/status/expiresAt, already camelCase) already matches
 *  docs/wire-contract-conventions.md, so this is a direct `{items}` projection with no separate
 *  `toWireGrant` function needed (unlike ActionRequest's `toWireActionRequest`, which drops/renames
 *  fields — `CapabilityGrantRow` has nothing to drop). */
const listGrantsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { principalId } = params as { principalId?: string };
  const rows = await listGrants(client, workspaceId, { principalId });
  return { result: { items: rows.map(toWireGrant) } };
};

/** `list_policies` (S3.11) — every explicit `policies` row (`governance/policy/policies.ts`'s
 *  `PolicyRow`), projected through `toWirePolicy` (S3.7 wire fix — see resource-wire.ts's own
 *  module doc comment). */
const listPoliciesHandler: CapabilityHandler = async (client, workspaceId) => {
  const rows = await listPolicies(client, workspaceId);
  return { result: { items: rows.map(toWirePolicy) } };
};

/** `list_quotas` (S3.11) — every I18 quota key with its resolved value and whether that value is
 *  an explicit override or the compiled-in default (`application/task/quotas.ts`'s `QuotaListEntry`,
 *  already the wire shape this needs). */
const listQuotasHandler: CapabilityHandler = async (client, workspaceId) => {
  const rows = await listQuotas(client, workspaceId);
  return { result: { items: rows } };
};

// -------------------------------------------------------------------------------------------
// S2.7 task/find_* handlers (docs/development-tasks.md S2.7). `invoke_worker` deliberately never
// touches the `client` dispatch.ts hands it — see `application/task/invoke.ts`'s own module doc
// comment for why (it manages its own independently-committed transactions via the configured
// `TaskRuntimeDeps.pool`, so a freshly-minted WorkerRun Handle is usable the moment the Worker
// container can reach the kernel, not only after this whole capability call returns).
// `create_task` is deliberately **not** wired (see this section's own note below).
// -------------------------------------------------------------------------------------------

/**
 * §5.2 `Turn --generated--> Task` (docs/development-tasks.md S2.11 deliverable 4): resolves the
 * caller's currently-*running* Turn, if any, using `_client` — the one transaction
 * `dispatchCapability` (dispatch.ts) already has open for this whole handler call. Only
 * `wasRunning === true` counts — `findAttributableTurn`'s 5-minute recency fallback exists for
 * egress/llm-usage attribution (where "which Turn was this probably part of" is the right
 * question), but "generated" here means *during*, not *shortly after*: a Task invoked well after
 * its nearest Turn ended did not come from that Turn.
 *
 * **Two-phase (P1-4 fix, review job 652a4abc)**: phase 1 (still inside dispatch.ts's transaction)
 * only runs `invokeWorkerCreate` — the fast, no-network-wait half (resolve/validate the
 * WorkerDefinition, I18 quota checks, mint the child Handle, spawn the WorkerRun) — and returns
 * immediately. `input.wait:true`'s poll (`waitForOutcome`, up to `input.timeout ?? 90` seconds) is
 * deferred to `afterCommit`, run only once phase 1 has committed, holding no transaction of its
 * own across the wait — see `application/task/invoke.ts`'s own module doc comment for the full
 * "why holding dispatch.ts's transaction open across this wait was a real pool-exhaustion defect,
 * not just a missed optimization" rationale.
 */
/** `invoke_worker`'s wire shape: docs/wire-contract-conventions.md §2 (2026-09-08 decision) — a
 *  create-style capability's result is the created resource (the spawned Task) keyed `id`, never a
 *  top-level `taskId` duplicate; `workerRunId` stays as a `<resource>Id` reference to the sibling
 *  WorkerRun it also created. `InvokeWorkerResult` (application/task/invoke.ts) itself keeps its
 *  own `taskId` field name — it is an internal task-subsystem type read by many non-wire callers
 *  (the reaper, tests, `waitForOutcome`'s own recursion) — this is purely the projection at the
 *  capability boundary, same pattern as `toWireTask`/`toWireWorkerDefinition` below. */
function toWireInvokeWorkerResult(created: InvokeWorkerResult) {
  return {
    id: created.taskId,
    workerRunId: created.workerRunId,
    status: created.status,
    ...(created.result !== undefined ? { result: created.result } : {}),
    ...(created.failureReason !== undefined ? { failureReason: created.failureReason } : {}),
  };
}

const invokeWorkerHandler: CapabilityHandler = async (_client, workspaceId, params, ctx) => {
  const principalId = ctx?.principalId ?? '';
  const attributedTurn = principalId
    ? await findAttributableTurn(_client, { workspaceId, principalId, at: new Date() })
    : undefined;
  const turnId = attributedTurn?.wasRunning ? attributedTurn.id : undefined;
  const input = params as InvokeWorkerInput;

  const created = await invokeWorkerCreate(
    workspaceId,
    { principalId, channel: ctx?.channel ?? 'handle', claims: ctx?.claims, turnId },
    input,
    getConfiguredTaskRuntime(),
  );

  if (!input.wait) {
    return {
      result: toWireInvokeWorkerResult(created),
      resourceType: 'task',
      resourceId: created.taskId,
    };
  }

  return {
    result: toWireInvokeWorkerResult(created),
    resourceType: 'task',
    resourceId: created.taskId,
    afterCommit: () =>
      waitForOutcome(
        getConfiguredTaskRuntime(),
        workspaceId,
        principalId,
        created.taskId,
        created.workerRunId,
        { timeoutMs: resolveWaitTimeoutMs(input.timeout) },
      ).then(toWireInvokeWorkerResult),
  };
};

function toWireWorkerRun(row: {
  readonly id: string;
  readonly status: string;
  readonly containerId: string | null;
  readonly depth: number;
  readonly attempt: number;
  readonly startedAt: Date;
  readonly terminatedAt: Date | null;
}) {
  return {
    id: row.id,
    status: row.status,
    containerId: row.containerId,
    depth: row.depth,
    attempt: row.attempt,
    startedAt: row.startedAt.toISOString(),
    terminatedAt: row.terminatedAt ? row.terminatedAt.toISOString() : null,
  };
}

/** The wire shape one Task + its WorkerRuns projects to, shared by `get_task` and the S2.10
 *  addition `list_tasks` (one Task per array entry there, same per-Task shape). */
function toWireTask(task: TaskRow, workerRuns: readonly WorkerRunRow[]) {
  return {
    id: task.id,
    status: task.status,
    onBehalfOf: task.onBehalfOf,
    workerDefinitionId: task.workerDefinitionId,
    workerDefinitionVersion: task.workerDefinitionVersion,
    input: task.input,
    result: task.result,
    tokenBudget: task.tokenBudget,
    tokensUsed: task.tokensUsed,
    durationLimitSec: task.durationLimitSec,
    failureReason: task.failureReason,
    createdAt: task.createdAt.toISOString(),
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    failedAt: task.failedAt ? task.failedAt.toISOString() : null,
    cancelledAt: task.cancelledAt ? task.cancelledAt.toISOString() : null,
    workerRuns: workerRuns.map(toWireWorkerRun),
  };
}

const getTaskHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { taskId } = params as { taskId: string };
  const { task, workerRuns } = await getTaskWithWorkerRuns(client, workspaceId, taskId);
  return {
    result: toWireTask(task, workerRuns),
    resourceType: 'task',
    resourceId: task.id,
  };
};

/** `list_tasks` (S2.10 addition — see `packages/shared/src/capabilities.ts`'s registry entry and
 *  `application/task/service.ts`'s `listTasksForPrincipal` for why one had to be added and how it
 *  is scoped). Human-channel-only, so `currentPrincipalId` (same RLS-session-variable read every
 *  other human-channel handler in this file already uses) is the caller. */
const listTasksHandler: CapabilityHandler = async (client, workspaceId) => {
  const principalId = await currentPrincipalId(client);
  const rows = await listTasksForPrincipal(client, workspaceId, principalId);
  return { result: { items: rows.map(({ task, workerRuns }) => toWireTask(task, workerRuns)) } };
};

/** `create_task`: **not wired** (docs/development-tasks.md S2.7 "if the registry has it,
 *  implement as 'invoke without spawn'? — read its paramsSchema and decide; document"). Decision:
 *  `create_task`'s registered `paramsSchema` (`packages/shared/src/capabilities.ts`) is `{input:
 *  z.unknown()}` — it carries no `definitionId`/`version`, but `tasks.worker_definition_id`/
 *  `.worker_definition_version` are `not null` (migrations/task/0001_tasks.sql) and every other
 *  Task-creating path in this codebase (`invoke_worker`) always pins one at creation time (§5.5
 *  "Task 固定引用启动时版本"). There is no well-formed Task this handler could create from its own
 *  params alone without either fabricating a WorkerDefinition reference or loosening a column
 *  constraint that every other part of the system relies on staying `not null` — both are outside
 *  this task's ownership to decide unilaterally for a capability whose shape predates it. Left
 *  unwired (falls through to `CapabilityNotImplementedError`, HTTP 501) rather than guessed at;
 *  `invoke_worker(..., wait: false)` already covers "create a Task and don't wait for it" for
 *  every real caller today.
 */

const setQuotaHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { key, value } = params as { key: string; value: unknown };
  const updatedBy = await currentPrincipalId(client);
  const result = await setQuotaValue(client, workspaceId, { key, value, updatedBy });
  // No resourceId: `audit_records.resource_id` is a uuid column (migrations/core/0004_audit.sql)
  // and a quota key (`task.max_depth`) is not one — returning it here made every `set_quota` call
  // fail its audit INSERT with a 500 (found on the host, S2.7 apply). The key is already in the
  // audit payload's `params`.
  return { result: toWireQuota(result), resourceType: 'quota' };
};

/** S3.13 runtime consumer: `find_workers`/`invoke_worker` are `channel: 'handle'`-only
 *  (`capabilities.ts`'s own registry entries) — `ctx.principalId` is therefore always already
 *  `claims.obo` (`dispatch.ts`'s `callerContext`), the chain's originating human, never the
 *  immediate calling agent's own identity; a Worker→Worker call inherits the same principal
 *  unchanged, so no session-kind branching is needed here to make "the calling principal's own
 *  profile" mean the right thing in either case. */
const findWorkersHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { need } = params as { need: string };
  const parentAuthority = await resolveParentAuthority(client, workspaceId, {
    principalId: ctx?.principalId ?? '',
    channel: ctx?.channel ?? 'handle',
    claims: ctx?.claims,
  });
  const agentProfile = ctx?.principalId
    ? await readAgentProfile(client, workspaceId, ctx.principalId)
    : undefined;
  const result = await findWorkers(
    client,
    workspaceId,
    {
      parentAuthority,
      enabledWorkerDefinitionIds: agentProfile?.enabledWorkerDefinitions ?? null,
    },
    need,
  );
  return { result: { items: result } };
};

const findOperationsHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { need } = params as { need: string };
  const parentAuthority = await resolveParentAuthority(client, workspaceId, {
    principalId: ctx?.principalId ?? '',
    channel: ctx?.channel ?? 'handle',
    claims: ctx?.claims,
  });
  const result = await findOperations(client, workspaceId, { parentAuthority }, need);
  return { result: { items: result.map(toWireObject) } };
};

const findProceduresHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { need } = params as { need: string };
  const parentAuthority = await resolveParentAuthority(client, workspaceId, {
    principalId: ctx?.principalId ?? '',
    channel: ctx?.channel ?? 'handle',
    claims: ctx?.claims,
  });
  const result = await findProcedures(client, workspaceId, { parentAuthority }, need);
  return { result: { items: result } };
};

/** `cancel_task` — not in S2.7's own explicit "handlers wired" list, but wired anyway: it is a
 *  thin, self-contained pass-through to `terminateTask` (already required internally, e.g. by the
 *  budget-exhaustion path), the capability's `paramsSchema` (`{taskId}`) needs nothing this
 *  handler cannot already provide, and leaving a registered-but-unwired capability whose service
 *  function already exists would be a stranger inconsistency than wiring it.
 *
 *  Item 5 fix (review job 652a4abc lane3 P2-5: "cancel_task (member) has no ownership check"):
 *  `terminateTask` itself performs no ownership check (it trusts its caller) — `minRole:'member'`
 *  alone would let any authenticated member cancel any other principal's Task by guessing/reading
 *  its id. A non-owner caller may only cancel a Task whose `onBehalfOf` is themselves; `owner`
 *  bypasses (tenant-root, same convention every other owner-override in this module already
 *  uses). Reads the Task first (`getTaskWithWorkerRuns`, the same read `get_task` already does) —
 *  a 403 for "not yours" is preferable to `terminateTask`'s own `TaskNotFoundError` (404) leaking
 *  no information either way, but 403 is the more accurate reason here. */
const cancelTaskHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { taskId } = params as { taskId: string };
  const caller = await currentPrincipalRole(client, workspaceId);
  if (caller.role !== 'owner') {
    const { task } = await getTaskWithWorkerRuns(client, workspaceId, taskId);
    if (task.onBehalfOf !== caller.id) {
      throw new ForbiddenError(
        `cancel_task: principal ${caller.id} may not cancel Task ${taskId} (owned by another principal)`,
      );
    }
  }
  const result = await terminateTask(workspaceId, caller.id, taskId);
  return {
    result: { id: result.id, status: result.status },
    resourceType: 'task',
    resourceId: result.id,
  };
};

/** capability name → handler, for every wired capability. */
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
  ['record_decision', recordDecisionHandler],
  ['list_conflicts', listConflictsHandler],
  ['resolve_conflict', resolveConflictHandler],
  ['verify_fact', verifyFactHandler],
  ['query_decisions', queryDecisionsHandler],
  ['causal_chain', causalChainHandler],
  ['decision_impact', decisionImpactHandler],
  ['find_precedents', findPrecedentsHandler],
  ['propose_worker_definition', proposeWorkerDefinitionHandler],
  ['publish_worker_definition', publishWorkerDefinitionHandler],
  ['deprecate_worker_definition', deprecateWorkerDefinitionHandler],
  ['list_worker_definitions', listWorkerDefinitionsHandler],
  ['assert_fact', assertFactHandler],
  ['supersede_fact', supersedeFactHandler],
  ['invalidate_fact', invalidateFactHandler],
  ['approve', approveHandler],
  ['reject', rejectHandler],
  ['list_pending', listPendingHandler],
  ['get_action', getActionHandler],
  ['set_auto_approved_action_kind', setAutoApprovedActionKindHandler],
  ['set_policy', setPolicyHandler],
  ['grant_capability', grantCapabilityHandler],
  ['revoke_capability', revokeCapabilityHandler],
  // S3.11 (docs/development-tasks.md "中台控制面") — governance read-side additions.
  ['list_grants', listGrantsHandler],
  ['list_policies', listPoliciesHandler],
  ['list_quotas', listQuotasHandler],
  ['request_action', requestActionHandler],
  ['propose_operation', proposeOperationHandler],
  ['publish_operation', publishOperationHandler],
  ['deprecate_operation', deprecateOperationHandler],
  // S2.14 (docs/development-tasks.md S2.14) — skill-procedure-handlers.ts.
  ['propose_skill', proposeSkillHandler],
  ['publish_skill', publishSkillHandler],
  ['deprecate_skill', deprecateSkillHandler],
  ['list_skills', listSkillsHandler],
  ['propose_procedure', proposeProcedureHandler],
  ['publish_procedure', publishProcedureHandler],
  ['deprecate_procedure', deprecateProcedureHandler],
  ['list_procedures', listProceduresHandler],
  // S2.7 (docs/development-tasks.md S2.7) — `create_task` deliberately absent, see
  // `setQuotaHandler`'s neighboring doc comment above ("create_task: not wired").
  ['invoke_worker', invokeWorkerHandler],
  ['get_task', getTaskHandler],
  ['list_tasks', listTasksHandler],
  ['cancel_task', cancelTaskHandler],
  ['set_quota', setQuotaHandler],
  ['find_workers', findWorkersHandler],
  ['find_operations', findOperationsHandler],
  ['find_procedures', findProceduresHandler],
  // S2.9 (docs/development-tasks.md S2.9) — worker-result-handler.ts.
  ['list_allowed_operations', listAllowedOperationsHandler],
  ['report_task_result', reportTaskResultHandler],
  // S2.13 (docs/development-tasks.md S2.13) — connection-handlers.ts / operation-manifest-
  // handlers.ts's own `publish_manifest`.
  ['request_connection', requestConnectionHandler],
  // S2.12 fix — the dispatchable capability behind the `<gate>.<op>` observe projection.
  ['observe_operation', observeOperationHandler],
  ['create_connection', createConnectionHandler],
  ['connect_gatekeeper', connectGatekeeperHandler],
  ['list_connection_requests', listConnectionRequestsHandler],
  ['publish_manifest', publishManifestHandler],
  // S3.11 (docs/development-tasks.md "中台控制面") — gatekeeper-read-handlers.ts.
  ['list_gatekeepers', listGatekeepersHandler],
  ['get_gatekeeper', getGatekeeperHandler],
  ['list_operations', listOperationsHandler],
  // S3.12 catalog-usage follow-up — same module as list_operations above.
  ['get_operation_stats', getOperationStatsHandler],
  // S3.11 — members-handlers.ts.
  ['list_principals', listPrincipalsHandler],
  ['create_principal', createPrincipalHandler],
  ['set_principal_role', setPrincipalRoleHandler],
  ['rotate_api_key', rotateApiKeyHandler],
  ['disable_principal', disablePrincipalHandler],
  ['get_workspace', getWorkspaceHandler],
  // S3.11 — models-catalog-handler.ts.
  ['list_models', listModelsHandler],
  // S3.13 (docs/development-tasks.md "每用户智能体配置") — agent-profile-handlers.ts.
  ['get_agent_profile', getAgentProfileHandler],
  ['set_agent_profile', setAgentProfileHandler],
  ['get_agent_policy', getAgentPolicyHandler],
  ['set_agent_policy', setAgentPolicyHandler],
  // S3.1 (docs/development-tasks.md S3.1) — ontology-handlers.ts.
  ['get_type', getTypeHandler],
  ['list_types', listTypesHandler],
  ['validate', validateHandler],
  ['propose_ontology_change', proposeOntologyChangeHandler],
  ['publish_ontology_version', publishOntologyVersionHandler],
  // S3.3 (docs/development-tasks.md S3.3) — ingest-handlers.ts.
  ['register_source', registerSourceHandler],
  ['submit_observations', submitObservationsHandler],
]);
