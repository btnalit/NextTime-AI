import { TURN_TRANSITIONS, type TurnStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { enqueue } from '../../substrate/outbox/index.js';
import { publishChatPushEvent } from './push.js';

/**
 * application/chat/turn-recovery: the Turn-end primitives. `endTurn` is the one writer of a Turn's
 * terminal status (2026-10-02 review R-55) — `application/chat/event-sink.ts`'s `turnEnded`
 * handler, `endUnknownRuntimeTurn` below and `application/gateway/handlers.ts`'s `report_turn` all
 * end a Turn through it, so every move follows `@nexttime/shared`'s `TURN_TRANSITIONS` and carries
 * the same two effects: enqueue `TurnCompleted` and push `chat.metadata`. Before R-55 each writer
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
 * Caller contract: `client`'s transaction must already be scoped to a principal with visibility
 * into `turnId`'s Activity (i.e. opened via `withWorkspace(pool, {workspaceId, principalId}, ...)`
 * for a principal `activities_visibility` (migrations/core/0003_chat.sql) admits) — the same
 * contract every other write in this module already assumes.
 */

/** A Turn's terminal statuses — every `TurnStatus` but `running`. */
export type TurnEndStatus = Exclude<TurnStatus, 'running'>;

/** The states `TURN_TRANSITIONS` lets a Turn reach `status` from. */
function sourceStatesFor(status: TurnEndStatus): string[] {
  return TURN_TRANSITIONS.edges.filter((edge) => edge.to === status).map((edge) => edge.from);
}

/**
 * Moves `turnId` to `status` if `TURN_TRANSITIONS` allows it from the Turn's current state — today
 * only from `running` — and, when this call moved it, enqueues `TurnCompleted` and pushes
 * `chat.metadata`. A `completed` on a Turn whose stop was requested lands as `interrupted` (module
 * doc comment). Resolves with the status the Turn ended in, or `undefined` when it did not move
 * (already ended — by any writer, for any reason — or not visible): a duplicate or late report is a
 * no-op, with no second `TurnCompleted` and no push of a status the Turn does not have.
 */
export async function endTurn(
  client: PoolClient,
  workspaceId: string,
  turnId: string,
  status: TurnEndStatus,
): Promise<TurnEndStatus | undefined> {
  const result = await client.query<{ chat_id: string | null; status: TurnEndStatus }>(
    `update activities
     set status = case when $3::text = 'completed' and metadata ? 'stopRequestedAt'
                       then 'interrupted' else $3::text end,
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
    publishChatPushEvent({
      type: 'chat.metadata',
      chatId: row.chat_id,
      metadata: { turnId, turnStatus: row.status },
    });
  }
  return row.status;
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

/**
 * Ends `turnId` as `interrupted` through `endTurn` — idempotent: calling this for a Turn that has
 * (or concurrently does) already end for a real reason (a genuine runtime `turnEnded` racing in,
 * or a second `stop_agent` call) is a safe no-op — no duplicate `TurnCompleted`, no duplicate
 * `chat.metadata` push. Returns whether it actually ended anything. `_chatId` is the caller's own
 * view of the Turn's chat; the row's `chat_id` is what the effects use.
 */
export async function endUnknownRuntimeTurn(
  client: PoolClient,
  workspaceId: string,
  _chatId: string,
  turnId: string,
): Promise<boolean> {
  return (await endTurn(client, workspaceId, turnId, 'interrupted')) !== undefined;
}
