import type { ChatRow } from '../../application/chat/index.js';
import type { QuotaRow } from '../../application/task/index.js';
import type { CapabilityGrantRow } from '../../governance/capability/index.js';
import {
  type ConnectionRequestRow,
  redactConnectionAddress,
} from '../../governance/connections/index.js';
import type { AutoApproveConsent, PolicyRow } from '../../governance/policy/index.js';
import type { AuditRecordRow } from '../../substrate/audit/index.js';
import type { SourceRow } from '../../substrate/epistemic/index.js';
import type { Fact, GraphObject } from '../../substrate/graph/index.js';

/**
 * application/gateway/resource-wire: the wire-projection functions for every resource whose own
 * DB-row-shaped type (`substrate/graph/store.ts`'s `GraphObject`/`Fact`, `substrate/audit/
 * writer.ts`'s `AuditRecordRow`, `application/chat/service.ts`'s `ChatRow`,
 * `governance/capability/grants.ts`'s `CapabilityGrantRow`, `governance/policy/policies.ts`'s
 * `PolicyRow`, `application/task/quotas.ts`'s `QuotaRow`, `governance/connections/types.ts`'s
 * `ConnectionRequestRow`) carries a real `Date` — S3.7 wire fix (docs/wire-contract-conventions.md
 * §1 "`*At` 一律 ISO 8601 UTC 字符串"): before this file, `get_object`/`search`/`state_at`/
 * `get_entry_context`/`find_operations`/`audit_query`/`reconstruct`/`list_chats`/`new_chat`/
 * `list_grants`/`grant_capability`/`revoke_capability`/`connect_gatekeeper`/`list_policies`/
 * `set_policy`/`set_auto_approved_action_kind`/`set_quota`/`list_connection_requests` each handed
 * `dispatchCapability` the raw internal row object, `Date` fields and all — never visible as a
 * real behavior difference on the actual wire (`JSON.stringify` already turns a `Date` into an ISO
 * string), but a real inconsistency against every other handler in this file's sibling
 * `action-request-wire.ts`/`toWireTask`/`toWireWorkerDefinition`/... convention, and one this
 * task's own `resultSchema`/`KERNEL_VALIDATE_RESULTS` machinery needs a single, honest shape to
 * validate against. One function per resource, application layer, same convention as
 * `action-request-wire.ts` — reused by every handler that returns that resource.
 *
 * `toWirePolicy` additionally renames `PolicyRow.actionKind` (bare string, matches the
 * `policies.action_kind` DB column — used pervasively that way inside `governance/policy`/
 * `governance/approval`, unaffected) to `actionKindTag` at this wire boundary only — §1's
 * vocabulary table reserves bare `actionKind` for the `{tag,label}` ActionDescription display
 * object (`packages/shared/src/wire/governance.ts`'s `PolicyWireSchema` has the fuller note).
 */

/** The address properties of the Object types the kernel writes for a connection: where a gate is
 *  reached. Every read shows them through `redactConnectionAddress` (#620 review M2), the rule
 *  every other display of a gate address uses — one written before legacy 186 can still carry a
 *  credential (`scrub-raw-secrets` counts it for its owner, `gatekeeperAddresses`). The stored
 *  value is untouched: the gate is called at it. */
const ADDRESS_PROPERTIES: Readonly<Record<string, readonly ('target' | 'endpoint')[]>> = {
  Gatekeeper: ['target', 'endpoint'],
  ConnectedSystem: ['target'],
};

function displayedProperties(object: GraphObject): GraphObject['properties'] {
  const fields = ADDRESS_PROPERTIES[object.objectType];
  if (!fields) return object.properties;
  const shown: Record<string, unknown> = { ...object.properties };
  for (const field of fields) {
    const value = shown[field];
    if (typeof value === 'string') shown[field] = redactConnectionAddress(field, value);
  }
  return shown;
}

export function toWireObject(object: GraphObject) {
  return {
    id: object.id,
    objectType: object.objectType,
    identityKey: object.identityKey,
    properties: displayedProperties(object),
    createdAt: object.createdAt.toISOString(),
    updatedAt: object.updatedAt.toISOString(),
    lastObservedAt: object.lastObservedAt ? object.lastObservedAt.toISOString() : null,
  };
}

