import type { PoolClient } from 'pg';
import {
  NotProposerError,
  type PublishActor,
  mayPublishOrDeprecate,
} from '../../governance/capability/index.js';

/**
 * D-24, the version half (review 2026-10-02): propose is permissive — `propose_skill` /
 * `propose_procedure` / `propose_worker_definition` accept any existing family id and add the next
 * version to it — so "publisher = proposer" on the version alone would let a builder add a version
 * to someone else's family and publish it as its proposer, superseding that family's live version.
 * The key point is the publish: publishing a version of a family that already has a published
 * version proposed by someone else needs that proposer, or the workspace owner (the same rule
 * `publishOperation` applies to the live row a revision deprecates).
 *
 * `table` is one of this module's three registries (a fixed union, never caller input). Rows of
 * the version being published are excluded (it is a draft, so `status = 'published'` already
 * excludes it). No actor (an internal caller) is not checked.
 */
export type PublishFamilyTable = 'skills' | 'procedures' | 'worker_definitions';

export async function assertFamilyPublishAuthority(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly table: PublishFamilyTable;
    readonly action: string;
    readonly familyId: string;
    readonly subject: string;
    readonly actor: PublishActor | undefined;
  },
): Promise<void> {
  const { actor } = input;
  if (actor === undefined || actor.role === 'owner') return;
  const result = await client.query<{ version: number; proposed_by: string }>(
    `select version, proposed_by from ${input.table}
     where workspace_id = $1 and id = $2 and status = 'published' and proposed_by <> $3
     order by version desc
     limit 1`,
    [workspaceId, input.familyId, actor.principalId],
  );
  const live = result.rows[0];
  if (live && !mayPublishOrDeprecate(actor, live.proposed_by)) {
    throw new NotProposerError(
      input.action,
      `${input.subject} (the family's published version ${live.version} it would supersede)`,
    );
  }
}
