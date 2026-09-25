import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import { publishChatPushEvent } from './push.js';

/**
 * application/chat/service: Chat/Turn persistence (design doc §5.1.3 Chat/Turn, §8.1
 * sendChatMessage, §9.2/§9.3 chat capabilities; docs/development-tasks.md S1.4 deliverable 2).
 * `list_chats` / `new_chat` / `send_chat_message` / `stop_agent`'s DB half / `get_chat_history`
 * live here; `application/gateway/handlers.ts` wires each as a `CAPABILITY_HANDLERS` entry
 * (docs/development-tasks.md S1.4: "Register these as CAPABILITY_HANDLERS entries").
 *
 * Caller identity: `CapabilityHandler` (application/gateway/handlers.ts) receives `(client,
 * workspaceId, params)` — no `principalId`. `dispatchCapability` (application/gateway/dispatch.ts)
 * *does* already know it (it is exactly the `on_behalf_of` `withWorkspace()` scoped this
 * transaction's RLS session variables to) but has no channel to hand it to a handler without a
 * signature change outside this task's ownership (docs/development-tasks.md S1.4 ownership: "add
 * handlers only" to gateway/handlers.ts, not dispatch.ts). `currentPrincipalId` below recovers it
 * the same way RLS itself does — reading back the `app.principal_id` session variable dispatch.ts
 * already set (`substrate/ontology`'s `app_principal()` SQL function, migrations/core/
 * 0001_identity.sql) — rather than threading it through a new parameter.
 *
 * Turn creation ordering (§8.1 "K->>K: Turn(Activity) 落库"): `sendChatMessage` starts the Turn
 * *before* inserting the user's own message, not after — the opposite of the task brief's prose
 * order ("inserts the user message, starts the Turn"), because migrations/core/
 * 0008_chat_messages.sql's `turn_id` design deliberately wants the triggering user message to
 * already know its own turn_id (see that migration's own comment). Both still happen inside the
 * *same* transaction dispatch.ts opened (this module never calls `withWorkspace` itself — every
 * exported function here takes an already-open `client`), so a `TurnAlreadyRunning` collision on
 * the partial unique index still rolls back with nothing written, matching the task brief's actual
 * intent ("the partial unique index turns a second concurrent send into a clean error") — the
 * message insert that never gets a chance to run is simply moved from "rolled back" to "never
 * attempted", which is a strict improvement, not a behavior change.
 */

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/** Thrown when `chatId` does not exist, or exists but is not visible to the calling principal
 *  (RLS-filtered — the two cases are indistinguishable by design, so existence is never leaked to
 *  a non-owner). Maps to a 404-shaped error at every transport this module is reached from. */
export class ChatNotFoundError extends Error {
  constructor(workspaceId: string, chatId: string) {
    super(`Chat not found: workspace ${workspaceId}, id ${chatId}`);
    this.name = 'ChatNotFoundError';
  }
}

/** Thrown by `sendChatMessage` when the Chat already has a Turn in `status = 'running'` — the
 *  partial unique index `activities_one_running_turn_per_chat_uidx`
 *  (migrations/core/0008_chat_messages.sql) is the actual enforcement mechanism; this error is
 *  just what a caught unique-violation on it is translated into (§9.4 "进行中时 send_chat_message
 *  被拒"). */
export class TurnAlreadyRunningError extends Error {
  constructor(chatId: string) {
    super(`chat ${chatId} already has a Turn in progress`);
    this.name = 'TurnAlreadyRunningError';
  }
}

/** Thrown by `sendChatMessage` when the Chat is archived (S6-A, docs/console-completion-plan.md
 *  §4 "Chat 生命周期": archiving only affects list visibility, but an archived Chat takes no new
 *  Turn — restore it first). Enforced here, not only in the console, so an API caller cannot write
 *  into an archived Chat either. Maps to 409 at every transport, like `TurnAlreadyRunningError`. */
export class ChatArchivedError extends Error {
  constructor(chatId: string) {
    super(`chat ${chatId} is archived — unarchive it before sending`);
    this.name = 'ChatArchivedError';
  }
}

const ONE_RUNNING_TURN_PER_CHAT_CONSTRAINT = 'activities_one_running_turn_per_chat_uidx';

function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraintName;
}

// -------------------------------------------------------------------------------------------
// Row-shaped domain types
// -------------------------------------------------------------------------------------------

