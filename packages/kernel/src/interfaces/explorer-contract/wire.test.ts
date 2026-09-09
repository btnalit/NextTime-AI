import { describe, expect, it } from 'vitest';
import type { ProvEdge, ProvNode } from '../../application/gateway/provenance-graph.js';
import {
  DecisionResponseSchema,
  EdgeResponseSchema,
  NodeResponseSchema,
  ProvenanceEdgeSchema,
  ProvenanceNodeSchema,
} from './schemas.js';
import {
  toDecisionResponse,
  toEdgeResponse,
  toNodeResponse,
  toProvenanceEdge,
  toProvenanceNode,
} from './wire.js';

/**
 * Unit tests (no database) for wire.ts's domain -> reference-Explorer-wire projections, and a Zod
 * "snapshot" check that every projected object actually satisfies its own schemas.ts schema
 * (design doc §9.5 "响应形状按参考 Explorer explorer/schemas.py"; docs/development-tasks.md §S3.5
 * deliverable 4 "Zod snapshot of each response schema").
 */

describe('toNodeResponse', () => {
  it('projects a GraphObject into NodeResponse, with valid_from/valid_until null (Objects carry no bitemporal validity)', () => {
    const object = {
      workspaceId: 'ws-1',
      id: 'obj-1',
      objectType: 'ops.host',
      identityKey: { hostname: 'db-1' },
      properties: { hostname: 'db-1', ip: '10.0.0.1' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    };
    const response = toNodeResponse(object);
    expect(response).toMatchObject({
      id: 'obj-1',
      type: 'ops.host',
      properties: { hostname: 'db-1', ip: '10.0.0.1' },
      valid_from: null,
      valid_until: null,
    });
    expect(response.content).toContain('obj-1');
    expect(NodeResponseSchema.parse(response)).toEqual(response);
  });
});

describe('toEdgeResponse', () => {
  it('projects a Fact into EdgeResponse — familyId is its own id (no parallel-edge grouping in this domain)', () => {
    const fact = {
      workspaceId: 'ws-1',
      id: 'fact-1',
      linkType: 'test.runs_on',
      sourceObjectId: 'obj-a',
      targetObjectId: 'obj-b',
      properties: {},
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validUntil: null,
      recordedAt: new Date('2026-01-01T00:00:00Z'),
      supersededAt: null,
      invalidatedAt: null,
      invalidationReason: null,
      supersedesId: null,
      epistemicStatus: 'asserted' as const,
      confidence: null,
      activityId: 'activity-1',
      assertedBy: 'human-1',
      verifiedBy: null,
    };
    const response = toEdgeResponse(fact);
    expect(response).toMatchObject({
      id: 'fact-1',
      familyId: 'fact-1',
      source: 'obj-a',
      target: 'obj-b',
      type: 'test.runs_on',
      weight: 1,
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_until: null,
    });
    expect(EdgeResponseSchema.parse(response)).toEqual(response);
  });
});

describe('toDecisionResponse', () => {
  it('derives category/confidence as empty defaults (no source data), scenario from summary, outcome from status', () => {
    const row = {
      workspaceId: 'ws-1',
      id: 'decision-1',
      status: 'approved' as const,
      activityId: 'activity-1',
      sourceId: null,
      summary: 'restart the failed service',
      rationale: { actionRequestId: 'ar-1' },
      decidedBy: 'human-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      decidedAt: new Date('2026-01-01T00:05:00Z'),
    };
    const response = toDecisionResponse(row);
    expect(response).toMatchObject({
      decision_id: 'decision-1',
      category: '',
      scenario: 'restart the failed service',
      outcome: 'approved',
      confidence: 0,
      timestamp: '2026-01-01T00:05:00.000Z',
      metadata: { actionRequestId: 'ar-1' },
    });
    expect(JSON.parse(response.reasoning)).toEqual({ actionRequestId: 'ar-1' });
    expect(DecisionResponseSchema.parse(response)).toEqual(response);
  });

  it('falls back to createdAt when decidedAt is null (still-proposed Decision), and empty rationale', () => {
    const row = {
      workspaceId: 'ws-1',
      id: 'decision-2',
      status: 'proposed' as const,
      activityId: 'activity-1',
      sourceId: null,
      summary: null,
      rationale: null,
      decidedBy: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      decidedAt: null,
    };
    const response = toDecisionResponse(row);
    expect(response.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(response.scenario).toBe('');
    expect(response.reasoning).toBe('');
    expect(response.metadata).toEqual({});
    expect(DecisionResponseSchema.parse(response)).toEqual(response);
  });
});

describe('toProvenanceNode / toProvenanceEdge', () => {
  it('maps every ProvKind to its Semantica-shaped prov_type/parent_id pair', () => {
    const entity: ProvNode = { id: 'e1', label: 'Entity 1', kind: 'entity', sourceDocument: null };
    const activity: ProvNode = {
      id: 'a1',
      label: 'Activity 1',
      kind: 'activity',
      sourceDocument: null,
    };
    const agent: ProvNode = { id: 'g1', label: 'Agent 1', kind: 'agent', sourceDocument: null };

    expect(toProvenanceNode(entity)).toMatchObject({
      prov_type: 'Entity',
      parent_id: 'group_entity',
    });
    expect(toProvenanceNode(activity)).toMatchObject({
      prov_type: 'Activity',
      parent_id: 'group_activity',
    });
    expect(toProvenanceNode(agent)).toMatchObject({ prov_type: 'Agent', parent_id: 'group_agent' });

    for (const node of [entity, activity, agent]) {
      const wire = toProvenanceNode(node);
      expect(ProvenanceNodeSchema.parse(wire)).toEqual(wire);
    }
  });

  it('projects a ProvEdge 1:1, satisfying ProvenanceEdgeSchema', () => {
    const edge: ProvEdge = {
      id: 'e1->e2:used',
      source: 'e1',
      target: 'e2',
      label: 'used',
      direction: 'upstream',
    };
    const wire = toProvenanceEdge(edge);
    expect(wire).toEqual({
      id: 'e1->e2:used',
      source: 'e1',
      target: 'e2',
      label: 'used',
      direction: 'upstream',
    });
    expect(ProvenanceEdgeSchema.parse(wire)).toEqual(wire);
  });
});
