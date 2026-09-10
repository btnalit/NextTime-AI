import { describe, expect, it } from 'vitest';
import type { ExplainResult } from '../../substrate/epistemic/index.js';
import { buildProvenanceGraph } from './provenance-graph.js';

/**
 * Unit tests (no database, no Fastify) for provenance-graph.ts's `buildProvenanceGraph` — the one
 * place `/api/provenance`, `/api/provenance/report`, and `export_prov` all share for turning an
 * `explain()` chain into a node/edge graph (see that module's own doc comment).
 */

function factStep(overrides: Partial<NonNullable<ExplainResult['fact']>> = {}): ExplainResult {
  return {
    nodeType: 'fact',
    fact: {
      id: 'fact-1',
      linkType: 'test.runs_on',
      epistemicStatus: 'asserted',
      assertedByPrincipal: { id: 'human-1', kind: 'human', role: 'owner', displayName: 'Alice' },
      verifiedByPrincipal: null,
      observationId: null,
      ...overrides,
    },
    activity: {
      id: 'activity-1',
      kind: 'test.ingest',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      startedByPrincipal: { id: 'svc-1', kind: 'service', role: 'member', displayName: null },
      observations: [
        {
          id: 'obs-1',
          createdAt: '2026-01-01T00:00:00.500Z',
          source: {
            id: 'source-1',
            kind: 'test.collector',
            uri: 'file:///fixtures/host.json',
            visibility: 'private',
            ownerPrincipal: null,
          },
        },
      ],
      metadata: {},
      onBehalfOfPrincipal: null,
    },
  };
}

function decisionStep(id: string, summary: string | null): ExplainResult {
  return {
    nodeType: 'decision',
    decision: {
      id,
      status: 'approved',
      summary,
      decidedByPrincipal: { id: 'human-1', kind: 'human', role: 'owner', displayName: 'Alice' },
      source: null,
    },
    activity: null,
  };
}

describe('buildProvenanceGraph — single-step Fact chain (explain() for one Fact)', () => {
  it('adds the Fact, Activity, Observation, Source, and Principal nodes with expected classification', () => {
    const graph = buildProvenanceGraph([factStep()]);

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('fact-1')).toMatchObject({ kind: 'entity' });
    expect(byId.get('activity-1')).toMatchObject({ kind: 'activity' });
    expect(byId.get('obs-1')).toMatchObject({ kind: 'entity' });
    expect(byId.get('source-1')).toMatchObject({
      kind: 'entity',
      sourceDocument: 'file:///fixtures/host.json',
    });
    expect(byId.get('human-1')).toMatchObject({ kind: 'agent', label: 'Alice' });
    expect(byId.get('svc-1')).toMatchObject({ kind: 'agent' });
  });

  it('produces the expected edge set: wasGeneratedBy, wasAttributedTo, used, hadPrimarySource, wasAssociatedWith', () => {
    const graph = buildProvenanceGraph([factStep()]);
    const labels = graph.edges.map((e) => `${e.source}->${e.target}:${e.label}`);

    expect(labels).toContain('fact-1->activity-1:wasGeneratedBy');
    expect(labels).toContain('fact-1->human-1:wasAttributedTo');
    expect(labels).toContain('activity-1->svc-1:wasAssociatedWith');
    expect(labels).toContain('activity-1->obs-1:used');
    expect(labels).toContain('obs-1->source-1:hadPrimarySource');
  });

  it('every edge is direction "upstream" (explain() only ever walks backward)', () => {
    const graph = buildProvenanceGraph([factStep()]);
    expect(graph.edges.every((e) => e.direction === 'upstream')).toBe(true);
  });

  it('deduplicates nodes/edges referenced by more than one step', () => {
    const graph = buildProvenanceGraph([factStep(), factStep({ id: 'fact-1' })]);
    // Same fact id twice (defensive — a real causal_chain never repeats a step, but the builder
    // must not double-count if it ever did).
    const factNodes = graph.nodes.filter((n) => n.id === 'fact-1');
    expect(factNodes).toHaveLength(1);
  });
});

describe('buildProvenanceGraph — decision root with related Facts (causal_chain({decisionId}) shape)', () => {
  it('adds a "used" edge from the Decision root to every related Fact step, not a linear chain', () => {
    const chain: ExplainResult[] = [
      decisionStep('decision-1', 'approve the change'),
      factStep({ id: 'fact-a' }),
      factStep({ id: 'fact-b' }),
    ];
    const graph = buildProvenanceGraph(chain);
    const labels = graph.edges.map((e) => `${e.source}->${e.target}:${e.label}`);

    expect(labels).toContain('decision-1->fact-a:used');
    expect(labels).toContain('decision-1->fact-b:used');
    // Not a linear walk: fact-a is never linked directly to fact-b.
    expect(labels.some((l) => l.startsWith('fact-a->fact-b'))).toBe(false);
  });

  it('decision node label falls back to its own id when summary is null', () => {
    const graph = buildProvenanceGraph([decisionStep('decision-2', null)]);
    const node = graph.nodes.find((n) => n.id === 'decision-2');
    expect(node?.label).toBe('decision-2');
  });
});

describe('buildProvenanceGraph — fact-supersedes walk (causal_chain({factId}) shape)', () => {
  it('links consecutive steps with wasRevisionOf, newer -> older', () => {
    const chain: ExplainResult[] = [
      factStep({ id: 'fact-v3' }),
      factStep({ id: 'fact-v2' }),
      factStep({ id: 'fact-v1' }),
    ];
    const graph = buildProvenanceGraph(chain);
    const labels = graph.edges.map((e) => `${e.source}->${e.target}:${e.label}`);

    expect(labels).toContain('fact-v3->fact-v2:wasRevisionOf');
    expect(labels).toContain('fact-v2->fact-v1:wasRevisionOf');
  });
});

describe('buildProvenanceGraph — activity-only root (export_prov activityId)', () => {
  it('adds only the Activity sub-graph, no wasGeneratedBy edge (there is no separate root entity)', () => {
    const step: ExplainResult = {
      nodeType: 'activity',
      activity: factStep().activity,
    };
    const graph = buildProvenanceGraph([step]);
    const labels = graph.edges.map((e) => `${e.source}->${e.target}:${e.label}`);
    expect(labels.some((l) => l.endsWith(':wasGeneratedBy'))).toBe(false);
    expect(graph.nodes.some((n) => n.id === 'activity-1' && n.kind === 'activity')).toBe(true);
  });
});

describe('buildProvenanceGraph — empty input', () => {
  it('returns an empty graph', () => {
    expect(buildProvenanceGraph([])).toEqual({ nodes: [], edges: [] });
  });
});
