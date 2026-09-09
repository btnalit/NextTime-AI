import type { ExportProvDocument } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type ExplainResult, causalChain, explain } from '../../substrate/epistemic/index.js';
import type { CapabilityHandler } from './capability-handler.js';
import { type ProvGraph, buildProvenanceGraph } from './provenance-graph.js';

/**
 * application/gateway/export-prov-handler: the `export_prov` capability (docs/development-tasks.md
 * §S3.5; packages/shared/src/capabilities.ts's own doc comment on the registry entry) — a
 * previously "registered but no handler" capability (docs/development-tasks.md S3.7's inventory).
 * `channel: 'human'`, so it is reachable the ordinary way, `POST /api/cap/export_prov`
 * (interfaces/http/capability-route.ts) — no `interfaces/explorer-contract` involvement; that
 * module's own `/api/provenance*` routes are a different, reference-Explorer-shaped wire surface built from
 * the exact same underlying `explain()` data (`provenance-graph.ts`'s `buildProvenanceGraph`,
 * shared by both).
 */

export class ExportProvInputError extends Error {
  constructor() {
    super('export_prov: exactly one of factId/decisionId/activityId is required');
    this.name = 'ExportProvInputError';
  }
}

/** Every `ProvGraph` edge label this module's own `provenance-graph.ts` produces, mapped onto one
 *  of `ExportProvDocumentSchema`'s seven relation buckets. `hadPrimarySource` (Observation ->
 *  Source) folds into `wasDerivedFrom` — PROV-O's own `hadPrimarySource` is a sub-property of
 *  `wasDerivedFrom`, and this export is deliberately "PROV-JSON *style*" (the capability's own doc
 *  comment), not a byte-exact implementation of every named sub-relation. */
const RELATION_BUCKET: Record<string, keyof ExportProvDocument> = {
  wasGeneratedBy: 'wasGeneratedBy',
  used: 'used',
  wasAssociatedWith: 'wasAssociatedWith',
  actedOnBehalfOf: 'actedOnBehalfOf',
  wasAttributedTo: 'wasAttributedTo',
  hadPrimarySource: 'wasDerivedFrom',
  wasRevisionOf: 'wasRevisionOf',
};

/**
 * Projects a `ProvGraph` (this module's shared, deduplicated lineage graph — see provenance-
 * graph.ts's own doc comment) into PROV-JSON-style buckets. Deliberately uses two generic
 * attribute names (`prov:source`/`prov:target`) on every relation record rather than the real
 * PROV-O spec's per-relation-specific pair (`prov:entity`/`prov:activity` for `wasGeneratedBy`,
 * `prov:delegate`/`prov:responsible` for `actedOnBehalfOf`, ...) — this codebase's own domain
 * model does not cleanly satisfy every one of those pairings (e.g. `actedOnBehalfOf` here connects
 * an Activity to an Agent, not two Agents, because that is what `explain()`'s data actually gives
 * us), and guessing the "correct" spec-exact pairing per edge would be less honest than one
 * consistent, clearly-documented shape. `format: 'prov-json'` on the capability's own result names
 * this choice explicitly as "style", not a strict-conformance claim.
 */
function toProvJsonDocument(graph: ProvGraph): ExportProvDocument {
  const document: ExportProvDocument = {
    prefix: { prov: 'http://www.w3.org/ns/prov#' },
    entity: {},
    activity: {},
    agent: {},
    wasGeneratedBy: {},
    used: {},
    wasAssociatedWith: {},
    wasAttributedTo: {},
    wasDerivedFrom: {},
    actedOnBehalfOf: {},
    wasRevisionOf: {},
  };

  for (const node of graph.nodes) {
    const bucket =
      node.kind === 'entity'
        ? document.entity
        : node.kind === 'activity'
          ? document.activity
          : document.agent;
    bucket[node.id] = {
      label: node.label,
      ...(node.sourceDocument ? { 'prov:location': node.sourceDocument } : {}),
    };
  }

  let ordinal = 0;
  for (const edge of graph.edges) {
    const bucketName = RELATION_BUCKET[edge.label];
    if (!bucketName) continue; // defensive — every label provenance-graph.ts produces is listed above
    ordinal += 1;
    const bucket = document[bucketName] as Record<string, Record<string, unknown>>;
    bucket[`_:r${ordinal}`] = {
      'prov:source': edge.source,
      'prov:target': edge.target,
      label: edge.label,
      direction: edge.direction,
    };
  }

  return document;
}

interface ExportProvParams {
  readonly factId?: string;
  readonly decisionId?: string;
  readonly activityId?: string;
  readonly depth?: number;
}

/**
 * Resolves the `explain()` chain for exactly one of `factId`/`decisionId`/`activityId`. `factId`/
 * `decisionId` reuse `causalChain` (substrate/epistemic/decisions.ts) — the same bounded walk
 * `causal_chain`/the Explorer's `/api/decisions/:id/chain` already use — so `depth` behaves
 * identically here. `activityId` has no further chain to walk (an Activity is a leaf in this
 * walk's own direction — module doc comment); `depth` is accepted but ignored for it, matching
 * `causal_chain`'s own "no `.refine()` in paramsSchema" convention of leaving semantic-only
 * validation to the handler rather than the schema.
 */
async function resolveChain(
  client: PoolClient,
  workspaceId: string,
  params: ExportProvParams,
): Promise<{
  chain: readonly ExplainResult[];
  rootType: 'fact' | 'decision' | 'activity';
  rootId: string;
}> {
  const given = [params.factId, params.decisionId, params.activityId].filter(
    (value) => value !== undefined,
  );
  if (given.length !== 1) throw new ExportProvInputError();

  if (params.factId) {
    const result = await causalChain(client, workspaceId, {
      factId: params.factId,
      depth: params.depth,
    });
    return { chain: result.chain, rootType: 'fact', rootId: params.factId };
  }
  if (params.decisionId) {
    const result = await causalChain(client, workspaceId, {
      decisionId: params.decisionId,
      depth: params.depth,
    });
    return { chain: result.chain, rootType: 'decision', rootId: params.decisionId };
  }
  // Reached only when the earlier `given.length !== 1` check passed and neither factId nor
  // decisionId was set — activityId is therefore guaranteed defined here.
  if (!params.activityId) throw new ExportProvInputError();
  const step = await explain(client, workspaceId, { activityId: params.activityId });
  return { chain: [step], rootType: 'activity', rootId: params.activityId };
}

export const exportProvHandler: CapabilityHandler = async (client, workspaceId, rawParams) => {
  const params = rawParams as ExportProvParams;
  const { chain, rootType, rootId } = await resolveChain(client, workspaceId, params);

  const graph = buildProvenanceGraph(chain);
  const document = toProvJsonDocument(graph);

  return {
    result: { format: 'prov-json' as const, document },
    resourceType: rootType,
    resourceId: rootId,
  };
};
