import type { CapabilityChannel, HandleClaims, Role, WorkerDefinitionKind } from '@nexttime/shared';
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
import {
  type InvokeWorkerInput,
  findOperations,
  findProcedures,
  findWorkers,
  getConfiguredTaskRuntime,
  getTaskWithWorkerRuns,
  invokeWorker,
  resolveParentAuthority,
  setQuotaValue,
  terminateTask,
} from '../../application/task/index.js';
import {
  type WorkerDefinitionRow,
  deprecateWorkerDefinition,
  listWorkerDefinitions,
  proposeWorkerDefinition,
  publishWorkerDefinition,
} from '../../application/worker/index.js';
import {
  ActionRequestNotFoundError,
  approveActionRequest,
  getActionRequest,
  listPendingForApprover,
  rejectActionRequest,
} from '../../governance/approval/index.js';
import { grantCapability, revokeCapabilityGrant } from '../../governance/capability/index.js';
import {
  parseSetPolicyPayload,
  setAutoApprovedActionKind,
  setPolicy,
} from '../../governance/policy/index.js';
import type { AuditQueryFilter } from '../../substrate/audit/index.js';
import { queryAudit, reconstruct } from '../../substrate/audit/index.js';
import { explainByNodeId } from '../../substrate/epistemic/index.js';
import type { SearchInput, TraverseInput } from '../../substrate/graph/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import type { CapabilityHandler } from './capability-handler.js';
import { assertMetaOntologyHandleWriteAllowed } from './meta-ontology-guard.js';
import {
  deprecateOperationHandler,
  proposeOperationHandler,
  publishOperationHandler,
} from './operation-manifest-handlers.js';
import { requestActionHandler } from './request-action-handler.js';

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
  return { result: rows.map(toWireWorkerDefinition) };
};

// -------------------------------------------------------------------------------------------
// S2.6 I16 graph-write-path guard (docs/development-tasks.md S2.6 deliverable 4: "Handle 通道
// assert_fact(WorkerDefinition …) 403"). See application/gateway/meta-ontology-guard.ts's own
// doc comment for why this handler stops at the guard rather than performing a real write: the
// registered `assert_fact` capability's paramsSchema (`{objectId, linkType, value, sourceId?}`,
// packages/shared/src/capabilities.ts) predates S2.6, is not owned by it, and does not carry the
// `sourceObjectId`/`targetObjectId`/`activityId` `substrate/graph/store.ts`'s `AssertFactInput`
// requires (I3) — wiring the write itself is a separate, pre-existing gap this task does not
// silently paper over. `ctx?.channel` defaults to `'handle'` (fail-closed) for the theoretical
// case of a caller with no context attached (e.g. a handler invoked directly in a unit test).
// -------------------------------------------------------------------------------------------

export class AssertFactWriteNotImplementedError extends Error {
  constructor() {
    super(
      'assert_fact: the graph write is not implemented (pre-existing gap, not S2.6 scope — see ' +
        'application/gateway/handlers.ts module doc); only the I16 meta-ontology guard on the ' +
        'referenced object(s) runs here',
    );
    this.name = 'AssertFactWriteNotImplementedError';
  }
}

const assertFactHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { objectId, sourceId } = params as {
    objectId: string;
    linkType: string;
    value: unknown;
    sourceId?: string;
  };
  const channel: CapabilityChannel = ctx?.channel ?? 'handle';

  const referencedIds = [objectId, sourceId].filter(
    (candidate): candidate is string => typeof candidate === 'string',
  );
  for (const id of referencedIds) {
    const object = await graphStore.getObject(client, workspaceId, id);
    if (object) {
      assertMetaOntologyHandleWriteAllowed(channel, object.objectType);
    }
  }

  throw new AssertFactWriteNotImplementedError();
};

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
  return { result, resourceType: 'action_request', resourceId: result.id };
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
  return { result, resourceType: 'action_request', resourceId: result.id };
};

/** `list_pending`: the caller's own I14-scoped queue (`governance/approval/reads.ts`'s
 *  `listPendingForApprover`). */
const listPendingHandler: CapabilityHandler = async (client, workspaceId) => {
  const caller = await currentPrincipalRole(client, workspaceId);
  const result = await listPendingForApprover(client, workspaceId, {
    principalId: caller.id,
    role: caller.role,
  });
  return { result };
};

/** `get_action`: workspace-scoped read, not I14-narrowed (§9.3 "get_action returns one
 *  (workspace-scoped)") — any `operator`+ role may read any single ActionRequest by id. */
const getActionHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { actionRequestId } = params as { actionRequestId: string };
  const result = await getActionRequest(client, workspaceId, actionRequestId);
  if (!result) throw new ActionRequestNotFoundError(workspaceId, actionRequestId);
  return { result, resourceType: 'action_request', resourceId: actionRequestId };
};

/** "总是批准此类" — writes/upserts a workspace auto-approval rule for one action_kind (§9.3,
 *  design doc S2.10 card action). See `governance/policy/policies.ts`'s own doc comment for why
 *  the I8 high-blast-radius guard can only fire here when a prior `set_policy` call already
 *  recorded this action_kind's `blast_radius` (S2.6's graph-stored Operation metadata, the only
 *  other source of truth, does not exist yet). */
const setAutoApprovedActionKindHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { actionKind } = params as { actionKind: string };
  const setBy = await currentPrincipalId(client);
  const result = await setAutoApprovedActionKind(client, workspaceId, { actionKind, setBy });
  return { result, resourceType: 'policy', resourceId: result.id };
};

const setPolicyHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { policy } = params as { policy: unknown };
  const payload = parseSetPolicyPayload(policy);
  const setBy = await currentPrincipalId(client);
  const result = await setPolicy(client, workspaceId, { ...payload, setBy });
  return { result, resourceType: 'policy', resourceId: result.id };
};

const grantCapabilityHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { principalId, capability, scope } = params as {
    principalId: string;
    capability: string;
    scope: Record<string, unknown>;
  };
  const grantedBy = await currentPrincipalId(client);
  const result = await grantCapability(client, workspaceId, {
    principalId,
    capability,
    scope,
    grantedBy,
  });
  return { result, resourceType: 'capability_grant', resourceId: result.id };
};

const revokeCapabilityHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { grantId } = params as { grantId: string };
  const result = await revokeCapabilityGrant(client, workspaceId, grantId);
  return { result, resourceType: 'capability_grant', resourceId: result.id };
};

// -------------------------------------------------------------------------------------------
// S2.7 task/find_* handlers (docs/development-tasks.md S2.7). `invoke_worker` deliberately never
// touches the `client` dispatch.ts hands it — see `application/task/invoke.ts`'s own module doc
// comment for why (it manages its own independently-committed transactions via the configured
// `TaskRuntimeDeps.pool`, so a freshly-minted WorkerRun Handle is usable the moment the Worker
// container can reach the kernel, not only after this whole capability call returns).
// `create_task` is deliberately **not** wired (see this section's own note below).
// -------------------------------------------------------------------------------------------

const invokeWorkerHandler: CapabilityHandler = async (_client, workspaceId, params, ctx) => {
  const result = await invokeWorker(
    workspaceId,
    { principalId: ctx?.principalId ?? '', channel: ctx?.channel ?? 'handle', claims: ctx?.claims },
    params as InvokeWorkerInput,
    getConfiguredTaskRuntime(),
  );
  return { result, resourceType: 'task', resourceId: result.taskId };
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

const getTaskHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { taskId } = params as { taskId: string };
  const { task, workerRuns } = await getTaskWithWorkerRuns(client, workspaceId, taskId);
  return {
    result: {
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
    },
    resourceType: 'task',
    resourceId: task.id,
  };
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
  return { result, resourceType: 'quota' };
};

const findWorkersHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { need } = params as { need: string };
  const parentAuthority = await resolveParentAuthority(client, workspaceId, {
    principalId: ctx?.principalId ?? '',
    channel: ctx?.channel ?? 'handle',
    claims: ctx?.claims,
  });
  const result = await findWorkers(client, workspaceId, { parentAuthority }, need);
  return { result };
};

const findOperationsHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { need } = params as { need: string };
  const parentAuthority = await resolveParentAuthority(client, workspaceId, {
    principalId: ctx?.principalId ?? '',
    channel: ctx?.channel ?? 'handle',
    claims: ctx?.claims,
  });
  const result = await findOperations(client, workspaceId, { parentAuthority }, need);
  return { result };
};

const findProceduresHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { need } = params as { need: string };
  const parentAuthority = await resolveParentAuthority(client, workspaceId, {
    principalId: ctx?.principalId ?? '',
    channel: ctx?.channel ?? 'handle',
    claims: ctx?.claims,
  });
  const result = await findProcedures(client, workspaceId, { parentAuthority }, need);
  return { result };
};

/** `cancel_task` — not in S2.7's own explicit "handlers wired" list, but wired anyway: it is a
 *  thin, self-contained pass-through to `terminateTask` (already required internally, e.g. by the
 *  budget-exhaustion path), the capability's `paramsSchema` (`{taskId}`) needs nothing this
 *  handler cannot already provide, and leaving a registered-but-unwired capability whose service
 *  function already exists would be a stranger inconsistency than wiring it. */
const cancelTaskHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { taskId } = params as { taskId: string };
  const actorPrincipalId = await currentPrincipalId(client);
  const result = await terminateTask(workspaceId, actorPrincipalId, taskId);
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
  ['propose_worker_definition', proposeWorkerDefinitionHandler],
  ['publish_worker_definition', publishWorkerDefinitionHandler],
  ['deprecate_worker_definition', deprecateWorkerDefinitionHandler],
  ['list_worker_definitions', listWorkerDefinitionsHandler],
  ['assert_fact', assertFactHandler],
  ['approve', approveHandler],
  ['reject', rejectHandler],
  ['list_pending', listPendingHandler],
  ['get_action', getActionHandler],
  ['set_auto_approved_action_kind', setAutoApprovedActionKindHandler],
  ['set_policy', setPolicyHandler],
  ['grant_capability', grantCapabilityHandler],
  ['revoke_capability', revokeCapabilityHandler],
  ['request_action', requestActionHandler],
  ['propose_operation', proposeOperationHandler],
  ['publish_operation', publishOperationHandler],
  ['deprecate_operation', deprecateOperationHandler],
  // S2.7 (docs/development-tasks.md S2.7) — `create_task` deliberately absent, see
  // `setQuotaHandler`'s neighboring doc comment above ("create_task: not wired").
  ['invoke_worker', invokeWorkerHandler],
  ['get_task', getTaskHandler],
  ['cancel_task', cancelTaskHandler],
  ['set_quota', setQuotaHandler],
  ['find_workers', findWorkersHandler],
  ['find_operations', findOperationsHandler],
  ['find_procedures', findProceduresHandler],
]);
