import type { RejectableDraftKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * application/worker/draft-rejections (legacy 491): the record a rejection leaves for the draft's
 * proposer. `reject_draft` deletes the draft (`draft-lifecycle.ts`'s `rejectDraft`, which writes
 * {@link recordDraftRejection} in the same transaction); `draft_rejections` (worker/0006) keeps
 * what was rejected, whose it was, who rejected it and why, append-only. `list_draft_rejections`
 * reads a proposer's own ({@link listDraftRejections}) — a draft an agent proposed is the person's
 * its Handle acted for, as `proposed_by` is on the draft itself.
 */

export interface DraftRejectionInput {
  readonly kind: RejectableDraftKind;
  readonly familyId: string;
  readonly version: number;
  /** The draft's own name, as it was when it was rejected. */
  readonly name: string | null;
  readonly proposedBy: string;
  readonly rejectedBy: string;
  /** The reviewer's reason as the AuditRecord keeps it (suspected secrets redacted). */
  readonly reason: string;
  readonly draftDigest: string;
}

export async function recordDraftRejection(
  client: PoolClient,
  workspaceId: string,
  rejection: DraftRejectionInput,
): Promise<void> {
  await client.query(
    `insert into draft_rejections
       (workspace_id, kind, family_id, version, name, proposed_by, rejected_by, reason,
        draft_digest)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      workspaceId,
      rejection.kind,
      rejection.familyId,
      rejection.version,
      rejection.name,
      rejection.proposedBy,
      rejection.rejectedBy,
      rejection.reason,
      rejection.draftDigest,
    ],
  );
}

export interface DraftRejectionRow {
  readonly kind: RejectableDraftKind;
  readonly familyId: string;
  readonly version: number;
  readonly name: string | null;
  readonly rejectedBy: string;
  readonly reason: string;
  readonly rejectedAt: Date;
}

/** The rejections of drafts `proposedBy` proposed, newest first, at most `limit`; `kind` narrows
 *  to Skills or Procedures. */
export async function listDraftRejections(
  client: PoolClient,
  workspaceId: string,
  proposedBy: string,
  options: { readonly kind?: RejectableDraftKind; readonly limit: number },
): Promise<readonly DraftRejectionRow[]> {
  const result = await client.query<{
    kind: RejectableDraftKind;
    family_id: string;
    version: number;
    name: string | null;
    rejected_by: string;
    reason: string;
    rejected_at: Date;
  }>(
    `select kind, family_id, version, name, rejected_by, reason, rejected_at
       from draft_rejections
      where workspace_id = $1 and proposed_by = $2 and ($3::text is null or kind = $3)
      order by rejected_at desc, id
      limit $4`,
    [workspaceId, proposedBy, options.kind ?? null, options.limit],
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    familyId: row.family_id,
    version: row.version,
    name: row.name,
    rejectedBy: row.rejected_by,
    reason: row.reason,
    rejectedAt: row.rejected_at,
  }));
}
