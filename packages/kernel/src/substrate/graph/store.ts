import type { EpistemicStatus, PrincipalKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * substrate/graph/store: the `GraphStore` facade (design doc §9.1 "GraphStore facade 先 SQL",
 * §7.1 graph module, §7.10 substrate layer) — Object/Link(=Fact) reads and writes, `traverse` /
 * `neighbors` / `stateAt` / `search`. Pure types + interface + the small pure helpers that don't
 * need a database (epistemic-status-by-caller-kind, input validation) live here so they're unit
 * testable with no Postgres involved; `sql-store.ts` supplies the Postgres implementation.
 *
 * Every method takes an already-open `pg` `PoolClient` (never a `Pool`) — the caller is expected
 * to have obtained it from `adapters/db/pool.ts`'s `withWorkspace()`, which has already set the
 * `app.workspace_id` / `app.principal_id` RLS session variables and switched onto the
 * `nexttime_app` role, and which wraps the whole call in one transaction (BEGIN…COMMIT/ROLLBACK).
 * This module must not import that adapter directly (§7.10 six-layer rule: substrate may depend
 * only on domain); the `FactAsserted` outbox write goes through `substrate/outbox` (see
 * sql-store.ts).
 */

// -------------------------------------------------------------------------------------------
// Row-shaped domain types (design doc §9.2 `objects` / `links` DDL)
// -------------------------------------------------------------------------------------------

/** An Object (graph node) — design doc §5.1.2. */
export interface GraphObject {
  readonly workspaceId: string;
  readonly id: string;
  readonly objectType: string;
  /** The caller-supplied identity key/value pairs this Object was upserted by, or `null`. */
  readonly identityKey: Record<string, unknown> | null;
  readonly properties: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A Link (= Fact) — design doc §5.1.2, §5.4 I3/I4, §5.5, §5.6. */
export interface Fact {
  readonly workspaceId: string;
  readonly id: string;
  readonly linkType: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly properties: Record<string, unknown>;
  /** Business-time validity interval (§5.5 bitemporal). */
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  /** System-time bookkeeping (§5.5 `recorded → superseded | invalidated`). */
  readonly recordedAt: Date;
  readonly supersededAt: Date | null;
  readonly invalidatedAt: Date | null;
  /** Caller-supplied free-text reason for `invalidateFact`, or `null` (migrations/core/0007). */
  readonly invalidationReason: string | null;
  readonly supersedesId: string | null;
  /** Independent belief-strength axis (§5.6). */
  readonly epistemicStatus: EpistemicStatus;
  readonly confidence: number | null;
  readonly activityId: string;
  readonly assertedBy: string;
  readonly verifiedBy: string | null;
  /** W5 (migrations/core/0018): the single Observation that fed this Fact, when the writer knew
   *  it — `submit_observations` threads one per submitted item; `null` for ad-hoc `assert_fact`
   *  and every pre-0018 row. `explain(factId)` narrows to it when set (§5.1.3 provenance one
   *  level below the Activity), and falls back to the Activity's whole Observation list otherwise. */
  readonly observationId: string | null;
}

/** The derived lifecycle state of a Fact row (§5.5) — not a stored column, computed from timestamps. */
export type FactLifecycleState = 'recorded' | 'superseded' | 'invalidated';

/** Direction of traversal relative to the anchor Object (§9.3 `traverse`). */
export const TRAVERSE_DIRECTION_VALUES = ['in', 'out', 'both'] as const;
export type TraverseDirection = (typeof TRAVERSE_DIRECTION_VALUES)[number];

/** Maximum `traverse` depth (design doc §9.3 "bounded to depth ≤ 3", I18-adjacent cap). */
export const MAX_TRAVERSE_DEPTH = 3;
export const MIN_TRAVERSE_DEPTH = 1;
export const DEFAULT_TRAVERSE_DEPTH = 1;
export const DEFAULT_TRAVERSE_DIRECTION: TraverseDirection = 'both';

// -------------------------------------------------------------------------------------------
// The calling Principal (kind decides epistemic_status — §5.6, docs/development-tasks.md S1.2)
// -------------------------------------------------------------------------------------------

export interface CallerPrincipal {
  readonly id: string;
  /**
   * **Not trusted** (lane-1 P2 fix): `SqlGraphStore.assertFact`/`supersedeFact` derive the actual
   * `epistemic_status`-driving kind from the `principals` row for `id` in the same transaction,
   * never from this field — a caller could otherwise claim `kind: 'human'` (→ `asserted`) for a
   * write that was not actually made by a human principal, or vice versa. Kept optional, rather
   * than removed, purely so existing call sites that still pass it (e.g. a service-principal
   * caller that wants its intent documented at the call site) do not need to change; a caller that
   * omits it entirely is exactly as correct as one that supplies it.
   *
   * A Worker's result-contract path (§5.6 / S2.9, `application/task/result.ts`'s
   * `postWorkerResult`) no longer needs a downgrade flag here to reach `inferred`: `id` is a real
   * `kind='agent'` principal (`application/task/agent-principal.ts`'s `ensureWorkerAgentPrincipal`,
   * one per (workspace, WorkerDefinition)) — `deriveEpistemicStatus` below already yields
   * `inferred` for it, the same way every other caller kind already works. (Replaces the interim
   * `viaAgent` flag this codebase carried before agent-kind principals existed — PR #84.)
   */
  readonly kind?: PrincipalKind;
}

// -------------------------------------------------------------------------------------------
// Method inputs / outputs
// -------------------------------------------------------------------------------------------

export interface UpsertObjectInput {
  readonly objectType: string;
  readonly properties?: Record<string, unknown>;
  /** Object identity: object_type (above) + these key/value pairs (design doc §16). Upserts by
   *  this key when non-empty; otherwise always inserts a new Object. */
  readonly identity?: Record<string, unknown>;
}

/**
 * Deliberately has no `epistemicStatus` field — see I3 in the class comment on
 * `EpistemicStatusOverrideError` below. `activityId` is required (I3: every Fact must trace to
 * the Activity that produced it).
 */
export interface AssertFactInput {
  readonly linkType: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly activityId: string;
  readonly properties?: Record<string, unknown>;
  readonly validFrom?: Date;
  readonly validUntil?: Date | null;
  readonly confidence?: number | null;
  /** See `Fact.observationId`. Optional — most writers have no single Observation to name. */
  readonly observationId?: string | null;
}

export interface SupersedeFactInput extends AssertFactInput {
  /** The existing Fact this new assertion supersedes. */
  readonly factId: string;
}

/**
 * `assertFact`'s return: the written/found Fact, plus — only on the idempotent no-op path
 * (docs/development-tasks.md S3.2 followup "idempotent re-assertion"; `factContentEquals` below)
 * — `unchanged: true`. Every other path (fresh assert, same-origin content-changed supersede,
 * different-origin conflict-branch insert) never sets the flag, so this remains structurally
 * exactly a `Fact` (one additional *optional* property) — every existing caller that only ever
 * used a bare `Fact` (six of the eight `assertFact` call sites in this codebase) keeps compiling
 * and behaving exactly as before. The one caller that reads it today is `ingest-handlers.ts`'s
 * `submit_observations`, which reports it back to a collector as `factsUnchanged`.
 */
export type AssertFactResult = Fact & { readonly unchanged?: true };

/** `verifyFact` (S3.2 `verify_fact` capability, design doc §5.3 item 6 / I3.6): promotes an
 *  existing Fact's `epistemic_status` to `verified` and stamps `verified_by: caller.id`. Evidence
 *  presence (the "harder half" of I3.6 — 0002_substrate.sql's own comment: "verified 的 Fact 没有
 *  verified_by 与 Evidence" needs a cross-table check the DB CHECK alone cannot express) is the
 *  caller's responsibility to verify first (`application/gateway/epistemic-handlers.ts`'s
 *  `verifyFactHandler` checks `substrate/epistemic`'s `hasEvidence` before calling this) — kept out
 *  of `GraphStore` itself so this module never has to read the `evidence` table it does not own. */
export interface VerifyFactInput {
  readonly factId: string;
}

export interface InvalidateFactInput {
  readonly factId: string;
  /**
   * Persisted to `links.invalidation_reason` (migrations/core/0007_fact_invalidation_reason.sql,
   * docs/development-tasks.md S1.3 item 7). I4's content-column immutability trigger
   * (`links_block_content_update`, 0002_substrate.sql) does not block this column — it is a new
   * nullable column that trigger's explicit blocklist never names, the same way it already never
   * named `invalidated_at`.
   */
  readonly reason?: string;
}

export interface NeighborsInput {
  readonly objectId: string;
  readonly direction?: TraverseDirection;
  readonly linkType?: string;
}

export interface TraverseInput {
  readonly fromId: string;
  readonly direction?: TraverseDirection;
  readonly linkType?: string;
  /** 1..3 (`MIN_TRAVERSE_DEPTH`..`MAX_TRAVERSE_DEPTH`); defaults to `DEFAULT_TRAVERSE_DEPTH`. */
  readonly depth?: number;
}

export interface TraverseEdge {
  readonly linkId: string;
  readonly linkType: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  /** The shallowest depth (1-based) at which this edge was reached from `fromId`. */
  readonly depth: number;
}

export interface TraverseResult {
  /** Unique Object ids reached (excludes `fromId` itself), ordered by shallowest depth first. */
  readonly nodes: readonly string[];
  readonly edges: readonly TraverseEdge[];
}

export interface StateAtInput {
  readonly objectId: string;
  readonly at: Date;
}

export interface StateAtResult {
  readonly object: GraphObject | null;
  /** Facts touching `objectId` (either endpoint) that were current — both business-time
   *  (`valid_from`/`valid_until`) and system-time (`recorded_at`/`superseded_at`/
   *  `invalidated_at`) — as of `at`. */
  readonly facts: readonly Fact[];
}

export interface SearchInput {
  readonly query: string;
  readonly objectType?: string;
  readonly limit?: number;
  /** Opaque keyset cursor from a previous `SearchPage.nextCursor` (queries.ts
   *  `encodeSearchCursor`); absent or malformed → first page. */
  readonly cursor?: string;
}

/** `searchPage` (W5 `search` pagination): one page plus the cursor for the next, `nextCursor`
 *  absent on the last page. */
export interface SearchPage {
  readonly items: readonly GraphObject[];
  readonly nextCursor?: string;
}

export const DEFAULT_SEARCH_LIMIT = 50;
/** Hard cap a single `search` page may carry; a larger requested `limit` is clamped here and the
 *  capability result marks `truncated: true` (docs/wire-contract-conventions.md §3). */
export const MAX_SEARCH_LIMIT = 200;

/**
 * `listRecentFacts` (docs/development-tasks.md S1.4 `get_entry_context`: "up to N recent
 * non-superseded Facts for the workspace with epistemic_status"): a small additive `GraphStore`
 * method, not part of the S1.2 method set. `application/gateway/handlers.ts`'s
 * `get_entry_context` handler is the only caller — see this method's own note in sql-store.ts for
 * why it was added here (the ownership carve-out for GraphStore in the S1.4 dispatch) rather than
 * as a hand-written query in gateway/handlers.ts.
 */
export const DEFAULT_RECENT_FACTS_LIMIT = 20;

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/**
 * Thrown when `assertFact`/`supersedeFact` receives a caller-supplied `epistemicStatus` (or
 * `epistemic_status`) field — the S1.2 dispatch is explicit that epistemic_status is derived
 * from the caller's `PrincipalKind`, never accepted from the caller, so this is checked at
 * runtime even though `AssertFactInput`'s type already omits the field (a caller going through
 * JS, or spreading an untyped object, could still smuggle one in).
 */
export class EpistemicStatusOverrideError extends Error {
  constructor() {
    super(
      'assertFact/supersedeFact: epistemic_status is derived from the caller PrincipalKind and cannot be supplied by the caller',
    );
    this.name = 'EpistemicStatusOverrideError';
  }
}

export class TraverseDepthError extends Error {
  constructor(depth: number) {
    super(
      `traverse: depth must be between ${MIN_TRAVERSE_DEPTH} and ${MAX_TRAVERSE_DEPTH}, got ${depth}`,
    );
    this.name = 'TraverseDepthError';
  }
}

export class FactNotFoundError extends Error {
  constructor(workspaceId: string, factId: string) {
    super(`Fact not found: workspace ${workspaceId}, id ${factId}`);
    this.name = 'FactNotFoundError';
  }
}

/**
 * Thrown by `supersedeFact` when the replacement's `(linkType, sourceObjectId, targetObjectId)`
 * does not match the Fact it supersedes (I5 — lane-1 P1 fix): a supersede replaces the *content*
 * of an existing edge (properties/valid_from/valid_until/confidence/epistemic promotion), never
 * its identity. Without this check, `state_at()` history for the *original* triple silently stops
 * updating while a `supersedes_id` chain quietly walks off to a completely different edge — a
 * caller reading the old triple's history at a later `at` would see stale data with no indication
 * a "supersede" ever happened to it at all.
 */
export class SupersedeIdentityMismatchError extends Error {
  constructor(workspaceId: string, factId: string) {
    super(
      `supersedeFact: workspace ${workspaceId}, fact ${factId} — the replacement's (linkType, sourceObjectId, targetObjectId) must match the Fact it supersedes (I5); to record a genuinely different edge, assertFact a new Fact instead`,
    );
    this.name = 'SupersedeIdentityMismatchError';
  }
}

// -------------------------------------------------------------------------------------------
// Pure helpers (unit-testable with no database)
// -------------------------------------------------------------------------------------------

/**
 * epistemic_status by caller kind (docs/development-tasks.md S1.2 dispatch, design doc §5.6):
 * human → asserted, agent → inferred, service → observed.
 */
const EPISTEMIC_STATUS_BY_PRINCIPAL_KIND: Readonly<Record<PrincipalKind, EpistemicStatus>> = {
  human: 'asserted',
  agent: 'inferred',
  service: 'observed',
};

/** Derives the `epistemic_status` a new Fact gets from who is asserting it. Pure, no IO. */
export function deriveEpistemicStatus(principalKind: PrincipalKind): EpistemicStatus {
  return EPISTEMIC_STATUS_BY_PRINCIPAL_KIND[principalKind];
}

/**
 * Throws `EpistemicStatusOverrideError` if `input` carries a caller-supplied epistemic status
 * under either the camelCase (TS-shaped) or snake_case (raw/DB-shaped) key. Pure, no IO.
 */
export function assertNoCallerSuppliedEpistemicStatus(input: object): void {
  const bag = input as Record<string, unknown>;
  if (bag.epistemicStatus !== undefined || bag.epistemic_status !== undefined) {
    throw new EpistemicStatusOverrideError();
  }
}

/** Derives a Fact's lifecycle state from its (mutually exclusive) bookkeeping timestamps. */
export function factLifecycleState(fact: {
  readonly supersededAt: Date | null;
  readonly invalidatedAt: Date | null;
}): FactLifecycleState {
  if (fact.invalidatedAt !== null) return 'invalidated';
  if (fact.supersededAt !== null) return 'superseded';
  return 'recorded';
}

/** Deterministic JSON serialization — sorts object keys recursively so two `properties` objects
 *  with the same content but different key order compare equal. A local copy of `application/
 *  gateway/action-executor.ts`'s own `stableStringify` (same pattern, same scope limit: no BigInt/
 *  Date/cyclic handling, fine because a Fact's `properties` is always JSON-shaped caller input) —
 *  not imported from there because substrate may not depend on the application layer (§7.10
 *  six-layer rule). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Idempotent-re-assertion equality (docs/development-tasks.md S3.2 followup —
 * `SqlGraphStore.assertFact`'s "same-origin re-assertion" branch): whether re-asserting `input` on
 * top of the currently-active `prior` Fact (same `(linkType, sourceObjectId, targetObjectId)`
 * identity, same origin — both already established by the caller before this is invoked) should be
 * treated as a no-op rather than a supersede. Exactly three things are compared, deliberately no
 * more:
 *
 *  - `linkType`/`sourceObjectId`/`targetObjectId` — already guaranteed equal by the identity
 *    lookup that found `prior` in the first place; re-checked here anyway so this function's own
 *    contract is self-evidently complete rather than silently relying on a fact only true at its
 *    one call site.
 *  - `properties` deep-equal after (recursively) sorting keys — key order is never meaningful
 *    content, same convention `ingest-handlers.ts`'s `identityCacheKey` already uses for identity
 *    objects, extended here to nested values via `stableStringify` above.
 *  - `validUntil` both `null` — only an open-ended Fact on *both* sides is eligible for the no-op
 *    path; a Fact with an explicit business-time end on either side conservatively falls through to
 *    the existing supersede path (no writer in this codebase gives `validUntil` today, so this
 *    never actually excludes a real caller — it exists so a future bitemporal-close caller is not
 *    silently short-circuited by this fix).
 *
 * Deliberately excludes `validFrom`: no writer in this codebase — the host-inventory collector
 * included, `ingest-handlers.ts`'s `IngestLink` has no `validFrom` field at all — ever supplies
 * one, so every insert gets `coalesce($, now())`. Comparing it would make every re-assertion "not
 * equal" purely from insert-time clock drift, defeating the very idempotency this function exists
 * to provide.
 *
 * Also excludes `confidence`: no writer in this codebase varies `confidence` across otherwise-
 * identical re-assertions today, and `epistemic_status` (caller-kind-derived, never caller content
 * — `assertNoCallerSuppliedEpistemicStatus` already forbids supplying it) is not part of "content"
 * at all.
 */
export function factContentEquals(
  prior: Pick<Fact, 'linkType' | 'sourceObjectId' | 'targetObjectId' | 'properties' | 'validUntil'>,
  input: Pick<
    AssertFactInput,
    'linkType' | 'sourceObjectId' | 'targetObjectId' | 'properties' | 'validUntil'
  >,
): boolean {
  if (
    prior.linkType !== input.linkType ||
    prior.sourceObjectId !== input.sourceObjectId ||
    prior.targetObjectId !== input.targetObjectId
  ) {
    return false;
  }
  if (prior.validUntil !== null || (input.validUntil ?? null) !== null) return false;
  return stableStringify(prior.properties) === stableStringify(input.properties ?? {});
}

/** Validates and normalizes a `traverse`/`neighbors` depth; throws `TraverseDepthError` if out of range. */
export function normalizeTraverseDepth(depth: number | undefined): number {
  const resolved = depth ?? DEFAULT_TRAVERSE_DEPTH;
  if (
    !Number.isInteger(resolved) ||
    resolved < MIN_TRAVERSE_DEPTH ||
    resolved > MAX_TRAVERSE_DEPTH
  ) {
    throw new TraverseDepthError(resolved);
  }
  return resolved;
}

// -------------------------------------------------------------------------------------------
// The facade
// -------------------------------------------------------------------------------------------

export interface GraphStore {
  upsertObject(
    client: PoolClient,
    workspaceId: string,
    input: UpsertObjectInput,
  ): Promise<GraphObject>;

  getObject(client: PoolClient, workspaceId: string, objectId: string): Promise<GraphObject | null>;

  /** Reads one Object by its `(object_type, identity)` upsert key (§16 identity keys) — the
   *  lookup `upsertObject`'s own partial unique index (migrations/core/0006_object_identity.sql)
   *  is built on. `null` when no Object has that identity, or when `identity` is empty (there is
   *  nothing to look up — an identity-less Object is never addressable this way, only by id).
   *  Added for governance/gatekeepers' Operation manifest registry (S2.4): resolving a Gatekeeper's
   *  published Operation by `{gatekeeperId, name}` without a dedicated relational table (design
   *  doc §9.2 "operations 作为平台元本体存于 objects / links"). */
  getObjectByIdentity(
    client: PoolClient,
    workspaceId: string,
    objectType: string,
    identity: Record<string, unknown>,
  ): Promise<GraphObject | null>;

  assertFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: AssertFactInput,
  ): Promise<AssertFactResult>;

  supersedeFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: SupersedeFactInput,
  ): Promise<Fact>;

  invalidateFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: InvalidateFactInput,
  ): Promise<Fact>;

  verifyFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: VerifyFactInput,
  ): Promise<Fact>;

  neighbors(
    client: PoolClient,
    workspaceId: string,
    input: NeighborsInput,
  ): Promise<readonly Fact[]>;

  traverse(client: PoolClient, workspaceId: string, input: TraverseInput): Promise<TraverseResult>;

  stateAt(client: PoolClient, workspaceId: string, input: StateAtInput): Promise<StateAtResult>;

  search(
    client: PoolClient,
    workspaceId: string,
    input: SearchInput,
  ): Promise<readonly GraphObject[]>;

  /** W5: the paginated form of `search` — same predicate and ordering, keyset cursor in/out.
   *  `search` itself keeps returning a bare page-less array for its existing callers
   *  (explorer-read-service's batch fetch, find-means); new callers wanting a cursor use this. */
  searchPage(client: PoolClient, workspaceId: string, input: SearchInput): Promise<SearchPage>;

  /** Up to `limit` (default `DEFAULT_RECENT_FACTS_LIMIT`) currently-active (non-superseded,
   *  non-invalidated) Facts for the workspace, newest `recorded_at` first. */
  listRecentFacts(
    client: PoolClient,
    workspaceId: string,
    limit?: number,
  ): Promise<readonly Fact[]>;
}
