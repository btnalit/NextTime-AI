import type { AdminAgentStopResultWire, AgentProposalTargetsWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import {
  type AdminAgentMembership,
  listAdminAgentMemberships,
  readAdminAgentStatus,
  readChosenTargetIds,
  requireAdminAgentMembership,
  setAdminAgentTargets,
} from '../admin-agent/targets.js';
import { revokeUserAdminAgentSessions } from '../identity/credentials.js';
import type {
  CapabilityHandler,
  CapabilityHandlerContext,
  CapabilityHandlerResult,
} from './capability-handler.js';
import { stopResidentContainers } from './resident-containers.js';

/**
 * application/gateway/admin-agent-handlers (S11 AA4c; the AA4c plan's D1, D3, D6, D7): what a
 * platform administrator does about their own admin agent in the console — `get_admin_agent_status`,
 * `set_admin_agent_targets`, `stop_admin_agent`, platform capabilities run in a platform
 * transaction as `ctx.platformUser` — and the agent's own read of its targets,
 * `agent_list_proposal_targets` (`adminAgentOnly`, in its trial workspace's transaction). Each acts
 * on the caller's own admin agent only: no param names another person. Dispatch writes each call's
 * audit row (one platform audit row per change of the targets, F5).
 */

function platformUserOf(
  name: string,
  ctx: CapabilityHandlerContext | undefined,
): NonNullable<CapabilityHandlerContext['platformUser']> {
  if (!ctx?.platformUser) {
    throw new Error(`${name}: no platform user in the call's context (a platform-scope call)`);
  }
  return ctx.platformUser;
}

export const getAdminAgentStatusHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  _params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const user = platformUserOf('get_admin_agent_status', ctx);
  return { result: await readAdminAgentStatus(client, user.id) };
};

export const setAdminAgentTargetsHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const user = platformUserOf('set_admin_agent_targets', ctx);
  const { trialWorkspaceId, targetWorkspaceIds } = params as {
    readonly trialWorkspaceId: string;
    readonly targetWorkspaceIds: readonly string[];
  };
  const result = await setAdminAgentTargets(client, user.id, trialWorkspaceId, targetWorkspaceIds);
  return {
    result,
    resourceType: 'workspace',
    resourceId: trialWorkspaceId,
    // What the params alone do not say: what the set was before, so the row reads as a change.
    auditPayload: {
      added: result.added,
      removed: result.removed,
      targets: result.targets.map((target) => target.workspaceId),
    },
  };
};

/** `agent_list_proposal_targets`: the ids the agent's administrator chose in this trial workspace —
 *  nothing else of those workspaces (D3). Dispatch has refused every caller but an admin agent's
 *  session; the read answers for the call's Principal alone (governance 0036). */
export const agentListProposalTargetsHandler: CapabilityHandler = async (
  client,
): Promise<CapabilityHandlerResult> => {
  const result: AgentProposalTargetsWire = {
    targetWorkspaceIds: await readChosenTargetIds(client),
  };
  return { result };
};

/** Stops one running Turn of `chatId` — what `stop_agent` does once it has the Chat — and returns
 *  what to run after the stopping transaction commits, if anything (handlers.ts supplies it: it
 *  holds the runtime). */
export type StopRunningTurn = (
  client: PoolClient,
  workspaceId: string,
  chatId: string,
  turnId: string,
) => Promise<(() => void) | undefined>;

/** The person's running admin agent Turns in one trial workspace, stopped as that person. */
async function stopAdminAgentTurns(
  pool: PoolLike,
  membership: AdminAgentMembership,
  stopRunningTurn: StopRunningTurn,
): Promise<number> {
  const after: Array<() => void> = [];
  const stopped = await withWorkspace(
    pool,
    { workspaceId: membership.workspaceId, principalId: membership.principalId },
    async (client) => {
      const running = await client.query<{ id: string; chat_id: string }>(
        `select id, chat_id from activities
          where workspace_id = $1 and kind = 'agent_turn' and status = 'running'
            and started_by = $2 and metadata ->> 'sessionKind' = 'admin_agent'
          order by created_at, id`,
        [membership.workspaceId, membership.principalId],
      );
      for (const turn of running.rows) {
        const continuation = await stopRunningTurn(
          client,
          membership.workspaceId,
          turn.chat_id,
          turn.id,
        );
        if (continuation !== undefined) after.push(continuation);
      }
      return running.rows.length;
    },
  );
  for (const continuation of after) continuation();
  return stopped;
}

/**
 * `stop_admin_agent {trialWorkspaceId?}` (D6): stops the caller's own admin agent in that trial
 * workspace, or in every one. Two phases, like `purge_workspace`: the platform transaction revokes
 * its `admin_agent` sessions and every Handle under them (what reaches llm-proxy at once), and is
 * the call's audit row; once that committed, each running admin agent Turn is stopped as its person
 * in their trial workspace, as `stop_agent` would, and then (S11 AA4c-2) its container is stopped,
 * best-effort: with its Handles revoked it could no longer act anyway. The next message in an admin
 * agent's Chat opens a new session, and a new container.
 */
export function stopAdminAgentHandlerWith(stopRunningTurn: StopRunningTurn): CapabilityHandler {
  return async (client, _workspaceId, params, ctx): Promise<CapabilityHandlerResult> => {
    const user = platformUserOf('stop_admin_agent', ctx);
    const { trialWorkspaceId } = params as { readonly trialWorkspaceId?: string };
    const memberships =
      trialWorkspaceId === undefined
        ? await listAdminAgentMemberships(client, user.id)
        : [await requireAdminAgentMembership(client, user.id, trialWorkspaceId)];
    const revoked =
      memberships.length === 0
        ? []
        : await revokeUserAdminAgentSessions(client, user.id, {
            workspaceIds: memberships.map((membership) => membership.workspaceId),
          });
    return {
      result: { revokedSessions: revoked.length, stoppedTurns: 0 },
      ...(trialWorkspaceId === undefined
        ? {}
        : { resourceType: 'workspace', resourceId: trialWorkspaceId }),
      auditPayload: {
        trialWorkspaceIds: memberships.map((membership) => membership.workspaceId),
        revokedSessionIds: [...revoked],
      },
      afterCommit: async (pool): Promise<AdminAgentStopResultWire> => {
        let stoppedTurns = 0;
        for (const membership of memberships) {
          stoppedTurns += await stopAdminAgentTurns(pool, membership, stopRunningTurn);
        }
        await stopResidentContainers(
          memberships.map((membership) => membership.principalId),
          ['admin_agent'],
        );
        return { revokedSessions: revoked.length, stoppedTurns };
      },
    };
  };
}
