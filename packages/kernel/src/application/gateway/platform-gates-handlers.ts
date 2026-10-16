import type {
  GateHostedDefinitionWire,
  GateInstanceWire,
  SelfConnectionWire,
} from '@nexttime/shared';
import { GATE_SHARED_CREDENTIAL_SLOT, mintGateHostToken } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { platformGateTarget } from '../../adapters/gatekeeper-client/index.js';
import {
  assertConnectionParamsCarryNoCredentials,
  redactConnectionAddress,
} from '../../governance/connections/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import {
  type SelfConnectionListRow,
  confirmPendingManifest,
  createHostedGateInstance,
  deleteHostedGateInstance,
  displayedGateInstance,
  getConnector,
  getGateInstance,
  listConnectors,
  listExternalRuntimes,
  listGateInstances,
  listSelfConnections,
  operationsOf,
  recordGateInstanceCheck,
  revokeEntryHandlesForConnector,
  revokeEntryHandlesInWorkspace,
  revokeExternalRuntime,
  setSelfConnectionSuspension,
  updateConnector,
  updateGateInstance,
} from '../gates/index.js';
import { getConfiguredTaskRuntime } from '../task/runtime.js';
import type { CapabilityHandler } from './capability-handler.js';
import { urlHost } from './gate-target.js';
import { describeGateOperations, probeGatekeeperHealth } from './gatekeeper-read-handlers.js';
import { PlatformAdminError } from './platform-handlers.js';

/**
 * application/gateway/platform-gates-handlers: the P-B1 `scope:'platform'` integration
 * capabilities (docs/platform-admin-design.md §6.3; development-tasks.md P-B "拆分与决定") —
 * connectors (三态 + per-Operation deny list), gate instances (name / enable / disable / trust /
 * test), external runtimes (inventory + revoke) and — P0b — the gates workspaces connected
 * themselves (inventory + suspend / resume). Same transaction shape as
 * `platform-handlers.ts` (`withPlatform`, `nexttime_app`, `app.platform = on`); the catalog tables
 * are readable from every workspace transaction and writable only here (core 0023).
 *
 * What these handlers deliberately do *not* do: enable an instance inside a workspace (that needs
 * a Principal — `gate-instance-handlers.ts`, owner), tear down workspace links when a connector's
 * mode changes (design §8: mode gates new enables and catalog visibility only), or touch a
 * credential (the platform never holds one).
 */

/** The instance as stored — what the handlers below decide on. What they return goes through
 *  `displayedGateInstance` (its addresses as every gate address is shown). */
async function requireGateInstance(client: PoolClient, gateId: string): Promise<GateInstanceWire> {
  const instance = await getGateInstance(client, gateId);
  if (!instance) throw new PlatformAdminError('gate_not_found', 'gate instance not found');
  return instance;
}

export const listConnectorsHandler: CapabilityHandler = async (client) => {
  return { result: { items: await listConnectors(client) } };
};

export const setConnectorModeHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
) => {
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
  const nextDisabledOperations = input.disabledOperations
    ? [...new Set(input.disabledOperations)].sort()
    : undefined;
  await updateConnector(client, input.name, {
    mode: input.mode,
    disabledOperations: nextDisabledOperations,
  });
  const after = await getConnector(client, input.name);

  // P-B1 propagation fix (production incident 2026-09-26): a deny-list or mode edit that actually
  // changes what this connector's already-linked workspaces may call must reach every already-
  // issued entry-agent Handle right away, not on whatever unrelated Grant/AgentProfile change next
  // happens to touch the same workspace — `assertOperationEnabled` refuses the call regardless of
  // what a stale Handle still advertises as a tool (`revokeEntryHandlesForConnector`, application/
  // gates/store.ts, has the full reasoning). Compared against the sorted `before` snapshot so a
  // no-op save (the same list re-submitted) never revokes anything it does not have to.
  const denyListChanged =
    nextDisabledOperations !== undefined &&
    JSON.stringify(nextDisabledOperations) !==
      JSON.stringify([...before.disabledOperations].sort());
  const modeChanged = input.mode !== undefined && input.mode !== before.mode;
  if (denyListChanged || modeChanged) {
    const { linkedWorkspaceCount, revokedWorkspaceCount } = await revokeEntryHandlesForConnector(
      client,
      input.name,
    );
    if (revokedWorkspaceCount > 0) {
      await writeAudit(client, {
        workspaceId: null,
        actorPrincipalId: null,
        actorUserId: ctx?.platformUser?.id,
        action: 'connector.entry_handles_revoked',
        resourceType: 'connector',
        // `audit_records.resource_id` is a uuid; a connector is keyed by name, so the name goes in
        // the payload as `resourceRef` — the same place dispatch's own audit row for
        // `set_connector_mode` puts it.
        payload: {
          resourceRef: input.name,
          linkedWorkspaceCount,
          revokedWorkspaceCount,
          disabledOperations: after?.disabledOperations ?? [],
          mode: after?.mode,
        },
      });
    }
  }

  return { result: after, resourceType: 'connector', resourceId: input.name };
};

