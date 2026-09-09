import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import {
  type DecisionImpactResult,
  type DecisionRow,
  type ExplainResult,
  causalChain,
  decisionImpact,
  explainByNodeId,
  findPrecedents,
  queryDecisions,
} from '../../substrate/epistemic/index.js';
import type { Fact, GraphObject } from '../../substrate/graph/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { type ProvGraph, buildProvenanceGraph } from './provenance-graph.js';

// Re-exported so `interfaces/explorer-contract` (which may not import `substrate/**` directly,
// `.dependency-cruiser.cjs`'s `kernel-interfaces-must-not-reach-into-substrate-directly`) can type
// this module's own return values (`listDecisionsForExplorer`'s `readonly DecisionRow[]`,
// `listGraphNodesForExplorer`'s `ExplorerPage<GraphObject>`, `listGraphEdgesForExplorer`'s
// `ExplorerPage<Fact>`) without a second, hand-duplicated copy of any of these types.
export type { DecisionRow } from '../../substrate/epistemic/index.js';
export type { Fact, GraphObject } from '../../substrate/graph/index.js';

/**
 * application/gateway/explorer-read-service: the read-side business logic behind the nine
 * Explorer endpoints (docs/development-tasks.md §S3.5; design doc §9.5) — `interfaces/explorer-
 * contract` calls these directly and never re-enters `dispatchCapability` for them, for a
 * structural reason, not a style preference: every capability these reads would otherwise map to
 * (`get_object`/`traverse`/`search`/`state_at` in the `graph` group, `explain`/`query_decisions`/
 * `causal_chain`/`decision_impact`/`find_precedents` in the `epistemic` group —
 * `packages/shared/src/capabilities.ts`) is registered `channel: 'handle'` — agent/Worker-facing
 * only. `authorizeCapabilityCall` (authorize.ts) rejects a human caller outright for any of them,
 * and Explorer is deliberately a `channel: 'human'`, API-key client (design doc §7.6 "Explorer 是
 * human 通道客户端，用 API key，不用 Handle") — going through `dispatchCapability` is therefore not
 * merely slower here, it is not a usable path at all. These functions are this module's own
 * `channel: 'human'`-shaped read surface instead: same `withWorkspace` RLS scoping
 * `dispatchCapability` itself uses, same underlying substrate calls the `handle`-channel
 * capabilities use, no policy/quota gate (there is none to check — every one of these is a
 * read), and no audit-record write (these are Explorer diagnostic reads, not governed capability
 * calls — `export_prov`, by contrast, *is* a `channel: 'human'` capability with its own audit
 * trail; see `export-prov-handler.ts`).
 *
 * Every function takes `(pool, workspaceId, principalId, params)` and opens its own
 * `withWorkspace` transaction — `interfaces/explorer-contract/index.ts` resolves `workspaceId`/
 * `principalId` once per request (`resolveCaller`, the API key's own Principal/workspace) and
 * never touches `pool`/`substrate` itself, keeping the six-layer rule intact
 * (`.dependency-cruiser.cjs`: interfaces may depend on adapters for the `PoolLike` *type* the same
 * way `interfaces/http/capability-route.ts` already does via `DispatchDeps`, but the actual
 * `withWorkspace` calls all live here, in application).
 *
 * **Pagination note** (nodes/edges/decisions): `GraphStore.search`/`listRecentFacts` have no
 * native offset or keyset cursor (substrate/graph is out of this task's file ownership — adding
 * one there is future work), so `listGraphNodesForExplorer`/`listGraphEdgesForExplorer` fetch one
 * bounded batch (`EXPLORER_MAX_FETCH`, ordered by `updated_at`/`recorded_at` desc — the same order
 * the reference Explorer's own `/api/graph/nodes`/`/api/graph/edges` document) and paginate over it in memory,
 * with an opaque offset cursor. Known limitation, documented rather than hidden: a workspace with
 * more than `EXPLORER_MAX_FETCH` matching objects/facts will not expose the tail past that cap
 * through this endpoint, and `total`/`has_more` describe the fetched batch, not the true
 * workspace-wide count once that cap is hit. `listDecisionsForExplorer` instead loops
 * `queryDecisions`'s own keyset cursor (which *is* real, decisions.ts's own pagination) until it
 * has enough rows, bounded the same way.
 */

const graphStore = new SqlGraphStore();

