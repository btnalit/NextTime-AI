import type {
  AdminProposalPlatformSegmentInputWire,
  AdminProposalSegmentApplyResultWire,
  AdminProposalSegmentInputWire,
  AdminProposalSegmentStatus,
  AdminProposalStatus,
} from '@nexttime/shared';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import { credentialReviewAudit } from '../../governance/redaction/index.js';
import {
  type AdminProposalScope,
  type AdminProposalWorkerGateChoice,
  agentProposalOf,
  applyAdminProposalSegment,
  checkAdminProposal,
  countAdminProposalSegments,
  getAdminProposal,
  listAdminProposalSegments,
  listAdminProposals,
  previewAdminProposalSegment,
  proposeAdminProposal,
  rejectAdminProposalSegment,
  verifyChangeSegment,
  withdrawAdminProposal,
} from '../change-plan/index.js';
import { loadPackRegistry } from '../packs/index.js';
import type {
  CapabilityHandler,
  CapabilityHandlerContext,
  CapabilityHandlerResult,
} from './capability-handler.js';
import { toChangeVerificationWire } from './change-segment-handlers.js';
import { sourceRequirementsChecker } from './change-verification.js';

/**
 * application/gateway/admin-proposal-handlers (S11 AA3b-1): Admin proposals
 * (application/change-plan/admin-proposals.ts; migrations/governance/0032).
 *
 *  - The `admin_proposal` group (`adminAgentOnly`): what an admin agent proposes from its trial
 *    workspace and reads back — only its own administrator's proposals there (F12) — and withdraws.
 *    Dispatch has already checked the agent's authority (I-A1, I-A6) and gives `ctx.adminAgent`.
 *  - Three `platform` capabilities: a platform administrator in the console reads every proposal and
 *    withdraws one, in a platform transaction (`ctx.platformUser`).
 *  - S11 AA3b-2, the `modules` group: the owner of a workspace a segment is addressed to lists,
 *    previews, applies and rejects it (application/change-plan/admin-proposal-segments.ts) — human
 *    channel, owner, a person (`actsForPerson`, `HUMAN_ONLY`), in the workspace's transaction.
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

/**
 * Who reads a proposal, from what dispatch established about the call — never from its params, and
 * never from its Principal: an admin agent acts as its administrator's own Principal (AA1), so
 * only the session kind tells the two apart. Dispatch sets `ctx.adminAgent` exactly when the
 * call came through an `admin_agent` session, and `ctx.platformUser` only on the platform
 * channel (a console session's cookie; no Handle reaches it). An admin agent is `agent` whatever
 * else the context carries (coordinator 2026-11-02).
 */
export function adminProposalReaderOf(
  name: string,
  ctx: CapabilityHandlerContext | undefined,
): AdminProposalScope['reader'] {
  if (ctx?.adminAgent) return 'agent';
  if (ctx?.platformUser) return 'platform';
  throw new Error(`${name}: neither an admin agent nor a platform user in the call's context`);
}

/** F12: on the agent's side, the proposals its administrator proposed in this trial workspace — read
 *  as the agent reads them (no owner's reason for a rejection). */
function agentScope(
  name: string,
  workspaceId: string,
  userId: string,
  ctx: CapabilityHandlerContext | undefined,
): AdminProposalScope {
  return { workspaceId, proposedByUser: userId, reader: adminProposalReaderOf(name, ctx) };
}

/** A platform administrator's: every proposal — and why an owner rejected a segment, unless the call
 *  is an admin agent's (which the platform channel never is). */
function platformScope(
  name: string,
  ctx: CapabilityHandlerContext | undefined,
): AdminProposalScope {
  return { reader: adminProposalReaderOf(name, ctx) };
}

/** The packs this deployment ships, whose names a proposal's own source name must not take. */
async function shippedPackNames(): Promise<ReadonlySet<string>> {
  return new Set((await loadPackRegistry()).keys());
}

interface ProposeAdminProposalParams {
  readonly title: string;
  readonly description?: string;
  readonly sourceName: string;
  readonly segments: readonly AdminProposalSegmentInputWire[];
  readonly platform?: AdminProposalPlatformSegmentInputWire;
}

