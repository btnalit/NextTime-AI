import {
  DEFAULT_RECENT_FACTS_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_TRAVERSE_DIRECTION,
  type NeighborsInput,
  type SearchInput,
  type StateAtInput,
  type TraverseDirection,
  type TraverseInput,
  type UpsertObjectInput,
  normalizeTraverseDepth,
} from './store.js';

/**
 * substrate/graph/queries: pure SQL-text-and-parameter builders for `sql-store.ts`. No IO, no
 * `pg` import — every function here takes plain values in and returns `{ text, values }` out,
 * so depth clamping, direction defaulting, and parameter binding are unit-testable without a
 * database (docs/development-tasks.md S1.2: "unit (no DB) for CTE/query builders").
 */

export interface SqlQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

const FACT_COLUMNS = `workspace_id, id, link_type, source_object_id, target_object_id, properties,
  valid_from, valid_until, recorded_at, superseded_at, invalidated_at, invalidation_reason,
  supersedes_id, epistemic_status, confidence, activity_id, asserted_by, verified_by,
  observation_id`;

const OBJECT_COLUMNS =
  'workspace_id, id, object_type, identity_key, properties, created_at, updated_at';

function hasOwnKeys(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return value !== undefined && Object.keys(value).length > 0;
}

/**
 * Fact (=`links` row, aliased `l`) visibility predicate — belt-and-suspenders alongside the
 * `links_visibility` RLS policy (migrations/core/0010_link_visibility.sql, redefined by
 * migrations/core/0013_link_visibility_security_definer.sql): every Fact-reading query builder
 * below states the rule explicitly, the same convention this file already follows for
 * `workspace_id` (bound as `$1` even though RLS enforces it too).
 *
 * Calls the `security definer` function `link_visible_to_caller` (0013) rather than joining
 * `observations`/`sources` inline here — `nexttime_app` (the role every one of these queries runs
 * under) has no RLS visibility into an `observations`/`sources` row it does not own, so an inline
 * join here would suffer the exact bug 0013's own comment documents: RLS on those two tables
 * hiding the very evidence this predicate needs to correctly hide a Fact. The function bypasses
 * that (see 0013) and returns only a boolean.
 */
const LINK_VISIBLE_PREDICATE = 'link_visible_to_caller(l.workspace_id, l.activity_id)';

// -------------------------------------------------------------------------------------------
// objects
// -------------------------------------------------------------------------------------------

/**
 * `upsertObject` (design doc §16 identity keys, docs/development-tasks.md S1.2): when
 * `input.identity` carries at least one key, upserts by `(workspace_id, object_type,
 * identity_key)` against the partial unique index from migrations/core/0006_object_identity.sql
 * — a shallow jsonb merge (`||`) of new properties over old on conflict. With no identity, always
 * inserts a new row (there is nothing to conflict against).
 */
export function buildUpsertObjectQuery(workspaceId: string, input: UpsertObjectInput): SqlQuery {
  const properties = input.properties ?? {};

  if (hasOwnKeys(input.identity)) {
    return {
      text: `
        insert into objects (workspace_id, object_type, identity_key, properties)
        values ($1, $2, $3::jsonb, $4::jsonb)
        on conflict (workspace_id, object_type, identity_key) where identity_key is not null
        do update set properties = objects.properties || excluded.properties, updated_at = now()
        returning ${OBJECT_COLUMNS}
      `,
      values: [
        workspaceId,
        input.objectType,
        JSON.stringify(input.identity),
        JSON.stringify(properties),
      ],
    };
  }

  return {
    text: `
      insert into objects (workspace_id, object_type, properties)
      values ($1, $2, $3::jsonb)
      returning ${OBJECT_COLUMNS}
    `,
    values: [workspaceId, input.objectType, JSON.stringify(properties)],
  };
}

export function buildGetObjectQuery(workspaceId: string, objectId: string): SqlQuery {
  return {
    text: `select ${OBJECT_COLUMNS} from objects where workspace_id = $1 and id = $2`,
    values: [workspaceId, objectId],
  };
}
/** `getObjectByIdentity` (store.ts): looks up an Object by its `(object_type, identity_key)`
 *  upsert key — the same partial unique index `buildUpsertObjectQuery` conflicts against
 *  (migrations/core/0006_object_identity.sql). jsonb equality (`=`), not containment (`@>`): an
 *  identity key is an exact key/value set, matching the upsert's own conflict semantics. */
export function buildGetObjectByIdentityQuery(
  workspaceId: string,
  objectType: string,
  identity: Record<string, unknown>,
): SqlQuery {
  return {
    text: `
      select ${OBJECT_COLUMNS}
      from objects
      where workspace_id = $1 and object_type = $2 and identity_key = $3::jsonb
    `,
    values: [workspaceId, objectType, JSON.stringify(identity)],
  };
}

