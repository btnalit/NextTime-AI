import type { PoolClient } from 'pg';
import { enqueue } from '../../substrate/outbox/index.js';
import { publishChatPushEvent } from './push.js';

/**
 * application/chat/turn-recovery: `endUnknownRuntimeTurn` — the same two durable effects
 * `application/chat/event-sink.ts`'s `turnEnded` handler produces for a runtime-reported Turn end
 * (`endActivity` + enqueue `TurnCompleted`), plus the same `chat.metadata` push
 * `application/chat/recovery.ts`'s startup scan already sends, used instead when a caller learns —
 * via `AgentRuntime.stopTurn`'s boolean return (`application/host-bridge/agent-runtime.ts`) — that
 * the runtime has no record of a Turn it was asked to stop (lane-4 P1/P2 fix,
 * docs/development-tasks.md: "`stop_agent` on a Turn the runtime does not know ends the Activity
 * `interrupted` + enqueues `TurnCompleted`").
 *
 * Why this matters: before this fix, `stop_agent` (`application/gateway/handlers.ts`'s
 * `stopAgentHandler`) called `agentRuntime?.stopTurn(turnId)` and reported `{stopped: true}`
 * unconditionally whenever a `running` Turn existed in the DB — even when the runtime itself (e.g.
 * after a kernel/agent-host restart abandoned the Turn before this call, or any other reason the
 * runtime never heard of it) will *never* independently emit the `turnEnded` event that would
 * normally end the Activity. The Activity stayed `running` forever, permanently wedging the Chat
 * behind `activities_one_running_turn_per_chat_uidx` (`send_chat_message` →
 * `TurnAlreadyRunningError`), while `stop_agent` kept lying that it had stopped something.
 *
 * Ownership note (see this PR's own "deferred" list): this function is the reusable primitive —
 * `application/gateway/handlers.ts`'s `stopAgentHandler` is the call site that needs to invoke it
 * when `stopTurn` returns `false`, but `application/gateway/**` is outside this task's file
 * ownership (owned by a concurrently-developed lane), so that one-line wiring is left for that
 * lane/a follow-up, documented explicitly rather than silently left undone.
 *
 * Caller contract: `client`'s transaction must already be scoped to a principal with visibility
 * into `turnId`'s Activity (i.e. opened via `withWorkspace(pool, {workspaceId, principalId}, ...)`
 * for a principal `activities_visibility` (migrations/core/0003_chat.sql) admits) — the same
 * contract every other write in this module already assumes.
 */

/**
 * Ends `turnId` as `interrupted` and enqueues `TurnCompleted` — idempotent: the UPDATE is
 * conditioned on `status = 'running'`, so calling this for a Turn that has (or concurrently does)
 * already end for a real reason (a genuine runtime `turnEnded` racing in, or a second `stop_agent`
 * call) is a safe no-op — no duplicate `TurnCompleted`, no duplicate `chat.metadata` push. Returns
 * whether it actually ended anything.
 */
export async function endUnknownRuntimeTurn(
  client: PoolClient,
  workspaceId: string,
  chatId: string,
  turnId: string,
): Promise<boolean> {
  const result = await client.query(
    `update activities
     set status = 'interrupted', ended_at = now()
     where workspace_id = $1 and id = $2 and kind = 'agent_turn' and status = 'running'`,
    [workspaceId, turnId],
  );
  if ((result.rowCount ?? 0) === 0) return false;

  await enqueue(client, {
    type: 'TurnCompleted',
    workspaceId,
    chatId,
    turnId,
    status: 'interrupted',
  });
  publishChatPushEvent({
    type: 'chat.metadata',
    chatId,
    metadata: { turnId, turnStatus: 'interrupted' },
  });
  return true;
}
