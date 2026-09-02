import type { PoolClient } from 'pg';
import { startActivity } from '../../substrate/epistemic/index.js';
import { enqueue } from '../../substrate/outbox/index.js';

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
}

interface ChatDbRow {
  workspace_id: string;
  id: string;
  owner_principal_id: string;
  title: string | null;
  visibility: string;
  created_at: Date;
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
}

const CHAT_COLUMNS = 'workspace_id, id, owner_principal_id, title, visibility, created_at';
const CHAT_MESSAGE_COLUMNS =
  'workspace_id, id, chat_id, turn_id, role, content, sequence, created_at';

function mapChatRow(row: ChatDbRow): ChatRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    title: row.title,
    visibility: row.visibility,
    createdAt: row.created_at,
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

export async function listChats(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<readonly ChatRow[]> {
  const result = await client.query<ChatDbRow>(
    `select ${CHAT_COLUMNS} from chats
     where workspace_id = $1 and owner_principal_id = $2
     order by created_at desc`,
    [workspaceId, principalId],
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
  const result = await client.query<ChatDbRow>(
    `insert into chats (workspace_id, owner_principal_id, title)
     values ($1, $2, $3)
     returning ${CHAT_COLUMNS}`,
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
    `select ${CHAT_COLUMNS} from chats where workspace_id = $1 and id = $2`,
    [workspaceId, chatId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ChatNotFoundError(workspaceId, chatId);
  return mapChatRow(row);
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
 */
export async function insertChatMessage(
  client: PoolClient,
  workspaceId: string,
  input: InsertChatMessageInput,
): Promise<ChatMessageRow> {
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [input.chatId]);

  const result = await client.query<ChatMessageDbRow>(
    `insert into chat_messages (workspace_id, chat_id, turn_id, role, content, sequence)
     select $1, $2, $3, $4, $5::jsonb,
       coalesce(
         (select max(sequence) from chat_messages where workspace_id = $1 and chat_id = $2),
         0
       ) + 1
     returning ${CHAT_MESSAGE_COLUMNS}`,
    [workspaceId, input.chatId, input.turnId, input.role, JSON.stringify(input.content)],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('insertChatMessage: INSERT ... RETURNING produced no row');
  return mapChatMessageRow(row);
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
  await requireChatAccess(client, workspaceId, input.chatId);

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

  await enqueue(client, {
    type: 'TurnStarted',
    workspaceId,
    chatId: input.chatId,
    turnId,
    principalId,
    prompt: input.text,
  });

  return { message, turnId };
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
