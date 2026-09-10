import type { ChatRow } from '../../application/chat/index.js';
import type { QuotaRow } from '../../application/task/index.js';
import type { CapabilityGrantRow } from '../../governance/capability/index.js';
import type { ConnectionRequestRow } from '../../governance/connections/index.js';
import type { PolicyRow } from '../../governance/policy/index.js';
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

export function toWireObject(object: GraphObject) {
  return {
    id: object.id,
    objectType: object.objectType,
    identityKey: object.identityKey,
    properties: object.properties,
    createdAt: object.createdAt.toISOString(),
    updatedAt: object.updatedAt.toISOString(),
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

export function toWirePolicy(row: PolicyRow) {
  return {
    id: row.id,
    actionKindTag: row.actionKind,
    blastRadius: row.blastRadius,
    autoApprove: row.autoApprove,
    requesterCanApprove: row.requesterCanApprove,
    setBy: row.setBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
 * S3.3 addition: `register_source`'s result projection. `SourceRow.metadata.name` (folded in by
 * `application/gateway/ingest-handlers.ts`'s `registerSourceHandler` — `sources` has no `name`
 * column of its own) is surfaced as a top-level `name` field here; `null` when a Source's metadata
 * was never written with one (e.g. a hypothetical future caller that skips this convention).
 */
export function toWireSource(row: SourceRow) {
  const name = typeof row.metadata.name === 'string' ? row.metadata.name : null;
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
    target: row.target,
    requestedBy: row.requestedBy,
    gatekeeperId: row.gatekeeperId,
    completedBy: row.completedBy,
    requestedAt: row.requestedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
