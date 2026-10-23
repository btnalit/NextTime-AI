import type { PoolClient } from 'pg';
import type { ChatRow } from '../chat/index.js';
import {
  findChatIdForActionPending,
  listChats,
  newChat,
  requireChatAccess,
} from '../chat/index.js';
import { getGoalRun } from '../goal/index.js';
import { readTaskGoalStep, taskForWorkerRun } from '../task/index.js';

/**
 * application/linkage/chat-targets: "which Chat does this system message go into" — the rules
 * `application/linkage`'s consumers need (docs/development-tasks.md S2.11 deliverable 1: "a system
 * message into the on_behalf_of user's Chat that generated the Task (find the chat via the Task's
 * originating Turn)"; "into each holder's most recent (or a new) Chat"). The same Chat is the one
 * the matching `pending_context_items` row belongs to (R-57 / D-23), and an ActionRequest's
 * requester gets the Chat of the Task whose Worker raised it (`resolveRequesterChat`).
 *
 * Reads `activities.chat_id` directly with parameterized SQL rather than adding a new
 * `substrate/epistemic` read method — the same precedent `application/host-bridge/
 * turn-attribution.ts`'s own doc comment documents ("`activities` is owned by `core`... this file
 * reads it directly... matching the existing precedent") and `application/chat/service.ts`'s own
 * `findRunningTurn` already establishes for this exact table.
 */

/** The most recently created Chat `principalId` owns, or a newly created one if they have none
 *  yet. Used both as the ActionRequest-holder target and as the Task-chat fallback below. */
export async function resolveDefaultChat(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<ChatRow> {
  const chats = await listChats(client, workspaceId, principalId); // ordered created_at desc
  const mostRecent = chats[0];
  if (mostRecent) return mostRecent;
  return newChat(client, workspaceId, principalId, {});
}

/**
 * The Chat an ActionRequest's `system.action_update` messages belong to (leftover 78,
 * docs/STATUS.md §4): pinned to whichever Chat already holds `principalId`'s own
 * `system.action_pending` message for `actionRequestId` (`findChatIdForActionPending`) — never
 * re-derived per event the way `resolveDefaultChat`'s "most recently created Chat" rule is, which
 * can drift to a different Chat if `principalId` creates a new one between the `pending` and
 * `updated` events. Falls back to `resolveRequesterChat` (the requester) / `resolveDefaultChat`
 * (anyone else: pass `parentWorkerRunId: null`) only when no pending message is found (e.g. a
 * pre-fix ActionRequest that has no `system.action_pending` row to pin to).
 */
export async function resolveActionRequestChat(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  actionRequestId: string,
  parentWorkerRunId: string | null,
): Promise<ChatRow> {
  const pinnedChatId = await findChatIdForActionPending(client, workspaceId, actionRequestId);
  if (pinnedChatId) return requireChatAccess(client, workspaceId, pinnedChatId);
  return resolveRequesterChat(client, workspaceId, principalId, parentWorkerRunId);
}

/**
 * The Chat an ActionRequest belongs to for its requester (2026-10-02 review R-57, decision D-23:
 * "items belong to the chat that started them"): a Worker raises it (`parent_worker_run_id`), so it
 * is the Chat of that Worker's Task — `resolveTaskChat`, the Chat whose Turn invoked the Worker.
 * `resolveDefaultChat` when there is no Worker parent (a human-channel `request_action`), when the
 * Task is not `principalId`'s own, or when `parentWorkerRunId` is `null` because the caller is
 * resolving for a holder rather than the requester. Same caller contract as `resolveTaskChat`.
 */
export async function resolveRequesterChat(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  parentWorkerRunId: string | null,
): Promise<ChatRow> {
  if (parentWorkerRunId) {
    const task = await taskForWorkerRun(client, workspaceId, parentWorkerRunId);
    if (task && task.onBehalfOf === principalId) return resolveTaskChat(client, workspaceId, task);
  }
  return resolveDefaultChat(client, workspaceId, principalId);
}

/**
 * The Chat a Task "belongs to" for chat-linkage purposes: the Chat of the Turn that invoked it
 * (`tasks.created_by_activity_id → activities.chat_id`); for a Task with no Turn attribution that
 * runs for a goal's step (S11 GO5e-2: its attempt, which the advancer creates outside any Turn, or
 * a Task its Worker invoked), the goal's Chat (`resolveGoalChat`) — so a goal's progress lands in
 * the conversation it was proposed from; otherwise `resolveDefaultChat` (e.g. invoked from the
 * human channel with no running Turn — `invoke.ts`'s own doc comment on when that column is null).
 *
 * Caller contract: `client`'s transaction must already be scoped to `onBehalfOf` (i.e. opened via
 * `withWorkspace(pool, {workspaceId, principalId: onBehalfOf}, ...)`) — both `activities` and
 * `chats` RLS require it to see the row at all.
 */
export async function resolveTaskChat(
  client: PoolClient,
  workspaceId: string,
  task: {
    readonly id: string;
    readonly onBehalfOf: string;
    readonly createdByActivityId: string | null;
  },
): Promise<ChatRow> {
  if (task.createdByActivityId) {
    const chatId = await activityChatId(client, workspaceId, task.createdByActivityId);
    if (chatId) return requireChatAccess(client, workspaceId, chatId);
  }
  const goalStep = await readTaskGoalStep(client, workspaceId, task.id);
  if (goalStep) {
    const goal = await getGoalRun(client, workspaceId, goalStep.goalRunId);
    // A step's Task runs for the goal's requester (`step-attempt.ts`, `invoke.ts`'s inheritance).
    if (goal && goal.onBehalfOf === task.onBehalfOf) {
      return resolveGoalChat(client, workspaceId, goal);
    }
  }
  return resolveDefaultChat(client, workspaceId, task.onBehalfOf);
}

/**
 * The Chat a GoalRun "belongs to" (S11 GO5e-2, plan §4.14 "发起目标的对话里，里程碑以系统消息出现"):
 * the Chat of the Turn it was proposed in (`goal_runs.originated_in_turn_id → activities.chat_id`),
 * or the requester's `resolveDefaultChat` for a goal proposed with no Turn behind it (the console,
 * or a Handle call outside any Turn). Same caller contract as `resolveTaskChat`, scoped to the
 * goal's requester (`onBehalfOf`).
 */
export async function resolveGoalChat(
  client: PoolClient,
  workspaceId: string,
  goal: { readonly onBehalfOf: string; readonly originatedInTurnId: string | null },
): Promise<ChatRow> {
  if (goal.originatedInTurnId) {
    const chatId = await activityChatId(client, workspaceId, goal.originatedInTurnId);
    if (chatId) return requireChatAccess(client, workspaceId, chatId);
  }
  return resolveDefaultChat(client, workspaceId, goal.onBehalfOf);
}

async function activityChatId(
  client: PoolClient,
  workspaceId: string,
  activityId: string,
): Promise<string | null> {
  const result = await client.query<{ chat_id: string | null }>(
    'select chat_id from activities where workspace_id = $1 and id = $2',
    [workspaceId, activityId],
  );
  return result.rows[0]?.chat_id ?? null;
}
