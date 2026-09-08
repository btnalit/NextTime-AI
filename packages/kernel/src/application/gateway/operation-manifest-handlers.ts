import { OperationSchema } from '@nexttime/shared';
import { z } from 'zod';
import {
  deprecateOperation,
  proposeOperation,
  publishManifest,
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
 *
 * S2.13 addition: `publish_manifest` — the `connection` group's bulk counterpart to
 * `publish_operation` above (design doc §7.5 "owner 发布清单"). Lives here, not
 * connection-handlers.ts, because it is a thin adapter over `governance/gatekeepers`'s own
 * `publishManifest` and touches no `governance/connections` state at all.
 *
 * Draft isolation (review 2026-09, docs/development-tasks.md S2.4 "实现说明补充"): `publish_manifest`
 * publishes only the drafts the gate itself declared (`origin: 'import'`); an agent's
 * `propose_operation` draft is published one at a time through `publish_operation`, whose result
 * carries the draft's full definition so the owner sees exactly what is going live. A proposal
 * over an identity that is not the caller's own draft is `OperationIdentityConflictError` (409).
 * All three rules are enforced in `governance/gatekeepers/manifest.ts`, not here.
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

/** `publish_operation(gatekeeperId, name)` — the result carries the published draft's full
 *  definition (`operation`, plus its `origin` and `proposedBy`), not just `{name, status}`: this
 *  is the only path an agent-proposed draft goes live through, and the owner (or a console
 *  rendering a diff later) must be able to see exactly what was just published. */
export const publishOperationHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { gatekeeperId, name } = params as { gatekeeperId: string; name: string };
  const record = await publishOperation(client, workspaceId, { gatekeeperId, name });
  return {
    result: {
      gatekeeperId: record.gatekeeperId,
      name: record.name,
      status: record.status,
      origin: record.origin ?? null,
      proposedBy: record.proposedBy ?? null,
      operation: record.operation,
    },
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

/** `publish_manifest(gatekeeperId)` — publishes every `origin: 'import'` draft Operation of one
 *  Gatekeeper instance (`governance/gatekeepers`'s `publishManifest`); agent/human proposals stay
 *  drafts and are listed in `skippedDraftOperationNames`. Empty `publishedOperationNames` (no
 *  import drafts to publish) is a successful, not an error, result — the same "nothing to do"
 *  tolerance `deprecateOperation`'s own transition table would otherwise reject one-at-a-time; a
 *  bulk call over zero rows is trivially a no-op. */
export const publishManifestHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { gatekeeperId } = params as { gatekeeperId: string };
  const published = await publishManifest(client, workspaceId, { gatekeeperId });
  return {
    result: {
      gatekeeperId,
      publishedOperationNames: published.publishedOperationNames,
      skippedDraftOperationNames: published.skippedDraftOperationNames,
    },
    resourceType: 'gatekeeper',
    resourceId: gatekeeperId,
  };
};