export const proposeAdminProposalHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const agent = adminAgentOf('propose_admin_proposal', ctx);
  const input = params as ProposeAdminProposalParams;
  const checked = checkAdminProposal(input, await shippedPackNames());
  const proposal = await proposeAdminProposal(
    client,
    {
      workspaceId,
      principalId: ctx?.principalId ?? '',
      userId: agent.userId,
      sessionId: agent.sessionId,
    },
    input,
    checked,
  );
  return {
    result: proposal,
    resourceType: 'admin_proposal',
    resourceId: proposal.id,
    auditPayload: {
      contentDigest: proposal.contentDigest,
      segments: proposal.segments.map((segment) => ({
        ordinal: segment.ordinal,
        authority: segment.authority,
        targetWorkspaceId: segment.targetWorkspaceId,
        contentDigest: segment.contentDigest,
        items: segment.items.length,
      })),
    },
  };
};

export const agentListAdminProposalsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  _params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const agent = adminAgentOf('agent_list_admin_proposals', ctx);
  return {
    result: await listAdminProposals(
      client,
      agentScope('agent_list_admin_proposals', workspaceId, agent.userId, ctx),
    ),
  };
};

export const agentGetAdminProposalHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const agent = adminAgentOf('agent_get_admin_proposal', ctx);
  const { proposalId } = params as { readonly proposalId: string };
  return {
    result: agentProposalOf(
      await getAdminProposal(
        client,
        proposalId,
        agentScope('agent_get_admin_proposal', workspaceId, agent.userId, ctx),
      ),
    ),
    resourceType: 'admin_proposal',
    resourceId: proposalId,
  };
};

export const agentWithdrawAdminProposalHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const agent = adminAgentOf('agent_withdraw_admin_proposal', ctx);
  const { proposalId, reason } = params as {
    readonly proposalId: string;
    readonly reason?: string;
  };
  const proposal = await withdrawAdminProposal(
    client,
    proposalId,
    agentScope('agent_withdraw_admin_proposal', workspaceId, agent.userId, ctx),
    agent.userId,
    reason,
  );
  return {
    result: agentProposalOf(proposal),
    resourceType: 'admin_proposal',
    resourceId: proposalId,
  };
};

export const listAdminProposalsHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  platformUserOf('list_admin_proposals', ctx);
  const { status, platformSegmentStatus } = params as {
    readonly status?: AdminProposalStatus;
    readonly platformSegmentStatus?: AdminProposalSegmentStatus;
  };
  return {
    result: await listAdminProposals(client, platformScope('list_admin_proposals', ctx), {
      status,
      platformSegmentStatus,
    }),
  };
};

export const getAdminProposalHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  platformUserOf('get_admin_proposal', ctx);
  const { proposalId } = params as { readonly proposalId: string };
  return {
    result: await getAdminProposal(client, proposalId, platformScope('get_admin_proposal', ctx)),
    resourceType: 'admin_proposal',
    resourceId: proposalId,
  };
};

export const withdrawAdminProposalHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const user = platformUserOf('withdraw_admin_proposal', ctx);
  const { proposalId, reason } = params as {
    readonly proposalId: string;
    readonly reason?: string;
  };
  const proposal = await withdrawAdminProposal(
    client,
    proposalId,
    platformScope('withdraw_admin_proposal', ctx),
    user.id,
    reason,
  );
  return { result: proposal, resourceType: 'admin_proposal', resourceId: proposalId };
};

// -------------------------------------------------------------------------------------------
// S11 AA3b-2: the target workspace's owner
// -------------------------------------------------------------------------------------------

/** The person deciding: dispatch admits only a person on the human channel (`actsForPerson`,
 *  `HUMAN_ONLY`), and the core checks the applier once more (`assertChangeApplierIsPerson`); a
 *  call without one here is a wiring bug. */
function ownerOf(name: string, ctx: CapabilityHandlerContext | undefined): string {
  if (!ctx?.principalId) throw new Error(`${name}: no calling principal in context`);
  if (ctx.channel !== 'human') throw new Error(`${name}: invoked outside the human channel`);
  return ctx.principalId;
}

export const listAdminProposalSegmentsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
): Promise<CapabilityHandlerResult> => {
  const { status } = params as { readonly status?: AdminProposalSegmentStatus };
  return { result: await listAdminProposalSegments(client, workspaceId, status) };
};

