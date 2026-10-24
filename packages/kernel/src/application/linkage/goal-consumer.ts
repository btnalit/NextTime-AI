import type { GoalRunChange } from '@nexttime/shared';
import { withWorkspace } from '../../adapters/db/pool.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import { insertChatMessage, publishChatPushEvent } from '../chat/index.js';
import { getGoalRun } from '../goal/index.js';
import type { OutboxDeliveryMeta } from '../outbox/index.js';
import { resolveGoalChat } from './chat-targets.js';
import { buildGoalUpdateContent } from './content.js';
import type { LinkageDeps } from './deps.js';
import { insertPendingContextItem } from './store.js';

/**
 * application/linkage/goal-consumer (S11 GO5e-2; plan §4.14 "对话：发起目标的对话里，里程碑以系统消息
 * 出现（复用 `system.task_update` 的通道），用户不用来回切页面"; §7.2 S1 "对话里出现里程碑消息"): the
 * `GoalRunUpdated` outbox consumer. Every change of a GoalRun becomes one `system.goal_update`
 * message in the goal's chat (`resolveGoalChat`: the chat it was proposed from), pushed to that
 * chat's subscribers; every change but the proposal also becomes a `goal_update` context item for
 * that chat's next Turn, so the entry agent learns that the requester confirmed the goal, that it
 * paused and why, or how it ended — the goal runs without the agent (plan §4.1), and the agent
 * otherwise hears of it only when the user asks and it reads the goal. The proposal is left out:
 * the agent that proposed it already knows, and a goal proposed in the console was not the agent's.
 *
 * Nothing here starts a Turn: a message and a context item wait for the user's next message
 * (§7.2 S1 "期间没有产生新的 `TurnStarted`").
 *
 * Same two-phase read/write and at-least-once dedupe as `task-consumer.ts` (see its doc comment):
 * the first read opens `withWorkspace` with the GoalRun's own id as an inert `principalId`
 * (`goal_runs` RLS is workspace-only); the writes run scoped to the requester, whose chat it is.
 * Both writes are idempotent on the outbox id (`chat_messages.source_outbox_id`,
 * `pending_context_items_dedupe_uidx`), and `seenOutboxIds` is filled only after they commit.
 */

type GoalRunUpdatedEvent = Extract<DomainEvent, { type: 'GoalRunUpdated' }>;

export interface GoalRunUpdatedSource {
  subscribe(
    eventType: 'GoalRunUpdated',
    consumer: (event: GoalRunUpdatedEvent, meta: OutboxDeliveryMeta) => Promise<void> | void,
  ): () => void;
}

/** The changes that are not a context item: see the module doc comment. */
const NOT_FOR_THE_AGENT: ReadonlySet<GoalRunChange> = new Set(['propose']);

/** Registers the `GoalRunUpdated` consumer on `dispatcher`. Returns an unsubscribe function. */
export function registerGoalRunUpdatedConsumer(
  dispatcher: GoalRunUpdatedSource,
  deps: LinkageDeps,
): () => void {
  const seenOutboxIds = new Set<string>();

  return dispatcher.subscribe('GoalRunUpdated', async (event, meta) => {
    if (seenOutboxIds.has(meta.outboxId)) return;

    const goal = await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: event.goalRunId },
      (client) => getGoalRun(client, event.workspaceId, event.goalRunId),
    );
    if (!goal) return;

    await withWorkspace(
      deps.pool,
      { workspaceId: event.workspaceId, principalId: goal.onBehalfOf },
      async (client) => {
        const chat = await resolveGoalChat(client, event.workspaceId, goal);
        const content = buildGoalUpdateContent({
          goalRunId: goal.id,
          change: event.change,
          status: event.status,
          run: goal,
        });
        const message = await insertChatMessage(client, event.workspaceId, {
          chatId: chat.id,
          turnId: null,
          role: 'system',
          content: content as unknown as Record<string, unknown>,
          sourceOutboxId: meta.outboxId,
        });
        publishChatPushEvent({
          type: 'chat.message',
          chatId: chat.id,
          message: {
            id: message.id,
            role: 'system',
            text: content.text,
            createdAt: message.createdAt.toISOString(),
            sequence: message.sequence,
            kind: content.kind,
            content: content as unknown as Record<string, unknown>,
          },
        });

        if (event.change !== undefined && NOT_FOR_THE_AGENT.has(event.change)) return;
        await insertPendingContextItem(client, event.workspaceId, {
          principalId: goal.onBehalfOf,
          chatId: chat.id,
          kind: 'goal_update',
          subjectId: goal.id,
          payload: content as unknown as Record<string, unknown>,
          sourceOutboxId: meta.outboxId,
        });
      },
    );

    seenOutboxIds.add(meta.outboxId);
  });
}
