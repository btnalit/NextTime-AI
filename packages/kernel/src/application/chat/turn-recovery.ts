import { TURN_TRANSITIONS, type TurnStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { enqueue } from '../../substrate/outbox/index.js';
import { publishChatPushEvent } from './push.js';

/**
 * application/chat/turn-recovery: the Turn-end primitives. `endTurn` is the one writer of a Turn's
 * terminal status (2026-10-02 review R-55) — `application/chat/event-sink.ts`'s `turnEnded`
 * handler, `endUnknownRuntimeTurn` below and `application/gateway/handlers.ts`'s `report_turn` all
 * end a Turn through it, so every move follows `@nexttime/shared`'s `TURN_TRANSITIONS` and carries
 * the same two effects: enqueue `TurnCompleted` (in the transaction) and push `chat.metadata`
 * (`publishTurnEnded`, after the commit — see below). Before R-55 each writer
 * had its own UPDATE and the runtime's was unguarded: a `completed` that arrived after a Stop
 * (`interrupted`) or an accept timeout (`failed`) overwrote it. `application/chat/recovery.ts`'s
 * startup scan is the one other writer — a bulk `running → interrupted`, the same `interrupt`
 * edge — and keeps its own statement because it runs before anything can push to a client.
 *
 * `endUnknownRuntimeTurn` is used when a caller learns — via `AgentRuntime.stopTurn`'s boolean
 * return (`application/host-bridge/agent-runtime.ts`) — that the runtime has no record of a Turn
 * it was asked to stop (lane-4 P1/P2 fix, docs/development-tasks.md: "`stop_agent` on a Turn the
 * runtime does not know ends the Activity `interrupted` + enqueues `TurnCompleted`"). Before that
 * fix `stop_agent` reported `{stopped: true}` while the Activity stayed `running` forever, wedging
 * the Chat behind `activities_one_running_turn_per_chat_uidx` (`send_chat_message` →
 * `TurnAlreadyRunningError`).
 *
 * Stop intent (R-55): `requestTurnStop` records `metadata.stopRequestedAt` on the running Turn
 * before `stop_agent` signals the runtime, and `endTurn` reads a later `completed` on such a Turn
 * as `interrupted` — the same rule agent-host already applies to its own report (`stopRequested ?
 * 'interrupted' : 'completed'`), held here too because the entry extension's `report_turn` races
 * agent-host's `turnEnded` after an abort and the first writer now wins.
 *
 * Lost messages (STATUS legacy 128): a `message` the runtime handed over — its frame already
 * acknowledged, so agent-host will not send it again — that the kernel could not store is
 * recorded on the Turn (`recordMessagePersistFailure`, `metadata.messagePersistFailure`), and
 * `endTurn` reads a later `completed` on such a Turn as `failed`: `completed` would claim an answer
 * the history does not have. Stop intent still comes first (a stopped Turn ends `interrupted`, as
 * before); the record stays on the Turn whatever it ends as.
 *
 * Push after commit: `endTurn` only writes; the caller pushes the returned `EndedTurn` with
 * `publishTurnEnded` once its transaction has committed (the event sink after `withWorkspace`, a
 * capability handler from `afterCommit`). A push from inside the transaction told a connected client
 * the Turn had ended while the row — and a reader of `get_chat_history` — still said `running`, or
 * said nothing at all if the transaction then rolled back.
 *
 * Caller contract: `client`'s transaction must already be scoped to a principal with visibility
 * into `turnId`'s Activity (i.e. opened via `withWorkspace(pool, {workspaceId, principalId}, ...)`
 * for a principal `activities_visibility` (migrations/core/0003_chat.sql) admits) — the same
 * contract every other write in this module already assumes.
 */

/** A Turn's terminal statuses — every `TurnStatus` but `running`. */
export type TurnEndStatus = Exclude<TurnStatus, 'running'>;

/** What `endTurn` moved: the status the Turn landed in and its Chat (`null` for a Turn without
 *  one) — the input `publishTurnEnded` needs once the caller's transaction has committed. */
export interface EndedTurn {
  readonly turnId: string;
  readonly status: TurnEndStatus;
  readonly chatId: string | null;
}

/** The states `TURN_TRANSITIONS` lets a Turn reach `status` from. */
function sourceStatesFor(status: TurnEndStatus): string[] {
  return TURN_TRANSITIONS.edges.filter((edge) => edge.to === status).map((edge) => edge.from);
}

/**
 * Moves `turnId` to `status` if `TURN_TRANSITIONS` allows it from the Turn's current state — today
 * only from `running` — and, when this call moved it, enqueues `TurnCompleted` in the same
 * transaction. A `completed` on a Turn whose stop was requested lands as `interrupted`, and
 * otherwise on a Turn that lost a message as `failed` (module doc comment). Resolves with what
 * moved, for the caller to `publishTurnEnded` after its commit,
 * or `undefined` when it did not move (already ended — by any writer, for any reason — or not
 * visible): a duplicate or late report is a no-op, with no second `TurnCompleted` and nothing to
 * push.
 */
export async function endTurn(
  client: PoolClient,
  workspaceId: string,
  turnId: string,
  status: TurnEndStatus,
): Promise<EndedTurn | undefined> {
  const result = await client.query<{ chat_id: string | null; status: TurnEndStatus }>(
    `update activities
     set status = case when $3::text = 'completed' and metadata ? 'stopRequestedAt'
                       then 'interrupted'
                       when $3::text = 'completed' and metadata ? 'messagePersistFailure'
                       then 'failed'
                       else $3::text end,
         ended_at = now()
     where workspace_id = $1 and id = $2 and kind = 'agent_turn' and status = any($4::text[])
     returning chat_id, status`,
    [workspaceId, turnId, status, sourceStatesFor(status)],
  );
  const row = result.rows[0];
  if (!row) return undefined;

  if (row.chat_id !== null) {
    await enqueue(client, {
      type: 'TurnCompleted',
      workspaceId,
      chatId: row.chat_id,
      turnId,
      status: row.status,
    });
  }
  return { turnId, status: row.status, chatId: row.chat_id };
}

/**
 * Tells connected clients a Turn ended (`chat.metadata`) — call only once the transaction that
 * `endTurn` wrote in has committed (module doc comment). A no-op for `undefined` (nothing moved) and
 * for a Turn without a Chat.
 */
export function publishTurnEnded(ended: EndedTurn | undefined): void {
  if (!ended || ended.chatId === null) return;
  publishChatPushEvent({
    type: 'chat.metadata',
    chatId: ended.chatId,
    metadata: { turnId: ended.turnId, turnStatus: ended.status },
  });
}

/**
 * Records that the user asked `turnId` to stop (`metadata.stopRequestedAt`) — a no-op unless the
 * Turn is still running. `stop_agent` calls it before signalling the runtime, so the row lock it
 * takes orders it ahead of any `report_turn` the resulting abort produces.
 */
export async function requestTurnStop(
  client: PoolClient,
  workspaceId: string,
  turnId: string,
): Promise<void> {
  await client.query(
    `update activities
     set metadata = metadata || jsonb_build_object('stopRequestedAt', now())
     where workspace_id = $1 and id = $2 and kind = 'agent_turn' and status = 'running'`,
    [workspaceId, turnId],
  );
}

/** Messages the kernel received for a Turn and could not store (legacy 128) — see
 *  `recordMessagePersistFailure`. */
export interface MessagePersistFailure {
  /** When the first of them failed. */
  readonly firstAt: Date;
  readonly count: number;
  /** The first failure's SQLSTATE (`22P05` for text `jsonb` cannot hold), or `null` for an error
   *  that carries none. The full error goes to the log only. */
  readonly errorCode: string | null;
}

/**
 * Records on `turnId` (`metadata.messagePersistFailure`) that `failure.count` more of its messages
 * could not be stored — merged into what is already there (earliest `firstAt`, summed `count`,
 * first `errorCode`), whatever the Turn's status. `endTurn` then reads a `completed` on the Turn
 * as `failed` (module doc comment).
 */
export async function recordMessagePersistFailure(
  client: PoolClient,
  workspaceId: string,
  turnId: string,
  failure: MessagePersistFailure,
): Promise<void> {
  await client.query(
    `update activities
     set metadata = metadata || jsonb_build_object('messagePersistFailure', jsonb_build_object(
           'firstAt', least((metadata->'messagePersistFailure'->>'firstAt')::timestamptz,
                            $3::timestamptz),
           'count', coalesce((metadata->'messagePersistFailure'->>'count')::int, 0) + $4::int,
           'errorCode', coalesce(metadata->'messagePersistFailure'->'errorCode', to_jsonb($5::text))))
     where workspace_id = $1 and id = $2 and kind = 'agent_turn'`,
    [workspaceId, turnId, failure.firstAt.toISOString(), failure.count, failure.errorCode],
  );
}

/**
 * Ends `turnId` as `interrupted` through `endTurn` — idempotent: calling this for a Turn that has
 * (or concurrently does) already end for a real reason (a genuine runtime `turnEnded` racing in,
 * or a second `stop_agent` call) is a safe no-op — no duplicate `TurnCompleted`, nothing to push.
 * Resolves with what it ended (for `publishTurnEnded` after the caller's commit), or `undefined`.
 * `_chatId` is the caller's own view of the Turn's chat; the row's `chat_id` is what the effects
 * use.
 */
export async function endUnknownRuntimeTurn(
  client: PoolClient,
  workspaceId: string,
  _chatId: string,
  turnId: string,
): Promise<EndedTurn | undefined> {
  return endTurn(client, workspaceId, turnId, 'interrupted');
}