/** Cap for the in-memory-pagination batches above — matches the reference Explorer's own
 *  `/api/graph/nodes` `limit` query param ceiling (`le=5000`, explorer/routes/graph.py). */
const EXPLORER_MAX_FETCH = 5000;

/**
 * The platform meta-ontology's own Object-projection `objectType`s (substrate/ontology/
 * meta-objects.ts: `WorkerDefinition`/`Gatekeeper`/`Skill`/`Procedure`/`Operation`, plus the
 * `connects_to`/`exposes` Facts wiring them together) — mechanism, not the domain content an
 * operator opens Explorer to look at. Design doc §9.5/§7.6 says the Explorer hides Ontology and
 * other governance workspaces; these rows are the same category of thing even though they live in
 * the *same* `objects`/`links` tables as genuine domain Objects (there is no separate table to
 * simply not query), so every one of `listGraphNodesForExplorer`/`listGraphEdgesForExplorer`/
 * `searchGraphForExplorer`/`getTemporalBoundsForExplorer`/`getTemporalSnapshotForExplorer` filters
 * them out explicitly. Hand-maintained against `meta-objects.ts`'s own five `objectType` literals
 * (substrate/ontology is out of this task's file ownership, so this cannot import a shared
 * constant from there) — a future meta-object type added there needs the matching literal added
 * here too, the same "one place must be updated when another changes" coupling this codebase
 * already documents elsewhere (e.g. `RELATION_BUCKET` in export-prov-handler.ts).
 */
const PLATFORM_META_OBJECT_TYPES = new Set([
  'WorkerDefinition',
  'Gatekeeper',
  'Skill',
  'Procedure',
  'Operation',
]);

/** Fetches every currently-active Fact (bounded to `EXPLORER_MAX_FETCH`) whose *both* endpoints
 *  are ordinary domain Objects — excludes any Fact touching a platform meta-ontology Object
 *  (module doc comment above). Shared by every temporal/edge read below so the exclusion can never
 *  drift between them. */
async function fetchDomainFacts(client: PoolClient, workspaceId: string): Promise<readonly Fact[]> {
  const [facts, metaObjectIds] = await Promise.all([
    graphStore.listRecentFacts(client, workspaceId, EXPLORER_MAX_FETCH),
    fetchPlatformMetaObjectIds(client, workspaceId),
  ]);
  if (metaObjectIds.size === 0) return facts;
  return facts.filter(
    (fact) => !metaObjectIds.has(fact.sourceObjectId) && !metaObjectIds.has(fact.targetObjectId),
  );
}

async function fetchPlatformMetaObjectIds(
  client: PoolClient,
  workspaceId: string,
): Promise<ReadonlySet<string>> {
  const batches = await Promise.all(
    [...PLATFORM_META_OBJECT_TYPES].map((objectType) =>
      graphStore.search(client, workspaceId, { query: '', objectType, limit: EXPLORER_MAX_FETCH }),
    ),
  );
  return new Set(batches.flat().map((object) => object.id));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/** Never throws on a malformed cursor (same convention as `substrate/epistemic/decisions.ts`'s
 *  own `decodeKeysetCursor`) — an unparseable or negative cursor is treated as "start over". */
function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = Number.parseInt(decoded, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export interface ExplorerPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly skip: number;
  readonly limit: number;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

function paginateBatch<T>(batch: readonly T[], offset: number, limit: number): ExplorerPage<T> {
  const page = batch.slice(offset, offset + limit);
  const hasMore = offset + limit < batch.length;
  return {
    items: page,
    total: batch.length,
    skip: offset,
    limit,
    nextCursor: hasMore ? encodeOffsetCursor(offset + limit) : null,
    hasMore,
  };
}

// -------------------------------------------------------------------------------------------
// Graph workspace: GET /api/graph/nodes, GET /api/graph/edges, POST /api/graph/search
// -------------------------------------------------------------------------------------------

export interface ExplorerNodesParams {
  readonly type?: string;
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** the reference Explorer's own `skip` — only used when `cursor` is absent (forward pagination continues
   *  from `cursor` regardless of `skip` once the caller has one). */
  readonly skip?: number;
}

function resolveOffset(params: { readonly cursor?: string; readonly skip?: number }): number {
  return params.cursor ? decodeOffsetCursor(params.cursor) : Math.max(params.skip ?? 0, 0);
}

export async function listGraphNodesForExplorer(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
  params: ExplorerNodesParams,
): Promise<ExplorerPage<GraphObject>> {
  const limit = clamp(params.limit ?? 100, 1, EXPLORER_MAX_FETCH);
  const offset = resolveOffset(params);
  return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
    const batch = await graphStore.search(client, workspaceId, {
      // Empty query -> the `ILIKE '%%'` pattern (queries.ts's `buildSearchQuery`) matches every
      // row — "list all objects" has no dedicated GraphStore method, so `search('')` stands in.
      query: params.search ?? '',
      objectType: params.type,
      limit: EXPLORER_MAX_FETCH,
    });
    const domainOnly = batch.filter((object) => !PLATFORM_META_OBJECT_TYPES.has(object.objectType));
    return paginateBatch(domainOnly, offset, limit);
  });
}

