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
  readonly supersedesId: string | null;
  /** Independent belief-strength axis (§5.6). */
  readonly epistemicStatus: EpistemicStatus;
  readonly confidence: number | null;
  readonly activityId: string;
  readonly assertedBy: string;
  readonly verifiedBy: string | null;
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
  readonly kind: PrincipalKind;
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
}

export interface SupersedeFactInput extends AssertFactInput {
  /** The existing Fact this new assertion supersedes. */
  readonly factId: string;
}

export interface InvalidateFactInput {
  readonly factId: string;
  /**
   * Not currently persisted — see sql-store.ts's `invalidateFact` doc comment: I4's
   * content-column trigger blocks writing to `links.properties` on an already-recorded row
   * (invalidation only ever touches `invalidated_at`), so there is nowhere in the current schema
   * to durably record a free-text reason without either an I4 exception or a new column. Kept in
   * the input shape now (accepted, silently not persisted) so the call site doesn't have to
   * change again once a column exists.
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
}

export const DEFAULT_SEARCH_LIMIT = 50;

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

  assertFact(
    client: PoolClient,
    workspaceId: string,
    caller: CallerPrincipal,
    input: AssertFactInput,
  ): Promise<Fact>;

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
}
