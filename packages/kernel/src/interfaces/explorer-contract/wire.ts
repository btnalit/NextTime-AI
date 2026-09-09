import type {
  ExplorerDecisionRow as DecisionRow,
  ExplorerFact as Fact,
  ExplorerGraphObject as GraphObject,
  ProvEdge,
  ProvNode,
} from '../../application/gateway/index.js';
import type {
  DecisionResponse,
  EdgeResponse,
  NodeResponse,
  ProvenanceEdge,
  ProvenanceNode,
} from './schemas.js';

/**
 * interfaces/explorer-contract/wire: projects this kernel's own domain shapes (`GraphObject`/
 * `Fact`/`DecisionRow`/`ProvNode`/`ProvEdge`) onto the reference-Explorer-mirrored wire shapes
 * (schemas.ts). Kept separate from `index.ts` (the Fastify route registrations) the same way
 * `application/gateway/resource-wire.ts` is kept separate from `handlers.ts` — one place that
 * knows every field mapping, easy to unit-test without a Fastify app or a database.
 */

export function toNodeResponse(object: GraphObject): NodeResponse {
  return {
    id: object.id,
    type: object.objectType,
    // the reference Explorer's `content` is a free-text label; our Objects have no such field, only a
    // `properties` bag — a short stable placeholder (never `content: ''`, which the front-end's
    // `label || id` fallbacks already treat as "no label") keeps every node visibly identifiable
    // in the graph view without inventing a summarization algorithm.
    content: `${object.objectType}:${object.id}`,
    properties: object.properties,
    // Objects carry no bitemporal validity of their own in this domain — see explorer-read-
    // service.ts's module doc comment ("Objects carry no bitemporal validity...").
    valid_from: null,
    valid_until: null,
  };
}

export function toEdgeResponse(fact: Fact): EdgeResponse {
  return {
    id: fact.id,
    // No parallel-edge "family" concept in this domain (the reference Explorer's `familyId` groups multiple
    // rendered curves for the same underlying relationship) — each Fact is its own singleton
    // family, so `familyId` is just its own id.
    familyId: fact.id,
    source: fact.sourceObjectId,
    target: fact.targetObjectId,
    type: fact.linkType,
    weight: 1,
    properties: fact.properties,
    valid_from: fact.validFrom.toISOString(),
    valid_until: fact.validUntil ? fact.validUntil.toISOString() : null,
  };
}

/**
 * `DecisionRow` (substrate/epistemic/decisions.ts) has no `category`/`scenario`/`outcome`/
 * `confidence` columns — the reference Explorer's ContextGraph-native decision node does, ours does not.
 * `category`/`confidence` have no source data at all (`''`/`0`); `scenario` is `summary`;
 * `outcome` is `status` (`DecisionStatus` — `proposed`/`approved`/`rejected`/... reads sensibly
 * through the front-end's own outcome-color heuristic, `outcomeColor()` in DecisionWorkspace.tsx,
 * even though the value sets don't line up exactly); `reasoning` is the free-form `rationale`
 * jsonb, stringified (there is no single "reasoning" text field to point at instead);
 * `timestamp` prefers `decidedAt`, falling back to `createdAt` for a still-`proposed` Decision.
 */
export function toDecisionResponse(row: DecisionRow): DecisionResponse {
  return {
    decision_id: row.id,
    category: '',
    scenario: row.summary ?? '',
    reasoning: row.rationale ? JSON.stringify(row.rationale) : '',
    outcome: row.status,
    confidence: 0,
    timestamp: (row.decidedAt ?? row.createdAt).toISOString(),
    metadata: row.rationale ?? {},
  };
}

const PROV_KIND_TO_TYPE = {
  entity: { prov_type: 'Entity', parent_id: 'group_entity' },
  activity: { prov_type: 'Activity', parent_id: 'group_activity' },
  agent: { prov_type: 'Agent', parent_id: 'group_agent' },
} as const;

export function toProvenanceNode(node: ProvNode): ProvenanceNode {
  const classification = PROV_KIND_TO_TYPE[node.kind];
  return {
    id: node.id,
    label: node.label,
    prov_type: classification.prov_type,
    parent_id: classification.parent_id,
    source_document: node.sourceDocument,
  };
}

export function toProvenanceEdge(edge: ProvEdge): ProvenanceEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    direction: edge.direction,
  };
}