export interface ExplorerEdgesParams {
  readonly type?: string;
  readonly source?: string;
  readonly target?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly skip?: number;
}

export async function listGraphEdgesForExplorer(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
  params: ExplorerEdgesParams,
): Promise<ExplorerPage<Fact>> {
  const limit = clamp(params.limit ?? 100, 1, EXPLORER_MAX_FETCH);
  const offset = resolveOffset(params);
  return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
    const batch = await fetchDomainFacts(client, workspaceId);
    const filtered = batch.filter(
      (fact) =>
        (!params.type || fact.linkType === params.type) &&
        (!params.source || fact.sourceObjectId === params.source) &&
        (!params.target || fact.targetObjectId === params.target),
    );
    return paginateBatch(filtered, offset, limit);
  });
}

export interface ExplorerSearchParams {
  readonly query: string;
  readonly objectType?: string;
  readonly limit?: number;
}

export interface ExplorerSearchResultItem {
  readonly node: GraphObject;
  /** Our `search` has no relevance scoring (ILIKE, not ranked) — every result gets `1.0`,
   *  documented rather than fabricated. */
  readonly score: number;
}

export async function searchGraphForExplorer(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
  params: ExplorerSearchParams,
): Promise<{ readonly results: readonly ExplorerSearchResultItem[]; readonly total: number }> {
  const limit = clamp(params.limit ?? 20, 1, 200);
  return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
    // Fetches a bounded batch and filters+slices in memory — same shape as
    // `listGraphNodesForExplorer` above, so a query that matches many platform meta-objects still
    // returns up to `limit` genuine domain results rather than under-filling the page.
    const batch = await graphStore.search(client, workspaceId, {
      query: params.query,
      objectType: params.objectType,
      limit: EXPLORER_MAX_FETCH,
    });
    const domainOnly = batch.filter((object) => !PLATFORM_META_OBJECT_TYPES.has(object.objectType));
    const results = domainOnly.slice(0, limit).map((node) => ({ node, score: 1 }));
    return { results, total: results.length };
  });
}

// -------------------------------------------------------------------------------------------
// Temporal: GET /api/temporal/bounds, GET /api/temporal/snapshot
// -------------------------------------------------------------------------------------------

/**
 * Our `objects` (graph nodes) carry no bitemporal validity of their own — only `links` (Facts) do
 * (substrate/graph/store.ts's `GraphObject` vs `Fact`; the reference Explorer's ContextGraph nodes carry
 * `valid_from`/`valid_until` directly, ours do not). `bounds`/`snapshot` below therefore derive
 * temporal state from Facts, not Objects: bounds are the min `valid_from` / max
 * (`valid_until` ?? `recorded_at`) across the fetched Fact batch, and an Object counts as "active"
 * at time T iff at least one Fact valid at T touches it (source or target) — the closest thing our
 * domain has to "this node existed at time T". Documented adaptation, not a bug.
 */
export async function getTemporalBoundsForExplorer(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
): Promise<{ readonly min: Date | null; readonly max: Date | null }> {
  return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
    const facts = await fetchDomainFacts(client, workspaceId);
    let min: Date | null = null;
    let max: Date | null = null;
    for (const fact of facts) {
      if (min === null || fact.validFrom < min) min = fact.validFrom;
      const end = fact.validUntil ?? fact.recordedAt;
      if (max === null || end > max) max = end;
    }
    return { min, max };
  });
}

