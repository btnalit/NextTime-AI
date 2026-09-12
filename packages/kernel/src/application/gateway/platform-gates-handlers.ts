import type { GateInstanceWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  GENERIC_CONNECTOR_NAMES,
  getConnector,
  getGateInstance,
  listConnectors,
  listExternalRuntimes,
  listGateInstances,
  operationsOf,
  recordGateInstanceCheck,
  revokeExternalRuntime,
  updateConnector,
  updateGateInstance,
} from '../gates/index.js';
import type { CapabilityHandler } from './capability-handler.js';
import { describeGateOperations, probeGatekeeperHealth } from './gatekeeper-read-handlers.js';
import { PlatformAdminError } from './platform-handlers.js';

/**
 * application/gateway/platform-gates-handlers: the P-B1 `scope:'platform'` integration
 * capabilities (docs/platform-admin-design.md §6.3; development-tasks.md P-B "拆分与决定") —
 * connectors (三态 + per-Operation deny list), gate instances (name / enable / disable / trust /
 * test) and external runtimes (inventory + revoke). Same transaction shape as
 * `platform-handlers.ts` (`withPlatform`, `nexttime_app`, `app.platform = on`); the catalog tables
 * are readable from every workspace transaction and writable only here (core 0023).
 *
 * What these handlers deliberately do *not* do: enable an instance inside a workspace (that needs
 * a Principal — `gate-instance-handlers.ts`, owner), tear down workspace links when a connector's
 * mode changes (design §8: mode gates new enables and catalog visibility only), or touch a
 * credential (the platform never holds one).
 */

async function requireGateInstance(client: PoolClient, gateId: string): Promise<GateInstanceWire> {
  const instance = await getGateInstance(client, gateId);
  if (!instance) throw new PlatformAdminError('gate_not_found', 'gate instance not found');
  return instance;
}

export const listConnectorsHandler: CapabilityHandler = async (client) => {
  return { result: { items: await listConnectors(client) } };
};

export const setConnectorModeHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as {
    name: string;
    mode?: 'disabled' | 'self_serve' | 'platform_preset';
    disabledOperations?: string[];
  };
  const before = await getConnector(client, input.name);
  if (!before) throw new PlatformAdminError('connector_not_found', 'connector not found');
  if (input.mode === 'platform_preset' && GENERIC_CONNECTOR_NAMES.includes(input.name)) {
    // A generic kind has no platform-run instances until the P-B2 gate host exists; preset mode
    // would make it an empty catalog entry that hides the self-serve wizard for nothing.
    throw new PlatformAdminError(
      'connector_mode_not_allowed',
      `the generic connector "${input.name}" cannot be platform-preset yet (no gate host, P-B2)`,
    );
  }
  await updateConnector(client, input.name, {
    mode: input.mode,
    disabledOperations: input.disabledOperations
      ? [...new Set(input.disabledOperations)].sort()
      : undefined,
  });
  const after = await getConnector(client, input.name);
  return { result: after, resourceType: 'connector', resourceId: input.name };
};

export const listGateInstancesHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as {
    status?: 'discovered' | 'enabled' | 'disabled' | 'lost';
    connector?: string;
  };
  return { result: { items: await listGateInstances(client, input) } };
};

export const getGateInstanceHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { gateId: string };
  const instance = await requireGateInstance(client, input.gateId);
  return { result: instance, resourceType: 'gate_instance', resourceId: instance.gateId };
};

export const updateGateInstanceHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
) => {
  const input = params as {
    gateId: string;
    displayName?: string;
    status?: 'enabled' | 'disabled';
    trust?: 'byo' | 'vetted';
  };
  const before = await requireGateInstance(client, input.gateId);
  if (input.trust === 'vetted' && before.transportKind !== 'mcp') {
    throw new PlatformAdminError(
      'trust_not_applicable',
      'only an MCP gate instance can be marked vetted (design §6.3 MCP 信任分级)',
    );
  }
  await updateGateInstance(client, input.gateId, input);
  const after = await requireGateInstance(client, input.gateId);
  return { result: after, resourceType: 'gate_instance', resourceId: after.gateId };
};

export const testGateInstanceHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { gateId: string };
  const instance = await requireGateInstance(client, input.gateId);
  const health = await probeGatekeeperHealth(instance.endpoint);
  let describedOperationCount: number | null = null;
  if (health === 'ok') {
    try {
      const described = await describeGateOperations(instance.endpoint);
      describedOperationCount = operationsOf(described.operations).length;
    } catch {
      describedOperationCount = null;
    }
  }
  await recordGateInstanceCheck(client, instance.gateId, health);
  return {
    result: {
      gateId: instance.gateId,
      health,
      describedOperationCount,
      checkedAt: new Date().toISOString(),
    },
    resourceType: 'gate_instance',
    resourceId: instance.gateId,
  };
};

export const listExternalRuntimesHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
) => {
  const input = params as { workspaceId?: string };
  return { result: { items: await listExternalRuntimes(client, input) } };
};

export const revokeExternalRuntimeHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
) => {
  const input = params as { workspaceId: string; sessionId: string };
  const revoked = await revokeExternalRuntime(client, input.workspaceId, input.sessionId);
  if (!revoked) {
    throw new PlatformAdminError('runtime_not_found', 'no active external runtime session found');
  }
  return {
    result: { workspaceId: input.workspaceId, sessionId: input.sessionId, revoked: true },
    resourceType: 'session',
    resourceId: input.sessionId,
  };
};
