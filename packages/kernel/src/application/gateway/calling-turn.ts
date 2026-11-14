import type { PoolClient } from 'pg';
import { findAttributableTurn } from '../../application/host-bridge/index.js';
import type { CapabilityHandlerContext } from './capability-handler.js';

/**
 * application/gateway/calling-turn (legacy 443): the running Turn a capability call comes from, for
 * what records where it came from — `propose_goal`'s `originated_in_turn_id`, `invoke_worker`'s
 * `tasks.created_by_activity_id` (and through it the Chat a Task reports to, linkage
 * `resolveTaskChat`).
 *
 * A Turn is an agent's, so only a call through that agent's own session is part of one: the entry
 * agent's session (`sessions.kind = 'entry'`) — its person's running entry Turn — and an admin
 * agent's session — that session's own Turn (S11 AA4c, `findAttributableTurn`'s `adminSessionId`).
 * Nothing else comes from a Turn, whatever Turn the same person's agent happens to be running: a
 * person's own call (the human channel), a client a member issued a Handle to (`issue_handle`,
 * `mcp_session`), a service's Handle. A Worker run's own `invoke_worker` takes its root Task's Turn
 * instead (application/task `invoke.ts`), never this one.
 *
 * `adminSessionId`: the admin agent session the caller already checked (`invoke_worker`,
 * `assertAdminAgentInTrialWorkspace`); otherwise the one dispatch resolved (`ctx.adminAgent`).
 */
export async function callingTurnId(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  ctx: CapabilityHandlerContext | undefined,
  adminSessionId?: string,
): Promise<string | undefined> {
  const sid = ctx?.channel === 'handle' ? ctx.claims?.sid : undefined;
  if (!sid || !principalId) return undefined;
  const adminSession = adminSessionId ?? ctx?.adminAgent?.sessionId;
  if (adminSession === undefined) {
    const session = await client.query<{ kind: string }>(
      'select kind from sessions where workspace_id = $1 and id = $2',
      [workspaceId, sid],
    );
    if (session.rows[0]?.kind !== 'entry') return undefined;
  }
  const turn = await findAttributableTurn(client, {
    workspaceId,
    principalId,
    at: new Date(),
    ...(adminSession === undefined ? {} : { adminSessionId: adminSession }),
  });
  return turn?.wasRunning ? turn.id : undefined;
}
