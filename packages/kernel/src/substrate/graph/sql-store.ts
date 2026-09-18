import type { EpistemicStatus, PrincipalKind } from '@nexttime/shared';
import {
  EPISTEMIC_PROMOTION_TRANSITIONS,
  FACT_LIFECYCLE_TRANSITIONS,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { openConflict, resolveFactOrigin, sameFactOrigin } from '../epistemic/index.js';
import { enqueue } from '../outbox/index.js';
import { enforceOntologyOnLinkWrite } from './ontology-guard.js';
import {
  buildFindActiveFactByIdentityQuery,
  buildGetFactForUpdateQuery,
  buildGetObjectByIdentityQuery,
  buildGetObjectQuery,
  buildInsertFactQuery,
  buildInvalidateUnobservedFactsQuery,
  buildLatestFactInvalidatedForIdentityQuery,
  buildMarkFactInvalidatedQuery,
  buildMarkFactSupersededQuery,
  buildNeighborsQuery,
  buildRecentFactsQuery,
  buildSearchQuery,
  buildStateAtFactsQuery,
  buildTouchFactObservationQuery,
  buildTraverseQuery,
  buildUpsertObjectQuery,
  buildVerifyFactQuery,
  encodeSearchCursor,
} from './queries.js';
import {
  type AssertFactInput,
  type AssertFactResult,
  type CallerPrincipal,
  DEFAULT_SEARCH_LIMIT,
  type Fact,
  FactNotFoundError,
  type GraphObject,
  type GraphStore,
  type InvalidateFactInput,
  type InvalidateUnobservedFactsInput,
  MAX_SEARCH_LIMIT,
  type NeighborsInput,
  type SearchInput,
  type SearchPage,
  type StateAtInput,
  type StateAtResult,
  type SupersedeFactInput,
  SupersedeIdentityMismatchError,
  type TraverseEdge,
  type TraverseInput,
  type TraverseResult,
  type UpsertObjectInput,
  type VerifyFactInput,
  assertNoCallerSuppliedEpistemicStatus,
  deriveEpistemicStatus,
  factContentEquals,
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
  last_observed_at: Date | null;
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
  observation_id: string | null;
  last_observation_id: string | null;
  last_observed_at: Date | null;
}

/**
 * S5.5 (leftover 24): bound on the extra re-reads `assertFact` performs, past the advisory-lock
 * re-read, when the identity's newest row is `superseded` but its successor is not yet visible to
 * this statement's snapshot (see the `assertFact` comment on the loop for the race this closes).
 * Each attempt is one more short-lived Postgres round trip only on the already-rare "blocked on a
 * row someone else is superseding" path — 5 gives real interleavings several chances to resolve
 * without risking an unbounded wait if something is genuinely stuck.
 */
const MAX_ACTIVE_FACT_REREAD_ATTEMPTS = 5;

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
    lastObservedAt: row.last_observed_at,
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
    observationId: row.observation_id,
    lastObservationId: row.last_observation_id,
    lastObservedAt: row.last_observed_at,
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

/**
 * Resolves `caller.id`'s real `principals.kind` (lane-1 P2 fix — see `CallerPrincipal.kind`'s own
 * doc comment in store.ts): the sole source of truth `assertFact`/`supersedeFact` use to derive
 * `epistemic_status`, deliberately ignoring whatever `caller.kind` a call site may still pass.
 * Throws if `id` has no `principals` row in this workspace — every `asserted_by` FK requires one
 * to exist anyway, so this should never actually fire outside a caller bug.
 */
async function resolveCallerKind(
  client: PoolClient,
  workspaceId: string,
  callerId: string,
): Promise<PrincipalKind> {
  const result = await client.query<{ kind: PrincipalKind }>(
    'select kind from principals where workspace_id = $1 and id = $2',
    [workspaceId, callerId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `SqlGraphStore: no principals row for workspace ${workspaceId}, id ${callerId} — cannot derive epistemic_status`,
    );
  }
  return row.kind;
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

  async getObjectByIdentity(
    client: PoolClient,
    workspaceId: string,
    objectType: string,
    identity: Record<string, unknown>,
  ): Promise<GraphObject | null> {
    if (Object.keys(identity).length === 0) return null;
    const query = buildGetObjectByIdentityQuery(workspaceId, objectType, identity);
    const result = await client.query<ObjectRow>(query.text, query.values as unknown[]);
    const row = result.rows[0];
    return row === undefined ? null : mapObjectRow(row);
  }

  /**
   * S3.2 conflict detection (I5, docs/development-tasks.md S3.2) runs first, before any insert:
   * `buildFindActiveFactByIdentityQuery` looks for an existing non-superseded/non-invalidated Fact
   * with the same `(linkType, sourceObjectId, targetObjectId)` identity (`for update` — locks it
   * for the rest of this transaction, serializing a concurrent assertion against the same
   * identity). None found → the ordinary insert-only path below, unchanged.
   *
   * Prior Fact(s) *are* found (several after a Conflict — 0027) → `resolveFactOrigin`
   * (substrate/epistemic) resolves "who/what asserted this" for the new assertion and each prior
   * row (the epistemic Source feeding each side's Activity when there is exactly one, else the
   * asserting principal — see `conflicts.ts`'s own module doc comment for why this is the
   * generalization I5's "按 source_id 判定" needs to be correct for every writer in this codebase,
   * not only the one that happens to attach an Observation); the writer builds on its *own* row
   * when it has one, else on the newest. Same origin, content
   * *unchanged* (`factContentEquals`, store.ts — docs/development-tasks.md S3.2 followup
   * "idempotent re-assertion") → a true no-op: returns the existing Fact as-is (`unchanged: true`),
   * writes nothing, and enqueues no `FactAsserted` — a collector re-submitting the same structural
   * fact on every run must not grow `links`/`outbox` by one row per run forever. Same origin,
   * content *changed* → this call *is* a supersede (delegates to `this.supersedeFact`, which the
   * caller could equally well have called directly had it already known the prior Fact's id — the
   * delegation is exactly that same path, just discovered here instead of by the caller). Different
   * origin → both Facts stay `recorded`; `openConflict` (substrate/epistemic) opens a
   * `status='open'` Conflict referencing both, keyed to *this* insert's own Activity (the one whose
   * assertion discovered the disagreement).
   */
  async assertFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: AssertFactInput,
  ): Promise<AssertFactResult> {
    assertNoCallerSuppliedEpistemicStatus(input);
    // S5.1 (ontology-guard.ts): I2 at the write point, before the identity lookup below takes
    // any lock and before any of the three write paths this method can end in.
    await enforceOntologyOnLinkWrite(client, workspaceId, caller, input);

    const priorQuery = buildFindActiveFactByIdentityQuery(workspaceId, {
      linkType: input.linkType,
      sourceObjectId: input.sourceObjectId,
      targetObjectId: input.targetObjectId,
    });
    let priorResult = await client.query<FactRow>(priorQuery.text, priorQuery.values as unknown[]);
    if (priorResult.rows.length === 0) {
      // W5.5 (docs/code-review-2026-09-10.md §2.2, STATUS leftover 17): a *first* assertion of an
      // identity has no row for `FOR UPDATE` to lock, and `links` deliberately has no unique
      // constraint on the identity (the Conflict path keeps two active rows on purpose), so two
      // concurrent first assertions from different origins both saw "no prior Fact", both inserted,
      // and no Conflict was opened. Serialize on the identity with a transaction-scoped advisory
      // lock (same `pg_advisory_xact_lock(hashtext(...))` convention `application/task/invoke.ts`'s
      // quota-locked insert uses) and re-read: the second transaction now blocks until the first
      // commits and sees its row through the ordinary origin comparison below. Taken only on the
      // no-prior-row path so steady-state re-observation of known edges never locks; a hashtext
      // collision merely over-serializes. Two batches locking overlapping first-time identities in
      // opposite order can still deadlock — Postgres aborts one (`40P01`), which surfaces as a 500
      // to that caller; the collector's interval loop re-submits on its next cycle and the ingest
      // is idempotent, so the batch is retried rather than lost.
      await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
        `${workspaceId}:fact:${input.linkType}:${input.sourceObjectId}:${input.targetObjectId}`,
      ]);
      priorResult = await client.query<FactRow>(priorQuery.text, priorQuery.values as unknown[]);

      // S5.5 (migrations/core/0029, STATUS leftover 24): the re-read above is itself a `for update`
      // lookup and can block on a THIRD transaction superseding the row it locks. Under READ
      // COMMITTED, an unblocked `for update` statement (EvalPlanQual) rechecks only the specific row
      // it was blocked on against its now-committed version — it never rescans for a sibling row
      // (the successor) that same blocking transaction also inserted, because that row is outside
      // this statement's own snapshot, taken when the statement started, before the blocking
      // transaction committed. So this re-read can *also* come back with 0 rows even though a
      // successor now exists — three-transaction interleaving, not covered by the single re-read
      // above (which only closes the two-transaction race).
      //
      // Bounded retry, gated on whether the identity's *newest* row (any lifecycle state, not only
      // still-active — `latest_fact_invalidated_for_identity`) is `invalidated` rather than on
      // whether it is `superseded`: a *second* concurrent supersede (a fourth transaction superseding
      // the very successor the third one just created, or deeper) keeps making the newest row the
      // latest un-superseded link in the chain — checking `superseded_at` on it would wrongly read
      // "no successor" and stop one re-read short of ever finding that chain's current tip. Checking
      // `invalidated_at` does not have this gap: `recorded → superseded | invalidated` is mutually
      // exclusive and terminal, so a chain only ever *ends* (no further successor to wait for) by
      // invalidation, never by supersession. Re-read again whenever the newest row exists and is not
      // invalidated (it is `recorded` — a fresh read finds it directly — or `superseded` — its own
      // successor may or may not be visible yet, worth another look). Stops the moment the lookup
      // finds rows, or the newest row is invalidated / there is no row at all (a fresh insert is
      // genuinely correct); also stops after MAX_ACTIVE_FACT_REREAD_ATTEMPTS so a genuinely stuck
      // interleaving cannot wedge this call forever — at that point `assertFact` falls through to the
      // same "insert fresh" behavior it had before this fix, which is safe (never corrupts state)
      // even if imperfect (an avoidable extra active Fact).
      for (
        let attempt = 0;
        priorResult.rows.length === 0 && attempt < MAX_ACTIVE_FACT_REREAD_ATTEMPTS;
        attempt++
      ) {
        const latestQuery = buildLatestFactInvalidatedForIdentityQuery(workspaceId, {
          linkType: input.linkType,
          sourceObjectId: input.sourceObjectId,
          targetObjectId: input.targetObjectId,
        });
        const latestResult = await client.query<{ invalidated: boolean | null }>(
          latestQuery.text,
          latestQuery.values as unknown[],
        );
        if (latestResult.rows[0]?.invalidated !== false) break;
        priorResult = await client.query<FactRow>(priorQuery.text, priorQuery.values as unknown[]);
      }
    }
    const newestRow = priorResult.rows[0];

    if (newestRow) {
      // S5.2 (migrations/core/0027): the lookup returns every still-active row of the identity —
      // after a Conflict, several. The row this writer builds on is its *own* (the first with the
      // same origin, newest first): unchanged / touch / supersede below. Only when none is its own
      // is the newest the counterpart for the corroboration / Conflict branch — 0017's behaviour
      // whenever a single row exists. Building on the latest row regardless was wrong once the
      // observation window existed: a collector re-observing an identity another Source had
      // contradicted would open a second Conflict and then retire its own untouched row.
      const newOrigin = await resolveFactOrigin(client, workspaceId, {
        activityId: input.activityId,
        assertedBy: caller.id,
      });
      let ownRow: FactRow | undefined;
      for (const row of priorResult.rows) {
        const origin = await resolveFactOrigin(client, workspaceId, {
          activityId: row.activity_id,
          assertedBy: row.asserted_by,
        });
        if (sameFactOrigin(origin, newOrigin)) {
          ownRow = row;
          break;
        }
      }
      const priorRow = ownRow ?? newestRow;
      const priorFact = mapFactRow(priorRow);
      if (ownRow) {
        if (factContentEquals(priorFact, input)) {
          // S5.2 (migrations/core/0026): the same Source saw the same Fact again — no new row,
          // `unchanged` semantics intact, but the freshness clock advances when the writer names
          // its Observation. The observation window (`invalidateUnobservedFacts`) reads exactly
          // this clock to tell "seen this run" from "gone".
          if (input.observationId) {
            const touch = buildTouchFactObservationQuery(
              workspaceId,
              priorRow.id,
              input.observationId,
            );
            const touched = await client.query<FactRow>(touch.text, touch.values as unknown[]);
            const touchedRow = touched.rows[0];
            if (touchedRow) return { ...mapFactRow(touchedRow), unchanged: true };
          }
          return { ...priorFact, unchanged: true };
        }
        // Already ontology-checked above (same identity) — the guarded public `supersedeFact`
        // would only repeat the same three queries.
        return this.supersedeValidatedFact(client, workspaceId, caller, {
          ...input,
          factId: priorRow.id,
        });
      }

      // Different origin, identical content: corroboration, not disagreement (W5.5, STATUS
      // leftover 16). Before every WorkerRun became its own Source this branch was only reached
      // with genuinely differing sources; now two runs of the same Worker that reach the same
      // conclusion land here too, and opening a Conflict between two agreeing Facts would be
      // wrong. Two cases, split on whether the caller can *see* the prior Fact — the identity
      // lookup above is SECURITY DEFINER (migrations/core/0017) and finds rows RLS would hide:
      //   - visible: the prior Fact is returned `unchanged` (the agreeing Observation stays on its
      //     own Activity for `explain(activityId)`); a first-class "corroborated by" record is a
      //     possible follow-up, not built here.
      //   - hidden (the prior's Activity carries a Source private to someone else): returning its
      //     id would hand the caller a Fact it can never read back, so the caller gets its own
      //     Fact on its own Activity — and no Conflict, since the two agree.
      if (factContentEquals(priorFact, input)) {
        const visible = await client.query(
          'select 1 from links where workspace_id = $1 and id = $2',
          [workspaceId, priorRow.id],
        );
        if (visible.rows.length > 0) {
          return { ...priorFact, unchanged: true };
        }
        return this.insertFreshFact(client, workspaceId, caller, input);
      }

      const callerKind = await resolveCallerKind(client, workspaceId, caller.id);
      const epistemicStatus = deriveEpistemicStatus(callerKind);
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
        supersedesId: null,
        observationId: input.observationId ?? null,
      });
      const insertResult = await client.query<FactRow>(
        insertQuery.text,
        insertQuery.values as unknown[],
      );
      const newFact = mapFactRow(
        firstRowOrThrow(
          insertResult.rows,
          () => new Error('assertFact: INSERT ... RETURNING produced no row'),
        ),
      );

      await openConflict(client, workspaceId, {
        factAId: priorRow.id,
        factBId: newFact.id,
        activityId: input.activityId,
      });
      await enqueueFactAsserted(client, workspaceId, newFact);
      return newFact;
    }

    return this.insertFreshFact(client, workspaceId, caller, input);
  }

  /** The "no prior active Fact this caller may build on" insert `assertFact` ends in: a new row with
   *  `supersedes_id` null, epistemic status derived from the caller's real principal kind, and the
   *  `FactAsserted` outbox event. */
  private async insertFreshFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: AssertFactInput,
  ): Promise<Fact> {
    const callerKind = await resolveCallerKind(client, workspaceId, caller.id);
    const epistemicStatus = deriveEpistemicStatus(callerKind);

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
      observationId: input.observationId ?? null,
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
    // S5.1 (ontology-guard.ts): the replacement Fact's LinkType / endpoints are checked exactly
    // like a fresh assertion's — a supersede keeps the identity, so this is the same check the
    // prior Fact passed (or, for a row written before S5.1, never had).
    await enforceOntologyOnLinkWrite(client, workspaceId, caller, input);
    return this.supersedeValidatedFact(client, workspaceId, caller, input);
  }

  /** `supersedeFact` after the ontology guard — `assertFact`'s same-origin delegation enters
   *  here directly, having already run the guard on the same identity. */
  private async supersedeValidatedFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: SupersedeFactInput,
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

    // I5 (lane-1 P1 fix): a supersede may only replace the *content* of the Fact it targets, never
    // its identity — the replacement's (linkType, sourceObjectId, targetObjectId) must match the
    // Fact being superseded, checked before any write (and before the lifecycle-transition check
    // below, so a caller gets the more specific error).
    if (
      input.linkType !== currentRow.link_type ||
      input.sourceObjectId !== currentRow.source_object_id ||
      input.targetObjectId !== currentRow.target_object_id
    ) {
      throw new SupersedeIdentityMismatchError(workspaceId, input.factId);
    }

    // Illegal transition (e.g. superseding an already-superseded/invalidated Fact) throws
    // IllegalTransition (@nexttime/shared) before any write happens.
    const currentState = factLifecycleState({
      supersededAt: currentRow.superseded_at,
      invalidatedAt: currentRow.invalidated_at,
    });
    transition(FACT_LIFECYCLE_TRANSITIONS, currentState, 'supersede');

    const callerKind = await resolveCallerKind(client, workspaceId, caller.id);
    const epistemicStatus = deriveEpistemicStatus(callerKind);
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
      observationId: input.observationId ?? null,
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

  /** S5.2 observation window — see `GraphStore.invalidateUnobservedFacts` (store.ts) and
   *  `buildInvalidateUnobservedFactsQuery` (queries.ts) for the predicate. RLS applies as for any
   *  other update on the workspace client: only Facts the observing Principal can see are touched,
   *  which for a collector's own Source is every Fact it ever fed. */
  async invalidateUnobservedFacts(
    client: PoolClient,
    workspaceId: string,
    input: InvalidateUnobservedFactsInput,
  ): Promise<readonly string[]> {
    if (input.objectTypes.length === 0) return [];
    const query = buildInvalidateUnobservedFactsQuery(workspaceId, input);
    const result = await client.query<{ id: string }>(query.text, query.values as unknown[]);
    return result.rows.map((row) => row.id);
  }

  /** S3.2 `verify_fact` — see `VerifyFactInput`'s own doc comment in store.ts for why the Evidence
   *  precondition (I3.6) is checked by the caller, not here. */
  async verifyFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: VerifyFactInput,
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

    transition(EPISTEMIC_PROMOTION_TRANSITIONS, currentRow.epistemic_status, 'verify');

    const query = buildVerifyFactQuery(workspaceId, input.factId, caller.id);
    const result = await client.query<FactRow>(query.text, query.values as unknown[]);
    return mapFactRow(
      firstRowOrThrow(result.rows, () => new FactNotFoundError(workspaceId, input.factId)),
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

  async searchPage(
    client: PoolClient,
    workspaceId: string,
    input: SearchInput,
  ): Promise<SearchPage> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    // Over-fetch by one: a (limit + 1)th row proves there is a next page without a second query,
    // and is never returned itself — it will be the first row of that next page.
    const query = buildSearchQuery(workspaceId, { ...input, limit: limit + 1 });
    const result = await client.query<ObjectRow>(query.text, query.values as unknown[]);
    const rows = result.rows.slice(0, limit);
    const items = rows.map(mapObjectRow);
    const last = items[items.length - 1];
    const nextCursor =
      result.rows.length > limit && last ? encodeSearchCursor(last.updatedAt, last.id) : undefined;
    return nextCursor === undefined ? { items } : { items, nextCursor };
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
