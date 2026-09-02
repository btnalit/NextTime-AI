import type { PoolClient } from 'pg';
import type { AuditQueryFilter } from '../../substrate/audit/index.js';
import { queryAudit, reconstruct } from '../../substrate/audit/index.js';
import { explainByNodeId } from '../../substrate/epistemic/index.js';
import type { SearchInput, TraverseInput } from '../../substrate/graph/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';

/**
 * application/gateway/handlers: the real handlers wired for the S1.3 capability set (`get_object`
 * / `traverse` / `search` / `state_at` / `explain` / `audit_query` / `reconstruct` —
 * docs/development-tasks.md S1.3, item 3). Every other registry capability has no entry in
 * `CAPABILITY_HANDLERS` and falls through to dispatch.ts's `CapabilityNotImplementedError`
 * (HTTP 501).
 *
 * Each handler receives an already-open `PoolClient` inside dispatch.ts's `withWorkspace()`
 * transaction (the same one `writeAudit` appends to — I11) and already-`paramsSchema`-validated
 * params (`unknown` here only because `Capability.paramsSchema` is `z.ZodType`, not a per-name
 * generic — dispatch.ts is what ties a name to its schema before calling in).
 */

export interface CapabilityHandlerResult {
  readonly result: unknown;
  readonly resourceType?: string;
  readonly resourceId?: string;
}

export type CapabilityHandler = (
  client: PoolClient,
  workspaceId: string,
  params: unknown,
) => Promise<CapabilityHandlerResult>;

const graphStore = new SqlGraphStore();

const getObjectHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { objectId } = params as { objectId: string };
  const result = await graphStore.getObject(client, workspaceId, objectId);
  return { result, resourceType: 'object', resourceId: objectId };
};

const traverseHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const input = params as TraverseInput;
  const result = await graphStore.traverse(client, workspaceId, input);
  return { result, resourceType: 'object', resourceId: input.fromId };
};

const searchHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const input = params as SearchInput;
  const result = await graphStore.search(client, workspaceId, input);
  return { result };
};

const stateAtHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { objectId, at } = params as { objectId: string; at: string };
  const result = await graphStore.stateAt(client, workspaceId, { objectId, at: new Date(at) });
  return { result, resourceType: 'object', resourceId: objectId };
};

const explainHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { nodeId } = params as { nodeId: string };
  const result = await explainByNodeId(client, workspaceId, nodeId);
  return { result, resourceType: result.nodeType, resourceId: nodeId };
};

/** Picks the recognized `AuditQueryFilter` fields out of the capability's opaque `jsonRecord`. */
function toAuditQueryFilter(filter: Record<string, unknown> | undefined): AuditQueryFilter {
  if (!filter) return {};
  const result: { -readonly [K in keyof AuditQueryFilter]?: AuditQueryFilter[K] } = {};
  if (typeof filter.actorPrincipalId === 'string')
    result.actorPrincipalId = filter.actorPrincipalId;
  if (typeof filter.action === 'string') result.action = filter.action;
  if (typeof filter.resourceType === 'string') result.resourceType = filter.resourceType;
  if (typeof filter.resourceId === 'string') result.resourceId = filter.resourceId;
  if (typeof filter.limit === 'number') result.limit = filter.limit;
  return result;
}

const auditQueryHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { filter } = params as { filter?: Record<string, unknown> };
  const result = await queryAudit(client, workspaceId, toAuditQueryFilter(filter));
  return { result };
};

const reconstructHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { entityId } = params as { entityId: string };
  const result = await reconstruct(client, workspaceId, { objectId: entityId });
  return { result, resourceType: 'object', resourceId: entityId };
};

/** capability name → handler, for every S1.3-wired capability. */
export const CAPABILITY_HANDLERS: ReadonlyMap<string, CapabilityHandler> = new Map([
  ['get_object', getObjectHandler],
  ['traverse', traverseHandler],
  ['search', searchHandler],
  ['state_at', stateAtHandler],
  ['explain', explainHandler],
  ['audit_query', auditQueryHandler],
  ['reconstruct', reconstructHandler],
]);
