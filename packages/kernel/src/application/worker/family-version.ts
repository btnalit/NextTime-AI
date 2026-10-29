import type { PoolClient } from 'pg';

/**
 * application/worker/family-version (S11 W1a E2-0, legacy 48 ②; S10 decision 10 "修改已发布的 =
 * 同族新版本"): what proposing the next version of an existing Skill or Procedure family requires.
 * `propose_skill{skillId}` / `propose_procedure{procedureId}` reach it; without a family id a
 * proposal starts a new family, as before.
 *
 *   - The family exists — an id with no version is not found (never a fresh family under a caller's
 *     chosen id).
 *   - Its latest version is not a draft. `publish_skill` / `publish_procedure` publish the latest
 *     version of a family, so a second draft on top would quietly take the first one's place;
 *     the pending draft is published or discarded first (409 `draft_pending`).
 *
 * The same refusal holds for a pack's install of a Skill family's next version, checked at its review
 * (`application/change-plan/family-item.ts`): a pack never proposes over a person's pending draft.
 *
 * The caller holds the lock that serializes the family's versions before calling
 * {@link readFamilyHead}: `lockWorkerRegistry` for Skills (which `publishSkill` / `deprecateSkill`
 * take too), the latest Procedure row `for update` for Procedures (which `publishProcedure` /
 * `deprecateProcedure` take). The callers are capability calls with the builder floor and a pack's
 * install (the owner's), and a builder or the owner sees every draft (`draftVisibleTo`), so naming
 * the pending draft reveals nothing the caller could not read.
 */

export type FamilyKind = 'skill' | 'procedure';

/** The family's latest version is a draft: publish or discard it before proposing another. */
export class FamilyDraftPendingError extends Error {
  readonly code = 'draft_pending' as const;
  readonly kind: FamilyKind;
  readonly familyId: string;
  readonly draftVersion: number;
  constructor(kind: FamilyKind, familyId: string, draftVersion: number, draftName?: string) {
    const label = kind === 'skill' ? 'Skill' : 'Procedure';
    const named = draftName === undefined ? '' : ` "${draftName}"`;
    super(
      `${label}${named} ${familyId}@${draftVersion} is a draft that has not been published or discarded — publishing takes a family's latest version, so another draft would take its place. Publish or discard it, then propose the next version. Nothing was proposed`,
    );
    this.name = 'FamilyDraftPendingError';
    this.kind = kind;
    this.familyId = familyId;
    this.draftVersion = draftVersion;
  }
}

export interface FamilyHead {
  readonly version: number;
  readonly status: string;
  readonly name: string;
}

/** The family's latest version, read fresh (after the caller's lock is held), or `null` when the
 *  family has no version at all. */
export async function readFamilyHead(
  client: PoolClient,
  table: 'skills' | 'procedures',
  workspaceId: string,
  familyId: string,
): Promise<FamilyHead | null> {
  const result = await client.query<FamilyHead>(
    `select version, status, name from ${table}
     where workspace_id = $1 and id = $2
     order by version desc
     limit 1`,
    [workspaceId, familyId],
  );
  return result.rows[0] ?? null;
}

/** Refuses a next version on top of a pending draft. */
export function assertNoPendingDraft(kind: FamilyKind, familyId: string, head: FamilyHead): void {
  if (head.status === 'draft') {
    throw new FamilyDraftPendingError(kind, familyId, head.version, head.name);
  }
}
