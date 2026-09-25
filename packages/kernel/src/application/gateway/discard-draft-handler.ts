import type { DraftKind } from '@nexttime/shared';
import { discardDraft } from '../../application/worker/index.js';
import { currentPrincipalId } from '../chat/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/discard-draft-handler: the `discard_draft` capability (S8 W3 K2, leftover
 * 82; `packages/shared/src/capabilities.ts`'s own registry-entry doc comment) — one-capability-
 * per-file, same convention `export-prov-handler.ts`/`operation-manifest-handlers.ts` already
 * established rather than growing `handlers.ts`'s own map body further. The write logic itself
 * (ownership check, `status = 'draft'` guard, the delete) lives in
 * `application/worker/draft-lifecycle.ts`'s `discardDraft` — this handler only resolves the
 * caller's own principal id and shapes the wire result; the AuditRecord is written by
 * `dispatch.ts`'s generic per-call mechanism (I11), same as every other handler in this file.
 */

interface DiscardDraftParams {
  readonly kind: DraftKind;
  readonly id: string;
  readonly version: number;
}

export const discardDraftHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { kind, id, version } = params as DiscardDraftParams;
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  const discarded = await discardDraft(client, workspaceId, principalId, { kind, id, version });

  return {
    result: { kind: discarded.kind, id: discarded.id, version: discarded.version },
    resourceType: discarded.kind,
    resourceId: discarded.id,
  };
};