export interface ChatRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly ownerPrincipalId: string;
  readonly title: string | null;
  readonly visibility: string;
  readonly createdAt: Date;
  /** S6-A chat lifecycle (migrations/core/0031_chat_archived_at.sql): `null` = active. Archiving
   *  only affects `listChats`'s default filter — every other read of the Chat and its Turns is
   *  unchanged (docs/console-completion-plan.md §4 "归档只影响列表可见性"). */
  readonly archivedAt: Date | null;
  /** S8 W4 (audit C1 "对话行副标题显示 chats.created_at，看起来像很久没动过"): the newest of the
   *  Chat's own `created_at` and its `chat_messages.created_at` (max), so a Chat with today's Turn
   *  reads as "today", not stuck at the instant the row was first created. Read-only projection —
   *  no new column, computed by `listChats`'s own query (a fresh `newChat` row has no messages yet,
   *  so its `lastActivityAt` is simply its own `createdAt`). */
  readonly lastActivityAt: Date;
  /** S8 W4 (audit C1 "状态副标题"): whether this Chat currently has a Turn in `status='running'` —
   *  the same partial unique index `activities_one_running_turn_per_chat_uidx`
   *  (migrations/core/0008_chat_messages.sql) `sendChatMessage` relies on to keep one Turn per
   *  Chat, read back here instead of written anywhere new. */
  readonly hasRunningTurn: boolean;
}

export type ChatMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatMessageRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly chatId: string;
  readonly turnId: string | null;
  readonly role: ChatMessageRole;
  readonly content: Record<string, unknown>;
  /** `chat_messages.sequence` is `bigint`; mapped to a plain `number` here (see this module's own
   *  doc comment on why — matches `PlatformEventSchema`'s `chat.message.message.sequence:
   *  z.number()`, packages/shared/src/events.ts). Safe well within `Number.MAX_SAFE_INTEGER` for
   *  any real per-chat message count. */
  readonly sequence: number;
  readonly createdAt: Date;
  /** The outbox row this message was produced from (migrations/core/
   *  0009_chat_messages_source_outbox_id.sql) — `null` for a human's own message
   *  (`sendChatMessage`) and for an AgentRuntime-driven assistant/tool message
   *  (`event-sink.ts`), neither of which is outbox-driven. */
  readonly sourceOutboxId: string | null;
}

interface ChatDbRow {
  workspace_id: string;
  id: string;
  owner_principal_id: string;
  title: string | null;
  visibility: string;
  created_at: Date;
  archived_at: Date | null;
  last_activity_at: Date;
  has_running_turn: boolean;
}

interface ChatMessageDbRow {
  workspace_id: string;
  id: string;
  chat_id: string;
  turn_id: string | null;
  role: string;
  content: Record<string, unknown>;
  sequence: string; // bigint comes back from `pg` as a string
  created_at: Date;
  source_outbox_id: string | null; // bigint comes back from `pg` as a string
}

const CHAT_COLUMNS =
  'workspace_id, id, owner_principal_id, title, visibility, created_at, archived_at';
const CHAT_MESSAGE_COLUMNS =
  'workspace_id, id, chat_id, turn_id, role, content, sequence, created_at, source_outbox_id';

// S8 W4 (audit C1): `last_activity_at`/`has_running_turn` are read-only projections — no new
// column, no new write path — shared by every query below that returns a wire-facing `ChatRow`
// (`listChats`, `requireChatAccess`, `renameChat`, `setChatArchived`), not only `listChats`: a
// splice of a stale `renameChat`/`setChatArchived` result would otherwise silently regress these
// two fields in the console's own cache right after the very write that's supposed to keep it
// current (`chat-lifecycle.ts`'s `spliceChat`). Every call site aliases the source row `c`. The
// running-Turn lookup reuses the exact index `sendChatMessage`'s one-running-Turn-per-Chat guard
// already maintains (`activities_one_running_turn_per_chat_uidx`, migrations/core/
// 0008_chat_messages.sql), so this is an index-backed lookup, not a new scan pattern.
const CHAT_ACTIVITY_JOIN_SQL = `
  left join lateral (
    select max(cm.created_at) as last_message_at
    from chat_messages cm
    where cm.workspace_id = c.workspace_id and cm.chat_id = c.id
  ) m on true
  left join lateral (
    select true as running
    from activities a
    where a.workspace_id = c.workspace_id and a.chat_id = c.id
      and a.kind = 'agent_turn' and a.status = 'running'
    limit 1
  ) r on true`;
