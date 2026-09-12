import type { PoolClient } from 'pg';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import {
  findGateLinkByGate,
  getConnector,
  getGateInstance,
  insertGateLink,
  listAvailableGateInstances,
  operationsOf,
} from '../gates/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/gate-instance-handlers: the workspace half of P-B1 (docs/platform-admin-
 * design.md §6.3 "平台预置（管理员建实例、工作区一键启用）"; development-tasks.md P-B 决定 ①) —
 * `list_available_gate_instances` / `enable_gate_instance`, `scope:'workspace'`, owner.
 *
 * Enabling mirrors `cli/bootstrap.ts`'s `register-gatekeeper --publish` step for step — one
 * Activity, `registerGatekeeper`, `importManifest` (origin `import`), `publishOperation` for every
 * imported draft, `ConnectionCreated` — and then writes the `workspace_gate_links` row that lets
 * the approval decision read the instance's `trust` and the connector's deny list live. It runs on
 * the workspace plane on purpose: `registerGatekeeper` and the Activity need a real Principal,
 * which the platform plane does not have; an administrator who is not a member delegates first.
 * Idempotent per (workspace, gate): a second call returns the existing Gatekeeper.
 */

export class GateInstanceNotAvailableError extends Error {
  readonly code: 'gate_not_found' | 'gate_not_enabled' | 'connector_not_preset';
  constructor(code: GateInstanceNotAvailableError['code'], message: string) {
    super(message);
    this.name = 'GateInstanceNotAvailableError';
    this.code = code;
  }
}

export const listAvailableGateInstancesHandler: CapabilityHandler = async (client, workspaceId) => {
  return { result: { items: await listAvailableGateInstances(client, workspaceId) } };
};

async function requireAvailable(client: PoolClient, gateId: string) {
  const instance = await getGateInstance(client, gateId);
  if (!instance)
    throw new GateInstanceNotAvailableError('gate_not_found', 'gate instance not found');
  const connector = await getConnector(client, instance.connector);
  if (!connector || connector.mode !== 'platform_preset') {
    throw new GateInstanceNotAvailableError(
      'connector_not_preset',
      `connector "${instance.connector}" is not in platform-preset mode`,
    );
  }
  if (instance.status !== 'enabled') {
    throw new GateInstanceNotAvailableError(
      'gate_not_enabled',
      `gate instance "${gateId}" is ${instance.status}, not enabled by the administrator`,
    );
  }
  return instance;
}

export const enableGateInstanceHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  if (!ctx?.principal) {
    throw new Error('enable_gate_instance: no resolved human principal in context');
  }
  const { gateId } = params as { gateId: string };
  const existing = await findGateLinkByGate(client, workspaceId, gateId);
  if (existing) {
    return {
      result: {
        gateId,
        gatekeeperId: existing.gatekeeperObjectId,
        publishedOperationNames: [],
        skippedOperationNames: [],
      },
      resourceType: 'gatekeeper',
      resourceId: existing.gatekeeperObjectId,
    };
  }
  const instance = await requireAvailable(client, gateId);
  const actor = { id: ctx.principal.id, kind: ctx.principal.kind };

  const activity = await startActivity(client, workspaceId, {
    kind: 'governance.enable_gate_instance',
    principalId: actor.id,
    metadata: { gateId },
  });
  const { gatekeeperId } = await registerGatekeeper(client, workspaceId, {
    name: instance.displayName,
    transportKind: instance.transportKind,
    target: instance.target || instance.displayName,
    endpoint: instance.endpoint,
    activityId: activity.id,
    registeredBy: actor,
  });
  const operations = operationsOf(await rawOperations(client, gateId));
  const imported = await importManifest(client, workspaceId, {
    gatekeeperId,
    operations,
    proposedBy: actor,
    activityId: activity.id,
  });
  const publishedOperationNames: string[] = [];
  for (const record of imported.imported) {
    await publishOperation(client, workspaceId, { gatekeeperId, name: record.name });
    publishedOperationNames.push(record.name);
  }
  await endActivity(client, workspaceId, activity.id, 'completed');
  await insertGateLink(client, {
    workspaceId,
    gateId,
    gatekeeperObjectId: gatekeeperId,
    enabledBy: actor.id,
  });
  await enqueue(client, {
    type: 'ConnectionCreated',
    workspaceId,
    gatekeeperId,
    kind: instance.transportKind,
    target: instance.target || instance.displayName,
  });
  return {
    result: {
      gateId,
      gatekeeperId,
      publishedOperationNames,
      skippedOperationNames: imported.skipped.map((entry) => entry.name),
    },
    resourceType: 'gatekeeper',
    resourceId: gatekeeperId,
  };
};

/** The announced manifest as stored (`gate_instances.operations`), not the wire projection. */
async function rawOperations(client: PoolClient, gateId: string): Promise<unknown> {
  const result = await client.query<{ operations: unknown }>(
    'select operations from gate_instances where gate_id = $1',
    [gateId],
  );
  return result.rows[0]?.operations ?? [];
}
