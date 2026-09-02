import { z } from 'zod';
import { ActionRequestStatusSchema, EpistemicStatusSchema, TaskStatusSchema } from './enums.js';

/**
 * Platform event vocabulary (design doc §7.10 domain/outbox events; §9.4 chat WebSocket push
 * events). Two families share one discriminated union so a single `PlatformEventSchema` can
 * validate anything crossing a module or transport boundary:
 *
 * - Domain events (§7.10): written to `outbox` in the same transaction as the state transition
 *   that caused them; other kernel modules subscribe instead of importing internals or querying
 *   another module's tables. `chat`/`web` may only consume these, never `approval`/`task` directly.
 * - Chat WS push events (§9.4): what `chat.ws` sends over `/ws` to a subscribed browser client.
 *   `chat.stream` itself carries one of five sub-kinds (`textDelta`/`toolCallStarted`/
 *   `toolCallEnded`/`workerSpawned`/`taskUpdated`), modeled as a nested discriminated union.
 *
 * Domain `TaskUpdated`/`ActionRequestUpdated` and WS `task.updated`/`action.updated` are
 * deliberately distinct variants — one is an internal bus event, the other a wire notification —
 * per their separate listings in §7.10 and §9.4.
 */

// ---------------------------------------------------------------------------------------------
// §7.10 domain event vocabulary — kept name- and shape-compatible with the pre-existing
// PLATFORM_EVENT_NAMES export (previously in index.ts).
// ---------------------------------------------------------------------------------------------

export const PLATFORM_EVENT_NAMES = [
  'TurnStarted',
  'TurnCompleted',
  'TaskUpdated',
  'ActionRequestPending',
  'ActionRequestUpdated',
  'ConnectionCreated',
  'FactAsserted',
  'EgressObserved',
  'BudgetWarning',
] as const;

export type PlatformEventName = (typeof PLATFORM_EVENT_NAMES)[number];

export const PlatformEventNameSchema = z.enum(PLATFORM_EVENT_NAMES);

const TurnStartedEvent = z.object({
  type: z.literal('TurnStarted'),
  workspaceId: z.string(),
  chatId: z.string(),
  turnId: z.string(),
  principalId: z.string(),
});

const TurnCompletedEvent = z.object({
  type: z.literal('TurnCompleted'),
  workspaceId: z.string(),
  chatId: z.string(),
  turnId: z.string(),
  status: z.enum(['completed', 'interrupted', 'failed']),
});

const TaskUpdatedEvent = z.object({
  type: z.literal('TaskUpdated'),
  workspaceId: z.string(),
  taskId: z.string(),
  status: TaskStatusSchema,
});

const ActionRequestPendingEvent = z.object({
  type: z.literal('ActionRequestPending'),
  workspaceId: z.string(),
  actionRequestId: z.string(),
  gatekeeperId: z.string(),
  actionKind: z.string(),
  resourceScope: z.string().optional(),
});

const ActionRequestUpdatedEvent = z.object({
  type: z.literal('ActionRequestUpdated'),
  workspaceId: z.string(),
  actionRequestId: z.string(),
  status: ActionRequestStatusSchema,
});

const ConnectionCreatedEvent = z.object({
  type: z.literal('ConnectionCreated'),
  workspaceId: z.string(),
  gatekeeperId: z.string(),
  kind: z.enum(['http', 'mcp', 'cli', 'ssh']),
  target: z.string(),
});

const FactAssertedEvent = z.object({
  type: z.literal('FactAsserted'),
  workspaceId: z.string(),
  factId: z.string(),
  objectId: z.string().optional(),
  epistemicStatus: EpistemicStatusSchema,
});

const EgressObservedEvent = z.object({
  type: z.literal('EgressObserved'),
  workspaceId: z.string(),
  activityId: z.string(),
  domain: z.string(),
  bytes: z.number().int().nonnegative().optional(),
});

const BudgetWarningEvent = z.object({
  type: z.literal('BudgetWarning'),
  workspaceId: z.string(),
  scope: z.enum(['task', 'turn', 'workspace_daily']),
  taskId: z.string().optional(),
  turnId: z.string().optional(),
  percent: z.number().min(0).max(100),
});

// ---------------------------------------------------------------------------------------------
// §9.4 chat WebSocket push events
// ---------------------------------------------------------------------------------------------

const ChatMessageEvent = z.object({
  type: z.literal('chat.message'),
  chatId: z.string(),
  message: z.object({
    id: z.string(),
    role: z.enum(['user', 'assistant', 'system']),
    text: z.string(),
    createdAt: z.string(),
  }),
});

const ChatStreamTextDelta = z.object({ streamKind: z.literal('textDelta'), delta: z.string() });
const ChatStreamToolCallStarted = z.object({
  streamKind: z.literal('toolCallStarted'),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown().optional(),
});
const ChatStreamToolCallEnded = z.object({
  streamKind: z.literal('toolCallEnded'),
  toolCallId: z.string(),
  result: z.unknown().optional(),
});
const ChatStreamWorkerSpawned = z.object({
  streamKind: z.literal('workerSpawned'),
  taskId: z.string(),
  workerRunId: z.string(),
  definitionId: z.string(),
});
const ChatStreamTaskUpdated = z.object({
  streamKind: z.literal('taskUpdated'),
  taskId: z.string(),
  status: TaskStatusSchema,
});

const ChatStreamPayload = z.discriminatedUnion('streamKind', [
  ChatStreamTextDelta,
  ChatStreamToolCallStarted,
  ChatStreamToolCallEnded,
  ChatStreamWorkerSpawned,
  ChatStreamTaskUpdated,
]);

const ChatStreamEvent = z.object({
  type: z.literal('chat.stream'),
  chatId: z.string(),
  turnId: z.string(),
  payload: ChatStreamPayload,
});

const ChatMetadataEvent = z.object({
  type: z.literal('chat.metadata'),
  chatId: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});

const ActionPendingEvent = z.object({
  type: z.literal('action.pending'),
  actionRequestId: z.string(),
  gatekeeperId: z.string(),
  title: z.string(),
  description: z.string(),
  actionKind: z.object({ tag: z.string(), label: z.string() }),
  awaitDecision: z.boolean(),
  simulated: z.unknown().optional(),
});

const ActionUpdatedEvent = z.object({
  type: z.literal('action.updated'),
  actionRequestId: z.string(),
  status: ActionRequestStatusSchema,
});

const TaskUpdatedPushEvent = z.object({
  type: z.literal('task.updated'),
  taskId: z.string(),
  status: TaskStatusSchema,
});

/** Discriminated union of every event that crosses a module, WS, or MCP boundary in the platform. */
export const PlatformEventSchema = z.discriminatedUnion('type', [
  TurnStartedEvent,
  TurnCompletedEvent,
  TaskUpdatedEvent,
  ActionRequestPendingEvent,
  ActionRequestUpdatedEvent,
  ConnectionCreatedEvent,
  FactAssertedEvent,
  EgressObservedEvent,
  BudgetWarningEvent,
  ChatMessageEvent,
  ChatStreamEvent,
  ChatMetadataEvent,
  ActionPendingEvent,
  ActionUpdatedEvent,
  TaskUpdatedPushEvent,
]);

export type PlatformEvent = z.infer<typeof PlatformEventSchema>;
export type ChatStreamPayload = z.infer<typeof ChatStreamPayload>;
