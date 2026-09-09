import type {
  ExplainActivityRef,
  ExplainPrincipalRef,
  ExplainResult,
  ExplainSourceRef,
} from '../../substrate/epistemic/index.js';

/**
 * application/gateway/provenance-graph: turns one or more `explain()` steps (substrate/epistemic/
 * explain.ts's `ExplainResult` — the PROV-O walk: Fact/Decision/Activity -> Observation(s) ->
 * Source, plus every Principal reference along the way) into a deduplicated, generic lineage
 * graph. Two consumers project this into their own wire shape:
 *
 *   - `explorer-read-service.ts`'s `/api/provenance` and `/api/provenance/report` (the reference
 *     Explorer's `ProvenanceNode`/`ProvenanceEdge` shape, `explorer/schemas.py`).
 *   - `export-prov-handler.ts`'s `export_prov` capability (PROV-JSON-style `{entity, activity,
 *     agent, wasGeneratedBy, ...}` buckets, `packages/shared/src/wire/provenance.ts`).
 *
 * Neither consumer walks `ExplainResult` itself — this is the one place that decides what counts
 * as a node/edge, so the two projections can never silently disagree about the underlying graph.
 * Pure and synchronous: no IO, no substrate import beyond the `ExplainResult` type itself.
 */

export type ProvKind = 'entity' | 'activity' | 'agent';

export interface ProvNode {
  readonly id: string;
  readonly label: string;
  readonly kind: ProvKind;
  /** `Source.uri` when this node is an Observation or a Source, else `null` — the closest thing
   *  our domain has to the reference Explorer's `source_document`. */
  readonly sourceDocument: string | null;
}

/** `direction` is relative to the *root* step (`chain[0]`): `'upstream'` means "this edge points
 *  toward something the root depended on / was produced by" — every edge this module currently
 *  produces is upstream (explain() only ever walks backward in time), kept as a field rather than
 *  a constant so a future forward/downstream source (e.g. a real "what did this Fact cause"
 *  query) can extend the same shape without a breaking change. */
export interface ProvEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string;
  readonly direction: 'upstream' | 'downstream';
}

export interface ProvGraph {
  readonly nodes: readonly ProvNode[];
  readonly edges: readonly ProvEdge[];
}

class GraphBuilder {
  private readonly nodes = new Map<string, ProvNode>();
  private readonly edges = new Map<string, ProvEdge>();

  addNode(node: ProvNode): void {
    // First writer wins — every step that references the same Principal/Source/Activity id
    // describes the same real-world thing, and the first description seen is as good as any
    // later one (Principal/Source rows never change identity mid-chain).
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
  }

  addEdge(edge: Omit<ProvEdge, 'id'>): void {
    const id = `${edge.source}->${edge.target}:${edge.label}`;
    if (!this.edges.has(id)) this.edges.set(id, { ...edge, id });
  }