export function toWireFact(fact: Fact) {
  return {
    id: fact.id,
    linkType: fact.linkType,
    sourceObjectId: fact.sourceObjectId,
    targetObjectId: fact.targetObjectId,
    properties: fact.properties,
    validFrom: fact.validFrom.toISOString(),
    validUntil: fact.validUntil ? fact.validUntil.toISOString() : null,
    recordedAt: fact.recordedAt.toISOString(),
    supersededAt: fact.supersededAt ? fact.supersededAt.toISOString() : null,
    invalidatedAt: fact.invalidatedAt ? fact.invalidatedAt.toISOString() : null,
    invalidationReason: fact.invalidationReason,
    supersedesId: fact.supersedesId,
    epistemicStatus: fact.epistemicStatus,
    confidence: fact.confidence,
    activityId: fact.activityId,
    assertedBy: fact.assertedBy,
    verifiedBy: fact.verifiedBy,
    observationId: fact.observationId,
    lastObservationId: fact.lastObservationId,
    lastObservedAt: fact.lastObservedAt ? fact.lastObservedAt.toISOString() : null,
  };
}

export function toWireAuditRecord(row: AuditRecordRow) {
  return {
    id: row.id,
    actorPrincipalId: row.actorPrincipalId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toWireChat(row: ChatRow) {
  return {
    id: row.id,
    ownerPrincipalId: row.ownerPrincipalId,
    title: row.title,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
    // S6-A chat lifecycle (wire/chat.ts `ChatWireSchema.archivedAt`): null = active.
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    // S8 W4 (audit C1, wire/chat.ts `ChatWireSchema.lastActivityAt`/`hasRunningTurn`).
    lastActivityAt: row.lastActivityAt.toISOString(),
    hasRunningTurn: row.hasRunningTurn,
  };
}

export function toWireGrant(row: CapabilityGrantRow) {
  return {
    id: row.id,
    principalId: row.principalId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    scope: row.scope,
    status: row.status,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

/** `inForce` (legacy 218): the version published on the rule's gate now, and whether an "always
 *  allow" rule was given for it — computed by the handler, which reads the Operation. */
export function toWirePolicy(
  row: PolicyRow,
  inForce: {
    readonly publishedOperationVersion: number | null;
    readonly autoApproveConsent: AutoApproveConsent;
  },
) {
  return {
    id: row.id,
    gatekeeperId: row.gatekeeperId,
    actionKindTag: row.actionKind,
    blastRadius: row.blastRadius,
    autoApprove: row.autoApprove,
    requesterCanApprove: row.requesterCanApprove,
    setBy: row.setBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    operationVersion: row.operationVersion,
    publishedOperationVersion: inForce.publishedOperationVersion,
    autoApproveConsent: inForce.autoApproveConsent,
  };
}

export function toWireQuota(row: QuotaRow) {
  return {
    key: row.key,
    value: row.value,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * S3.3 addition: `register_source`'s result projection. `name` is the `sources.name` column since
 * S5.3 (migration core 0028); a pre-0028 row whose name was left null by the backfill (a duplicate
 * within its kind) still projects the `metadata.name` it was written with, so nothing a caller
 * could read before disappears; `null` only when neither exists.
 */
export function toWireSource(row: SourceRow) {
  const name = row.name ?? (typeof row.metadata.name === 'string' ? row.metadata.name : null);
  return {
    id: row.id,
    kind: row.kind,
    name,
    ownerPrincipalId: row.ownerPrincipalId,
    visibility: row.visibility,
    uri: row.uri,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toWireConnectionRequest(row: ConnectionRequestRow) {
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    // Shown as every gate address is (`redactConnectionAddress`): a request from before legacy 186
    // can still carry a credential (`scrub-raw-secrets` counts it, `connectionTargets`).
    target: redactConnectionAddress('target', row.target),
    requestedBy: row.requestedBy,
    gatekeeperId: row.gatekeeperId,
    completedBy: row.completedBy,
    requestedAt: row.requestedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
