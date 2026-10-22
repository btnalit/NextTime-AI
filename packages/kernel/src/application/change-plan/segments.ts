import type {
  ChangeItemClassification,
  ChangeItemKind,
  ChangeSegmentStatus,
  PrincipalKind,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { WideningReason } from './classify.js';
import type { ChangeChannel, ChangeSource } from './engine.js';

/**
 * application/change-plan/segments: reading the workspace's applied segments and their items back
 * (S11 P1-B — `list_change_segments`, `get_change_segment`, and what a rollback starts from). The
 * records are what `applyWorkspaceSegment` wrote; nothing here changes them.
 */

/** A principal named on a change record, resolved for display. */
export interface ChangePrincipalRef {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly displayName: string | null;
}

export interface ChangeSegmentRecord {
  readonly id: string;
  readonly planId: string;
  readonly channel: ChangeChannel;
  readonly source: ChangeSource;
  readonly status: ChangeSegmentStatus;
  readonly reviewedDigest: string;
  readonly proposedBy: ChangePrincipalRef;
  readonly appliedBy: ChangePrincipalRef;
  readonly appliedAt: Date;
  readonly verifiedAt: Date | null;
  readonly rolledBackBy: ChangePrincipalRef | null;
  readonly rolledBackAt: Date | null;
  readonly itemCount: number;
  readonly wideningItemCount: number;
}

/** One stored item. `target` / `before` / `after` are its kind's shape (`ontology-item.ts`'s
 *  `parseStoredOntologyItem` reads an `ontology_version` item's). */
export interface ChangeItemRecord {
  readonly id: string;
  readonly segmentId: string;
  readonly ordinal: number;
  readonly kind: ChangeItemKind;
  readonly target: unknown;
  readonly before: unknown;
  readonly after: unknown;
  readonly classification: ChangeItemClassification;
  readonly widening: readonly WideningReason[];
  readonly confirmedBy: ChangePrincipalRef | null;
}

export class ChangeSegmentNotFoundError extends Error {
  readonly code = 'change_segment_not_found' as const;
  constructor(segmentId: string) {
    super(`change segment ${segmentId} not found in this workspace`);
    this.name = 'ChangeSegmentNotFoundError';
  }
}

interface SegmentDbRow {
  id: string;
  plan_id: string;
  channel: ChangeChannel;
  source_kind: 'pack';
  source_name: string;
  source_version: string;
  source_digest: string;
  status: ChangeSegmentStatus;
  reviewed_digest: string;
  applied_at: Date;
  verified_at: Date | null;
  rolled_back_at: Date | null;
  proposed_by: string;
  proposed_kind: PrincipalKind;
  proposed_name: string | null;
  applied_by: string;
  applied_kind: PrincipalKind;
  applied_name: string | null;
  rolled_back_by: string | null;
  rolled_back_kind: PrincipalKind | null;
  rolled_back_name: string | null;
  item_count: number;
  widening_item_count: number;
  /** The keyset cursor's time, to the microsecond (a `Date` keeps milliseconds only). */
  applied_at_key: string;
}

const SEGMENT_SELECT = `
  select s.id, s.plan_id, s.channel, s.source_kind, s.source_name, s.source_version,
         s.source_digest, s.status, s.reviewed_digest, s.applied_at, s.verified_at,
         s.rolled_back_at,
         s.proposed_by, pp.kind as proposed_kind, pp.display_name as proposed_name,
         s.applied_by, pa.kind as applied_kind, pa.display_name as applied_name,
         s.rolled_back_by, pr.kind as rolled_back_kind, pr.display_name as rolled_back_name,
         (select count(*)::int from change_items i
           where i.workspace_id = s.workspace_id and i.segment_id = s.id) as item_count,
         (select count(*)::int from change_items i
           where i.workspace_id = s.workspace_id and i.segment_id = s.id
             and i.classification = 'authority_widening') as widening_item_count,
         to_char(s.applied_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           as applied_at_key
    from change_segments s
    join principals pp on pp.workspace_id = s.workspace_id and pp.id = s.proposed_by
    join principals pa on pa.workspace_id = s.workspace_id and pa.id = s.applied_by
    left join principals pr on pr.workspace_id = s.workspace_id and pr.id = s.rolled_back_by`;

function mapSegment(row: SegmentDbRow): ChangeSegmentRecord {
  return {
    id: row.id,
    planId: row.plan_id,
    channel: row.channel,
    source: {
      kind: row.source_kind,
      name: row.source_name,
      version: row.source_version,
      digest: row.source_digest,
    },
    status: row.status,
    reviewedDigest: row.reviewed_digest,
    proposedBy: { id: row.proposed_by, kind: row.proposed_kind, displayName: row.proposed_name },
    appliedBy: { id: row.applied_by, kind: row.applied_kind, displayName: row.applied_name },
    appliedAt: row.applied_at,
    verifiedAt: row.verified_at,
    rolledBackBy:
      row.rolled_back_by === null || row.rolled_back_kind === null
        ? null
        : { id: row.rolled_back_by, kind: row.rolled_back_kind, displayName: row.rolled_back_name },
    rolledBackAt: row.rolled_back_at,
    itemCount: row.item_count,
    wideningItemCount: row.widening_item_count,
  };
}

/** One segment of `workspaceId`, or `null`. `forUpdate`: lock its row until the transaction ends —
 *  what a rollback does first, so two rollbacks of one segment run one after the other. */
export async function loadChangeSegment(
  client: PoolClient,
  workspaceId: string,
  segmentId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<ChangeSegmentRecord | null> {
  if (options.forUpdate) {
    await client.query(
      'select 1 from change_segments where workspace_id = $1 and id = $2 for update',
      [workspaceId, segmentId],
    );
  }
  const result = await client.query<SegmentDbRow>(
    `${SEGMENT_SELECT} where s.workspace_id = $1 and s.id = $2`,
    [workspaceId, segmentId],
  );
  const row = result.rows[0];
  return row ? mapSegment(row) : null;
}

/** The segment's items, by ordinal. */
export async function loadChangeItems(
  client: PoolClient,
  workspaceId: string,
  segmentId: string,
): Promise<readonly ChangeItemRecord[]> {
  const result = await client.query<{
    id: string;
    segment_id: string;
    ordinal: number;
    kind: ChangeItemKind;
    target: unknown;
    before: unknown;
    after: unknown;
    classification: ChangeItemClassification;
    widening: WideningReason[];
    confirmed_by: string | null;
    confirmed_kind: PrincipalKind | null;
    confirmed_name: string | null;
  }>(
    `select i.id, i.segment_id, i.ordinal, i.kind, i.target, i.before, i.after, i.classification,
            i.widening, i.confirmed_by, pc.kind as confirmed_kind,
            pc.display_name as confirmed_name
       from change_items i
       left join principals pc on pc.workspace_id = i.workspace_id and pc.id = i.confirmed_by
      where i.workspace_id = $1 and i.segment_id = $2
      order by i.ordinal`,
    [workspaceId, segmentId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    segmentId: row.segment_id,
    ordinal: row.ordinal,
    kind: row.kind,
    target: row.target,
    before: row.before,
    after: row.after,
    classification: row.classification,
    widening: row.widening,
    confirmedBy:
      row.confirmed_by === null || row.confirmed_kind === null
        ? null
        : { id: row.confirmed_by, kind: row.confirmed_kind, displayName: row.confirmed_name },
  }));
}

// -------------------------------------------------------------------------------------------
// list_change_segments — newest first, keyset-paginated on (applied_at, id)
// -------------------------------------------------------------------------------------------

export const DEFAULT_LIST_CHANGE_SEGMENTS_LIMIT = 50;
export const MAX_LIST_CHANGE_SEGMENTS_LIMIT = 200;

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function encodeCursor(row: SegmentDbRow): string {
  return Buffer.from(`${row.applied_at_key}|${row.id}`, 'utf8').toString('base64url');
}

/** `null` for a cursor this function did not produce — the first page, as `list_skills` does. */
function decodeCursor(
  cursor: string | undefined,
): { readonly appliedAt: string; readonly id: string } | null {
  if (!cursor) return null;
  const match = CURSOR_PATTERN.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  const appliedAt = match?.[1];
  const id = match?.[2];
  return appliedAt && id ? { appliedAt, id } : null;
}

export interface ListChangeSegmentsInput {
  readonly sourceName?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ChangeSegmentsPage {
  readonly items: readonly ChangeSegmentRecord[];
  readonly nextCursor?: string;
}

/** The workspace's segments, newest applied first (ties by id). The cursor carries the applied
 *  time to the microsecond, so segments applied within one millisecond are neither skipped nor
 *  repeated across pages. */
export async function listChangeSegments(
  client: PoolClient,
  workspaceId: string,
  input: ListChangeSegmentsInput = {},
): Promise<ChangeSegmentsPage> {
  const limit = Math.min(
    Math.max(input.limit ?? DEFAULT_LIST_CHANGE_SEGMENTS_LIMIT, 1),
    MAX_LIST_CHANGE_SEGMENTS_LIMIT,
  );
  const after = decodeCursor(input.cursor);
  const result = await client.query<SegmentDbRow>(
    `${SEGMENT_SELECT}
      where s.workspace_id = $1
        and ($2::text is null or s.source_name = $2)
        and ($3::timestamptz is null or (s.applied_at, s.id) < ($3::timestamptz, $4::uuid))
      order by s.applied_at desc, s.id desc
      limit $5`,
    [workspaceId, input.sourceName ?? null, after?.appliedAt ?? null, after?.id ?? null, limit + 1],
  );
  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map(mapSegment),
    ...(result.rows.length > limit && last ? { nextCursor: encodeCursor(last) } : {}),
  };
}
