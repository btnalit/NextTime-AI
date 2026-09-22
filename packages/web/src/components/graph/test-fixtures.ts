import type { ConflictWire, ExplainResultWire, FactWire, ObjectWire } from '@nexttime/shared';
import { vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';

/**
 * components/graph/test-fixtures: one small workspace for the graph page's tests — a Host with
 * two Containers, three Facts, one open Conflict — and a scripted `CapabilityCaller` that
 * answers `list_types` / `search` / `state_at` / `get_object` / `list_conflicts` / `explain`
 * from it. Times are relative to `Date.now()` at import so freshness is deterministic against
 * the page's own frozen clock.
 */
export const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
export const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

export const PROJECT_ID = '0b6a3d7e-8b0f-4d7e-9a11-3f5c2e1d0a99';

export function object(overrides: Partial<ObjectWire> & Pick<ObjectWire, 'id'>): ObjectWire {
  return {
    objectType: 'Container',
    identityKey: null,
    properties: {},
    createdAt: iso(-24 * HOUR),
    updatedAt: iso(-HOUR),
    lastObservedAt: null,
    ...overrides,
  };
}

export const HOST = object({
  id: 'h-1',
  objectType: 'Host',
  identityKey: { hostname: 'node-a' },
  properties: { os: 'linux', apiToken: 'secret-value' },
  lastObservedAt: iso(-10 * MIN),
});

export const WEB = object({
  id: 'c-1',
  identityKey: { composeProjectId: PROJECT_ID, serviceName: 'web' },
  properties: { image: 'web:1' },
  lastObservedAt: iso(-5 * HOUR),
});

export const DB = object({
  id: 'c-2',
  identityKey: { composeProjectId: PROJECT_ID, serviceName: 'db' },
  properties: {},
  lastObservedAt: null,
});

export const OBJECTS: readonly ObjectWire[] = [HOST, WEB, DB];

export function fact(overrides: Partial<FactWire> & Pick<FactWire, 'id'>): FactWire {
  return {
    linkType: 'runs_on',
    sourceObjectId: 'c-1',
    targetObjectId: 'h-1',
    properties: {},
    validFrom: iso(-24 * HOUR),
    validUntil: null,
    recordedAt: iso(-24 * HOUR),
    supersededAt: null,
    invalidatedAt: null,
    invalidationReason: null,
    supersedesId: null,
    epistemicStatus: 'observed',
    confidence: 0.95,
    activityId: 'act-1',
    assertedBy: 'p-collector',
    verifiedBy: null,
    observationId: 'obs-1',
    lastObservationId: 'obs-2',
    lastObservedAt: iso(-10 * MIN),
    ...overrides,
  };
}

/** web runs_on host (fresh), db runs_on host (in an open Conflict), host depends_on web (asserted,
 *  no observation clock). */
export const FACTS: readonly FactWire[] = [
  fact({ id: 'f-1' }),
  fact({ id: 'f-2', sourceObjectId: 'c-2', lastObservedAt: iso(-3 * HOUR) }),
  fact({
    id: 'f-3',
    linkType: 'depends_on',
    sourceObjectId: 'h-1',
    targetObjectId: 'c-1',
    epistemicStatus: 'asserted',
    confidence: null,
    observationId: null,
    lastObservationId: null,
    lastObservedAt: null,
  }),
];

export const CONFLICT: ConflictWire = {
  id: 'conf-1',
  conflictType: 'value',
  status: 'open',
  factAId: 'f-2',
  factBId: 'f-9',
  description: null,
  activityId: 'act-2',
  openedAt: iso(-HOUR),
  resolvedAt: null,
  resolvedBy: null,
  resolution: null,
};

export const TYPES = [
  { kind: 'object', name: 'Host', description: 'A machine', identityKey: ['hostname'] },
  {
    kind: 'object',
    name: 'Container',
    description: 'A container',
    identityKey: ['composeProjectId', 'serviceName'],
  },
  {
    kind: 'link',
    name: 'runs_on',
    signatures: [{ domain: 'Container', range: 'Host', description: '' }],
  },
];

export const EXPLAIN_F1: ExplainResultWire = {
  nodeType: 'fact',
  fact: {
    id: 'f-1',
    linkType: 'runs_on',
    epistemicStatus: 'observed',
    assertedByPrincipal: {
      id: 'p-collector',
      kind: 'service',
      role: 'member',
      displayName: 'collector',
    },
    verifiedByPrincipal: null,
    observationId: 'obs-1',
    invalidatedAt: null,
    invalidationReason: null,
    lastObservation: {
      id: 'obs-2',
      createdAt: iso(-10 * MIN),
      source: {
        id: 'src-1',
        kind: 'collector',
        uri: 'collector://host-inventory',
        visibility: 'workspace',
        ownerPrincipal: null,
      },
    },
  },
  activity: {
    id: 'act-1',
    kind: 'collector_run',
    status: 'completed',
    createdAt: iso(-24 * HOUR),
    endedAt: iso(-24 * HOUR + MIN),
    startedByPrincipal: {
      id: 'p-collector',
      kind: 'service',
      role: null,
      displayName: 'collector',
    },
    observations: [],
    metadata: {},
    onBehalfOfPrincipal: null,
  },
};

export type Handler = (params: unknown) => unknown | Promise<unknown>;

export interface ScriptedHttp extends CapabilityCaller {
  readonly calls: { readonly name: string; readonly params: unknown }[];
  callsTo(name: string): unknown[];
}

/** The default script; any handler can be overridden per test. */
export function scriptedHttp(overrides: Record<string, Handler> = {}): ScriptedHttp {
  const calls: { name: string; params: unknown }[] = [];
  const facts = FACTS;
  const base: Record<string, Handler> = {
    list_types: () => ({ items: TYPES }),
    list_conflicts: () => ({ items: [CONFLICT] }),
    search: (params) => {
      const { query, objectType, cursor } = params as {
        query: string;
        objectType?: string;
        cursor?: string;
      };
      if (cursor === 'page-2') return { items: [DB] };
      const items = OBJECTS.filter(
        (row) =>
          (objectType === undefined || row.objectType === objectType) &&
          (query === '' || JSON.stringify(row).includes(query)),
      );
      // Browse mode pages: first page is host + web, page 2 is db.
      if (query === '' && objectType === undefined)
        return { items: items.filter((row) => row.id !== 'c-2'), nextCursor: 'page-2' };
      return { items };
    },
    state_at: (params) => {
      const { objectId } = params as { objectId: string };
      const row = OBJECTS.find((candidate) => candidate.id === objectId) ?? null;
      return {
        object: row,
        facts: facts.filter((f) => f.sourceObjectId === objectId || f.targetObjectId === objectId),
      };
    },
    get_object: (params) => {
      const { objectId } = params as { objectId: string };
      return OBJECTS.find((candidate) => candidate.id === objectId) ?? null;
    },
    explain: (params) => {
      const { nodeId } = params as { nodeId: string };
      if (nodeId !== 'f-1') throw new Error(`unscripted explain ${nodeId}`);
      return EXPLAIN_F1;
    },
    ...overrides,
  };
  return {
    calls,
    callsTo: (name) => calls.filter((call) => call.name === name).map((call) => call.params),
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = base[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}