export interface ExplorerTemporalSnapshotResult {
  readonly at: Date;
  readonly activeObjectIds: readonly string[];
}

export async function getTemporalSnapshotForExplorer(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
  params: { readonly at?: Date },
): Promise<ExplorerTemporalSnapshotResult> {
  const at = params.at ?? new Date();
  return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
    const facts = await fetchDomainFacts(client, workspaceId);
    const active = new Set<string>();
    for (const fact of facts) {
      if (fact.validFrom <= at && (fact.validUntil === null || fact.validUntil > at)) {
        active.add(fact.sourceObjectId);
        active.add(fact.targetObjectId);
      }
    }
    return { at, activeObjectIds: [...active] };
  });
}

// -------------------------------------------------------------------------------------------
// Decision workspace: GET /api/decisions, GET /api/decisions/:id/chain
// -------------------------------------------------------------------------------------------

export interface ExplorerDecisionsParams {
  readonly category?: string;
  readonly skip?: number;
  readonly limit?: number;
}

/** Loops `queryDecisions`'s own keyset cursor (decisions.ts) until it has enough rows for
 *  `skip + limit`, bounded to `EXPLORER_MAX_FETCH` total — `queryDecisions` itself clamps each
 *  call's `limit` to `MAX_QUERY_DECISIONS_LIMIT` (100), so a single call cannot satisfy a large
 *  `skip` on its own. `category` has no column on `DecisionRow` (reference-Explorer-only concept — see
 *  `wire.ts`'s `toDecisionResponse`); filtered here only against `rationale.category` on the
 *  chance a future writer ever sets one, so the parameter is not silently a no-op if that changes. */
export async function listDecisionsForExplorer(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
  params: ExplorerDecisionsParams,
): Promise<readonly DecisionRow[]> {
  const skip = Math.max(params.skip ?? 0, 0);
  const limit = clamp(params.limit ?? 50, 1, 500);
  return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
    const collected: DecisionRow[] = [];
    let cursor: string | undefined;
    while (collected.length < skip + limit && collected.length < EXPLORER_MAX_FETCH) {
      const page = await queryDecisions(client, workspaceId, { limit: 100, cursor });
      if (page.items.length === 0) break;
      collected.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const filtered = params.category
      ? collected.filter((row) => row.rationale?.category === params.category)
      : collected;
    return filtered.slice(skip, skip + limit);
  });
}

export interface DecisionChainStep {
  readonly id: string;
  readonly type: string;
  readonly relationship: string;
  readonly content: string;
}

export interface DecisionChainResult {
  readonly decisionId: string;
  readonly chain: readonly DecisionChainStep[];
  /** `true` when at least one (but not all) of the aggregation sources below failed — the route
   *  maps this to HTTP 207 (design doc §9.5's partial-success convention). */
  readonly partial: boolean;
  readonly failedSources: readonly string[];
}

function explainStepToChainStep(
  step: ExplainResult,
  relationship: 'root' | 'related',
): DecisionChainStep {
  if (step.nodeType === 'fact' && step.fact) {
    return { id: step.fact.id, type: 'fact', relationship, content: step.fact.linkType };
  }
  if (step.nodeType === 'decision' && step.decision) {
    return {
      id: step.decision.id,
      type: 'decision',
      relationship,
      content: step.decision.summary ?? step.decision.id,
    };
  }
  // Defensive only — `causalChain({decisionId})` never actually produces an `activity`-typed step
  // (decisions.ts's own module doc comment: its chain is the Decision itself plus `explain()`'d
  // related Facts, never a bare Activity).
  return {
    id: step.activity?.id ?? '',
    type: 'activity',
    relationship,
    content: step.activity?.kind ?? '',
  };
}

/**
 * `/api/decisions/:id/chain` — the Explorer's one Decision-detail endpoint (design doc §9.5 lists
 * no separate `/api/decisions/{id}` or `/api/decisions/{id}/precedents`), so this single call
 * fans out to all four S3.2 epistemic read capabilities' own service functions
 * (`causal_chain`/`decision_impact`/`find_precedents` — `query_decisions` is `listDecisionsForExplorer`
 * above): `causalChain` for the Decision-plus-related-Facts walk (fatal — propagates
 * `ExplainNodeNotFoundError` if `decisionId` itself does not exist, mapped to 404 by the route,
 * *not* counted toward the 207 accounting below since the primary payload never even started),
 * then best-effort `decisionImpact` (downstream Facts/ActionRequests/Tasks) and, using
 * `decisionImpact`'s own result as the only available anchor (`find_precedents` needs an
 * `objectId`/`actionKindTag` this endpoint has no other source for — module doc comment above),
 * best-effort `findPrecedents`.
 */