const CHAT_ACTIVITY_SELECT_SQL = `coalesce(m.last_message_at, c.created_at) as last_activity_at,
    coalesce(r.running, false) as has_running_turn`;
const CHAT_COLUMNS_C =
  'c.workspace_id, c.id, c.owner_principal_id, c.title, c.visibility, c.created_at, c.archived_at';

function mapChatRow(row: ChatDbRow): ChatRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    title: row.title,
    visibility: row.visibility,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    lastActivityAt: row.last_activity_at,
    hasRunningTurn: row.has_running_turn,
  };
}

function mapChatMessageRow(row: ChatMessageDbRow): ChatMessageRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    chatId: row.chat_id,
    turnId: row.turn_id,
    // `role` is DB-CHECK-constrained (migrations/core/0008_chat_messages.sql) to
    // ChatMessageRole's value set — cast, not re-validated, the same convention
    // substrate/graph/sql-store.ts uses for `epistemic_status`.
    role: row.role as ChatMessageRole,
    content: row.content,
    sequence: Number(row.sequence),
    createdAt: row.created_at,
    sourceOutboxId: row.source_outbox_id,
  };
}

/**
 * Defensive plain-text projection of a `chat_messages.content` blob — S1's minimal content model
 * is `{text: string}` (`application/host-bridge`'s `AgentRuntimeEvent` "message" variant doc
 * comment); anything else round-trips through `JSON.stringify` rather than throwing. Shared by
 * `event-sink.ts` (building a `chat.message` push) and `application/gateway/handlers.ts`'s
 * `get_chat_history` handler (building the wire `text` field for each returned message) so the
 * two never drift on what "the text of a message" means.
 */
export function chatMessageText(content: Record<string, unknown>): string {
  const text = content.text;
  return typeof text === 'string' ? text : JSON.stringify(content);
}

/**
 * Review fix (code-review finding "`chat.message` payload drift"): the top-level `kind` a
 * `chat.message` wire message carries (`ChatMessageEvent.message.kind`, packages/shared/src/
 * events.ts) — `undefined` unless `content` itself has a string `kind` field, which today is true
 * only for the three `role='system'` shapes `application/linkage` writes
 * (`packages/shared/src/chat-message-content.ts`'s `SystemMessageContent` union, always
 * discriminated by its own `kind`). Before this fix, only `application/linkage`'s two system-push
 * call sites derived this field inline (`kind: content.kind`) when publishing a live push;
 * `get_chat_history`/`subscribe_chat` replay (`toWireChatMessage`, application/gateway/
 * handlers.ts) and the user/assistant/tool live-push producers (interfaces/ws/server.ts's
 * `publishSentMessagePush`, this module's own event-sink.ts) never set it at all — so a client
 * that renders a system card by checking `message.kind` (packages/web/src/lib/action-card.ts)
 * worked only for a message that happened to arrive as a live push, not for the same row loaded
 * from history or replayed after reconnect. One helper, used by every producer, closes the drift.
 */
export function chatMessageKind(content: Record<string, unknown>): string | undefined {
  const kind = content.kind;
  return typeof kind === 'string' ? kind : undefined;
}

// -------------------------------------------------------------------------------------------
// currentPrincipalId
// -------------------------------------------------------------------------------------------

/** Reads back the `app.principal_id` RLS session variable `withWorkspace()`/dispatch.ts already
 *  set for this transaction — see this module's own doc comment for why. */
export async function currentPrincipalId(client: PoolClient): Promise<string> {
  const result = await client.query<{ principal_id: string | null }>(
    'select app_principal() as principal_id',
  );
  const principalId = result.rows[0]?.principal_id;
  if (!principalId) {
    throw new Error(
      'currentPrincipalId: app.principal_id session variable is not set on this connection',
    );
  }
  return principalId;
}

// -------------------------------------------------------------------------------------------
// listChats / newChat
// -------------------------------------------------------------------------------------------

export interface ListChatsInput {
  /** S6-A (docs/console-completion-plan.md §5.1 "列表默认隐藏已归档"): `false`/omitted hides rows
   *  with `archived_at` set; `true` returns active and archived rows together (the console's
   *  "已归档" filter). */
  readonly includeArchived?: boolean;
}