/**
 * `search` keyset cursor (W5, docs/STATUS.md 遗留 2 / retrospective-2026-09-09.md §5.5): the page
 * boundary is the last row's `(updated_at, id)`, the same pair `buildSearchQuery` orders by, so a
 * page never skips or repeats a row even when `updated_at` ties. Opaque on the wire (base64url of
 * `<iso>|<uuid>`), same encoding `substrate/epistemic/decisions.ts` and `conflicts.ts` use for
 * their own cursors — a fourth private copy, deliberately (see this task's PR body: no shared
 * helper refactor in a W5 closeout).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeSearchCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** Same "never throws on a malformed cursor" convention as the decisions/conflicts decoders — a
 *  cursor that does not parse reads as "no cursor" (first page), never as a 500. */
export function decodeSearchCursor(
  cursor: string | undefined,
): { readonly updatedAt: string; readonly id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sepIndex = decoded.lastIndexOf('|');
    if (sepIndex < 0) return null;
    const updatedAt = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    // Both halves are bound with explicit casts (`$5::timestamptz`, `$6::uuid`) — validate both
    // here so a hand-crafted cursor can never reach Postgres and surface as a 500.
    if (!updatedAt || Number.isNaN(Date.parse(updatedAt)) || !UUID_PATTERN.test(id)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/** S1 minimal search (docs/development-tasks.md S1.2): ILIKE over properties and identity_key.
 *  W5: keyset-paginated on `(updated_at desc, id desc)` via `input.cursor` (see
 *  `encodeSearchCursor`); `limit` is bound as given — callers clamp (`MAX_SEARCH_LIMIT`, store.ts)
 *  and may over-fetch by one to detect a next page (`SqlGraphStore.searchPage`).
 *
 *  The sort/keyset column is `date_trunc('milliseconds', updated_at)`, not the raw column: the
 *  cursor round-trips through a JS `Date` (node-postgres parses `timestamptz` into one), which
 *  carries milliseconds only, while Postgres stores microseconds. Comparing the raw column against
 *  a millisecond-truncated cursor would drop every row sharing the boundary millisecond (all rows
 *  written in one transaction share the same `now()`), so both sides are truncated to the same
 *  precision and `id` breaks the ties. */
export function buildSearchQuery(workspaceId: string, input: SearchInput): SqlQuery {
  const pattern = `%${input.query}%`;
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const cursor = decodeSearchCursor(input.cursor);
  return {
    text: `
      select ${OBJECT_COLUMNS}
      from objects
      where workspace_id = $1
        and ($2::text is null or object_type = $2)
        and (properties::text ilike $3 or coalesce(identity_key::text, '') ilike $3)
        and (
          $5::timestamptz is null
          or (date_trunc('milliseconds', updated_at), id) < ($5::timestamptz, $6::uuid)
        )
      order by date_trunc('milliseconds', updated_at) desc, id desc
      limit $4
    `,
    values: [
      workspaceId,
      input.objectType ?? null,
      pattern,
      limit,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
    ],
  };
}

// -------------------------------------------------------------------------------------------
// links (facts)
// -------------------------------------------------------------------------------------------

export interface InsertFactParams {
  readonly linkType: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly properties: Record<string, unknown>;
  readonly validFrom: Date | null;
  readonly validUntil: Date | null;
  readonly epistemicStatus: string;
  readonly confidence: number | null;
  readonly activityId: string;
  readonly assertedBy: string;
  /** Set only by `supersedeFact` — the Fact this new row supersedes. */
  readonly supersedesId: string | null;
  /** The single Observation that fed this Fact (migrations/core/0018), or `null` when the writer
   *  has no single Observation to name (ad-hoc `assert_fact`, worker results today). */
  readonly observationId: string | null;
}

export function buildInsertFactQuery(workspaceId: string, params: InsertFactParams): SqlQuery {
  return {
    text: `
      insert into links
        (workspace_id, link_type, source_object_id, target_object_id, properties, valid_from,
         valid_until, epistemic_status, confidence, activity_id, asserted_by, supersedes_id,
         observation_id)
      values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()), $7::timestamptz, $8, $9, $10, $11, $12, $13)
      returning ${FACT_COLUMNS}
    `,
    values: [
      workspaceId,
      params.linkType,
      params.sourceObjectId,
      params.targetObjectId,
      JSON.stringify(params.properties),
      params.validFrom,
      params.validUntil,
      params.epistemicStatus,
      params.confidence,
      params.activityId,
      params.assertedBy,
      params.supersedesId,
      params.observationId,
    ],
  };
}

export function buildGetFactForUpdateQuery(workspaceId: string, factId: string): SqlQuery {
  return {
    text: `select ${FACT_COLUMNS} from links where workspace_id = $1 and id = $2 for update`,
    values: [workspaceId, factId],
  };
}

/**
 * S3.2 conflict detection (I5, docs/development-tasks.md S3.2): the identity `assertFact` checks
 * before every insert — "the same (source object, link type, target) as an existing non-superseded
 * Fact". Calls `find_active_fact_for_identity` (migrations/core/0017 — a `security definer`
 * function, same escape hatch as `link_visible_to_caller`/0013) rather than a plain `select ...
 * from links` here: the asserting caller's own `links_visibility` RLS would otherwise hide exactly
 * the case I5 exists to catch — a prior Fact fed by a private Source the caller does not own (see
 * that migration's own comment on the function for the full "why a plain SELECT is wrong here"
 * reasoning). The function's own `for update` (same convention as `buildGetFactForUpdateQuery`)
 * locks the row for the rest of `assertFact`'s transaction, so two concurrent assertions against
 * the same identity serialize rather than both reading "no prior Fact" and both inserting
 * independently. Only the *most recently recorded* still-active Fact is considered (the function's
 * own `order by recorded_at desc limit 1`) — after a Conflict has been opened once, more than one
 * Fact can be simultaneously `recorded` for the same identity (that is the whole point of "keep
 * both"); a third assertion is compared against the latest of those, not exhaustively against
 * every open side (see `conflicts.ts`'s own module comment for why this scope boundary is
 * acceptable for S3.2).
 */
export function buildFindActiveFactByIdentityQuery(
  workspaceId: string,
  identity: {
    readonly linkType: string;
    readonly sourceObjectId: string;
    readonly targetObjectId: string;
  },
): SqlQuery {
  return {
    text: `select ${FACT_COLUMNS} from find_active_fact_for_identity($1, $2, $3, $4)`,
    values: [workspaceId, identity.linkType, identity.sourceObjectId, identity.targetObjectId],
  };
}

/**
 * `verifyFact` (S3.2 `verify_fact` capability): promotes `epistemic_status` to `verified` and
 * stamps `verified_by`. The I4 content-immutability trigger (`links_block_content_update`,
 * migrations/core/0002_substrate.sql) explicitly excludes `epistemic_status`/`verified_by` from
 * its blocklist — "verify/contradict are legitimate follow-on writes to an already-recorded Fact,
 * not a content edit" — so this UPDATE is not blocked by I4 despite `links` otherwise being
 * append-only.
 */
export function buildVerifyFactQuery(
  workspaceId: string,
  factId: string,
  verifiedBy: string,
): SqlQuery {
  return {
    text: `
      update links set epistemic_status = 'verified', verified_by = $3
      where workspace_id = $1 and id = $2
      returning ${FACT_COLUMNS}
    `,
    values: [workspaceId, factId, verifiedBy],
  };
}

export function buildMarkFactSupersededQuery(workspaceId: string, factId: string): SqlQuery {
  return {
    text: `
      update links set superseded_at = now()
      where workspace_id = $1 and id = $2
      returning ${FACT_COLUMNS}
    `,
    values: [workspaceId, factId],
  };
}

/** `reason` (migrations/core/0007) is caller-supplied free text, or `null` when omitted. */
export function buildMarkFactInvalidatedQuery(
  workspaceId: string,
  factId: string,
  reason: string | null,
): SqlQuery {
  return {
    text: `
      update links set invalidated_at = now(), invalidation_reason = $3
      where workspace_id = $1 and id = $2
      returning ${FACT_COLUMNS}
    `,
    values: [workspaceId, factId, reason],
  };
}

/** Depth-1 read of the Facts touching `input.objectId`, filtered by direction/link type. */
export function buildNeighborsQuery(workspaceId: string, input: NeighborsInput): SqlQuery {
  const direction: TraverseDirection = input.direction ?? DEFAULT_TRAVERSE_DIRECTION;
  return {
    text: `
      select ${FACT_COLUMNS}
      from links l
      where workspace_id = $1
        and superseded_at is null
        and invalidated_at is null
        and (
          ($3 = 'out' and source_object_id = $2)
          or ($3 = 'in' and target_object_id = $2)
          or ($3 = 'both' and (source_object_id = $2 or target_object_id = $2))
        )
        and ($4::text is null or link_type = $4)
        and ${LINK_VISIBLE_PREDICATE}
      order by recorded_at desc
    `,
    values: [workspaceId, input.objectId, direction, input.linkType ?? null],
  };
}

/**
 * Recursive CTE walking currently-active (`superseded_at is null and invalidated_at is null`)
 * Facts from `input.fromId`, bounded to `MAX_TRAVERSE_DEPTH` (design doc §9.3, I18-adjacent cap).
 * Throws `TraverseDepthError` (via `normalizeTraverseDepth`) if `input.depth` is out of range.
 * Each edge is reported once, at the shallowest depth any path reached it (`group by … min(depth)`
 * — depth-bounded recursion over a possibly-cyclic graph can otherwise revisit the same edge from
 * more than one path).
 */
export function buildTraverseQuery(workspaceId: string, input: TraverseInput): SqlQuery {
  const direction: TraverseDirection = input.direction ?? DEFAULT_TRAVERSE_DIRECTION;
  const depth = normalizeTraverseDepth(input.depth);

  return {
    text: `
      with recursive walk(link_id, link_type, source_object_id, target_object_id, next_object_id, depth) as (
        select l.id, l.link_type, l.source_object_id, l.target_object_id,
          case when l.source_object_id = $2 then l.target_object_id else l.source_object_id end,
          1
        from links l
        where l.workspace_id = $1
          and l.superseded_at is null
          and l.invalidated_at is null
          and (
            ($3 = 'out' and l.source_object_id = $2)
            or ($3 = 'in' and l.target_object_id = $2)
            or ($3 = 'both' and (l.source_object_id = $2 or l.target_object_id = $2))
          )
          and ($4::text is null or l.link_type = $4)
          and ${LINK_VISIBLE_PREDICATE}

        union all

        select l.id, l.link_type, l.source_object_id, l.target_object_id,
          case when l.source_object_id = w.next_object_id then l.target_object_id else l.source_object_id end,
          w.depth + 1
        from links l
        join walk w on (
          ($3 = 'out' and l.source_object_id = w.next_object_id)
          or ($3 = 'in' and l.target_object_id = w.next_object_id)
          or ($3 = 'both' and (l.source_object_id = w.next_object_id or l.target_object_id = w.next_object_id))
        )
        where l.workspace_id = $1
          and l.superseded_at is null
          and l.invalidated_at is null
          and ($4::text is null or l.link_type = $4)
          and w.depth < $5
          and ${LINK_VISIBLE_PREDICATE}
      )
      select link_id, link_type, source_object_id, target_object_id, next_object_id, min(depth) as depth
      from walk
      group by link_id, link_type, source_object_id, target_object_id, next_object_id
      order by depth, link_id
    `,
    values: [workspaceId, input.fromId, direction, input.linkType ?? null, depth],
  };
}

/**
 * `listRecentFacts` (docs/development-tasks.md S1.4 `get_entry_context`): currently-active Facts
 * for the workspace, newest `recorded_at` first — the same "active" filter
 * `buildNeighborsQuery`/`buildTraverseQuery` already use (`superseded_at is null and
 * invalidated_at is null`), with no anchor Object (workspace-wide, not `traverse`-from-a-node).
 */
export function buildRecentFactsQuery(workspaceId: string, limit: number | undefined): SqlQuery {
  return {
    text: `
      select ${FACT_COLUMNS}
      from links l
      where workspace_id = $1
        and superseded_at is null
        and invalidated_at is null
        and ${LINK_VISIBLE_PREDICATE}
      order by recorded_at desc
      limit $2
    `,
    values: [workspaceId, limit ?? DEFAULT_RECENT_FACTS_LIMIT],
  };
}

// -------------------------------------------------------------------------------------------
// bitemporal read
// -------------------------------------------------------------------------------------------

/**
 * `stateAt` (design doc §9.1/§9.3 bitemporal read, docs/development-tasks.md S1.2): Facts
 * touching `input.objectId` that were current as of `input.at` on both axes — business time
 * (`valid_from <= at < valid_until`) and system time (`recorded_at <= at` and not yet
 * `superseded_at`/`invalidated_at` as of `at`). This is what makes "state_at(t0) still returns
 * the old fact after supersede" hold: supersede sets the old row's `superseded_at` to a time
 * after `t0`, so at `t0` it was still current on the system-time axis.
 */
export function buildStateAtFactsQuery(workspaceId: string, input: StateAtInput): SqlQuery {
  return {
    text: `
      select ${FACT_COLUMNS}
      from links l
      where workspace_id = $1
        and (source_object_id = $2 or target_object_id = $2)
        and recorded_at <= $3::timestamptz
        and (superseded_at is null or superseded_at > $3)
        and (invalidated_at is null or invalidated_at > $3)
        and valid_from <= $3
        and (valid_until is null or valid_until > $3)
        and ${LINK_VISIBLE_PREDICATE}
      order by recorded_at desc
    `,
    values: [workspaceId, input.objectId, input.at],
  };
}
