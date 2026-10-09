import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import type { AgentRuntimeEvent, AgentRuntimeEventSink } from '../host-bridge/index.js';
import { publishChatPushEvent } from './push.js';
import {
  type ChatMessageRow,
  chatMessageKind,
  chatMessageText,
  insertChatMessage,
} from './service.js';
import {
  type EndedTurn,
  type MessagePersistFailure,
  endTurn,
  publishTurnEnded,
  recordMessagePersistFailure,
} from './turn-recovery.js';

/**
 * application/chat/event-sink: `createChatEventSink` implements `application/host-bridge`'s
 * `AgentRuntimeEventSink` (design doc §7.2 "chat 只消费平台事件"; docs/development-tasks.md S1.4
 * deliverable 2 "Turn completion path: consumes the runtime's platform events ... to persist
 * assistant/tool messages ... push chat.stream deltas ... then endActivity(status) + TurnEnded").
 *
 * This is the *only* place `application/chat` and `application/host-bridge` meet, and even here
 * neither module imports the other's internals — `application/chat` implements a port
 * `application/host-bridge` declares (`AgentRuntimeEventSink`), and `packages/kernel/src/index.ts`
 * (the composition root) is the one place that constructs this sink and hands it to
 * `FakeAgentRuntime`'s constructor. See host-bridge/index.ts's own doc comment for the full
 * wiring picture.
 *
 * Runs outside any HTTP/WS request's transaction: an `AgentRuntime` emits these events on its own
 * schedule (a timer, in `FakeAgentRuntime`'s case; a real event stream from agent-host once S1.5
 * lands), not inside a request handler — so, unlike every `CAPABILITY_HANDLERS` entry in
 * gateway/handlers.ts, this sink opens its own `withWorkspace()` transaction per persisted write
 * rather than receiving an already-open `client`.
 *
 * A `message` it cannot store (legacy 128): the runtime acknowledged the frame on arrival, so
 * agent-host will not send it again, and a later `completed` for the Turn would claim an answer the
 * history does not have. The sink records the loss on the Turn (`recordMessagePersistFailure`, its
 * own transaction — the insert's rolled back) so `endTurn` ends it `failed`, logs it, and does not
 * throw: the Turn stays running until the runtime reports its end, and later messages are still
 * stored. When the record cannot be written either (the database is unreachable), the loss is kept
 * here and written in the transaction that ends the Turn, ahead of `endTurn`.
 */

export interface ChatEventSinkDeps {
  readonly pool: PoolLike;
  /** Structured log lines (JSON) — defaults to `console.error`, like `AgentHostRuntime`'s. */
  readonly log?: (line: string) => void;
}

/** A pg error's SQLSTATE, or `null` for an error without one. */
function sqlStateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function toChatStreamPayload(
  event: Extract<AgentRuntimeEvent, { type: 'textDelta' | 'toolCallStarted' | 'toolCallEnded' }>,
) {
  switch (event.type) {
    case 'textDelta':
      return { streamKind: 'textDelta' as const, delta: event.delta };
    case 'toolCallStarted':
      return {
        streamKind: 'toolCallStarted' as const,
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
      };
    case 'toolCallEnded':
      return {
        streamKind: 'toolCallEnded' as const,
        toolCallId: event.toolCallId,
        result: event.result,
        ...(event.isError !== undefined ? { isError: event.isError } : {}),
      };
  }
}

