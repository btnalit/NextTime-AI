import type { GateHostedDefinitionWire, GateInstanceWire } from '@nexttime/shared';
import { GATE_SHARED_CREDENTIAL_SLOT, mintGateHostToken } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  createHostedGateInstance,
  deleteHostedGateInstance,
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
import { getConfiguredTaskRuntime } from '../task/runtime.js';
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
  if (input.mode === 'platform_preset' && (input.name === 'cli' || input.name === 'ssh')) {
    // P-B2a (决定 ⑬) lifted this for `http` / `mcp`: the gate host runs platform instances of those
    // two. `cli` / `ssh` still have no host, so preset mode would be an empty catalog entry that
    // hides the self-serve wizard for nothing.
    throw new PlatformAdminError(
      'connector_mode_not_allowed',
      `the generic connector "${input.name}" cannot be platform-preset (no gate host for this kind)`,
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
  if (instance.endpoint === '') {
    // P-B2a: a gate-host instance the host has not announced yet has no endpoint to probe.
    await recordGateInstanceCheck(client, instance.gateId, 'unknown');
    return {
      result: {
        gateId: instance.gateId,
        health: 'unknown',
        describedOperationCount: null,
        checkedAt: new Date().toISOString(),
      },
      resourceType: 'gate_instance',
      resourceId: instance.gateId,
    };
  }
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

// -------------------------------------------------------------------------------------------
// P-B2a gate-host instances (决定 ⑥–⑬)
// -------------------------------------------------------------------------------------------

/** Where the browser posts a credential for `gateId` — same origin, Caddy `handle_path /gate-host/*`
 *  → the gate host's `/i/<gateId>/gate/connected-accounts` (决定 ⑩). */
export function gateHostCredentialUrl(gateId: string): string {
  return `/gate-host/i/${encodeURIComponent(gateId)}/gate/connected-accounts`;
}

export const createGateInstanceHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
) => {
  const input = params as {
    gateId: string;
    displayName?: string;
    transportKind: 'http' | 'mcp';
    target: string;
    credentialMode: 'shared' | 'connected_account';
    manifestSource?: string | null;
  };
  const definition: GateHostedDefinitionWire = {
    transportKind: input.transportKind,
    target: input.target,
    credentialMode: input.credentialMode,
    manifestSource: input.transportKind === 'http' ? (input.manifestSource ?? null) : null,
  };
  const created = await createHostedGateInstance(client, {
    gateId: input.gateId,
    displayName: input.displayName ?? input.gateId,
    definition,
  });
  if (!created) {
    throw new PlatformAdminError(
      'gate_id_taken',
      `a gate instance "${input.gateId}" already exists`,
    );
  }
  const instance = await requireGateInstance(client, input.gateId);
  return { result: instance, resourceType: 'gate_instance', resourceId: instance.gateId };
};

export const deleteGateInstanceHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
) => {
  const input = params as { gateId: string };
  const outcome = await deleteHostedGateInstance(client, input.gateId);
  if (outcome === 'not_found') {
    throw new PlatformAdminError('gate_not_found', 'gate instance not found');
  }
  if (outcome === 'not_hosted') {
    throw new PlatformAdminError(
      'gate_not_hosted',
      'only a gate-host instance can be deleted; a packaged gate disappears when its container stops announcing',
    );
  }
  if (outcome === 'in_use') {
    throw new PlatformAdminError(
      'gate_in_use',
      'a workspace still has this instance enabled — disable it instead (links are never torn down by the platform)',
    );
  }
  return {
    result: { gateId: input.gateId, deleted: true },
    resourceType: 'gate_instance',
    resourceId: input.gateId,
  };
};

/** Platform side of 决定 ⑩: a 5-minute token for the instance-wide (`shared`) credential slot. The
 *  credential itself never reaches the kernel — the browser posts it to the gate host. */
export const issueGateHostTokenHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
) => {
  const input = params as { gateId: string };
  const instance = await requireGateInstance(client, input.gateId);
  if (!instance.hosted || !instance.definition) {
    throw new PlatformAdminError(
      'gate_not_hosted',
      'credentials can only be entered for a gate-host instance; a packaged gate holds its own',
    );
  }
  if (instance.definition.credentialMode !== 'shared') {
    throw new PlatformAdminError(
      'credential_mode_mismatch',
      'this instance takes one credential per member (connected_account) — each member enters their own from the workspace',
    );
  }
  const subject = ctx?.platformUser?.id;
  if (!subject) throw new Error('issue_gate_host_token invoked outside a platform transaction');
  const { privateKey } = getConfiguredTaskRuntime();
  const minted = await mintGateHostToken({
    privateKey,
    gateId: instance.gateId,
    onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
    subject,
  });
  return {
    result: {
      gateId: instance.gateId,
      token: minted.token,
      url: gateHostCredentialUrl(instance.gateId),
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      credentialMode: 'shared',
      expiresAt: minted.expiresAt.toISOString(),
    },
    resourceType: 'gate_instance',
    resourceId: instance.gateId,
  };
};
