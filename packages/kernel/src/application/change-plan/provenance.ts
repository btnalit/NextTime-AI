import type { ChangeSegmentStatus, PrincipalKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { deriveOntologyPackId, loadPublishedOntologyHead } from '../../substrate/ontology/index.js';
import type { ChangeChannel, ChangeSource } from './engine.js';
import type { ChangePrincipalRef } from './segments.js';

/**
 * application/change-plan/provenance: "which ChangeItem put this here" (S11 plan §3.2 `Object
 * changed_by ChangeItem`) for an ontology family's installed version. Only versions applied through
 * the core since P1 have an item; a version published before P1, or outside a ChangePlan
 * (`publish_ontology_version`, `seed-domain-pack`), says so as `provenance_unknown` — never "no
 * change" and never something a rollback may act on. A rollback (`rollback.ts`) starts from a
 * segment's items and compares the head with each item's `after` before writing (§5.3 "先比较再写").
 *
 * A rolled back segment never wrote the head: its rollback retired, in the same transaction, the
 * version each of its items published (`ontology-item.ts`), and a retired version is never
 * published again (I12). So `recorded` always names a segment that is not `rolled_back`.
 */
export type OntologyProvenance =
  | { readonly status: 'not_installed' }
  | {
      readonly status: 'provenance_unknown';
      /** The installed (published head) version, which no ChangeItem wrote. */
      readonly version: number;
    }
  | {
      readonly status: 'recorded';
      readonly version: number;
      readonly segmentId: string;
      readonly segmentStatus: ChangeSegmentStatus;
      readonly itemId: string;
      readonly source: ChangeSource;
      /** `platform`: applied on the workspace's behalf, not by `appliedBy` themselves. */
      readonly channel: ChangeChannel;
      readonly appliedBy: ChangePrincipalRef;
      readonly appliedAt: Date;
    };

interface WritingItemRow {
  item_id: string;
  segment_id: string;
  status: ChangeSegmentStatus;
  channel: ChangeChannel;
  source_kind: 'pack';
  source_name: string;
  source_version: string;
  source_digest: string;
  applied_by: string;
  applied_kind: PrincipalKind;
  applied_name: string | null;
  applied_at: Date;
}

/** The `ontology_version` item that published `version` of the family `ontologyId`, or `null` when
 *  none did (published before P1 or outside the core). */
async function findWritingItem(
  client: PoolClient,
  workspaceId: string,
  ontologyId: string,
  version: number,
): Promise<WritingItemRow | null> {
  const result = await client.query<WritingItemRow>(
    `select i.id as item_id, s.id as segment_id, s.status, s.channel, s.source_kind,
            s.source_name, s.source_version, s.source_digest, s.applied_by,
            p.kind as applied_kind, p.display_name as applied_name, s.applied_at
       from change_items i
       join change_segments s on s.workspace_id = i.workspace_id and s.id = i.segment_id
       join principals p on p.workspace_id = s.workspace_id and p.id = s.applied_by
      where i.workspace_id = $1 and i.kind = 'ontology_version'
        and i.target ->> 'ontologyId' = $2
        and (i.after ->> 'version')::int = $3`,
    [workspaceId, ontologyId, version],
  );
  return result.rows[0] ?? null;
}

/** The segment whose item published `version` of the family `ontologyId`, or `null` (see
 *  `findWritingItem`). What a rollback that finds the family changed since names as the change to
 *  roll back first, and what `get_change_segment` names as an item's replacement. */
export async function findOntologyVersionSegment(
  client: PoolClient,
  workspaceId: string,
  ontologyId: string,
  version: number,
): Promise<string | null> {
  return (await findWritingItem(client, workspaceId, ontologyId, version))?.segment_id ?? null;
}

export async function loadOntologyProvenance(
  client: PoolClient,
  workspaceId: string,
  family: string,
): Promise<OntologyProvenance> {
  const ontologyId = deriveOntologyPackId(family);
  const head = await loadPublishedOntologyHead(client, workspaceId, ontologyId);
  if (!head) return { status: 'not_installed' };
  const row = await findWritingItem(client, workspaceId, ontologyId, head.version);
  if (!row) return { status: 'provenance_unknown', version: head.version };
  return {
    status: 'recorded',
    version: head.version,
    segmentId: row.segment_id,
    segmentStatus: row.status,
    itemId: row.item_id,
    source: {
      kind: row.source_kind,
      name: row.source_name,
      version: row.source_version,
      digest: row.source_digest,
    },
    channel: row.channel,
    appliedBy: { id: row.applied_by, kind: row.applied_kind, displayName: row.applied_name },
    appliedAt: row.applied_at,
  };
}
