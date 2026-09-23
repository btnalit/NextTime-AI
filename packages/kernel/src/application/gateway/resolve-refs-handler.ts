import { GATEKEEPER_GRANT_CAPABILITY } from '../../governance/capability/index.js';
import { SqlGraphStore, objectDisplayName } from '../../substrate/graph/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/resolve-refs-handler: `resolve_refs` (S8 W1-C, leftover 48 "无批量 Object
 * 读"; ui-audit-2026-09-23 J8/S10/O1). One bounded query per reference kind — never per id, never
 * N `get_object` round trips.
 *
 * **Visibility, per kind (the "never leak existence across visibility" requirement)**:
 *   - `object`/`gatekeeper` — the `objects` table's own workspace-RLS boundary, same as
 *     `get_object`/`list_gatekeepers` (both `minRole:'member'`, no per-row narrowing beyond the
 *     workspace itself).
 *   - `principal` — `displayName` only (never `role`/`hasApiKey`/`disabledAt` — the fields
 *     `list_principals`, `minRole:'operator'`, actually gates), available at this capability's own
 *     `minRole:'member'` floor: the same tier `explain` (member) already surfaces a Fact/Decision's
 *     `assertedBy`/actor principal id at, and the provenance pages built on it
 *     (`ExplainSection.tsx`) already render a `RefChip kind="principal"` a plain member cannot
 *     currently name (`list_principals` 403s for them — `useDirectoryNames.tsx`'s own
 *     `isDenied('list_principals')` fallback). A deliberate, narrower-than-`list_principals`
 *     design choice — flagged in this task's own PR body for a second look, not a silent
 *     assumption.
 *   - `workerDefinition` — `list_worker_definitions`'s own `minRole:'member'` boundary; no
 *     narrower here either (a published WorkerDefinition's name/kind is not itself sensitive).
 *   - `actionRequest` — the one kind with a real, sub-workspace visibility rule (I14): the exact
 *     same "owner sees every row; any other role only rows whose action_kind/resource_scope
 *     matches one of their own active capability_grants" predicate
 *     `governance/approval/reads.ts`'s `listActionRequestsForApprover`/`listPendingForApprover`
 *     already enforce, inlined into this kind's one query (never a per-row second query — that
 *     would violate "one query per kind, not per id" for up to 200 ids) so an ActionRequest a
 *     caller could not otherwise see is simply absent, never a name leak.
 */

const graphStore = new SqlGraphStore();

interface ResolvedRef {
  readonly id: string;
  readonly kind: 'object' | 'principal' | 'gatekeeper' | 'workerDefinition' | 'actionRequest';
  readonly name?: string;
  readonly typeName?: string;
}

export const resolveRefsHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  if (!ctx?.principal) {
    throw new Error(
      'resolve_refs: no resolved human principal in context (this capability is channel:"human"-only)',
    );
  }
  const { ids } = params as { ids: readonly string[] };
  const uniqueIds = [...new Set(ids)];
  const resolved: ResolvedRef[] = [];

  // -----------------------------------------------------------------------------------------
  // object / gatekeeper — one batched read over `objects` covers both (a Gatekeeper is a typed
  // Object, `governance/gatekeepers/registry.ts`'s own module doc comment).
  // -----------------------------------------------------------------------------------------
  const objectsById = await graphStore.getObjectsByIds(client, workspaceId, uniqueIds);
  for (const object of objectsById.values()) {
    resolved.push({
      id: object.id,
      kind: object.objectType === 'Gatekeeper' ? 'gatekeeper' : 'object',
      name: objectDisplayName(object),
      typeName: object.objectType,
    });
  }

  // -----------------------------------------------------------------------------------------
  // principal — displayName only (see this module's own doc comment on why this is narrower
  // than `list_principals`).
  // -----------------------------------------------------------------------------------------
  const principalsResult = await client.query<{
    id: string;
    kind: string;
    display_name: string | null;
  }>(
    'select id, kind, display_name from principals where workspace_id = $1 and id = any($2::uuid[])',
    [workspaceId, uniqueIds],
  );
  for (const row of principalsResult.rows) {
    resolved.push({
      id: row.id,
      kind: 'principal',
      ...(row.display_name ? { name: row.display_name } : {}),
      typeName: row.kind,
    });
  }

  // -----------------------------------------------------------------------------------------
  // workerDefinition — latest version per id (a WorkerDefinition id names a family across
  // versions, `application/worker/definitions.ts`); any status, not published-only — an id
  // referenced from somewhere the caller can already see (a Task, an audit row) should resolve to
  // a name even if the definition was since deprecated.
  // -----------------------------------------------------------------------------------------
  const definitionsResult = await client.query<{
    id: string;
    kind: string;
    definition: Record<string, unknown>;
  }>(
    `select distinct on (id) id, kind, definition from worker_definitions
     where workspace_id = $1 and id = any($2::uuid[])
     order by id, version desc`,
    [workspaceId, uniqueIds],
  );
  for (const row of definitionsResult.rows) {
    const name = row.definition.name;
    resolved.push({
      id: row.id,
      kind: 'workerDefinition',
      ...(typeof name === 'string' && name !== '' ? { name } : {}),
      typeName: row.kind,
    });
  }

  // -----------------------------------------------------------------------------------------
  // actionRequest — I14-filtered in the same query (see this module's own doc comment).
  // -----------------------------------------------------------------------------------------
  const isOwner = ctx.principal.role === 'owner';
  const actionRequestsResult = await client.query<{ id: string; action_kind: string }>(
    `select ar.id, ar.action_kind from action_requests ar
     where ar.workspace_id = $1
       and ar.id = any($2::uuid[])
       and (
         $3::boolean
         or exists (
           select 1 from capability_grants cg
           where cg.workspace_id = ar.workspace_id
             and cg.principal_id = $4
             and cg.status = 'active'
             and (cg.expires_at is null or cg.expires_at > now())
             and (
               (cg.resource_type = ar.action_kind
                and (cg.resource_id is null or cg.resource_id::text = ar.resource_scope))
               or (
                 ar.resource_scope is not null
                 and cg.resource_type = '${GATEKEEPER_GRANT_CAPABILITY}'
                 and (cg.resource_id is null or cg.resource_id::text = ar.resource_scope)
               )
             )
         )
       )`,
    [workspaceId, uniqueIds, isOwner, ctx.principal.id],
  );
  for (const row of actionRequestsResult.rows) {
    resolved.push({ id: row.id, kind: 'actionRequest', name: row.action_kind });
  }

  return { result: { items: resolved } };
};
