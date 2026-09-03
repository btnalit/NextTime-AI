import { OperationSchema } from '@nexttime/shared';
import { z } from 'zod';
import {
  deprecateOperation,
  proposeOperation,
  publishOperation,
} from '../../governance/gatekeepers/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { currentPrincipalId } from '../chat/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/operation-manifest-handlers: `propose_operation` (Handle channel, drafts
 * only — I16) and `publish_operation`/`deprecate_operation` (human channel, this task's own
 * addition to `packages/shared/src/capabilities.ts`, in the same style as `publish_skill`/
 * `deprecate_skill`) — design doc §5.1.4 Operation, §5.4 I16/I17; docs/development-tasks.md S2.4
 * "propose_operation 产草稿，owner 发布".
 */

const ProposeOperationParamsSchema = z.object({
  gatekeeperId: z.string().min(1),
  operation: z.unknown(),
});

export const proposeOperationHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { gatekeeperId, operation: rawOperation } = ProposeOperationParamsSchema.parse(params);
  const operation = OperationSchema.parse(rawOperation);
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  // propose_operation is a `channel:'handle'` capability (packages/shared/src/capabilities.ts) —
  // its normal caller is an agent/Worker session, but `authorizeCapabilityCall` also permits a
  // human caller (§9.3 "human 通道调用同样允许"); derive the CallerPrincipal kind `assertFact`'s
  // epistemic-status derivation needs (substrate/graph/store.ts) from the actual channel used
  // rather than assuming 'agent' unconditionally.
  const proposerKind = ctx?.channel === 'human' ? 'human' : 'agent';

  const activity = await startActivity(client, workspaceId, {
    kind: 'operation_proposal',
    principalId,
    metadata: { gatekeeperId, operation: operation.name },
  });

  const record = await proposeOperation(client, workspaceId, {
    gatekeeperId,
    operation,
    proposedBy: { id: principalId, kind: proposerKind },
    activityId: activity.id,
  });
  await endActivity(client, workspaceId, activity.id, 'completed');

  return {
    result: { gatekeeperId: record.gatekeeperId, name: record.name, status: record.status },
    resourceType: 'operation',
    resourceId: `${record.gatekeeperId}:${record.name}`,
  };
};

export const publishOperationHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { gatekeeperId, name } = params as { gatekeeperId: string; name: string };
  const record = await publishOperation(client, workspaceId, { gatekeeperId, name });
  return {
    result: { gatekeeperId: record.gatekeeperId, name: record.name, status: record.status },
    resourceType: 'operation',
    resourceId: `${record.gatekeeperId}:${record.name}`,
  };
};

export const deprecateOperationHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { gatekeeperId, name } = params as { gatekeeperId: string; name: string };
  const record = await deprecateOperation(client, workspaceId, { gatekeeperId, name });
  return {
    result: { gatekeeperId: record.gatekeeperId, name: record.name, status: record.status },
    resourceType: 'operation',
    resourceId: `${record.gatekeeperId}:${record.name}`,
  };
};
