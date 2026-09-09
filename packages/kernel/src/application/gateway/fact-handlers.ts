import type { CapabilityChannel } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { currentPrincipalId } from '../chat/index.js';
import type { CapabilityHandler } from './capability-handler.js';
import { assertMetaOntologyHandleWriteAllowed } from './meta-ontology-guard.js';
import { toWireFact } from './resource-wire.js';

/**
 * application/gateway/fact-handlers: `assert_fact` / `supersede_fact` / `invalidate_fact` — thin
 * wrappers over `substrate/graph`'s `GraphStore.assertFact`/`supersedeFact`/`invalidateFact` (S3.3
 * dispatch: "replace the AssertFactWriteNotImplementedError stub with a real write through the
 * graph store — single Fact, honours I4 and the caller's epistemic derivation"; "thin wrappers
 * over the store with the existing lifecycle rules").
 *
 * Deliberately thin: this file does no deduplication, no same-edge lookup, no conflict reasoning
 * of its own — every call maps 1:1 onto exactly one `GraphStore` write, whatever that store's own
 * current behavior is (today: always inserts; S3.2, landing in parallel, is expected to extend
 * `assertFact`/`supersedeFact` themselves with same-source/cross-source semantics — this file does
 * not anticipate or duplicate that). The one caller-side batching/idempotency policy this task
 * does add (same-source supersede-or-noop across repeated collector runs) lives in
 * `ingest-handlers.ts`'s `submit_observations` only, which has a real reason to need it (a
 * collector re-submitting the same structural fact on every run) — a single ad-hoc `assert_fact`
 * call has no such repetition to guard against, so it always writes exactly what it is asked to
 * write.
 *
 * I16 (meta-ontology guard, S2.6): preserved unchanged from the old stub — a Handle-channel caller
 * naming a meta-ontology ObjectType (`WorkerDefinition`/`Gatekeeper`/`Operation`/`Capability`/
 * `Skill`/`Procedure`) as either endpoint is rejected before any write, exactly as before this
 * task. Applied to `assert_fact`/`supersede_fact` (both now have real source/target object ids to
 * check); deliberately **not** applied to `invalidate_fact` — invalidating an existing Fact does
 * not create a new relationship naming a meta-ontology object the way asserting/superseding one
 * does, and doing so would need an extra read of the Fact's own endpoints this "thin wrapper"
 * shape does not otherwise need (known, narrow scope limit — see docs/runbooks/host-collector.md's
 * own note, if this ever needs closing).
 */

const graphStore = new SqlGraphStore();

interface AssertFactParams {
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly linkType: string;
  readonly properties?: Record<string, unknown>;
  readonly activityId?: string;
  readonly validFrom?: string;
  readonly validUntil?: string | null;
  readonly confidence?: number;
}

interface SupersedeFactParams extends AssertFactParams {
  readonly factId: string;
}

/** Runs `assertMetaOntologyHandleWriteAllowed` against every referenced Object that actually
 *  exists (an id naming no Object is not this guard's concern — the store's own FK constraint on
 *  `source_object_id`/`target_object_id` will reject it). */
async function guardReferencedObjectTypes(
  client: PoolClient,
  workspaceId: string,
  channel: CapabilityChannel,
  objectIds: readonly string[],
): Promise<void> {
  for (const objectId of objectIds) {
    const object = await graphStore.getObject(client, workspaceId, objectId);
    if (object) assertMetaOntologyHandleWriteAllowed(channel, object.objectType);
  }
}

/** Resolves the Activity a single ad-hoc Fact write traces to (I3) — the caller's own
 *  `activityId` when given (its lifecycle stays the caller's to manage), or a fresh one this
 *  function starts and ends around just this one write. Returns `null` for `ownActivityId` when
 *  the caller supplied one, so the handler knows not to call `endActivity` on it. */
async function resolveWriteActivity(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  kind: string,
  given: string | undefined,
): Promise<{ readonly activityId: string; readonly ownActivityId: string | null }> {
  if (given) return { activityId: given, ownActivityId: null };
  const activity = await startActivity(client, workspaceId, { kind, principalId });
  return { activityId: activity.id, ownActivityId: activity.id };
}

function toDateOrUndefined(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

function toValidUntil(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Date(value);
}

export const assertFactHandler: CapabilityHandler = async (client, workspaceId, rawParams, ctx) => {
  const params = rawParams as AssertFactParams;
  const channel: CapabilityChannel = ctx?.channel ?? 'handle';
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  await guardReferencedObjectTypes(client, workspaceId, channel, [
    params.sourceObjectId,
    params.targetObjectId,
  ]);

  const { activityId, ownActivityId } = await resolveWriteActivity(
    client,
    workspaceId,
    principalId,
    'meta.assert_fact',
    params.activityId,
  );

  const fact = await graphStore.assertFact(
    client,
    workspaceId,
    { id: principalId },
    {
      linkType: params.linkType,
      sourceObjectId: params.sourceObjectId,
      targetObjectId: params.targetObjectId,
      activityId,
      properties: params.properties,
      validFrom: toDateOrUndefined(params.validFrom),
      validUntil: toValidUntil(params.validUntil),
      confidence: params.confidence,
    },
  );

  if (ownActivityId) await endActivity(client, workspaceId, ownActivityId, 'completed');

  return { result: toWireFact(fact), resourceType: 'fact', resourceId: fact.id };
};

export const supersedeFactHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  const params = rawParams as SupersedeFactParams;
  const channel: CapabilityChannel = ctx?.channel ?? 'handle';
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  await guardReferencedObjectTypes(client, workspaceId, channel, [
    params.sourceObjectId,
    params.targetObjectId,
  ]);

  const { activityId, ownActivityId } = await resolveWriteActivity(
    client,
    workspaceId,
    principalId,
    'meta.supersede_fact',
    params.activityId,
  );

  const fact = await graphStore.supersedeFact(
    client,
    workspaceId,
    { id: principalId },
    {
      factId: params.factId,
      linkType: params.linkType,
      sourceObjectId: params.sourceObjectId,
      targetObjectId: params.targetObjectId,
      activityId,
      properties: params.properties,
      validFrom: toDateOrUndefined(params.validFrom),
      validUntil: toValidUntil(params.validUntil),
      confidence: params.confidence,
    },
  );

  if (ownActivityId) await endActivity(client, workspaceId, ownActivityId, 'completed');

  return { result: toWireFact(fact), resourceType: 'fact', resourceId: fact.id };
};

export const invalidateFactHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  const { factId, reason } = rawParams as { factId: string; reason?: string };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  const fact = await graphStore.invalidateFact(
    client,
    workspaceId,
    { id: principalId },
    { factId, reason },
  );

  return { result: toWireFact(fact), resourceType: 'fact', resourceId: fact.id };
};