export async function getDecisionChainForExplorer(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
  params: { readonly decisionId: string; readonly depth?: number },
): Promise<DecisionChainResult> {
  return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
    const causal = await causalChain(client, workspaceId, {
      decisionId: params.decisionId,
      depth: params.depth,
    });

    const chain: DecisionChainStep[] = causal.chain.map((step, index) =>
      explainStepToChainStep(step, index === 0 ? 'root' : 'related'),
    );

    const failedSources: string[] = [];
    let attempted = 0;

    attempted += 1;
    let impact: DecisionImpactResult | undefined;
    try {
      impact = await decisionImpact(client, workspaceId, { decisionId: params.decisionId });
    } catch {
      failedSources.push('decision_impact');
    }

    if (impact) {
      for (const fact of impact.facts) {
        chain.push({ id: fact.id, type: 'fact', relationship: 'produced', content: fact.linkType });
      }
      for (const actionRequest of impact.actionRequests) {
        chain.push({
          id: actionRequest.id,
          type: 'action_request',
          relationship: 'triggered',
          content: actionRequest.actionKindTag,
        });
      }
      for (const taskId of impact.taskIds) {
        chain.push({ id: taskId, type: 'task', relationship: 'spawned', content: taskId });
      }

      const objectId = impact.facts[0]?.sourceObjectId;
      const actionKindTag = impact.actionRequests[0]?.actionKindTag;
      if (objectId || actionKindTag) {
        attempted += 1;
        try {
          const precedents = await findPrecedents(client, workspaceId, {
            objectId,
            actionKindTag,
            limit: 10,
          });
          for (const decision of precedents.items) {
            if (decision.id === params.decisionId) continue;
            chain.push({
              id: decision.id,
              type: 'decision',
              relationship: 'precedent',
              content: decision.summary ?? decision.id,
            });
          }
        } catch {
          failedSources.push('find_precedents');
        }
      }
    }

    return {
      decisionId: params.decisionId,
      chain,
      partial: failedSources.length > 0 && failedSources.length < attempted,
      failedSources,
    };
  });
}

// -------------------------------------------------------------------------------------------
// Lineage workspace: GET /api/provenance, GET /api/provenance/report
// -------------------------------------------------------------------------------------------

export interface ExplorerProvenanceResult {
  readonly graph: ProvGraph;
  readonly source: string | null;
}

/**
 * `nodeId` resolves through `explainByNodeId` (Fact -> Activity -> Decision, in that order — the
 * same probing `explain` capability's own handler uses). Tracing lineage *from* a plain Object
 * (graph node) id is out of S3.5's scope: an Object has no direct Activity/Evidence chain of its
 * own in this domain (only the Facts that touch it do — I3), so an Object id here 404s the same
 * way any other unresolvable id does, via `ExplainNodeNotFoundError`.
 */
export async function getProvenanceForExplorer(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
  params: { readonly nodeId?: string },
): Promise<ExplorerProvenanceResult> {
  const nodeId = params.nodeId;
  if (!nodeId) return { graph: { nodes: [], edges: [] }, source: null };
  return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
    const step = await explainByNodeId(client, workspaceId, nodeId);
    return { graph: buildProvenanceGraph([step]), source: 'explain' };
  });
}

export interface ExplorerProvenanceReport {
  readonly nodeId: string;
  readonly label: string;
  readonly type: string;
  readonly graph: ProvGraph;
}

export async function getProvenanceReportForExplorer(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
  params: { readonly nodeId: string },
): Promise<ExplorerProvenanceReport> {
  return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
    const step = await explainByNodeId(client, workspaceId, params.nodeId);
    const label =
      step.nodeType === 'fact'
        ? (step.fact?.linkType ?? params.nodeId)
        : step.nodeType === 'decision'
          ? (step.decision?.summary ?? params.nodeId)
          : (step.activity?.kind ?? params.nodeId);
    return {
      nodeId: params.nodeId,
      label,
      type: step.nodeType,
      graph: buildProvenanceGraph([step]),
    };
  });
}