/** S11 AA4e: the same scope as the list, counted (`countAdminProposalSegments`). */
export const getAdminProposalSegmentCountsHandler: CapabilityHandler = async (
  client,
  workspaceId,
): Promise<CapabilityHandlerResult> => ({
  result: await countAdminProposalSegments(client, workspaceId),
});

/** `workerGates` as the domain takes it (by Worker name), as `install_pack`'s. */
function workerGateChoice(
  param: Readonly<Record<string, string[]>> | undefined,
): AdminProposalWorkerGateChoice {
  return new Map(Object.entries(param ?? {}));
}

export const previewAdminProposalSegmentHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const principalId = ownerOf('preview_admin_proposal_segment', ctx);
  const { segmentId, workerGates } = params as {
    readonly segmentId: string;
    readonly workerGates?: Record<string, string[]>;
  };
  return {
    result: await previewAdminProposalSegment(
      client,
      workspaceId,
      principalId,
      segmentId,
      workerGateChoice(workerGates),
    ),
    resourceType: 'admin_proposal_segment',
    resourceId: segmentId,
  };
};

export const applyAdminProposalSegmentHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const principalId = ownerOf('apply_admin_proposal_segment', ctx);
  const input = params as {
    readonly segmentId: string;
    readonly reviewedDigest: string;
    readonly confirmedOrdinals?: number[];
    readonly credentialsReviewed?: boolean;
    readonly workerGates?: Record<string, string[]>;
  };
  const applied = await applyAdminProposalSegment(client, workspaceId, principalId, {
    segmentId: input.segmentId,
    reviewedDigest: input.reviewedDigest,
    confirmedOrdinals: input.confirmedOrdinals ?? [],
    ...(input.credentialsReviewed !== undefined
      ? { credentialsReviewed: input.credentialsReviewed }
      : {}),
    workerGates: workerGateChoice(input.workerGates),
  });
  const result: AdminProposalSegmentApplyResultWire = {
    segment: applied.segment,
    changeSegmentId: applied.changeSegmentId,
    verification: null,
  };
  const { changeSegmentId } = applied;
  return {
    result,
    resourceType: 'admin_proposal_segment',
    resourceId: input.segmentId,
    auditPayload: {
      proposalId: applied.segment.proposal.id,
      changeSegmentId,
      digest: applied.plan.digest,
      ...credentialReviewAudit(applied.suspectedSecretValues),
    },
    // S11 AA5f: once the apply has committed, verify it once — as the owner who applied it,
    // recorded as `trigger: system` — in a transaction of its own, so the gate probes run after
    // the apply's locks are gone (as `install_pack`'s `verifyAfterInstall`). The apply stands
    // whatever happens here.
    afterCommit: async (pool) => ({
      ...result,
      verification: await verifyAfterApply(pool, workspaceId, principalId, changeSegmentId),
    }),
  };
};

/** The apply's first verification (see `applyAdminProposalSegmentHandler`); `null` when the run
 *  could not be made — logged, never thrown: the apply is committed, and the owner verifies it
 *  again from 安装历史. */
async function verifyAfterApply(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
  changeSegmentId: string,
): Promise<AdminProposalSegmentApplyResultWire['verification']> {
  try {
    return await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
      const { verification } = await verifyChangeSegment(client, workspaceId, {
        segmentId: changeSegmentId,
        verifiedBy: principalId,
        trigger: 'system',
        checkRequirements: sourceRequirementsChecker(client, workspaceId),
      });
      return toChangeVerificationWire(verification);
    });
  } catch (err) {
    console.error(
      `[kernel] apply_admin_proposal_segment: verifying change segment ${changeSegmentId} after the apply failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export const rejectAdminProposalSegmentHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const principalId = ownerOf('reject_admin_proposal_segment', ctx);
  const { segmentId, reason } = params as { readonly segmentId: string; readonly reason: string };
  const segment = await rejectAdminProposalSegment(
    client,
    workspaceId,
    principalId,
    segmentId,
    reason,
  );
  return {
    result: segment,
    resourceType: 'admin_proposal_segment',
    resourceId: segmentId,
    auditPayload: { proposalId: segment.proposal.id },
  };
};
