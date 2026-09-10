import { randomUUID } from 'node:crypto';
import type { ConflictStatus, ConflictType } from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * substrate/epistemic/conflicts: S3.2 冲突检测 (docs/development-tasks.md S3.2, design doc §5.4 I5
 * "异源不一致 → Conflict；同源变化 → supersede | 写入路径按 source_id 判定", §5.5 Conflict state
 * machine, §5.6 "私有 Fact 与工作区 Fact 冲突时，Conflict 只对私有一方可见"). Owns the `conflicts`
 * table (migrations/core/0002_substrate.sql, extended by 0017_conflict_provenance_and_visibility)
 * end to end: origin resolution, opening a Conflict, listing, and the resolve-time row update.
 *
 * **The single seam (PR body has the full "假设")**: `SqlGraphStore.assertFact`
 * (substrate/graph/sql-store.ts) is the one place every Fact writer in this codebase goes through
 * — collectors (`application/gateway/observed-facts.ts`), the Worker result contract
 * (`application/task/result.ts`'s `postWorkerResult`), `application/worker/{procedures,skills}.ts`,
 * and `substrate/ontology/meta-objects.ts` all call `graphStore.assertFact` directly, never a
 * shared application-level wrapper — `postWorkerResult` alone (the other candidate seam the S3.2
 * dispatch names) would miss every one of the others. `assertFact` therefore calls
 * `resolveFactOrigin`/`sameFactOrigin`/`openConflict` below directly (substrate/graph → substrate/
 * epistemic, one direction only — this module never imports `substrate/graph`, so there is no
 * import cycle) rather than this module reaching into `links` to drive the decision itself; the
 * *identity* lookup (finding the prior Fact to compare against) stays inside `substrate/graph`
 * (`queries.ts`'s `buildFindActiveFactByIdentityQuery`) because `links` is that module's own table.
 *
 * **Origin, not literally always `sources.id`**: I5's design-doc wording ("写入路径按 source_id
 * 判定") assumes every Fact-producing Activity has exactly one epistemic Source attached via
 * `observations` — true for the Worker-result flow (`postWorkerResult` records a workspace-visible
 * `worker_run` Source on the same Activity as `factsToAssert`) but *not* true for most other
 * writers today: `observed-facts.ts`, `worker/procedures.ts`, `worker/skills.ts`, and
 * `meta-objects.ts` never attach an Observation to the Activity they assert Facts from at all. A
 * literal "compare `sources.id`" rule would then have **no** origin signal to compare on either
 * side for the overwhelming majority of real writes, and the only defensible default ("no source
 * on either side" ⇒ treat as *different*) would open a spurious Conflict on every single ordinary
 * re-assertion of the same (object, link type, target) triple — directly contradicting S3.3's own
 * acceptance criterion ("跑两遍无重复无 Conflict"). `resolveFactOrigin` below instead falls back to
 * the asserting Principal (`asserted_by`) when an Activity has zero or more-than-one distinct
 * Source: the same collector/agent/service principal re-asserting is an update (supersede); a
 * genuinely different principal asserting something that collides is a real disagreement
 * (Conflict) — which subsumes the literal Source-based rule as its more precise case (the Worker-
 * session flow's single private Source *is* resolved and compared) while staying correct for every
 * writer that has no Source at all.
 */

// -------------------------------------------------------------------------------------------
// Origin resolution (I5's "source_id 判定", generalized — see module doc comment)
// -------------------------------------------------------------------------------------------

export interface FactOrigin {
  readonly kind: 'source' | 'principal';
  readonly id: string;
}

/**
 * Resolves "who/what is asserting this" for one Fact: the single distinct epistemic Source feeding
 * `activityId` via `observations`, if there is exactly one — otherwise `assertedBy` (the Fact's own
 * `asserted_by` principal). Reads only this module's own tables (`observations`).
 *
 * **This read is RLS-scoped to the current caller (deliberately, unlike `queries.ts`'s
 * `buildFindActiveFactByIdentityQuery`, which bypasses RLS — migrations/core/0017's own comment on
 * why)**: when `activityId` names an Activity fed by a *private* Source the current caller does not
 * own, `observations_visibility` hides that row, and this function falls back to the
 * `{kind:'principal', id: assertedBy}` case even though the true origin is that private Source.
 * This never flips a same/different verdict, though: a private Source's Observation can only ever
 * be inserted by that Source's own owner (`observations_visibility`'s `with check`), so the only
 * way this fallback fires is when the *caller* differs from that owner — and the fallback's id
 * (`assertedBy`, the *prior* Fact's own asserter) is then compared against the *current* caller's
 * own freshly-resolved origin, which by construction is never mistaken for someone else's identity.
 * The comparison in `sameFactOrigin` therefore still lands on "different" in every case where the
 * true, RLS-unaware comparison would have too.
 */
export async function resolveFactOrigin(
  client: PoolClient,
  workspaceId: string,
  input: { readonly activityId: string; readonly assertedBy: string },
): Promise<FactOrigin> {
  const result = await client.query<{ source_id: string }>(
    'select distinct source_id from observations where workspace_id = $1 and activity_id = $2',
    [workspaceId, input.activityId],
  );
  if (result.rows.length === 1) {
    const row = result.rows[0];
    if (row) return { kind: 'source', id: row.source_id };
  }
  return { kind: 'principal', id: input.assertedBy };
}

export function sameFactOrigin(a: FactOrigin, b: FactOrigin): boolean {
  return a.kind === b.kind && a.id === b.id;
}

// -------------------------------------------------------------------------------------------
// conflicts table
// -------------------------------------------------------------------------------------------

export interface ConflictRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly conflictType: ConflictType;
  readonly status: ConflictStatus;
  readonly factAId: string;
  readonly factBId: string;
  readonly description: string | null;
  readonly activityId: string;
  readonly openedAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolution: Record<string, unknown> | null;
}

interface ConflictDbRow {
  workspace_id: string;
  id: string;
  conflict_type: ConflictType;
  status: ConflictStatus;
  link_a_id: string;
  link_b_id: string;
  description: string | null;
  activity_id: string;
  opened_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution: Record<string, unknown> | null;
}

const CONFLICT_COLUMNS =
  'workspace_id, id, conflict_type, status, link_a_id, link_b_id, description, activity_id, ' +
  'opened_at, resolved_at, resolved_by, resolution';

function mapConflictRow(row: ConflictDbRow): ConflictRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    conflictType: row.conflict_type,
    status: row.status,
    factAId: row.link_a_id,
    factBId: row.link_b_id,
    description: row.description,
    activityId: row.activity_id,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolution: row.resolution,
  };
}

export class ConflictNotFoundError extends Error {
  constructor(workspaceId: string, conflictId: string) {
    super(`Conflict not found: workspace ${workspaceId}, id ${conflictId}`);
    this.name = 'ConflictNotFoundError';
  }
}

/**
 * Opens a `status='open'` Conflict between two Facts of the same identity asserted from different
 * origins (I5). `activityId` is the *new* Fact's own Activity — the one whose assertion discovered
 * the disagreement (migrations/core/0017's own column comment). Called from
 * `SqlGraphStore.assertFact` only — never from the `resolve_conflict` write path.
 *
 * **No `RETURNING`, deliberately** (regression found by CI, not by local testing — this sandbox
 * has no Postgres): PostgreSQL's RLS checks a `RETURNING` clause's output against the table's
 * `USING`-bearing (SELECT-equivalent) policy too, not only `WITH CHECK` — a documented behavior
 * distinct from an ordinary `WITH CHECK` failure, and it raises the *same* "new row violates
 * row-level security policy" error rather than silently omitting the row. `conflicts_visibility`'s
 * `using` clause is `conflict_visible_to_caller`, which is false for exactly the caller this
 * function is most often invoked by — I5's whole premise is that the inserting principal is
 * frequently *not* someone who can see the other side's private Fact, so `INSERT ... RETURNING`
 * would fail here on every such call. The id and `opened_at` are generated in this function
 * instead of read back, and the returned `ConflictRow` is assembled from already-known inputs.
 */
export async function openConflict(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly factAId: string;
    readonly factBId: string;
    readonly activityId: string;
    readonly conflictType?: ConflictType;
  },
): Promise<ConflictRow> {
  const id = randomUUID();
  const conflictType = input.conflictType ?? 'value';
  const openedAt = new Date();
  await client.query(
    `insert into conflicts (workspace_id, id, conflict_type, status, link_a_id, link_b_id, activity_id, opened_at)
     values ($1, $2, $3, 'open', $4, $5, $6, $7)`,
    [workspaceId, id, conflictType, input.factAId, input.factBId, input.activityId, openedAt],
  );
  return {
    workspaceId,
    id,
    conflictType,
    status: 'open',
    factAId: input.factAId,
    factBId: input.factBId,
    description: null,
    activityId: input.activityId,
    openedAt,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
}

/** `list_conflicts`: RLS (`conflicts_visibility`, migrations/core/0017) already restricts rows to
 *  ones the caller may see — this is a plain filtered, cursor-paginated SELECT on top of that.
 *  Cursor: opaque base64 of `${openedAtIso}|${id}`, keyset-paginated (`opened_at desc, id desc`) —
 *  no serial/sequence column exists on this table to page by instead (unlike `get_chat_history`'s
 *  `sequence`, `application/chat/service.ts`). */
export const DEFAULT_LIST_CONFLICTS_LIMIT = 20;
export const MAX_LIST_CONFLICTS_LIMIT = 100;

export interface ListConflictsInput {
  readonly status?: ConflictStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ConflictsPage {
  readonly items: readonly ConflictRow[];
  readonly nextCursor?: string;
}

function encodeKeysetCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** Never throws on a malformed cursor — degrades to "start over" (`null`), same convention
 *  `application/chat/service.ts`'s `parseCursor` documents for its own cursor. */
function decodeKeysetCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sepIndex = decoded.lastIndexOf('|');
    if (sepIndex < 0) return null;
    const at = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (!at || !id || Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export async function listConflicts(
  client: PoolClient,
  workspaceId: string,
  input: ListConflictsInput,
): Promise<ConflictsPage> {
  const limit = Math.min(input.limit ?? DEFAULT_LIST_CONFLICTS_LIMIT, MAX_LIST_CONFLICTS_LIMIT);
  const cursor = decodeKeysetCursor(input.cursor);

  const result = await client.query<ConflictDbRow>(
    `select ${CONFLICT_COLUMNS} from conflicts
     where workspace_id = $1
       and ($2::text is null or status = $2)
       and ($3::timestamptz is null or (opened_at, id) < ($3::timestamptz, $4::uuid))
     order by opened_at desc, id desc
     limit $5`,
    [workspaceId, input.status ?? null, cursor?.at ?? null, cursor?.id ?? null, limit],
  );

  const items = result.rows.map(mapConflictRow);
  const last = items[items.length - 1];
  const nextCursor =
    items.length === limit && last ? encodeKeysetCursor(last.openedAt, last.id) : undefined;
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

/** Locks and returns one Conflict row (`for update`) — `resolve_conflict`'s first step. RLS
 *  (`conflicts_visibility`) already restricts this to rows the caller may see; a row that exists
 *  but is hidden from the caller is indistinguishable here from one that does not exist at all
 *  (the same "private data leaks nothing, not even its existence" property `links_visibility`
 *  already has for Facts). */
export async function getConflictForUpdate(
  client: PoolClient,
  workspaceId: string,
  conflictId: string,
): Promise<ConflictRow> {
  const result = await client.query<ConflictDbRow>(
    `select ${CONFLICT_COLUMNS} from conflicts where workspace_id = $1 and id = $2 for update`,
    [workspaceId, conflictId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ConflictNotFoundError(workspaceId, conflictId);
  return mapConflictRow(row);
}

/**
 * `resolve_conflict`'s row update — the Fact-lifecycle side (invalidating the losing Fact(s) via
 * `GraphStore.invalidateFact`) and the Decision record are the caller's job
 * (`application/gateway/epistemic-handlers.ts`'s `resolveConflictHandler` — the one place in this
 * codebase that legitimately coordinates `substrate/graph` and `substrate/epistemic` together,
 * same shape as `application/task/result.ts`'s `postWorkerResult`); this function only ever
 * touches `conflicts` itself, matching `openConflict`/`listConflicts` above.
 *
 * `RETURNING` here is safe (unlike `openConflict`'s own — see that function's comment on the RLS/
 * RETURNING interaction): this UPDATE never touches `link_a_id`/`link_b_id`, the only columns
 * `conflicts_visibility`'s `using` clause depends on, so the row's visibility to the caller is
 * identical before and after — and the caller already proved they can see it, by construction,
 * since `resolveConflictHandler` only reaches this call after `getConflictForUpdate` (itself
 * `using`-gated) already found the row.
 */
export async function markConflictResolved(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly conflictId: string;
    readonly status: ConflictStatus;
    readonly resolvedBy: string;
    readonly resolution: Record<string, unknown>;
  },
): Promise<ConflictRow> {
  const result = await client.query<ConflictDbRow>(
    `update conflicts
     set status = $3, resolved_by = $4, resolved_at = now(), resolution = $5::jsonb
     where workspace_id = $1 and id = $2
     returning ${CONFLICT_COLUMNS}`,
    [
      workspaceId,
      input.conflictId,
      input.status,
      input.resolvedBy,
      JSON.stringify(input.resolution),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ConflictNotFoundError(workspaceId, input.conflictId);
  return mapConflictRow(row);
}
