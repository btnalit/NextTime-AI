import type { ChangePlanSegmentProposalWire, ChangePlanStatus } from '@nexttime/shared';
import {
  type ChangePlanScope,
  checkChangePlanProposal,
  getChangePlan,
  listChangePlans,
  proposeChangePlan,
  withdrawChangePlan,
} from '../change-plan/index.js';
import { loadPackRegistry } from '../packs/index.js';
import type {
  CapabilityHandler,
  CapabilityHandlerContext,
  CapabilityHandlerResult,
} from './capability-handler.js';

/**
 * application/gateway/change-plan-proposal-handlers (S11 AA3b-1): ChangePlan proposals
 * (application/change-plan/proposals.ts; migrations/governance/0032).
 *
 *  - The `change_plan` group (`adminAgentOnly`): what an admin agent proposes from its trial
 *    workspace and reads back — only its own administrator's plans there (F12) — and withdraws.
 *    Dispatch has already checked the agent's authority (I-A1, I-A6) and gives `ctx.adminAgent`.
 *  - Three `platform` capabilities: a platform administrator in the console reads every plan and
 *    withdraws one, in a platform transaction (`ctx.platformUser`).
 *
 * Every one runs in the call's own transaction, whose audit row dispatch writes.
 */

/** Dispatch sets `ctx.adminAgent` for an admin agent's call and refuses every other caller of an
 *  `adminAgentOnly` capability first (`AdminAgentOnlyError`), so a call without it here is a wiring
 *  bug, not a caller to answer. */
function adminAgentOf(
  name: string,
  ctx: CapabilityHandlerContext | undefined,
): NonNullable<CapabilityHandlerContext['adminAgent']> {
  if (!ctx?.adminAgent) {
    throw new Error(`${name}: no admin agent in the call's context (dispatch refuses any other)`);
  }
  return ctx.adminAgent;
}

/** A platform capability's acting administrator (dispatch's platform branch sets it). */
function platformUserOf(
  name: string,
  ctx: CapabilityHandlerContext | undefined,
): NonNullable<CapabilityHandlerContext['platformUser']> {
  if (!ctx?.platformUser) {
    throw new Error(`${name}: no platform user in the call's context (a platform-scope call)`);
  }
  return ctx.platformUser;
}

/** F12: on the agent's side, the plans its administrator proposed in this trial workspace. */
function agentScope(workspaceId: string, userId: string): ChangePlanScope {
  return { workspaceId, proposedByUser: userId };
}

/** The packs this deployment ships, whose names a plan's own source name must not take. */
async function shippedPackNames(): Promise<ReadonlySet<string>> {
  return new Set((await loadPackRegistry()).keys());
}

interface ProposeChangePlanParams {
  readonly title: string;
  readonly description?: string;
  readonly sourceName: string;
  readonly segments: readonly ChangePlanSegmentProposalWire[];
}

export const proposeChangePlanHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const agent = adminAgentOf('propose_change_plan', ctx);
  const input = params as ProposeChangePlanParams;
  const segments = checkChangePlanProposal(input, await shippedPackNames());
  const plan = await proposeChangePlan(
    client,
    {
      workspaceId,
      principalId: ctx?.principalId ?? '',
      userId: agent.userId,
      sessionId: agent.sessionId,
    },
    input,
    segments,
  );
  return {
    result: plan,
    resourceType: 'change_plan',
    resourceId: plan.id,
    auditPayload: {
      contentDigest: plan.contentDigest,
      segments: plan.segments.map((segment) => ({
        ordinal: segment.ordinal,
        targetWorkspaceId: segment.targetWorkspaceId,
        contentDigest: segment.contentDigest,
        items: segment.items.length,
      })),
    },
  };
};

export const agentListChangePlansHandler: CapabilityHandler = async (
  client,
  workspaceId,
  _params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const agent = adminAgentOf('agent_list_change_plans', ctx);
  return { result: await listChangePlans(client, agentScope(workspaceId, agent.userId)) };
};

export const agentGetChangePlanHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const agent = adminAgentOf('agent_get_change_plan', ctx);
  const { planId } = params as { readonly planId: string };
  return {
    result: await getChangePlan(client, planId, agentScope(workspaceId, agent.userId)),
    resourceType: 'change_plan',
    resourceId: planId,
  };
};

export const agentWithdrawChangePlanHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const agent = adminAgentOf('agent_withdraw_change_plan', ctx);
  const { planId, reason } = params as { readonly planId: string; readonly reason?: string };
  const plan = await withdrawChangePlan(
    client,
    planId,
    agentScope(workspaceId, agent.userId),
    agent.userId,
    reason,
  );
  return { result: plan, resourceType: 'change_plan', resourceId: planId };
};

export const listChangePlansHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  platformUserOf('list_change_plans', ctx);
  const { status } = params as { readonly status?: ChangePlanStatus };
  return { result: await listChangePlans(client, {}, status) };
};

export const getChangePlanHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  platformUserOf('get_change_plan', ctx);
  const { planId } = params as { readonly planId: string };
  return {
    result: await getChangePlan(client, planId, {}),
    resourceType: 'change_plan',
    resourceId: planId,
  };
};

export const withdrawChangePlanHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const user = platformUserOf('withdraw_change_plan', ctx);
  const { planId, reason } = params as { readonly planId: string; readonly reason?: string };
  const plan = await withdrawChangePlan(client, planId, {}, user.id, reason);
  return { result: plan, resourceType: 'change_plan', resourceId: planId };
};
