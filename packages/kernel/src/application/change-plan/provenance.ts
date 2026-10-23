import type { ChangeItemKind, ChangeSegmentStatus, PrincipalKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { deriveOntologyPackId, loadPublishedOntologyHead } from '../../substrate/ontology/index.js';
import type { ChangeChannel, ChangeSource } from './engine.js';
import { type FamilyItemKind, familyIdField, loadFamilyHeadVersion } from './family-item.js';
import type { ChangePrincipalRef } from './segments.js';

/**
 * application/change-plan/provenance: "which ChangeItem put this here" (S11 plan §3.2 `Object
 * changed_by ChangeItem`) for a family's installed version — an ontology family's, a Skill's or a
 * `worker` WorkerDefinition's — and for an Operation's live version (`findOperationVersionSegment`;
 * an Operation rolled back gets a further version no item wrote: `operation-item.ts`). Only versions applied through the core since P1 have an item; a
 * version published before P1, or outside a ChangePlan (`publish_ontology_version`,
 * `publish_skill`, `publish_worker_definition`, `seed-domain-pack`), says so as
 * `provenance_unknown` — never "no change" and never something a rollback may act on. A rollback
 * (`rollback.ts`) starts from a segment's items and compares the head with each item's `after`
 * before writing (§5.3 "先比较再写").
 *
 * A rolled back segment never wrote the head: its rollback retired, in the same transaction, the
 * version each of its items published (`ontology-item.ts`, `family-item.ts`), and a retired
 * version is never published again (I12). So `recorded` always names a segment that is not
 * `rolled_back`.
 */
export type ChangeProvenance =
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

/** A kind whose target names a family by one id field. */
type FamilyIdKind = Exclude<ChangeItemKind, 'operation_version'>;

/** Which item kind's target names its family under which field: a fixed table, never input. */
const TARGET_ID_FIELD: Readonly<Record<FamilyIdKind, string>> = {
  ontology_version: 'ontologyId',
  skill_version: familyIdField('skill_version'),
  worker_definition_version: familyIdField('worker_definition_version'),
};

/** The `kind` item whose target contains `target` and that published `version`, or `null` when
 *  none did (published before P1 or outside the core). */
async function findWritingItem(
  client: PoolClient,
  workspaceId: string,
  kind: ChangeItemKind,
  target: Readonly<Record<string, string>>,
  version: number,
): Promise<WritingItemRow | null> {
  const result = await client.query<WritingItemRow>(
    `select i.id as item_id, s.id as segment_id, s.status, s.channel, s.source_kind,
            s.source_name, s.source_version, s.source_digest, s.applied_by,
            p.kind as applied_kind, p.display_name as applied_name, s.applied_at
       from change_items i
       join change_segments s on s.workspace_id = i.workspace_id and s.id = i.segment_id
       join principals p on p.workspace_id = s.workspace_id and p.id = s.applied_by
      where i.workspace_id = $1 and i.kind = $2
        and i.target @> $3::jsonb
        and (i.after ->> 'version')::int = $4`,
    [workspaceId, kind, JSON.stringify(target), version],
  );
  return result.rows[0] ?? null;
}

/** The segment whose `kind` item published `version` of the family `familyId`, or `null` (see
 *  `findWritingItem`). What a rollback that finds the family changed since names as the change to
 *  roll back first, and what `get_change_segment` names as an item's replacement. */
export async function findVersionSegment(
  client: PoolClient,
  workspaceId: string,
  kind: FamilyIdKind,
  familyId: string,
  version: number,
): Promise<string | null> {
  const target = { [TARGET_ID_FIELD[kind]]: familyId };
  return (await findWritingItem(client, workspaceId, kind, target, version))?.segment_id ?? null;
}

/** As `findVersionSegment`, for an Operation (`{ gatekeeperId, name }`). */
export async function findOperationVersionSegment(
  client: PoolClient,
  workspaceId: string,
  operation: { readonly gatekeeperId: string; readonly name: string },
  version: number,
): Promise<string | null> {
  const target = { gatekeeperId: operation.gatekeeperId, name: operation.name };
  return (
    (await findWritingItem(client, workspaceId, 'operation_version', target, version))
      ?.segment_id ?? null
  );
}

/** As `findVersionSegment`, for an ontology family (`ontology_versions.id`). */
export async function findOntologyVersionSegment(
  client: PoolClient,
  workspaceId: string,
  ontologyId: string,
  version: number,
): Promise<string | null> {
  return findVersionSegment(client, workspaceId, 'ontology_version', ontologyId, version);
}

async function provenanceOf(
  client: PoolClient,
  workspaceId: string,
  kind: FamilyIdKind,
  familyId: string,
  headVersion: number | null,
): Promise<ChangeProvenance> {
  if (headVersion === null) return { status: 'not_installed' };
  const target = { [TARGET_ID_FIELD[kind]]: familyId };
  const row = await findWritingItem(client, workspaceId, kind, target, headVersion);
  if (!row) return { status: 'provenance_unknown', version: headVersion };
  return {
    status: 'recorded',
    version: headVersion,
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

/** The provenance of the ontology family `family`'s installed (published head) version. */
export async function loadOntologyProvenance(
  client: PoolClient,
  workspaceId: string,
  family: string,
): Promise<ChangeProvenance> {
  const ontologyId = deriveOntologyPackId(family);
  const head = await loadPublishedOntologyHead(client, workspaceId, ontologyId);
  return provenanceOf(client, workspaceId, 'ontology_version', ontologyId, head?.version ?? null);
}

/** The provenance of a Skill's or `worker` WorkerDefinition's installed (published head) version. */
export async function loadFamilyProvenance(
  client: PoolClient,
  workspaceId: string,
  kind: FamilyItemKind,
  familyId: string,
): Promise<ChangeProvenance> {
  const headVersion = await loadFamilyHeadVersion(client, workspaceId, kind, familyId);
  return provenanceOf(client, workspaceId, kind, familyId, headVersion);
}
