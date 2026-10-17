import type { ChangeSegmentStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { deriveOntologyPackId, loadPublishedOntologyHead } from '../../substrate/ontology/index.js';
import type { ChangeSource } from './engine.js';

/**
 * application/change-plan/provenance: "which ChangeItem put this here" (S11 plan §3.2 `Object
 * changed_by ChangeItem`) for an ontology family's installed version. Only versions applied through
 * the core since P1 have an item; a version published before P1, or outside a ChangePlan
 * (`publish_ontology_version`, `seed-domain-pack`), says so as `provenance_unknown` — never "no
 * change" and never something a rollback may act on. A rollback (P1-B) starts from `recorded` and
 * compares the head with the item's `after` before writing (§5.3 "先比较再写").
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
      readonly appliedBy: string;
      readonly appliedAt: Date;
    };

export async function loadOntologyProvenance(
  client: PoolClient,
  workspaceId: string,
  family: string,
): Promise<OntologyProvenance> {
  const ontologyId = deriveOntologyPackId(family);
  const head = await loadPublishedOntologyHead(client, workspaceId, ontologyId);
  if (!head) return { status: 'not_installed' };
  const result = await client.query<{
    item_id: string;
    segment_id: string;
    status: ChangeSegmentStatus;
    source_kind: 'pack';
    source_name: string;
    source_version: string;
    source_digest: string;
    applied_by: string;
    applied_at: Date;
  }>(
    `select i.id as item_id, s.id as segment_id, s.status, s.source_kind, s.source_name,
            s.source_version, s.source_digest, s.applied_by, s.applied_at
       from change_items i
       join change_segments s on s.workspace_id = i.workspace_id and s.id = i.segment_id
      where i.workspace_id = $1 and i.kind = 'ontology_version'
        and i.target ->> 'ontologyId' = $2
        and (i.after ->> 'version')::int = $3`,
    [workspaceId, ontologyId, head.version],
  );
  const row = result.rows[0];
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
    appliedBy: row.applied_by,
    appliedAt: row.applied_at,
  };
}
