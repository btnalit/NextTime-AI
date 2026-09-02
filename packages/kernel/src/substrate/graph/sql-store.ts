import type { EpistemicStatus } from '@nexttime/shared';
import { FACT_LIFECYCLE_TRANSITIONS, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { enqueue } from '../outbox/index.js';
import {
  buildGetFactForUpdateQuery,
  buildGetObjectQuery,
  buildInsertFactQuery,
  buildMarkFactInvalidatedQuery,
  buildMarkFactSupersededQuery,
  buildNeighborsQuery,
  buildRecentFactsQuery,
  buildSearchQuery,
  buildStateAtFactsQuery,
  buildTraverseQuery,
  buildUpsertObjectQuery,
} from './queries.js';
import {
  type AssertFactInput,
  type CallerPrincipal,
  type Fact,
  FactNotFoundError,
  type GraphObject,
  type GraphStore,
  type InvalidateFactInput,
  type NeighborsInput,
  type SearchInput,
  type StateAtInput,
  type StateAtResult,
  type SupersedeFactInput,
  type TraverseEdge,
  type TraverseInput,
  type TraverseResult,
  type UpsertObjectInput,
  assertNoCallerSuppliedEpistemicStatus,
  deriveEpistemicStatus,
  factLifecycleState,
} from './store.js';

/**
 * substrate/graph/sql-store: the Postgres `GraphStore` implementation (design doc §9.1 "先 SQL",
 * docs/development-tasks.md S1.2). Every method takes a `pg` `PoolClient` already inside a
 * `withWorkspace()` transaction (see store.ts's module doc) — this module never opens a `Pool`
 * or starts/commits a transaction itself; atomicity ("supersedeFact inserts the new fact and
 * sets superseded_at/supersedes_id in one transaction", "a failed assertFact leaves no partial
 * rows") comes entirely from the caller's surrounding `withWorkspace()` BEGIN…COMMIT/ROLLBACK.
 *
 * Outbox write path: `assertFact`/`supersedeFact` append their `FactAsserted` domain event through
 * `substrate/outbox`'s `enqueue()` (the single sanctioned outbox writer — schema-validated against
 * `@nexttime/shared`'s `PlatformEventSchema`, never a hand-written INSERT), on the same `client`
 * and therefore in the same transaction as the Fact insert (design doc §7.10 "领域事件与 outbox").
 */

interface ObjectRow {
  workspace_id: string;
  id: string;
  object_type: string;
  identity_key: Record<string, unknown> | null;
  properties: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface FactRow {
  workspace_id: string;
  id: string;
  link_type: string;
  source_object_id: string;
  target_object_id: string;
  properties: Record<string, unknown>;
  valid_from: Date;
  valid_until: Date | null;
  recorded_at: Date;
  superseded_at: Date | null;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
  supersedes_id: string | null;
  epistemic_status: EpistemicStatus;
  confidence: number | null;
  activity_id: string;
  asserted_by: string;
  verified_by: string | null;
}

interface TraverseRow {
  link_id: string;
  link_type: string;
  source_object_id: string;
  target_object_id: string;
  next_object_id: string;
  depth: number;
}

function mapObjectRow(row: ObjectRow): GraphObject {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    objectType: row.object_type,
    identityKey: row.identity_key,
    properties: row.properties,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFactRow(row: FactRow): Fact {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    linkType: row.link_type,
    sourceObjectId: row.source_object_id,
    targetObjectId: row.target_object_id,
    properties: row.properties,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    recordedAt: row.recorded_at,
    supersededAt: row.superseded_at,
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
    supersedesId: row.supersedes_id,
    epistemicStatus: row.epistemic_status,
    confidence: row.confidence,
    activityId: row.activity_id,
    assertedBy: row.asserted_by,
    verifiedBy: row.verified_by,
  };
}

/**
 * `FactAsserted` (packages/shared/src/events.ts) for a freshly inserted Fact row. `objectId`
 * carries the Fact's target Object — the endpoint a consumer most often wants to refresh.
 */
async function enqueueFactAsserted(
  client: PoolClient,
  workspaceId: string,
  fact: Fact,
): Promise<void> {
  await enqueue(client, {
    type: 'FactAsserted',
    workspaceId,
    factId: fact.id,
    objectId: fact.targetObjectId,
    epistemicStatus: fact.epistemicStatus,
  });
}

function firstRowOrThrow<T>(rows: readonly T[], onMissing: () => Error): T {
  const row = rows[0];
  if (row === undefined) throw onMissing();
  return row;
}

export class SqlGraphStore implements GraphStore {
  async upsertObject(
    client: PoolClient,
    workspaceId: string,
    input: UpsertObjectInput,
  ): Promise<GraphObject> {
    const query = buildUpsertObjectQuery(workspaceId, input);
    const result = await client.query<ObjectRow>(query.text, query.values as unknown[]);
    return mapObjectRow(
      firstRowOrThrow(
        result.rows,
        () => new Error('upsertObject: INSERT ... RETURNING produced no row'),
      ),
    );
  }

  async getObject(
    client: PoolClient,
    workspaceId: string,
    objectId: string,
  ): Promise<GraphObject | null> {
    const query = buildGetObjectQuery(workspaceId, objectId);
    const result = await client.query<ObjectRow>(query.text, query.values as unknown[]);
    const row = result.rows[0];
    return row === undefined ? null : mapObjectRow(row);
  }

  async assertFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: AssertFactInput,
  ): Promise<Fact> {
    assertNoCallerSuppliedEpistemicStatus(input);
    const epistemicStatus = deriveEpistemicStatus(caller.kind);

    const query = buildInsertFactQuery(workspaceId, {
      linkType: input.linkType,
      sourceObjectId: input.sourceObjectId,
      targetObjectId: input.targetObjectId,
      properties: input.properties ?? {},
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      epistemicStatus,
      confidence: input.confidence ?? null,
      activityId: input.activityId,
      assertedBy: caller.id,
      supersedesId: null,
    });
    const result = await client.query<FactRow>(query.text, query.values as unknown[]);
    const fact = mapFactRow(
      firstRowOrThrow(
        result.rows,
        () => new Error('assertFact: INSERT ... RETURNING produced no row'),
      ),
    );

    await enqueueFactAsserted(client, workspaceId, fact);
    return fact;
  }

  async supersedeFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: SupersedeFactInput,
  ): Promise<Fact> {
    assertNoCallerSuppliedEpistemicStatus(input);

    const currentQuery = buildGetFactForUpdateQuery(workspaceId, input.factId);
    const currentResult = await client.query<FactRow>(
      currentQuery.text,
      currentQuery.values as unknown[],
    );
    const currentRow = firstRowOrThrow(
      currentResult.rows,
      () => new FactNotFoundError(workspaceId, input.factId),
    );

    // Illegal transition (e.g. superseding an already-superseded/invalidated Fact) throws
    // IllegalTransition (@nexttime/shared) before any write happens.
    const currentState = factLifecycleState({
      supersededAt: currentRow.superseded_at,
      invalidatedAt: currentRow.invalidated_at,
    });
    transition(FACT_LIFECYCLE_TRANSITIONS, currentState, 'supersede');

    const epistemicStatus = deriveEpistemicStatus(caller.kind);
    const insertQuery = buildInsertFactQuery(workspaceId, {
      linkType: input.linkType,
      sourceObjectId: input.sourceObjectId,
      targetObjectId: input.targetObjectId,
      properties: input.properties ?? {},
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      epistemicStatus,
      confidence: input.confidence ?? null,
      activityId: input.activityId,
      assertedBy: caller.id,
      supersedesId: input.factId,
    });
    const insertResult = await client.query<FactRow>(
      insertQuery.text,
      insertQuery.values as unknown[],
    );
    const newFact = mapFactRow(
      firstRowOrThrow(
        insertResult.rows,
        () => new Error('supersedeFact: INSERT ... RETURNING produced no row'),
      ),
    );

    const markQuery = buildMarkFactSupersededQuery(workspaceId, input.factId);
    const markResult = await client.query<FactRow>(markQuery.text, markQuery.values as unknown[]);
    firstRowOrThrow(markResult.rows, () => new FactNotFoundError(workspaceId, input.factId));

    await enqueueFactAsserted(client, workspaceId, newFact);
    return newFact;
  }

  async invalidateFact(
    client: PoolClient,
    workspaceId: string,
    _caller: CallerPrincipal,
    input: InvalidateFactInput,
  ): Promise<Fact> {
    const currentQuery = buildGetFactForUpdateQuery(workspaceId, input.factId);
    const currentResult = await client.query<FactRow>(
      currentQuery.text,
      currentQuery.values as unknown[],
    );
    const currentRow = firstRowOrThrow(
      currentResult.rows,
      () => new FactNotFoundError(workspaceId, input.factId),
    );

    const currentState = factLifecycleState({
      supersededAt: currentRow.superseded_at,
      invalidatedAt: currentRow.invalidated_at,
    });
    transition(FACT_LIFECYCLE_TRANSITIONS, currentState, 'invalidate');

    // `input.reason`, if given, is persisted to `links.invalidation_reason` (migrations/core/
    // 0007) — see InvalidateFactInput's doc comment in store.ts.
    const markQuery = buildMarkFactInvalidatedQuery(
      workspaceId,
      input.factId,
      input.reason ?? null,
    );
    const markResult = await client.query<FactRow>(markQuery.text, markQuery.values as unknown[]);
    return mapFactRow(
      firstRowOrThrow(markResult.rows, () => new FactNotFoundError(workspaceId, input.factId)),
    );
  }

  async neighbors(
    client: PoolClient,
    workspaceId: string,
    input: NeighborsInput,
  ): Promise<readonly Fact[]> {
    const query = buildNeighborsQuery(workspaceId, input);
    const result = await client.query<FactRow>(query.text, query.values as unknown[]);
    return result.rows.map(mapFactRow);
  }

  async traverse(
    client: PoolClient,
    workspaceId: string,
    input: TraverseInput,
  ): Promise<TraverseResult> {
    // buildTraverseQuery validates/clamps depth (throws TraverseDepthError) before any query runs.
    const query = buildTraverseQuery(workspaceId, input);
    const result = await client.query<TraverseRow>(query.text, query.values as unknown[]);

    const edges: TraverseEdge[] = result.rows.map((row) => ({
      linkId: row.link_id,
      linkType: row.link_type,
      sourceObjectId: row.source_object_id,
      targetObjectId: row.target_object_id,
      depth: Number(row.depth),
    }));

    const shallowestDepthByNode = new Map<string, number>();
    for (const row of result.rows) {
      const depth = Number(row.depth);
      const known = shallowestDepthByNode.get(row.next_object_id);
      if (known === undefined || depth < known)
        shallowestDepthByNode.set(row.next_object_id, depth);
    }
    const nodes = [...shallowestDepthByNode.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([objectId]) => objectId);

    return { nodes, edges };
  }

  async stateAt(
    client: PoolClient,
    workspaceId: string,
    input: StateAtInput,
  ): Promise<StateAtResult> {
    const objectQuery = buildGetObjectQuery(workspaceId, input.objectId);
    const objectResult = await client.query<ObjectRow>(
      objectQuery.text,
      objectQuery.values as unknown[],
    );
    const objectRow = objectResult.rows[0];

    const factsQuery = buildStateAtFactsQuery(workspaceId, input);
    const factsResult = await client.query<FactRow>(
      factsQuery.text,
      factsQuery.values as unknown[],
    );

    return {
      object: objectRow === undefined ? null : mapObjectRow(objectRow),
      facts: factsResult.rows.map(mapFactRow),
    };
  }

  async search(
    client: PoolClient,
    workspaceId: string,
    input: SearchInput,
  ): Promise<readonly GraphObject[]> {
    const query = buildSearchQuery(workspaceId, input);
    const result = await client.query<ObjectRow>(query.text, query.values as unknown[]);
    return result.rows.map(mapObjectRow);
  }

  /**
   * Additive S1.4 method (see store.ts's doc comment on this method, and the S1.4 dispatch's
   * ownership note: "if GraphStore lacks something you need ... a small additive method in
   * substrate/graph"). `get_entry_context` (gateway/handlers.ts) is the only caller.
   */
  async listRecentFacts(
    client: PoolClient,
    workspaceId: string,
    limit?: number,
  ): Promise<readonly Fact[]> {
    const query = buildRecentFactsQuery(workspaceId, limit);
    const result = await client.query<FactRow>(query.text, query.values as unknown[]);
    return result.rows.map(mapFactRow);
  }
}
