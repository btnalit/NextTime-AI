import type { DomainEvent } from '../../substrate/outbox/index.js';
import type { OutboxDeliveryMeta } from '../outbox/index.js';
import type { AgentRuntime } from './agent-runtime.js';

type TurnStartedEvent = Extract<DomainEvent, { type: 'TurnStarted' }>;

/**
 * The minimal slice of `OutboxDispatcher` this module needs — a `subscribe` fixed to
 * `'TurnStarted'`, rather than depending on the dispatcher's full generic `subscribe<T>` (a real
 * `OutboxDispatcher` instance satisfies this narrower type; test fakes can implement it directly
 * without also having to be generic).
 */
export interface TurnStartedSource {
  subscribe(
    eventType: 'TurnStarted',
    consumer: (event: TurnStartedEvent, meta: OutboxDeliveryMeta) => Promise<void> | void,
  ): () => void;
}

/**
 * application/host-bridge/turn-started-consumer: subscribes an `AgentRuntime` to the outbox's
 * `TurnStarted` events (design doc §7.10 host-bridge row "把 pi 事件翻译为平台事件后发布"; §8.1 data
 * flow; docs/development-tasks.md S1.4 deliverable 5 "host-bridge subscribes to TurnStarted via
 * the outbox dispatcher and calls startTurn, prefixing the prompt with the
 * `<!--nexttime:turn_id=<id>-->` marker the extension expects").
 *
 * This is the one place that adds the marker (packages/platform-extension/src/modes/entry.ts's
 * `TURN_ID_MARKER` — the real S1.5 runtime's `pi` extension strips it back off before the model
 * ever sees it; `FakeAgentRuntime` just echoes it as part of the prompt).
 *
 * Idempotency (docs/development-tasks.md S1.4: "consumers idempotent (dedupe on the outbox row
 * id)", design doc §13 "outbox 派发器崩溃 ... 消费者幂等"): a bounded, process-lifetime `Set` of
 * already-started `outboxId`s. This is a best-effort guard, not a crash-durable one — a dispatcher
 * crash before this row's transaction commits means the row was never actually marked delivered
 * (OutboxDispatcher's own per-row-transaction design, dispatcher.ts's doc comment), so the
 * ordinary "undelivered row gets redelivered" case is not double-processing at all, just a first
 * successful attempt after a retry; this Set instead protects the narrower case of this *same*
 * process being handed the same outboxId more than once (e.g. two consumers racing a shared
 * dispatcher instance is not possible here — one dispatcher, one consumer registration — but a
 * caller that calls `registerTurnStartedConsumer` twice against the same dispatcher would
 * otherwise start every Turn twice). A crash-durable dedupe table is out of S1.4 scope.
 */

const MARKER_PREFIX = '<!--nexttime:turn_id=';
const MARKER_SUFFIX = '-->\n';

function withTurnIdMarker(turnId: string, prompt: string): string {
  return `${MARKER_PREFIX}${turnId}${MARKER_SUFFIX}${prompt}`;
}

/** Registers `runtime` to receive every `TurnStarted` domain event from `dispatcher`. Returns an
 *  unsubscribe function (see `OutboxDispatcher.subscribe`). */
export function registerTurnStartedConsumer(
  dispatcher: TurnStartedSource,
  runtime: AgentRuntime,
): () => void {
  const seenOutboxIds = new Set<string>();

  return dispatcher.subscribe('TurnStarted', async (event, meta) => {
    if (seenOutboxIds.has(meta.outboxId)) return;
    seenOutboxIds.add(meta.outboxId);

    await runtime.startTurn({
      workspaceId: event.workspaceId,
      chatId: event.chatId,
      turnId: event.turnId,
      principalId: event.principalId,
      prompt: withTurnIdMarker(event.turnId, event.prompt),
    });
  });
}
