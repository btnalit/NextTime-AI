import { type RejectableDraftKind, rejectDraft } from '../../application/worker/index.js';
import { type CapabilityHandler, publishActorOf } from './capability-handler.js';

/**
 * application/gateway/reject-draft-handler: the `reject_draft` capability (E2-0b; review #493 on
 * #764, F2) — the reviewer's transition that takes a pending Skill / Procedure draft off its family
 * (`application/worker/draft-lifecycle.ts`'s `rejectDraft`, which holds the rule). One capability
 * per file, as `discard-draft-handler.ts`. dispatch.ts's per-call AuditRecord already carries the
 * params (`reason` and `draftDigest`, redacted like every audited param); this adds whose draft it
 * was and the version that stays in use (not its name: the resource id and version name it).
 */

interface RejectDraftParams {
  readonly kind: RejectableDraftKind;
  readonly id: string;
  readonly version: number;
  readonly draftDigest: string;
  readonly reason: string;
}

export const rejectDraftHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { kind, id, version, draftDigest, reason } = params as RejectDraftParams;
  const rejected = await rejectDraft(
    client,
    workspaceId,
    publishActorOf('reject_draft', ctx),
    { kind, id, version },
    draftDigest,
    reason,
  );
  return {
    result: { kind: rejected.kind, id: rejected.id, version: rejected.version },
    resourceType: rejected.kind,
    resourceId: rejected.id,
    auditPayload: {
      rejectedDraft: { proposedBy: rejected.proposedBy, inUseVersion: rejected.inUseVersion },
    },
  };
};