export const listGateInstancesHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as {
    status?: 'discovered' | 'enabled' | 'disabled' | 'lost';
    connector?: string;
  };
  const items = await listGateInstances(client, input);
  return { result: { items: items.map(displayedGateInstance) } };
};

export const getGateInstanceHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { gateId: string };
  const instance = await requireGateInstance(client, input.gateId);
  return {
    result: displayedGateInstance(instance),
    resourceType: 'gate_instance',
    resourceId: instance.gateId,
  };
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
  return {
    result: displayedGateInstance(after),
    resourceType: 'gate_instance',
    resourceId: after.gateId,
  };
};

/**
 * `confirm_gate_manifest` (R-18, decision D-18): adopts the instance's held announcement as the
 * manifest in effect — the one later workspace enables import and `refresh_operation_governance`
 * aligns to. `digest` must be the pending manifest's own digest (`GateInstanceWire.pendingManifest
 * .digest`): a newer announce replaces the pending manifest, so a confirm can only adopt what the
 * administrator was shown. Workspace Operations already deployed are untouched — each owner aligns
 * them with their own preview and confirm. One platform AuditRecord names what changed.
 */
export const confirmGateManifestHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
) => {
  const input = params as { gateId: string; digest: string };
  const outcome = await confirmPendingManifest(client, input.gateId, input.digest);
  if (outcome.kind === 'not_found') {
    throw new PlatformAdminError('gate_not_found', 'gate instance not found');
  }
  if (outcome.kind === 'nothing_pending') {
    throw new PlatformAdminError(
      'no_pending_manifest',
      `gate instance "${input.gateId}" has no announced manifest awaiting confirmation`,
    );
  }
  if (outcome.kind === 'stale') {
    throw new PlatformAdminError(
      'manifest_changed',
      `gate instance "${input.gateId}" announced a newer manifest since this one was shown — review it again`,
    );
  }
  await writeAudit(client, {
    workspaceId: null,
    actorPrincipalId: null,
    actorUserId: ctx?.platformUser?.id,
    action: 'gate_instance.manifest_confirmed',
    resourceType: 'gate_instance',
    // `audit_records.resource_id` is a uuid; a gate instance is keyed by its `GATE_ID`, so it goes
    // in the payload as `resourceRef` (same convention as `connector.entry_handles_revoked`).
    payload: {
      resourceRef: input.gateId,
      digest: input.digest,
      added: outcome.diff.added.map((operation) => operation.name),
      removed: outcome.diff.removed.map((operation) => operation.name),
      changed: outcome.diff.changed,
    },
  });
  const after = await requireGateInstance(client, input.gateId);
  return {
    result: displayedGateInstance(after),
    resourceType: 'gate_instance',
    resourceId: after.gateId,
  };
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
  const health = await probeGatekeeperHealth(platformGateTarget(instance.endpoint));
  let describedOperationCount: number | null = null;
  if (health === 'ok') {
    try {
      const described = await describeGateOperations(platformGateTarget(instance.endpoint));
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
// P0b (S10 W2; STATUS leftover 118 remainder ①): gates workspaces connected themselves
// -------------------------------------------------------------------------------------------

/** Platform gate instances by endpoint host — the host rule `platformGateIdForEndpoint`
 *  (gate-target.ts) applies per call, read once for a whole list. */
async function catalogGateIdsByHost(client: PoolClient): Promise<ReadonlyMap<string, string>> {
  const result = await client.query<{ gate_id: string; endpoint: string }>(
    "select gate_id, endpoint from gate_instances where endpoint <> '' order by gate_id",
  );
  const byHost = new Map<string, string>();
  for (const row of result.rows) {
    const host = urlHost(row.endpoint);
    if (host !== null && !byHost.has(host)) byHost.set(host, row.gate_id);
  }
  return byHost;
}

/** One row as the platform sees it. The address goes through `redactConnectionAddress` here too,
 *  so a copy core 0045 backfilled before `scrub-raw-secrets` ran never shows a credential (#620
 *  review M2) — the scrub then fixes the row itself. */
function toSelfConnectionWire(
  row: SelfConnectionListRow,
  catalogByHost: ReadonlyMap<string, string>,
): SelfConnectionWire {
  const host = urlHost(row.endpoint);
  return {
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    gatekeeperId: row.gatekeeperObjectId,
    connector: row.connector,
    target: redactConnectionAddress('target', row.target),
    endpoint: redactConnectionAddress('endpoint', row.endpoint),
    connectedByName: row.connectedByName,
    connectedAt: row.connectedAt.toISOString(),
    suspendedAt: row.suspendedAt ? row.suspendedAt.toISOString() : null,
    suspendedByLogin: row.suspendedByLogin,
    suspensionReason: row.suspensionReason,
    catalogGateId: host === null ? null : (catalogByHost.get(host) ?? null),
  };
}

export const listSelfConnectionsHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
) => {
  const input = params as { connector?: string; workspaceId?: string };
  const rows = await listSelfConnections(client, input);
  const catalogByHost = await catalogGateIdsByHost(client);
  return { result: { items: rows.map((row) => toSelfConnectionWire(row, catalogByHost)) } };
};

/**
 * `suspend_self_connection` / `resume_self_connection`: the platform's cut-off for one gate a
 * workspace connected itself. The row is the whole mechanism — every call path reads it through
 * `operationPlatformStatus` (enforcement, the agent's tool list, reachability, queued executions),
 * the same predicate the connector deny list goes through, so nothing else is written here. A
 * change re-issues the workspace's entry-agent Handles (`revokeEntryHandlesInWorkspace`), as a
 * deny-list edit does for linked workspaces: the next Turn's tool projection follows at once.
 * Dispatch writes this call's own platform audit row (params: workspace, Gatekeeper, reason); the
 * Handle re-issue gets its own row, as `set_connector_mode`'s does.
 */
async function setSuspension(
  client: PoolClient,
  input: { workspaceId: string; gatekeeperId: string },
  suspend: { readonly byUserId: string; readonly reason: string | null } | null,
  actorUserId: string | undefined,
): Promise<SelfConnectionWire> {
  const outcome = await setSelfConnectionSuspension(
    client,
    input.workspaceId,
    input.gatekeeperId,
    suspend,
  );
  if (!outcome) {
    throw new PlatformAdminError(
      'self_connection_not_found',
      'no gate that workspace connected itself has that id',
    );
  }
  if (outcome.changed && (await revokeEntryHandlesInWorkspace(client, input.workspaceId))) {
    await writeAudit(client, {
      workspaceId: null,
      actorPrincipalId: null,
      actorUserId,
      action: 'self_connection.entry_handles_revoked',
      resourceType: 'gatekeeper',
      resourceId: input.gatekeeperId,
      payload: { workspaceId: input.workspaceId, suspended: suspend !== null },
    });
  }
  const [row] = await listSelfConnections(client, input);
  if (!row) throw new Error('setSuspension: the self connection vanished inside its transaction');
  return toSelfConnectionWire(row, await catalogGateIdsByHost(client));
}

export const suspendSelfConnectionHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
) => {
  const user = ctx?.platformUser;
  if (!user) throw new Error('suspend_self_connection: invoked outside a platform transaction');
  const input = params as { workspaceId: string; gatekeeperId: string; reason?: string };
  const result = await setSuspension(
    client,
    input,
    { byUserId: user.id, reason: input.reason ?? null },
    user.id,
  );
  return { result, resourceType: 'gatekeeper', resourceId: input.gatekeeperId };
};

export const resumeSelfConnectionHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  ctx,
) => {
  const user = ctx?.platformUser;
  if (!user) throw new Error('resume_self_connection: invoked outside a platform transaction');
  const input = params as { workspaceId: string; gatekeeperId: string };
  const result = await setSuspension(client, input, null, user.id);
  return { result, resourceType: 'gatekeeper', resourceId: input.gatekeeperId };
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
  // Review of #549 (the gate-instance half of legacy 186): the definition is stored as given, sent
  // to the gate host, and shown to every platform administrator and enabling workspace — a
  // credential in its target or manifest source is refused before anything is written. The gate
  // host takes the credential through its own entry (`issue_gate_host_token`), never the kernel.
  assertConnectionParamsCarryNoCredentials('create_gate_instance', {
    target: input.target,
    manifestSource: input.transportKind === 'http' ? input.manifestSource : null,
  });
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
  return {
    result: displayedGateInstance(instance),
    resourceType: 'gate_instance',
    resourceId: instance.gateId,
  };
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
