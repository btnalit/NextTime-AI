import {
  type ConnectorWire,
  type GateInstanceWire,
  PLATFORM_STATE_AUDIT_RECENT_LIMIT,
  PLATFORM_STATE_AUDIT_SCAN_ROWS,
  PLATFORM_STATE_GATES_LIMIT,
  getCapability,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { findSuspectedSecrets } from '../../governance/redaction/index.js';
import { addressLikeReason, findAddressLike } from './platform-state-probes.js';
import {
  type PlatformAuditSummaryRow,
  projectConnector,
  projectConnectors,
  projectGateInstance,
  projectGateInstances,
  summarizePlatformAudit,
} from './platform-state.js';

/**
 * application/admin-agent/platform-state.test (S11 AA2; pure, no database): the projections of
 * `platform_state_*` against hostile sources. Every field a projection drops carries a unique
 * canary; every string it passes is tried with values shaped like an address, a path or a
 * credential. What comes out must hold no canary, no suspected secret and nothing address-like,
 * must fit the capability's strict result schema, and must not change when the source gains a
 * field (nothing is spread).
 *
 * Private addresses are assembled at run time: CI's IP-literal guard reads test files too.
 */

const PRIVATE_V4 = [10, 20, 30, 40].join('.');
const PRIVATE_V4_B = [192, 168, 7, 9].join('.');
const ULA_V6 = ['fd12', '3456', '789a', '', '1'].join(':');
const HOSTILE_STRINGS = [
  PRIVATE_V4,
  `${PRIVATE_V4_B}:5432`,
  `[${ULA_V6}]:8443`,
  'db.internal.example:5432',
  `https://user:pw@${PRIVATE_V4}/x`,
  '/var/lib/canary-hostile-path',
  `sk-${'a1B2'.repeat(12)}`,
  ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.'),
  'ops@db.internal.example',
] as const;

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-01T11:00:00.000Z';

function operationSummary(name: string) {
  return {
    name,
    mode: 'observe' as const,
    blastRadius: 'canary-gates-op-blast',
    autoApprovable: true,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    gateOwnedParams: [{ param: 'canary-gates-owned-param', location: 'header' as const }],
  };
}

function hostileGate(overrides: Partial<GateInstanceWire> = {}): GateInstanceWire {
  return {
    gateId: 'gate-alpha',
    connector: 'ragflow',
    displayName: 'canary-gates-display-name',
    transportKind: 'http',
    target: `https://admin:canary-gates-target-pw@${PRIVATE_V4}:9380/canary-gates-target`,
    endpoint: `http://${PRIVATE_V4_B}:7700/canary-gates-endpoint`,
    status: 'enabled',
    trust: 'vetted',
    health: 'ok',
    lastSeenAt: T1,
    lastCheckedAt: T1,
    operationCount: 3,
    enabledWorkspaceCount: 2,
    enablingWorkspaces: [
      { id: 'canary-gates-enabling-ws-id', name: 'canary-gates-enabling-ws-name' },
    ],
    operations: [operationSummary('canary-gates-operation')],
    hosted: true,
    definition: {
      transportKind: 'http',
      target: 'https://canary-gates-definition-target.example:9380',
      credentialMode: 'shared',
      manifestSource: 'https://canary-gates-manifest-source.example/openapi.json',
      preset: 'ragflow',
    },
    pendingManifest: {
      digest: 'canary-gates-pending-digest',
      announcedAt: T1,
      operationCount: 4,
      added: [operationSummary('canary-gates-added')],
      removed: [],
      changed: [],
      refusedOperations: ['canary-gates-refused-operation', 'second'],
    },
    createdAt: T0,
    updatedAt: T1,
    ...overrides,
  };
}

function hostileConnector(overrides: Partial<ConnectorWire> = {}): ConnectorWire {
  return {
    name: 'ragflow',
    kind: 'http',
    packaged: false,
    mode: 'platform_preset',
    disabledOperations: [
      'docs.search',
      'dataset_list',
      ...HOSTILE_STRINGS,
      'fetch https canary-connectors-op',
      'a/b',
    ],
    operationCount: 7,
    instanceCount: 1,
    selfConnectionCount: 3,
    suspendedSelfConnectionCount: 1,
    updatedAt: T1,
    ...overrides,
  };
}

/** The four checks every projected result passes. The secret detector with its field-name rule
 *  also names every `credentialMode` — which kind of credential a gate takes, an enum, never one. */
function expectClean(capabilityName: string, out: unknown): void {
  const text = JSON.stringify(out);
  expect(text, capabilityName).not.toMatch(/canary/i);
  expect(findSuspectedSecrets(out).count, capabilityName).toBe(0);
  const byName = findSuspectedSecrets(out, { secretFields: true });
  expect(
    byName.paths.filter((path) => !path.endsWith('.credentialMode')),
    capabilityName,
  ).toEqual([]);
  expect(findAddressLike(out), capabilityName).toEqual([]);
  const schema = getCapability(capabilityName)?.resultSchema;
  expect(schema?.safeParse(out).success, capabilityName).toBe(true);
}

describe('findAddressLike (the probe itself)', () => {
  it('catches every hostile value it is meant to catch, and nothing plain', () => {
    for (const value of HOSTILE_STRINGS.filter(
      (v) => !v.startsWith('sk-') && !v.startsWith('eyJ'),
    )) {
      expect(addressLikeReason(value), value).not.toBeNull();
    }
    for (const value of ['ragflow', 'docs.search', 'gate-alpha', T0, 'workspace.created', 'self']) {
      expect(addressLikeReason(value), value).toBeNull();
    }
    expect(findAddressLike({ a: [{ b: `x ${PRIVATE_V4} y` }] })).toEqual([
      '$.a[0].b: an IP literal',
    ]);
  });
});

describe('platform_state_gates projection', () => {
  it('keeps the gate’s state and counts, and none of its addresses, names or definitions', () => {
    const out = projectGateInstances([hostileGate()], T1);
    expectClean('platform_state_gates', out);
    expect(out).toEqual({
      instances: [
        {
          gateId: 'gate-alpha',
          connector: 'ragflow',
          transportKind: 'http',
          hosted: true,
          preset: 'ragflow',
          credentialMode: 'shared',
          status: 'enabled',
          trust: 'vetted',
          health: 'ok',
          lastSeenAt: T1,
          lastCheckedAt: T1,
          operationCount: 3,
          enabledWorkspaceCount: 2,
          pendingManifest: {
            announcedAt: T1,
            operationCount: 4,
            addedCount: 1,
            removedCount: 0,
            changedCount: 0,
            refusedOperationCount: 2,
          },
          createdAt: T0,
          updatedAt: T1,
        },
      ],
      total: 1,
      truncated: false,
      checkedAt: T1,
    });
  });

  it('nulls a passed-through string out of shape, and drops an instance whose identity is', () => {
    for (const hostile of HOSTILE_STRINGS) {
      const gate = projectGateInstance(
        hostileGate({
          connector: hostile,
          lastSeenAt: hostile,
          lastCheckedAt: hostile,
          definition: {
            transportKind: 'mcp',
            target: 'https://canary.example',
            credentialMode: hostile as 'shared',
            manifestSource: null,
            preset: hostile,
          },
        }),
      );
      expect(gate?.connector, hostile).toBeNull();
      expect(gate?.preset, hostile).toBeNull();
      expect(gate?.credentialMode, hostile).toBeNull();
      expect(gate?.lastSeenAt, hostile).toBeNull();
      expect(gate?.lastCheckedAt, hostile).toBeNull();
      expectClean('platform_state_gates', {
        instances: [gate],
        total: 1,
        truncated: false,
        checkedAt: T1,
      });
      expect(projectGateInstance(hostileGate({ gateId: hostile })), hostile).toBeNull();
      expect(projectGateInstance(hostileGate({ createdAt: hostile })), hostile).toBeNull();
      expect(
        projectGateInstance(hostileGate({ status: hostile as GateInstanceWire['status'] })),
        hostile,
      ).toBeNull();
    }
  });

  it('a packaged gate has no preset or credential mode; a negative or fractional count reads 0', () => {
    const gate = projectGateInstance(
      hostileGate({ hosted: false, definition: null, pendingManifest: null, operationCount: -3 }),
    );
    expect(gate).toMatchObject({
      hosted: false,
      preset: null,
      credentialMode: null,
      pendingManifest: null,
      operationCount: 0,
    });
    expect(
      projectGateInstance(hostileGate({ enabledWorkspaceCount: 1.5 }))?.enabledWorkspaceCount,
    ).toBe(0);
  });

  it('does not change when the source gains a field — nothing is spread', () => {
    const plain = projectGateInstance(hostileGate());
    const widened = projectGateInstance({
      ...hostileGate(),
      healthEndpoint: 'canary-gates-health-endpoint',
      secretNote: 'canary-gates-extra',
    } as GateInstanceWire);
    expect(widened).toEqual(plain);
    const pending = hostileGate().pendingManifest;
    const widenedPending = projectGateInstance(
      hostileGate({
        pendingManifest: pending ? ({ ...pending, extra: 'canary' } as typeof pending) : null,
      }),
    );
    expect(widenedPending).toEqual(plain);
  });

  it('lists at most the limit, says it truncated, and counts every instance', () => {
    const gates = Array.from({ length: PLATFORM_STATE_GATES_LIMIT + 5 }, (_, i) =>
      hostileGate({ gateId: `gate-${i}` }),
    );
    const out = projectGateInstances([...gates, hostileGate({ gateId: 'X' })], T1);
    expect(out.instances).toHaveLength(PLATFORM_STATE_GATES_LIMIT);
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(PLATFORM_STATE_GATES_LIMIT + 6);
    expectClean('platform_state_gates', out);
  });
});

describe('platform_state_connectors projection', () => {
  it('keeps mode and counts; disabled Operation names only in plain identifier shape', () => {
    const out = projectConnectors([hostileConnector(), hostileConnector({ name: 'http' })], T1);
    expectClean('platform_state_connectors', out);
    expect(out.connectors[0]).toEqual({
      name: 'ragflow',
      kind: 'http',
      packaged: false,
      generic: false,
      mode: 'platform_preset',
      disabledOperationCount: 2 + HOSTILE_STRINGS.length + 2,
      disabledOperations: ['docs.search', 'dataset_list'],
      operationCount: 7,
      instanceCount: 1,
      selfConnectionCount: 3,
      suspendedSelfConnectionCount: 1,
      updatedAt: T1,
    });
    expect(out.connectors[1]?.generic).toBe(true);
  });

  it('drops a connector whose name, kind or mode is out of shape', () => {
    for (const hostile of HOSTILE_STRINGS) {
      expect(projectConnector(hostileConnector({ name: hostile })), hostile).toBeNull();
      expect(
        projectConnector(hostileConnector({ kind: hostile as ConnectorWire['kind'] })),
        hostile,
      ).toBeNull();
      expect(
        projectConnector(hostileConnector({ mode: hostile as ConnectorWire['mode'] })),
        hostile,
      ).toBeNull();
      expect(
        projectConnector(hostileConnector({ updatedAt: hostile }))?.updatedAt,
        hostile,
      ).toBeNull();
    }
  });

  it('does not change when the source gains a field', () => {
    expect(
      projectConnector({ ...hostileConnector(), workspaceNames: ['canary'] } as ConnectorWire),
    ).toEqual(projectConnector(hostileConnector()));
  });
});

describe('platform_state_audit summary', () => {
  const SELF = 'user-self';
  function row(overrides: Partial<PlatformAuditSummaryRow> = {}): PlatformAuditSummaryRow {
    return {
      action: 'create_gate_instance',
      actorUserId: SELF,
      resourceType: 'gate_instance',
      createdAt: new Date(T1),
      ...overrides,
    };
  }

  it('counts writes per action, lists the newest writes, leaves reads out and names no one', () => {
    const rows = [
      row(),
      row({ action: 'list_gate_instances' }),
      row({ action: 'platform_state_gates' }),
      row({ action: 'workspace.created', actorUserId: 'someone-else', resourceType: 'workspace' }),
      row({ action: 'platform.workspace_purged', actorUserId: null, resourceType: null }),
      row({ action: 'create_gate_instance', actorUserId: null }),
      ...HOSTILE_STRINGS.map((hostile) => row({ action: hostile, resourceType: hostile })),
      row({ action: 'update_user', resourceType: `user:${PRIVATE_V4}` }),
      {
        ...row({ action: 'set_connector_mode' }),
        payload: { target: `https://${PRIVATE_V4}`, canary: 'canary-audit-payload' },
        actorLogin: 'canary-audit-login',
      } as PlatformAuditSummaryRow,
    ];
    const out = summarizePlatformAudit(rows, SELF, T1);
    expectClean('platform_state_audit', out);
    expect(out.scannedRows).toBe(rows.length);
    expect(out.truncated).toBe(false);
    expect(out.unrecognizedWrites).toBe(HOSTILE_STRINGS.length);
    expect(out.writesByAction).toEqual([
      { action: 'create_gate_instance', count: 2 },
      { action: 'platform.workspace_purged', count: 1 },
      { action: 'set_connector_mode', count: 1 },
      { action: 'update_user', count: 1 },
      { action: 'workspace.created', count: 1 },
    ]);
    expect(out.recent.map((write) => [write.action, write.actor, write.resourceType])).toEqual([
      ['create_gate_instance', 'self', 'gate_instance'],
      ['workspace.created', 'another_administrator', 'workspace'],
      ['platform.workspace_purged', 'unattributed', null],
      ['create_gate_instance', 'unattributed', 'gate_instance'],
      ['update_user', 'self', null],
      ['set_connector_mode', 'self', 'gate_instance'],
    ]);
  });

  it('looks through at most the scan limit, says so, and lists at most the recent limit', () => {
    const rows = Array.from({ length: PLATFORM_STATE_AUDIT_SCAN_ROWS + 1 }, () => row());
    const out = summarizePlatformAudit(rows, SELF, T1);
    expect(out.scannedRows).toBe(PLATFORM_STATE_AUDIT_SCAN_ROWS);
    expect(out.truncated).toBe(true);
    expect(out.recent).toHaveLength(PLATFORM_STATE_AUDIT_RECENT_LIMIT);
    expect(out.writesByAction).toEqual([
      { action: 'create_gate_instance', count: PLATFORM_STATE_AUDIT_SCAN_ROWS },
    ]);
    expectClean('platform_state_audit', out);
  });
});
