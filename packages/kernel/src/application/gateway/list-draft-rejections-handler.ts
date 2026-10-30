import {
  DRAFT_REJECTIONS_LIMIT,
  type ListDraftRejectionsResultWire,
  type RejectableDraftKind,
} from '@nexttime/shared';
import { listDraftRejections } from '../../application/worker/index.js';
import { shownFreeText } from '../../governance/redaction/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/list-draft-rejections-handler: the `list_draft_rejections` capability
 * (legacy 491) — the caller's own rejected Skill / Procedure drafts, newest first
 * (`application/worker/draft-rejections.ts`). Human channel only, so the caller is the person
 * (`ctx.principal`); a draft an agent proposed on their behalf is theirs already. The reason shows
 * as every stored free text does (`shownFreeText`).
 */
export const listDraftRejectionsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  if (!ctx?.principal) {
    throw new Error('list_draft_rejections: no resolved human principal (human channel only)');
  }
  const { kind } = params as { kind?: RejectableDraftKind };
  const rows = await listDraftRejections(client, workspaceId, ctx.principal.id, {
    ...(kind !== undefined ? { kind } : {}),
    limit: DRAFT_REJECTIONS_LIMIT,
  });
  const result: ListDraftRejectionsResultWire = {
    items: rows.map((row) => ({
      kind: row.kind,
      id: row.familyId,
      version: row.version,
      name: row.name,
      reason: shownFreeText(row.reason),
      rejectedBy: row.rejectedBy,
      rejectedAt: row.rejectedAt.toISOString(),
    })),
  };
  return { result };
};