  build(): ProvGraph {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}

function principalLabel(principal: ExplainPrincipalRef): string {
  return principal.displayName ?? `${principal.kind}:${principal.id}`;
}

function addPrincipal(builder: GraphBuilder, principal: ExplainPrincipalRef | null): void {
  if (!principal) return;
  builder.addNode({
    id: principal.id,
    label: principalLabel(principal),
    kind: 'agent',
    sourceDocument: null,
  });
}

function addSource(builder: GraphBuilder, source: ExplainSourceRef | null): void {
  if (!source) return;
  builder.addNode({
    id: source.id,
    label: source.uri ?? `${source.kind}:${source.id}`,
    kind: 'entity',
    sourceDocument: source.uri,
  });
  addPrincipal(builder, source.ownerPrincipal);
}

/** Adds the Activity node, its principals, and its Observation/Source chain — every step
 *  (`fact`/`decision`/`activity`-rooted) shares this exact sub-graph shape. */
function addActivity(builder: GraphBuilder, activity: ExplainActivityRef | null): void {
  if (!activity) return;
  builder.addNode({
    id: activity.id,
    label: `${activity.kind} (${activity.status})`,
    kind: 'activity',
    sourceDocument: null,
  });
  addPrincipal(builder, activity.startedByPrincipal);
  if (activity.startedByPrincipal) {
    builder.addEdge({
      source: activity.id,
      target: activity.startedByPrincipal.id,
      label: 'wasAssociatedWith',
      direction: 'upstream',
    });
  }
  addPrincipal(builder, activity.onBehalfOfPrincipal);
  if (activity.onBehalfOfPrincipal) {
    builder.addEdge({
      source: activity.id,
      target: activity.onBehalfOfPrincipal.id,
      label: 'actedOnBehalfOf',
      direction: 'upstream',
    });
  }
  for (const observation of activity.observations) {
    builder.addNode({
      id: observation.id,
      label: `observation ${observation.createdAt}`,
      kind: 'entity',
      sourceDocument: observation.source?.uri ?? null,
    });
    builder.addEdge({
      source: activity.id,
      target: observation.id,
      label: 'used',
      direction: 'upstream',
    });
    addSource(builder, observation.source);
    if (observation.source) {
      builder.addEdge({
        source: observation.id,
        target: observation.source.id,
        label: 'hadPrimarySource',
        direction: 'upstream',
      });
    }
  }
}

/** The id of the node a step's own root object (Fact/Decision/Activity) is represented by —
 *  `null` only for the theoretical case of an `ExplainResult` with no populated variant, which
 *  `explain()` never actually produces (every `nodeType` branch always sets its matching field). */
function stepRootId(step: ExplainResult): string | null {
  if (step.nodeType === 'fact') return step.fact?.id ?? null;
  if (step.nodeType === 'decision') return step.decision?.id ?? null;
  return step.activity?.id ?? null;
}

/** Adds one `explain()` step's own root node (Fact/Decision — an `activity`-rooted step's "root"
 *  *is* the Activity node `addActivity` already adds, so there is nothing extra to add here). */
function addStepRoot(builder: GraphBuilder, step: ExplainResult): void {
  if (step.nodeType === 'fact' && step.fact) {
    const fact = step.fact;
    builder.addNode({
      id: fact.id,
      label: `${fact.linkType} (${fact.epistemicStatus})`,
      kind: 'entity',
      sourceDocument: null,
    });
    if (step.activity) {
      builder.addEdge({
        source: fact.id,
        target: step.activity.id,
        label: 'wasGeneratedBy',
        direction: 'upstream',
      });
    }
    addPrincipal(builder, fact.assertedByPrincipal);
    if (fact.assertedByPrincipal) {
      builder.addEdge({
        source: fact.id,
        target: fact.assertedByPrincipal.id,
        label: 'wasAttributedTo',
        direction: 'upstream',
      });
    }
    addPrincipal(builder, fact.verifiedByPrincipal);
    if (fact.verifiedByPrincipal) {
      builder.addEdge({
        source: fact.id,
        target: fact.verifiedByPrincipal.id,
        label: 'wasAttributedTo',
        direction: 'upstream',
      });
    }
    return;
  }

  if (step.nodeType === 'decision' && step.decision) {
    const decision = step.decision;
    builder.addNode({
      id: decision.id,
      label: decision.summary ?? decision.id,
      kind: 'entity',
      sourceDocument: null,
    });
    if (step.activity) {
      builder.addEdge({
        source: decision.id,
        target: step.activity.id,
        label: 'wasGeneratedBy',
        direction: 'upstream',
      });
    }
    addPrincipal(builder, decision.decidedByPrincipal);
    if (decision.decidedByPrincipal) {
      builder.addEdge({
        source: decision.id,
        target: decision.decidedByPrincipal.id,
        label: 'wasAttributedTo',
        direction: 'upstream',
      });
    }
    addSource(builder, decision.source);
    if (decision.source) {
      builder.addEdge({
        source: decision.id,
        target: decision.source.id,
        label: 'used',
        direction: 'upstream',
      });
    }
  }
  // nodeType === 'activity': addActivity(step.activity) below already covers it fully.
}

/**
 * Builds a deduplicated lineage graph from an ordered `explain()` chain (`causalChain`'s own
 * `chain` field, or a single-element array for a plain `explain`/`activityId` lookup).
 *
 * `chain[0]` is always the root the caller asked about. For a multi-step chain — `causalChain`'s
 * fact-supersedes walk, or its decision-plus-related-Facts walk — consecutive steps also get one
 * edge each: `wasRevisionOf` between two Fact steps of the same supersedes lineage (`chain[i]` is
 * the newer version, `chain[i+1]` the one it supersedes), or `used` from a Decision root to each
 * Fact its `rationale` names (the Decision "used" that evidence, PROV's own relation for "an
 * Activity/Entity consumed an Entity" — decisions.ts's own doc comment: these are not a
 * supersedes/derivation relationship, just facts the Decision's rationale happens to name).
 */
export function buildProvenanceGraph(chain: readonly ExplainResult[]): ProvGraph {
  const builder = new GraphBuilder();

  for (const step of chain) {
    addStepRoot(builder, step);
    addActivity(builder, step.activity);
  }

  const [rootStep, ...restSteps] = chain;
  if (rootStep && restSteps.length > 0) {
    const rootId = stepRootId(rootStep);
    if (rootStep.nodeType === 'decision' && rootId) {
      // `causalChain`'s decision branch (decisions.ts): chain[0] is the Decision itself, and every
      // later step is a sibling Fact its `rationale` names directly — not a linear walk, so every
      // one of them gets its own edge straight from the root.
      for (const step of restSteps) {
        const factId = stepRootId(step);
        if (factId)
          builder.addEdge({ source: rootId, target: factId, label: 'used', direction: 'upstream' });
      }
    } else {
      // `causalChain`'s fact branch: a linear `supersedes_id` walk — chain[i] is the newer version
      // of chain[i+1] (module doc comment).
      let previousId = rootId;
      for (const step of restSteps) {
        const currentId = stepRootId(step);
        if (previousId && currentId) {
          builder.addEdge({
            source: previousId,
            target: currentId,
            label: 'wasRevisionOf',
            direction: 'upstream',
          });
        }
        previousId = currentId;
      }
    }
  }

  return builder.build();
}
