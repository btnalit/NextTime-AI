import { z } from 'zod';

/**
 * interfaces/explorer-contract/schemas: Zod mirrors of the reference Explorer's `explorer/schemas.py` (design
 * doc §9.5 "响应形状按参考 Explorer explorer/schemas.py"; docs/development-tasks.md §S3.5) — the wire
 * shapes the unmodified Explorer static bundle (`explorer/build.sh`) actually parses. Field
 * *names* here are deliberately snake_case (and `EdgeResponse.familyId` deliberately is not, even
 * though everything around it is) because that is what the upstream Pydantic models emit — this
 * is a foreign wire contract we mirror byte-for-shape, not one of this repo's own
 * `docs/wire-contract-conventions.md` capability results (`packages/shared/src/wire/*.ts`), which
 * stay camelCase. Every field this module defines was confirmed against an actual `fetch(...)`
 * call site in the explorer's own front-end source (Graph/Decision/Lineage workspaces only —
 * §9.5's "only these nine endpoints") rather than transcribed from `schemas.py` alone, since
 * `schemas.py` carries several fields (FR-4/FR-6/FR-7/FR-8/FR-9 enrichments) no Graph/Decision/
 * Lineage workspace call site ever reads.
 */

export const NodeResponseSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    content: z.string(),
    properties: z.record(z.string(), z.unknown()),
    valid_from: z.string().nullable(),
    valid_until: z.string().nullable(),
  })
  .strict();
export type NodeResponse = z.infer<typeof NodeResponseSchema>;

export const EdgeResponseSchema = z
  .object({
    id: z.string(),
    familyId: z.string(),
    source: z.string(),
    target: z.string(),
    type: z.string(),
    weight: z.number(),
    properties: z.record(z.string(), z.unknown()),
    valid_from: z.string().nullable(),
    valid_until: z.string().nullable(),
  })
  .strict();
export type EdgeResponse = z.infer<typeof EdgeResponseSchema>;

export const NodeListResponseSchema = z
  .object({
    nodes: z.array(NodeResponseSchema),
    total: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean(),
  })
  .strict();
export type NodeListResponse = z.infer<typeof NodeListResponseSchema>;

export const EdgeListResponseSchema = z
  .object({
    edges: z.array(EdgeResponseSchema),
    total: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean(),
  })
  .strict();
export type EdgeListResponse = z.infer<typeof EdgeListResponseSchema>;

/** `SearchRequest` (schemas.py) — only the fields the Graph workspace's own search box actually
 *  sends (`{query, limit}`, GraphWorkspace.tsx) are required; the FR-7 proximity fields are
 *  accepted-and-ignored for forward compatibility with an unmodified upstream bundle that may one
 *  day start sending them. */
export const SearchRequestSchema = z
  .object({
    query: z.string(),
    filters: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().int().positive().max(200).optional(),
    anchor_node: z.string().optional(),
    max_hops: z.number().int().positive().optional(),
    min_semantic_similarity: z.number().optional(),
    rank_by: z.enum(['relevance', 'proximity', 'hybrid']).optional(),
  })
  .strict();
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchResultItemSchema = z
  .object({
    node: NodeResponseSchema,
    score: z.number(),
    hop_distance: z.number().int().nullable().optional(),
    semantic_similarity: z.number().nullable().optional(),
  })
  .strict();

export const SearchResultResponseSchema = z
  .object({
    results: z.array(SearchResultItemSchema),
    total: z.number().int().nonnegative(),
    query: z.string(),
  })
  .strict();
export type SearchResultResponse = z.infer<typeof SearchResultResponseSchema>;

export const TemporalBoundsResponseSchema = z
  .object({
    min: z.string().nullable(),
    max: z.string().nullable(),
  })
  .strict();
export type TemporalBoundsResponse = z.infer<typeof TemporalBoundsResponseSchema>;

export const TemporalSnapshotResponseSchema = z
  .object({
    timestamp: z.string(),
    active_node_ids: z.array(z.string()),
    active_node_count: z.number().int().nonnegative(),
  })
  .strict();
export type TemporalSnapshotResponse = z.infer<typeof TemporalSnapshotResponseSchema>;

/**
 * `DecisionResponse` (schemas.py) — our `decisions` row (substrate/epistemic/decisions.ts's
 * `DecisionRow`) has no `category`/`scenario`/`outcome`/`confidence` columns (the reference Explorer's
 * ContextGraph-native decision node does; ours does not — see `explorer-read-service.ts`'s
 * `toDecisionResponse` for exactly how each field is derived from what we do have).
 */
export const DecisionResponseSchema = z
  .object({
    decision_id: z.string(),
    category: z.string(),
    scenario: z.string(),
    reasoning: z.string(),
    outcome: z.string(),
    confidence: z.number(),
    timestamp: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

/**
 * One `CausalChainResponse.chain[]` entry — the reference Explorer's own shape (decisions.py's
 * `get_causal_chain`, built from `get_neighbors`) is an untyped `Dict[str, Any]`; this is the
 * subset `DecisionWorkspace.tsx`'s `ChainNode`/`ChainStep` actually reads (`id`, `relationship`,
 * `content`, `type`). `hop` is carried for parity with the reference Explorer's own neighbor-walk shape even
 * though the front-end does not read it.
 */
export const ChainStepSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    relationship: z.string(),
    content: z.string(),
    hop: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ChainStep = z.infer<typeof ChainStepSchema>;

/** `CausalChainResponse` plus an optional `message` — §9.5's 207 partial-success convention
 *  (`analytics.py`'s own precedent: a 207 status with a body the client still parses as success,
 *  `DecisionWorkspace.tsx`'s own `res.status === 207 && (data.message || ...)` handling). */
export const CausalChainResponseSchema = z
  .object({
    decision_id: z.string(),
    chain: z.array(ChainStepSchema),
    message: z.string().optional(),
  })
  .strict();
export type CausalChainResponse = z.infer<typeof CausalChainResponseSchema>;

export const ProvenanceNodeSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    prov_type: z.enum(['Entity', 'Activity', 'Agent']),
    parent_id: z.enum(['group_entity', 'group_activity', 'group_agent']),
    source_document: z.string().nullable().optional(),
    source_location: z.string().nullable().optional(),
    source_quote: z.string().nullable().optional(),
    confidence: z.number().nullable().optional(),
    checksum: z.string().nullable().optional(),
  })
  .strict();
export type ProvenanceNode = z.infer<typeof ProvenanceNodeSchema>;

export const ProvenanceEdgeSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    label: z.string(),
    direction: z.string(),
  })
  .strict();
export type ProvenanceEdge = z.infer<typeof ProvenanceEdgeSchema>;

export const ProvenanceResponseSchema = z
  .object({
    nodes: z.array(ProvenanceNodeSchema),
    edges: z.array(ProvenanceEdgeSchema),
    source: z.string().nullable().optional(),
    message: z.string().optional(),
  })
  .strict();
export type ProvenanceResponse = z.infer<typeof ProvenanceResponseSchema>;