export async function listChats(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  input: ListChatsInput = {},
): Promise<readonly ChatRow[]> {
  const result = await client.query<ChatDbRow>(
    `select ${CHAT_COLUMNS_C}, ${CHAT_ACTIVITY_SELECT_SQL}
     from chats c
     ${CHAT_ACTIVITY_JOIN_SQL}
     where c.workspace_id = $1 and c.owner_principal_id = $2
       and ($3::boolean or c.archived_at is null)
     order by c.created_at desc`,
    [workspaceId, principalId, input.includeArchived === true],
  );
  return result.rows.map(mapChatRow);
}

export interface NewChatInput {
  readonly title?: string;
}

export async function newChat(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  input: NewChatInput,
): Promise<ChatRow> {
  // A brand-new Chat has no messages and no Turn yet — `lastActivityAt` is just its own
  // `created_at`, `hasRunningTurn` is always false, both known without a join (see `listChats`'s
  // own comment for why those two are computed there instead of stored).
  const result = await client.query<ChatDbRow>(
    `insert into chats (workspace_id, owner_principal_id, title)
     values ($1, $2, $3)
     returning ${CHAT_COLUMNS}, created_at as last_activity_at, false as has_running_turn`,
    [workspaceId, principalId, input.title ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('newChat: INSERT ... RETURNING produced no row');
  return mapChatRow(row);
}

// -------------------------------------------------------------------------------------------
// requireChatAccess
// -------------------------------------------------------------------------------------------

/** Reads `chats` for `chatId` — RLS (`chats_visibility`, migrations/core/0003_chat.sql) already
 *  confines this to rows visible to the current principal, so "no row" and "not visible" are
 *  indistinguishable, and both throw `ChatNotFoundError`. Every other function in this module that
 *  touches a specific Chat calls this first. */
export async function requireChatAccess(
  client: PoolClient,
  workspaceId: string,
  chatId: string,
): Promise<ChatRow> {
  const result = await client.query<ChatDbRow>(
    `select ${CHAT_COLUMNS_C}, ${CHAT_ACTIVITY_SELECT_SQL}
     from chats c
     ${CHAT_ACTIVITY_JOIN_SQL}
     where c.workspace_id = $1 and c.id = $2`,
    [workspaceId, chatId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ChatNotFoundError(workspaceId, chatId);
  return mapChatRow(row);
}

/**
 * Finds the Chat that already holds the current principal's own `system.action_pending` message
 * for `actionRequestId` — leftover 78 (docs/STATUS.md §4): `application/linkage`'s
 * `action-request-consumer.ts` pins every later `system.action_update` message for the same
 * ActionRequest to this Chat, instead of independently re-resolving "the most recently created
 * Chat" (`chat-targets.ts`'s `resolveDefaultChat`) per outbox event — the latter can drift to a
 * *different* Chat if the principal creates a new one between the `ActionRequestPending` and
 * `ActionRequestUpdated` events, landing the update somewhere the pending card never was.
 *
 * RLS (`chat_messages_visibility`, mirroring `chats_visibility`) already confines this to Chats
 * visible to whichever principal the caller's transaction is scoped to
 * (`withWorkspace(pool, {workspaceId, principalId}, ...)`); a `content ->> 'kind'` match is exact
 * (`buildActionPendingContent` always sets it, `content.ts`), so no other message kind can match.
 * Returns `null` when no such message exists (e.g. a pre-fix ActionRequest, or the pending write
 * somehow never landed) — the caller falls back to its own default-chat rule.
 */
export async function findChatIdForActionPending(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<string | null> {
  const result = await client.query<{ chat_id: string }>(
    `select chat_id from chat_messages
     where workspace_id = $1
       and content ->> 'kind' = 'system.action_pending'
       and content ->> 'actionRequestId' = $2
     order by created_at desc
     limit 1`,
    [workspaceId, actionRequestId],
  );
  return result.rows[0]?.chat_id ?? null;
}

// -------------------------------------------------------------------------------------------
// insertChatMessage — the one write path for chat_messages (used by sendChatMessage below for the
// user's own message, and by application/chat's AgentRuntimeEventSink for assistant/tool
// messages).
// -------------------------------------------------------------------------------------------

export interface InsertChatMessageInput {
  readonly chatId: string;
  readonly turnId: string | null;
  readonly role: ChatMessageRole;
  readonly content: Record<string, unknown>;
  /** `OutboxDeliveryMeta.outboxId` (application/outbox/index.ts) when this message is produced by
   *  an outbox consumer (`application/linkage`'s task-consumer.ts / action-request-consumer.ts) —
   *  omitted for a human's own message (`sendChatMessage` below) and for an AgentRuntime-driven
   *  assistant/tool message (`event-sink.ts`), neither of which has an outbox row to key off.
   *  When present, makes this insert durably idempotent against a redelivered outbox row (lane-4
   *  P1 fix — see migrations/core/0009_chat_messages_source_outbox_id.sql's own doc comment): a
   *  second insert attempt for the same `(workspaceId, sourceOutboxId, chatId)` returns the row
   *  already written instead of creating a duplicate. */
  readonly sourceOutboxId?: string;
}

/**
 * Inserts one `chat_messages` row, allocating the next `sequence` for `chatId` itself
 * (`coalesce(max(sequence), 0) + 1`, scoped to `(workspace_id, chat_id)` — migrations/core/
 * 0008_chat_messages.sql's own comment on why `sequence` is a plain `bigint`, not a `bigserial`).
 * `pg_advisory_xact_lock(hashtext(chat_id))` serializes concurrent sequence allocation for the
 * *same* chat within this transaction's lifetime (auto-released at COMMIT/ROLLBACK, the same
 * `pg_advisory_xact_lock` convention every migration in this module already uses) — two chats
 * hashing to the same lock key would serialize against each other too, but `hashtext` is a 32-bit
 * hash over a UUID string, so that collision is rare and merely costs a moment's unnecessary
 * blocking, never incorrect data (unlike a lock-free `coalesce(max...)+1`, which could otherwise
 * let two concurrent inserts compute and attempt the same `sequence` for the same chat, one of
 * which would then fail outright on the `unique (workspace_id, chat_id, sequence)` constraint
 * instead of retrying).
 *
 * `input.sourceOutboxId` set: the INSERT carries an `ON CONFLICT ... DO NOTHING` against
 * `chat_messages_source_outbox_dedupe_uidx` (migrations/core/
 * 0009_chat_messages_source_outbox_id.sql), so a redelivered outbox row never produces a second
 * row — a conflict is detected by `RETURNING` producing no row, and the already-written row is
 * read back and returned instead (never an error; the caller cannot tell the two cases apart, nor
 * does it need to — see this function's own idempotency contract above).
 */
export async function insertChatMessage(
  client: PoolClient,
  workspaceId: string,
  input: InsertChatMessageInput,
): Promise<ChatMessageRow> {
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [input.chatId]);

  const result = await client.query<ChatMessageDbRow>(
    `insert into chat_messages (workspace_id, chat_id, turn_id, role, content, sequence, source_outbox_id)
     select $1, $2, $3, $4, $5::jsonb,
       coalesce(
         (select max(sequence) from chat_messages where workspace_id = $1 and chat_id = $2),
         0
       ) + 1,
       $6
     on conflict (workspace_id, source_outbox_id, chat_id) where source_outbox_id is not null
       do nothing
     returning ${CHAT_MESSAGE_COLUMNS}`,
    [
      workspaceId,
      input.chatId,
      input.turnId,
      input.role,
      JSON.stringify(input.content),
      input.sourceOutboxId ?? null,
    ],
  );
  const row = result.rows[0];
  if (row !== undefined) return mapChatMessageRow(row);

  if (input.sourceOutboxId !== undefined) {
    const existing = await client.query<ChatMessageDbRow>(
      `select ${CHAT_MESSAGE_COLUMNS} from chat_messages
       where workspace_id = $1 and chat_id = $2 and source_outbox_id = $3`,
      [workspaceId, input.chatId, input.sourceOutboxId],
    );
    const existingRow = existing.rows[0];
    if (existingRow !== undefined) return mapChatMessageRow(existingRow);
  }
  throw new Error('insertChatMessage: INSERT ... RETURNING produced no row');
}

// -------------------------------------------------------------------------------------------
// sendChatMessage
// -------------------------------------------------------------------------------------------

export interface SendChatMessageInput {
  readonly chatId: string;
  readonly text: string;
}

export interface SendChatMessageResult {
  readonly message: ChatMessageRow;
  readonly turnId: string;
}

/**
 * §8.1 sendChatMessage: starts the Turn (`activities`, `kind = 'agent_turn'`), inserts the user's
 * message referencing it, and enqueues `TurnStarted` — all in the caller's already-open
 * transaction, and this function never calls an `AgentRuntime` itself (design doc §7.10 "outbox
 * domain events are the coupling mechanism" — `application/host-bridge`'s `TurnStarted` consumer
 * does that, from the outbox, in a separate transaction entirely).
 */
export async function sendChatMessage(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  input: SendChatMessageInput,
): Promise<SendChatMessageResult> {
  const chat = await requireChatAccess(client, workspaceId, input.chatId);
  if (chat.archivedAt !== null) throw new ChatArchivedError(input.chatId);

  // leftover 64 (docs/STATUS.md §4): `roll_entry_containers` (`application/platform/runtime.ts`)
  // takes the *same* session-scoped advisory lock, keyed identically
  // (`roll_entry_containers:<principalId>`), around its own "no in-flight Turn? then stop the
  // resident" check for this principal — held for the duration of that check plus the
  // `stopResident` call. Taking the transaction-scoped form of the same lock here, before starting
  // a new Turn, means a Turn that would otherwise be dispatched to a container
  // `roll_entry_containers` is mid-stopping instead waits (briefly — the other side's own check +
  // one HTTP call) for that to finish, closing the race rather than merely narrowing it. A no-op
  // in the overwhelmingly common case (no roll in progress): Postgres resolves an uncontended
  // advisory lock without blocking. The key string is duplicated (not imported) in
  // `application/platform/runtime.ts` — see this comment there for why: two call sites, no shared
  // type, cheaper than a new cross-module import for one string literal.
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `roll_entry_containers:${principalId}`,
  ]);

  let turnId: string;
  try {
    const turn = await startActivity(client, workspaceId, {
      kind: 'agent_turn',
      chatId: input.chatId,
      principalId,
    });
    turnId = turn.id;
  } catch (err) {
    if (isUniqueViolation(err, ONE_RUNNING_TURN_PER_CHAT_CONSTRAINT)) {
      throw new TurnAlreadyRunningError(input.chatId);
    }
    throw err;
  }

  const message = await insertChatMessage(client, workspaceId, {
    chatId: input.chatId,
    turnId,
    role: 'user',
    content: { text: input.text },
  });

  if (chat.title === null) {
    await autoTitleChat(client, workspaceId, input.chatId, input.text);
  }

  await enqueue(client, {
    type: 'TurnStarted',
    workspaceId,
    chatId: input.chatId,
    turnId,
    principalId,
    // lane-1 P2 fix: a reference into chat_messages (RLS-scoped), not the message text inline —
    // see shared/src/events.ts's TurnStartedEvent doc comment.
    chatMessageId: message.id,
  });

  return { message, turnId };
}

// -------------------------------------------------------------------------------------------
// S6-A chat lifecycle (docs/console-completion-plan.md §4 "Chat 生命周期", §5.1, §6): auto-title
// on the first user message, `rename_chat`, `archive_chat` / `unarchive_chat`. Each write here
// also appends its own domain audit row (`chat.rename` / `chat.archive` / `chat.unarchive`) —
// dispatch.ts's per-capability row documents the API call, this one the Chat transition, the
// same two-row discipline governance/approval's transition-log.ts follows — and pushes
// `chat.metadata` so a client with the chat open (or the chat list) learns the new title /
// archived state without a reload (the same in-process push turn-recovery.ts uses for
// `turnStatus`). Ownership (own Chat; owner may archive others') is the *handler's* check
// (application/gateway/handlers.ts) — this module only ever sees a Chat RLS already showed the
// caller (`requireChatAccess`), and it never widens that.
// -------------------------------------------------------------------------------------------

/** docs/console-completion-plan.md §4 "title 在第一条用户消息落库时自动生成（截断）", §5.1 "前 40 字". */
export const CHAT_AUTO_TITLE_MAX_CHARS = 40;
/** `rename_chat`'s own ceiling (packages/shared/src/capabilities.ts `rename_chat.paramsSchema`). */
export const CHAT_TITLE_MAX_CHARS = 200;

/**
 * One line, trimmed, inner whitespace runs collapsed to a single space, cut to `maxChars` *code
 * points* (`Array.from`, so a CJK character or an emoji counts as one and is never split in the
 * middle of a surrogate pair). Returns `null` when nothing printable is left — the caller then
 * leaves the title untouched rather than writing an empty string.
 */
export function normalizeChatTitle(text: string, maxChars: number): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  const chars = Array.from(collapsed);
  return chars.length <= maxChars ? collapsed : chars.slice(0, maxChars).join('').trimEnd();
}

/**
 * Auto-title: `chats.title` was null when the caller's `sendChatMessage` read the row, so the
 * first `CHAT_AUTO_TITLE_MAX_CHARS` of this (first) user message become the title. The
 * `title is null` predicate is load-bearing — it is what makes `rename_chat` (and `new_chat`'s
 * explicit `title`) win forever: a concurrent or earlier rename means 0 rows updated, never an
 * overwrite. No audit row of its own (it is part of the `send_chat_message` call dispatch.ts
 * already audits, and it carries no decision by a human); the `chat.metadata` push tells a live
 * client the list entry's title changed.
 */
async function autoTitleChat(
  client: PoolClient,
  workspaceId: string,
  chatId: string,
  firstMessageText: string,
): Promise<void> {
  const title = normalizeChatTitle(firstMessageText, CHAT_AUTO_TITLE_MAX_CHARS);
  if (title === null) return;
  const result = await client.query<{ title: string }>(
    `update chats set title = $3
     where workspace_id = $1 and id = $2 and title is null
     returning title`,
    [workspaceId, chatId, title],
  );
  if (result.rows[0] !== undefined) {
    publishChatPushEvent({ type: 'chat.metadata', chatId, metadata: { title } });
  }
}

export interface RenameChatInput {
  readonly chatId: string;
  /** Raw title as the caller sent it — normalized here (`normalizeChatTitle`,
   *  `CHAT_TITLE_MAX_CHARS`). The capability's `paramsSchema` already guarantees at least one
   *  non-whitespace character, so normalization never yields `null` for a dispatched call. */
  readonly title: string;
  readonly actorPrincipalId: string;
}

/** `rename_chat` — writes `chats.title` unconditionally (a rename always wins over the auto-title,
 *  see `autoTitleChat`), audits `chat.rename` with the before/after pair, pushes `chat.metadata`.
 *  Throws `ChatNotFoundError` when RLS hides the row (the handler has already done the ownership
 *  check on the row it read, so this can only be a race with a concurrent delete). */
export async function renameChat(
  client: PoolClient,
  workspaceId: string,
  input: RenameChatInput,
): Promise<ChatRow> {
  const title = normalizeChatTitle(input.title, CHAT_TITLE_MAX_CHARS);
  if (title === null) {
    throw new Error(
      'renameChat: title is blank after normalization (paramsSchema should refuse it)',
    );
  }
  const before = await requireChatAccess(client, workspaceId, input.chatId);
  // Wrapped in a CTE (`updated`, aliased `c`) rather than a plain `UPDATE ... RETURNING` — Postgres
  // has no `RETURNING ... FROM` to join against `chat_messages`/`activities` directly, and the
  // console splices this result straight into its own `list_chats` cache (`chat-lifecycle.ts`'s
  // `spliceChat`), so `last_activity_at`/`has_running_turn` must be as current here as they are in
  // `listChats` (see `CHAT_ACTIVITY_JOIN_SQL`'s own comment).
  const result = await client.query<ChatDbRow>(
    `with updated as (
       update chats set title = $3
       where workspace_id = $1 and id = $2
       returning ${CHAT_COLUMNS}
     )
     select ${CHAT_COLUMNS_C}, ${CHAT_ACTIVITY_SELECT_SQL}
     from updated c
     ${CHAT_ACTIVITY_JOIN_SQL}`,
    [workspaceId, input.chatId, title],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ChatNotFoundError(workspaceId, input.chatId);
  const updated = mapChatRow(row);

  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.actorPrincipalId,
    action: 'chat.rename',
    resourceType: 'chat',
    resourceId: updated.id,
    payload: { from: before.title, to: updated.title },
  });
  publishChatPushEvent({
    type: 'chat.metadata',
    chatId: updated.id,
    metadata: { title: updated.title },
  });
  return updated;
}

