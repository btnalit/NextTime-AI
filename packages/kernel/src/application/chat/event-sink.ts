import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { endActivity } from '../../substrate/epistemic/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import type { AgentRuntimeEvent, AgentRuntimeEventSink } from '../host-bridge/index.js';
import { publishChatPushEvent } from './push.js';
import { chatMessageText, insertChatMessage } from './service.js';

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
 */

export interface ChatEventSinkDeps {
  readonly pool: PoolLike;
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
      };
  }
}

export function createChatEventSink(deps: ChatEventSinkDeps): AgentRuntimeEventSink {
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
          const message = await withWorkspace(
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
            },
          });
          return;
        }

        case 'turnEnded': {
          await withWorkspace(
            deps.pool,
            { workspaceId: event.workspaceId, principalId: event.principalId },
            async (client) => {
              await endActivity(client, event.workspaceId, event.turnId, event.status);
              await enqueue(client, {
                type: 'TurnCompleted',
                workspaceId: event.workspaceId,
                chatId: event.chatId,
                turnId: event.turnId,
                status: event.status,
              });
            },
          );
          // §13 "未完成 Turn 标 interrupted；下一轮注入'上轮中断'" — chat.metadata is how a
          // currently-connected client learns the Turn ended without needing a separate
          // chat.stream taskUpdated/workerSpawned sub-kind (there is no Task yet in S1 scope).
          publishChatPushEvent({
            type: 'chat.metadata',
            chatId: event.chatId,
            metadata: { turnId: event.turnId, turnStatus: event.status },
          });
          return;
        }
      }
    },
  };
}
