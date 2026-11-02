import type { PlatformChangeSegmentStatus } from '@nexttime/shared';
import { credentialReviewAudit } from '../../governance/redaction/index.js';
import {
  applyPlatformSegment,
  getPlatformChangeSegment,
  listPlatformChangeSegments,
  previewPlatformChangeRollback,
  previewPlatformSegment,
  rejectPlatformSegment,
  rollBackPlatformChangeSegment,
} from '../change-plan/index.js';
import type {
  CapabilityHandler,
  CapabilityHandlerContext,
  CapabilityHandlerResult,
} from './capability-handler.js';

/**
 * application/gateway/platform-change-handlers (S11 AA3c-1): an admin proposal's platform segment,
 * decided by a platform administrator in the console (application/change-plan/platform-segments.ts;
 * migrations/governance/0034) — preview, apply, reject — and the platform change segments its
 * apply records, read and rolled back from there.
 *
 * Every one is `scope: 'platform'`, `channel: 'human'`: dispatch's platform branch runs it in a
 * platform transaction as the acting administrator (`ctx.platformUser`) and writes the call's own
 * audit row. No Handle reaches the platform channel, so no agent — the admin agent included —
 * decides a platform segment (I-A1: it proposes, a person decides).
 */

/** A platform capability's acting administrator (dispatch's platform branch sets it); a call
 *  without one here is a wiring bug, not a caller to answer. */
function platformUserOf(
  name: string,
  ctx: CapabilityHandlerContext | undefined,
): NonNullable<CapabilityHandlerContext['platformUser']> {
  if (!ctx?.platformUser) {
    throw new Error(`${name}: no platform user in the call's context (a platform-scope call)`);
  }
  return ctx.platformUser;
}

export const previewPlatformSegmentHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  platformUserOf('preview_platform_segment', ctx);
  const { segmentId } = params as { readonly segmentId: string };
  return {
    result: await previewPlatformSegment(client, segmentId),
    resourceType: 'admin_proposal_segment',
    resourceId: segmentId,
  };
};

export const applyPlatformSegmentHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const user = platformUserOf('apply_platform_segment', ctx);
  const input = params as {
    readonly segmentId: string;
    readonly reviewedDigest: string;
    readonly confirmedOrdinals?: number[];
    readonly credentialsReviewed?: boolean;
  };
  const applied = await applyPlatformSegment(client, user.id, {
    segmentId: input.segmentId,
    reviewedDigest: input.reviewedDigest,
    confirmedOrdinals: input.confirmedOrdinals ?? [],
    ...(input.credentialsReviewed !== undefined
      ? { credentialsReviewed: input.credentialsReviewed }
      : {}),
  });
  const { segment, changeSegment } = applied.result;
  return {
    result: applied.result,
    resourceType: 'admin_proposal_segment',
    resourceId: input.segmentId,
    auditPayload: {
      proposalId: changeSegment.source.proposalId,
      platformChangeSegmentId: changeSegment.id,
      digest: changeSegment.reviewedDigest,
      gateIds: changeSegment.items.map((item) => item.gateId),
      proposedByUser: changeSegment.proposedBy.userId,
      segmentStatus: segment.status,
      ...credentialReviewAudit(applied.suspectedSecretValues),
    },
  };
};

export const rejectPlatformSegmentHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const user = platformUserOf('reject_platform_segment', ctx);
  const { segmentId, reason } = params as { readonly segmentId: string; readonly reason: string };
  const rejected = await rejectPlatformSegment(client, user.id, segmentId, reason);
  return {
    result: rejected.proposal,
    resourceType: 'admin_proposal_segment',
    resourceId: segmentId,
    auditPayload: {
      proposalId: rejected.proposal.id,
      withdrawnSegments: rejected.withdrawnSegments,
    },
  };
};

export const listPlatformChangeSegmentsHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  platformUserOf('list_platform_change_segments', ctx);
  const { status } = params as { readonly status?: PlatformChangeSegmentStatus };
  return { result: await listPlatformChangeSegments(client, status) };
};

export const getPlatformChangeSegmentHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  platformUserOf('get_platform_change_segment', ctx);
  const { changeSegmentId } = params as { readonly changeSegmentId: string };
  return {
    result: await getPlatformChangeSegment(client, changeSegmentId),
    resourceType: 'platform_change_segment',
    resourceId: changeSegmentId,
  };
};

export const previewRollBackPlatformChangeSegmentHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  platformUserOf('preview_roll_back_platform_change_segment', ctx);
  const { changeSegmentId } = params as { readonly changeSegmentId: string };
  return {
    result: await previewPlatformChangeRollback(client, changeSegmentId),
    resourceType: 'platform_change_segment',
    resourceId: changeSegmentId,
  };
};

export const rollBackPlatformChangeSegmentHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
): Promise<CapabilityHandlerResult> => {
  const user = platformUserOf('roll_back_platform_change_segment', ctx);
  const { changeSegmentId } = params as { readonly changeSegmentId: string };
  const rolledBack = await rollBackPlatformChangeSegment(client, user.id, changeSegmentId);
  return {
    result: rolledBack.result,
    resourceType: 'platform_change_segment',
    resourceId: changeSegmentId,
    auditPayload: {
      proposalId: rolledBack.proposalId,
      disabledGateIds: rolledBack.result.items
        .filter((item) => item.action === 'disable')
        .map((item) => item.gateId),
      withdrawnSegments: rolledBack.result.withdrawnSegments,
    },
  };
};