export interface SetChatArchivedInput {
  readonly chatId: string;
  /** `true` = `archive_chat` (sets `archived_at = now()` if not already set), `false` =
   *  `unarchive_chat` (clears it). Both idempotent: re-archiving keeps the original timestamp,
   *  re-activating an active chat is a no-op — still audited, since the caller asked for it. */
  readonly archived: boolean;
  readonly actorPrincipalId: string;
}

/** `archive_chat` / `unarchive_chat` (docs/console-completion-plan.md §4 `active ↔ archived`):
 *  visibility-only — nothing about the Chat's Turns, messages or provenance changes. Audits
 *  `chat.archive` / `chat.unarchive`, pushes `chat.metadata {archivedAt}`. */
export async function setChatArchived(
  client: PoolClient,
  workspaceId: string,
  input: SetChatArchivedInput,
): Promise<ChatRow> {
  // See `renameChat`'s own comment on the CTE wrapper: same reason (splice target, needs current
  // `last_activity_at`/`has_running_turn`), same shape.
  const result = await client.query<ChatDbRow>(
    input.archived
      ? `with updated as (
           update chats set archived_at = coalesce(archived_at, now())
           where workspace_id = $1 and id = $2
           returning ${CHAT_COLUMNS}
         )
         select ${CHAT_COLUMNS_C}, ${CHAT_ACTIVITY_SELECT_SQL}
         from updated c
         ${CHAT_ACTIVITY_JOIN_SQL}`
      : `with updated as (
           update chats set archived_at = null
           where workspace_id = $1 and id = $2
           returning ${CHAT_COLUMNS}
         )
         select ${CHAT_COLUMNS_C}, ${CHAT_ACTIVITY_SELECT_SQL}
         from updated c
         ${CHAT_ACTIVITY_JOIN_SQL}`,
    [workspaceId, input.chatId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ChatNotFoundError(workspaceId, input.chatId);
  const updated = mapChatRow(row);
  const archivedAt = updated.archivedAt ? updated.archivedAt.toISOString() : null;

  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.actorPrincipalId,
    action: input.archived ? 'chat.archive' : 'chat.unarchive',
    resourceType: 'chat',
    resourceId: updated.id,
    payload: { ownerPrincipalId: updated.ownerPrincipalId, archivedAt },
  });
  publishChatPushEvent({
    type: 'chat.metadata',
    chatId: updated.id,
    metadata: { archivedAt },
  });
  return updated;
}

