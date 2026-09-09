import {
  type OntologyTypeEntry,
  type OntologyVersionRow,
  getType,
  listTypes,
  proposeOntologyChange,
  publishOntologyDraft,
  validateLink,
} from '../../substrate/ontology/index.js';
import { currentPrincipalId } from '../chat/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/ontology-handlers: the five `ontology`-group capabilities (docs/development-
 * tasks.md S3.1 — `get_type` / `list_types` / `validate` / `propose_ontology_change` /
 * `publish_ontology_version`) — thin projections over `substrate/ontology/registry.ts`'s actual
 * logic, following the same shape every other `*-handlers.ts` file in this directory already uses
 * (`agent-profile-handlers.ts`'s own module doc comment: "capability-handler projection... over
 * that module's own row/effective-value source of truth").
 *
 * `ctx?.principalId ?? (await currentPrincipalId(client))` on every handler mirrors
 * `skill-procedure-handlers.ts`'s own fallback (dispatch.ts always passes `ctx` for a real
 * capability call; the fallback only matters for a unit test invoking a handler function
 * directly). `get_type`/`list_types`/`validate` are `channel:'handle'` with no `minRole` — every
 * authenticated caller may read the currently-visible ontology; `propose_ontology_change` is
 * `channel:'handle'`, `minRole:'builder'` (enforced by `authorizeCapabilityCall` before this file
 * ever runs); `publish_ontology_version` is `channel:'human'`-only (I16, same enforcement point).
 * Neither this file nor `registry.ts` re-checks channel/role — that is `authorize.ts`'s job, not a
 * handler's (same division of responsibility every other handler in this directory already
 * follows).
 */

function toWireOntologyType(entry: OntologyTypeEntry) {
  if (entry.kind === 'object') {
    return {
      kind: 'object' as const,
      name: entry.name,
      description: entry.description,
      identityKey: entry.identityKey,
    };
  }
  if (entry.kind === 'link') {
    return { kind: 'link' as const, name: entry.name, signatures: entry.signatures };
  }
  return {
    kind: 'action' as const,
    name: entry.name,
    description: entry.description,
    mode: entry.mode,
    blastRadius: entry.blastRadius,
    reversibility: entry.reversibility,
    autoApprovable: entry.autoApprovable,
    awaitDecision: entry.awaitDecision,
    requesterCanApprove: entry.requesterCanApprove,
  };
}

function toWireOntologyProposeResult(row: OntologyVersionRow) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    proposedBy: row.proposedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWireOntologyPublishResult(row: OntologyVersionRow) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

export const getTypeHandler: CapabilityHandler = async (client, workspaceId, rawParams, ctx) => {
  const { typeName } = rawParams as { typeName: string };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const type = await getType(client, workspaceId, principalId, typeName);
  return {
    result: type ? toWireOntologyType(type) : null,
    resourceType: 'ontology_type',
    resourceId: typeName,
  };
};

export const listTypesHandler: CapabilityHandler = async (client, workspaceId, rawParams, ctx) => {
  const { kind } = rawParams as { kind?: 'object' | 'link' | 'action' };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const types = await listTypes(client, workspaceId, principalId, kind);
  return { result: { items: types.map(toWireOntologyType) } };
};

export const validateHandler: CapabilityHandler = async (client, workspaceId, rawParams, ctx) => {
  const { link } = rawParams as {
    link: { linkType: string; sourceType: string; targetType: string };
  };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const result = await validateLink(client, workspaceId, principalId, link);
  return { result };
};

export const proposeOntologyChangeHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  const { id, change } = rawParams as { id?: string; change: unknown };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const row = await proposeOntologyChange(client, workspaceId, {
    id,
    change,
    proposedBy: principalId,
  });
  return {
    result: toWireOntologyProposeResult(row),
    resourceType: 'ontology_version',
    resourceId: row.id,
  };
};

export const publishOntologyVersionHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  const { id, version } = rawParams as { id: string; version: number };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const row = await publishOntologyDraft(client, workspaceId, {
    id,
    version,
    publishedBy: principalId,
  });
  return {
    result: toWireOntologyPublishResult(row),
    resourceType: 'ontology_version',
    resourceId: row.id,
  };
};
