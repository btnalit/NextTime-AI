import {
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
  valid_from, valid_until, recorded_at, superseded_at, invalidated_at, supersedes_id,
  epistemic_status, confidence, activity_id, asserted_by, verified_by`;

const OBJECT_COLUMNS =
  'workspace_id, id, object_type, identity_key, properties, created_at, updated_at';

function hasOwnKeys(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return value !== undefined && Object.keys(value).length > 0;
}

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

/** S1 minimal search (docs/development-tasks.md S1.2): ILIKE over properties and identity_key. */
export function buildSearchQuery(workspaceId: string, input: SearchInput): SqlQuery {
  const pattern = `%${input.query}%`;
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  return {
    text: `
      select ${OBJECT_COLUMNS}
      from objects
      where workspace_id = $1
        and ($2::text is null or object_type = $2)
        and (properties::text ilike $3 or coalesce(identity_key::text, '') ilike $3)
      order by updated_at desc
      limit $4
    `,
    values: [workspaceId, input.objectType ?? null, pattern, limit],
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
}

export function buildInsertFactQuery(workspaceId: string, params: InsertFactParams): SqlQuery {
  return {
    text: `
      insert into links
        (workspace_id, link_type, source_object_id, target_object_id, properties, valid_from,
         valid_until, epistemic_status, confidence, activity_id, asserted_by, supersedes_id)
      values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()), $7::timestamptz, $8, $9, $10, $11, $12)
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
    ],
  };
}

export function buildGetFactForUpdateQuery(workspaceId: string, factId: string): SqlQuery {
  return {
    text: `select ${FACT_COLUMNS} from links where workspace_id = $1 and id = $2 for update`,
    values: [workspaceId, factId],
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

export function buildMarkFactInvalidatedQuery(workspaceId: string, factId: string): SqlQuery {
  return {
    text: `
      update links set invalidated_at = now()
      where workspace_id = $1 and id = $2
      returning ${FACT_COLUMNS}
    `,
    values: [workspaceId, factId],
  };
}

/** Depth-1 read of the Facts touching `input.objectId`, filtered by direction/link type. */
export function buildNeighborsQuery(workspaceId: string, input: NeighborsInput): SqlQuery {
  const direction: TraverseDirection = input.direction ?? DEFAULT_TRAVERSE_DIRECTION;
  return {
    text: `
      select ${FACT_COLUMNS}
      from links
      where workspace_id = $1
        and superseded_at is null
        and invalidated_at is null
        and (
          ($3 = 'out' and source_object_id = $2)
          or ($3 = 'in' and target_object_id = $2)
          or ($3 = 'both' and (source_object_id = $2 or target_object_id = $2))
        )
        and ($4::text is null or link_type = $4)
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
      )
      select link_id, link_type, source_object_id, target_object_id, next_object_id, min(depth) as depth
      from walk
      group by link_id, link_type, source_object_id, target_object_id, next_object_id
      order by depth, link_id
    `,
    values: [workspaceId, input.fromId, direction, input.linkType ?? null, depth],
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
      from links
      where workspace_id = $1
        and (source_object_id = $2 or target_object_id = $2)
        and recorded_at <= $3::timestamptz
        and (superseded_at is null or superseded_at > $3)
        and (invalidated_at is null or invalidated_at > $3)
        and valid_from <= $3
        and (valid_until is null or valid_until > $3)
      order by recorded_at desc
    `,
    values: [workspaceId, input.objectId, input.at],
  };
}