// -------------------------------------------------------------------------------------------
// findRunningTurn — used by stopAgent (application/gateway/handlers.ts, which also owns the
// AgentRuntime.stopTurn call — see that file's doc comment for why the runtime dependency lives
// there and not in this module).
// -------------------------------------------------------------------------------------------

export interface RunningTurn {
  readonly id: string;
}

export async function findRunningTurn(
  client: PoolClient,
  workspaceId: string,
  chatId: string,
): Promise<RunningTurn | null> {
  const result = await client.query<{ id: string }>(
    `select id from activities
     where workspace_id = $1 and chat_id = $2 and kind = 'agent_turn' and status = 'running'`,
    [workspaceId, chatId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id };
}

// -------------------------------------------------------------------------------------------
// getChatHistory
// -------------------------------------------------------------------------------------------

export const DEFAULT_CHAT_HISTORY_LIMIT = 50;

export interface GetChatHistoryInput {
  readonly chatId: string;
  /** The `sequence` cursor to page after — every message with `sequence > cursor` is a candidate
   *  (matches `subscribe_chat`'s `startAfter`, packages/shared/src/capabilities.ts). Omitted (or
   *  `"0"`) starts from the beginning. */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ChatHistoryPage {
  readonly messages: readonly ChatMessageRow[];
  /** Present only when a full page was returned — a caller that gets fewer than `limit` messages
   *  back has reached the end of the currently-persisted history. */
  readonly nextCursor?: string;
}

/** Parses a cursor string into a finite, non-negative sequence number; `undefined`/empty parses
 *  to `0` (the beginning). Never throws on a malformed cursor — treats it as `0` instead, since a
 *  bad cursor should degrade to "start over", not fail the whole call. */
function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function getChatHistory(
  client: PoolClient,
  workspaceId: string,
  input: GetChatHistoryInput,
): Promise<ChatHistoryPage> {
  await requireChatAccess(client, workspaceId, input.chatId);

  const cursor = parseCursor(input.cursor);
  const limit = input.limit ?? DEFAULT_CHAT_HISTORY_LIMIT;

  const result = await client.query<ChatMessageDbRow>(
    `select ${CHAT_MESSAGE_COLUMNS} from chat_messages
     where workspace_id = $1 and chat_id = $2 and sequence > $3
     order by sequence asc
     limit $4`,
    [workspaceId, input.chatId, cursor, limit],
  );
  const messages = result.rows.map(mapChatMessageRow);
  const last = messages.at(-1);
  const nextCursor = messages.length === limit && last ? String(last.sequence) : undefined;

  return nextCursor === undefined ? { messages } : { messages, nextCursor };
}
