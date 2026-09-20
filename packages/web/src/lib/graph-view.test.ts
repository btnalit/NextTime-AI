import type { ConflictWire, ExplainResultWire, FactWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  conflictsByFactId,
  explainToProvenance,
  factDirection,
  groupFacts,
  identityKeysByType,
  isUuidLike,
  isoToLocalInput,
  localInputToIso,
  neighbourId,
  neighbourIds,
  objectDisplayName,
  objectTypeOptions,
} from './graph-view.js';

const UUID = '0b6a3d7e-8b0f-4d7e-9a11-3f5c2e1d0a99';

function fact(overrides: Partial<FactWire> = {}): FactWire {
  return {
    id: 'f-1',
    linkType: 'runs_on',
    sourceObjectId: 'o-1',
    targetObjectId: 'o-2',
    properties: {},
    validFrom: '2026-09-01T00:00:00Z',
    validUntil: null,
    recordedAt: '2026-09-01T00:00:00Z',
    supersededAt: null,
    invalidatedAt: null,
    invalidationReason: null,
    supersedesId: null,
    epistemicStatus: 'observed',
    confidence: 0.9,
    activityId: 'a-1',
    assertedBy: 'p-1',
    verifiedBy: null,
    observationId: 'obs-1',
    lastObservationId: 'obs-1',
    lastObservedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

describe('objectDisplayName', () => {
  it('prefers a name-like property', () => {
    expect(objectDisplayName({ identityKey: { hostname: 'h' }, properties: { name: 'web' } })).toBe(
      'web',
    );
  });

  it('falls back to identity-key values in the ontology’s order, skipping foreign uuids', () => {
    const object = {
      identityKey: { serviceName: 'api', composeProjectId: UUID },
      properties: { image: 'x' },
    };
    expect(objectDisplayName(object, ['composeProjectId', 'serviceName'])).toBe('api');
    // Without the ontology's order: stored order, still skipping the uuid.
    expect(objectDisplayName(object)).toBe('api');
    expect(
      objectDisplayName(
        { identityKey: { hostId: UUID, address: '192.0.2.1', port: 8080 }, properties: {} },
        ['hostId', 'address', 'port'],
      ),
    ).toBe('192.0.2.1 / 8080');
  });

  it('is undefined (bare-id fallback) when nothing usable exists', () => {
    expect(objectDisplayName({ identityKey: null, properties: {} })).toBeUndefined();
    expect(objectDisplayName({ identityKey: { id: UUID }, properties: { name: UUID } })).toBe(
      undefined,
    );
  });

  it('isUuidLike recognises canonical uuids only', () => {
    expect(isUuidLike(UUID)).toBe(true);
    expect(isUuidLike('web-1')).toBe(false);
    expect(isUuidLike(42)).toBe(false);
  });
});

describe('list_types helpers', () => {
  const types = [
    { kind: 'link', name: 'runs_on', signatures: [] },
    { kind: 'object', name: 'Host', description: '', identityKey: ['hostname'] },
    { kind: 'object', name: 'Container', description: '' },
  ];
  it('identityKeysByType keeps only object types that declare a key', () => {
    const map = identityKeysByType(types);
    expect(map.get('Host')).toEqual(['hostname']);
    expect(map.has('Container')).toBe(false);
    expect(map.has('runs_on')).toBe(false);
  });
  it('objectTypeOptions filters and sorts', () => {
    expect(objectTypeOptions(types).map((t) => t.name)).toEqual(['Container', 'Host']);
  });
});

describe('facts around an Object', () => {
  it('factDirection / neighbourId', () => {
    const f = fact();
    expect(factDirection(f, 'o-1')).toBe('out');
    expect(factDirection(f, 'o-2')).toBe('in');
    expect(factDirection(fact({ targetObjectId: 'o-1' }), 'o-1')).toBe('self');
    expect(neighbourId(f, 'o-1')).toBe('o-2');
    expect(neighbourId(f, 'o-2')).toBe('o-1');
  });

  it('groupFacts groups by link type + direction, outgoing first, link types alphabetical', () => {
    const facts = [
      fact({ id: 'a', linkType: 'runs_on', sourceObjectId: 'o-1', targetObjectId: 'h-1' }),
      fact({ id: 'b', linkType: 'depends_on', sourceObjectId: 'o-9', targetObjectId: 'o-1' }),
      fact({ id: 'c', linkType: 'runs_on', sourceObjectId: 'o-1', targetObjectId: 'h-2' }),
      fact({ id: 'd', linkType: 'depends_on', sourceObjectId: 'o-1', targetObjectId: 'o-3' }),
    ];
    const groups = groupFacts(facts, 'o-1');
    expect(groups.map((g) => g.key)).toEqual(['depends_on:out', 'depends_on:in', 'runs_on:out']);
    expect(groups[2]?.facts.map((f) => f.id)).toEqual(['a', 'c']);
    expect(neighbourIds(facts, 'o-1')).toEqual(['h-1', 'o-9', 'h-2', 'o-3']);
  });

  it('neighbourIds excludes the Object itself for a self-link and dedupes', () => {
    const facts = [
      fact({ id: 'a', sourceObjectId: 'o-1', targetObjectId: 'o-1' }),
      fact({ id: 'b', sourceObjectId: 'o-1', targetObjectId: 'o-2' }),
      fact({ id: 'c', sourceObjectId: 'o-2', targetObjectId: 'o-1' }),
    ];
    expect(neighbourIds(facts, 'o-1')).toEqual(['o-2']);
  });
});

describe('conflictsByFactId', () => {
  it('indexes both sides of every conflict', () => {
    const conflict = (id: string, a: string, b: string): ConflictWire => ({
      id,
      conflictType: 'value',
      status: 'open',
      factAId: a,
      factBId: b,
      description: null,
      activityId: 'act',
      openedAt: '2026-09-01T00:00:00Z',
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    });
    const map = conflictsByFactId([conflict('c1', 'f1', 'f2'), conflict('c2', 'f2', 'f3')]);
    expect(map.get('f1')?.map((c) => c.id)).toEqual(['c1']);
    expect(map.get('f2')?.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(map.has('f9')).toBe(false);
  });
});

describe('explainToProvenance', () => {
  const source = {
    id: 'src-1',
    kind: 'collector',
    uri: null,
    visibility: 'workspace',
    ownerPrincipal: null,
  };
  const base: ExplainResultWire = {
    nodeType: 'fact',
    fact: {
      id: 'f-1',
      linkType: 'runs_on',
      epistemicStatus: 'observed',
      assertedByPrincipal: { id: 'p-1', kind: 'service', role: 'member', displayName: 'collector' },
      verifiedByPrincipal: null,
      observationId: 'obs-1',
      invalidatedAt: null,
      invalidationReason: null,
      lastObservation: { id: 'obs-2', createdAt: '2026-09-02T00:00:00Z', source },
    },
    activity: {
      id: 'a-1',
      kind: 'ingest',
      status: 'completed',
      createdAt: '2026-09-01T00:00:00Z',
      endedAt: null,
      startedByPrincipal: { id: 'p-1', kind: 'service', role: null, displayName: 'collector' },
      observations: [{ id: 'obs-1', createdAt: '2026-09-01T00:00:00Z', source }],
      metadata: {},
      onBehalfOfPrincipal: null,
    },
  };

  it('maps the three segments, Source from the Fact’s own last observation', () => {
    const view = explainToProvenance(base);
    expect(view.fact?.linkType).toBe('runs_on');
    expect(view.fact?.lastObservation?.id).toBe('obs-2');
    expect(view.activity?.kind).toBe('ingest');
    expect(view.source?.id).toBe('src-1');
  });

  it('falls back to the Activity’s first Observation, then to no Source at all', () => {
    const noLast = explainToProvenance({
      ...base,
      fact: base.fact ? { ...base.fact, lastObservation: null } : undefined,
    });
    expect(noLast.source?.id).toBe('src-1');
    const asserted = explainToProvenance({
      ...base,
      fact: base.fact ? { ...base.fact, lastObservation: null } : undefined,
      activity: base.activity ? { ...base.activity, observations: [] } : null,
    });
    expect(asserted.source).toBeNull();
    expect(explainToProvenance({ nodeType: 'activity', activity: null }).fact).toBeNull();
  });
});

describe('as-of input helpers', () => {
  it('converts between datetime-local and ISO', () => {
    const iso = localInputToIso('2026-09-19T10:30');
    expect(iso).toBeDefined();
    expect(isoToLocalInput(iso as string)).toBe('2026-09-19T10:30');
    expect(localInputToIso('')).toBeUndefined();
    expect(localInputToIso('nope')).toBeUndefined();
    expect(isoToLocalInput('nope')).toBe('');
  });
});