export function createChatEventSink(deps: ChatEventSinkDeps): AgentRuntimeEventSink {
  const log = deps.log ?? ((line: string) => console.error(line));
  /** Lost messages not yet recorded on their Turn, by turnId — written when the Turn ends. */
  const unrecordedFailures = new Map<string, MessagePersistFailure>();

  async function recordLostMessage(
    event: Extract<AgentRuntimeEvent, { type: 'message' }>,
    err: unknown,
  ): Promise<void> {
    const failure: MessagePersistFailure = {
      firstAt: new Date(),
      count: 1,
      errorCode: sqlStateOf(err),
    };
    log(
      JSON.stringify({
        level: 'error',
        msg: 'chat event sink: could not store a runtime message — its Turn will not end completed',
        turnId: event.turnId,
        role: event.role,
        errorCode: failure.errorCode,
        error: String(err),
      }),
    );
    const earlier = unrecordedFailures.get(event.turnId);
    const pending: MessagePersistFailure = earlier
      ? { ...earlier, count: earlier.count + 1 }
      : failure;
    try {
      await withWorkspace(
        deps.pool,
        { workspaceId: event.workspaceId, principalId: event.principalId },
        (client) => recordMessagePersistFailure(client, event.workspaceId, event.turnId, pending),
      );
      unrecordedFailures.delete(event.turnId);
    } catch (recordErr) {
      unrecordedFailures.set(event.turnId, pending);
      log(
        JSON.stringify({
          level: 'error',
          msg: 'chat event sink: could not record the lost message on its Turn — recording it when the Turn ends',
          turnId: event.turnId,
          error: String(recordErr),
        }),
      );
    }
  }

  return {
    async handle(event: AgentRuntimeEvent): Promise<void> {
      switch (event.type) {
        case 'textDelta':
        case 'toolCallStarted':
        case 'toolCallEnded':
          // Ephemeral (§9.4 "chat.stream 永不持久化") — no DB write, straight to the push bus.
          publishChatPushEvent({
            type: 'chat.stream',
            chatId: event.chatId,
            turnId: event.turnId,
            payload: toChatStreamPayload(event),
          });
          return;

        case 'message': {
          let message: ChatMessageRow;
          try {
            message = await withWorkspace(
              deps.pool,
              { workspaceId: event.workspaceId, principalId: event.principalId },
              (client) =>
                insertChatMessage(client, event.workspaceId, {
                  chatId: event.chatId,
                  turnId: event.turnId,
                  role: event.role,
                  content: event.content,
                }),
            );
          } catch (err) {
            // Legacy 128 — module doc comment.
            await recordLostMessage(event, err);
            return;
          }
          publishChatPushEvent({
            type: 'chat.message',
            chatId: event.chatId,
            message: {
              id: message.id,
              // `message.role` is 'assistant' | 'tool' here (agent-runtime.ts's `message` variant
              // only allows those two) — a strict subset of both chat_messages.role's and the wire
              // ChatMessageEvent's four-way role enum, so this assigns without narrowing.
              role: message.role,
              text: chatMessageText(message.content),
              createdAt: message.createdAt.toISOString(),
              sequence: message.sequence,
              // Review fix (code-review finding "chat.message payload drift"): previously omitted
              // for this producer — only application/linkage's system-message push call sites set
              // `kind`/`content`, so a client checking `message.kind` worked for a system card but
              // not for an assistant/tool message, even though both are the same wire shape
              // (packages/shared/src/events.ts's `ChatMessageEvent`). `chatMessageKind` derives
              // `kind` the same way those call sites do — `undefined` here, since an
              // assistant/tool row's `content` never has its own `kind` field.
              kind: chatMessageKind(message.content),
              content: message.content,
              // S10 E1: the reply's Turn, so the console can hang the outcome control under it.
              turnId: message.turnId,
            },
          });
          return;
        }

        case 'turnEnded': {
          // R-55: through the one Turn transition (`endTurn`, turn-recovery.ts) — a no-op for a
          // Turn that already ended (a Stop, an accept timeout, the extension's `report_turn`), so
          // a late `completed` never overwrites `interrupted`/`failed`. When it does move the
          // Turn it also enqueues `TurnCompleted` and pushes `chat.metadata` (§13 "未完成 Turn 标
          // interrupted；下一轮注入'上轮中断'" — how a connected client learns the Turn ended),
          // the push only once the transaction has committed, like `chat.message` above: a client
          // told the Turn ended must find it ended, with its messages, when it reads history. A
          // lost message not yet recorded on the Turn is recorded first, so a `completed` here
          // ends it `failed` (legacy 128 — module doc comment).
          const unrecorded = unrecordedFailures.get(event.turnId);
          let ended: EndedTurn | undefined;
          try {
            ended = await withWorkspace(
              deps.pool,
              { workspaceId: event.workspaceId, principalId: event.principalId },
              async (client) => {
                if (unrecorded) {
                  await recordMessagePersistFailure(
                    client,
                    event.workspaceId,
                    event.turnId,
                    unrecorded,
                  );
                }
                return endTurn(client, event.workspaceId, event.turnId, event.status);
              },
            );
          } finally {
            // One `turnEnded` per Turn: nothing reads the entry after this, written or not.
            unrecordedFailures.delete(event.turnId);
          }
          publishTurnEnded(ended);
          return;
        }
      }
    },
  };
}
