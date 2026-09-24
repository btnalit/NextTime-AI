import { GATEKEEPER_GRANT_CAPABILITY } from '../../governance/capability/index.js';
import { SqlGraphStore, objectDisplayName } from '../../substrate/graph/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/resolve-refs-handler: `resolve_refs` (S8 W1-C, leftover 48 "无批量 Object
 * 读"; ui-audit-2026-09-23 J8/S10/O1). One bounded query per reference kind — never per id, never
 * N `get_object` round trips. S8 W1-A6 (audit S10, kit `RefChip`) added the `operation`/`task`/
 * `chat`/`workspace` kinds below the original five.
 *
 * **Visibility, per kind (the "never leak existence across visibility" requirement)**:
 *   - `object`/`gatekeeper`/`operation` — the `objects` table's own workspace-RLS boundary, same
 *     as `get_object`/`list_gatekeepers`/`list_operations` (all `minRole:'member'`, no per-row
 *     narrowing beyond the workspace itself). `operation` and `gatekeeper` are both typed graph
 *     Objects (`governance/gatekeepers/registry.ts`/`manifest.ts`'s own module doc comments) —
 *     one query already covers all three, split back out by `objectType` after the fact.
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
 *   - `task` — `tasks`' own RLS (`tasks_workspace_isolation`, migrations/task/0001_tasks.sql) is
 *     workspace-only, with no additional owner-narrowing rule on file for the table itself (that
 *     migration's own comment: "no visibility rule for Task is spelled out... a stricter,
 *     owner-only policy can be layered on later"); `list_tasks`'s "the caller's own Tasks" is a
 *     narrowing specific to *that* capability's "browse my own Tasks" purpose, not a general Task
 *     visibility rule — same reasoning as `workerDefinition` above (no narrower here either, a
 *     Task's existence/definition is not itself sensitive within the workspace). `name` is the
 *     Task's own WorkerDefinition's name (a Task has no name of its own), joined by the exact
 *     `(workspace_id, id, version)` identity `tasks.worker_definition_id`/`worker_definition_version`
 *     already carry.
 *   - `chat` — relies on RLS doing the real work: this handler's `client` runs inside
 *     `dispatch.ts`'s `withWorkspace` role-switch, so `chats_visibility`
 *     (migrations/core/0003_chat.sql: `visibility = 'workspace' OR owner_principal_id =
 *     app_principal()`) is already enforced by Postgres on the plain `select` below — a private
 *     chat belonging to someone else is simply absent from the result set, never a second
 *     application-level check.
 *   - `workspace` — the one kind with no RLS at all to lean on (`workspaces` deliberately has
 *     none, migrations/core/0001_identity.sql's own comment) and the one where this capability's
 *     own `workspaceId` argument is *always* the caller's current workspace — so "the caller's own
 *     workspace" only ever needs `id === workspaceId`, no query required; a platform administrator
 *     (`ctx.consoleUser?.platformRole === 'admin'` — S4.1 console-session login, threaded by
 *     `dispatch.ts`) additionally sees any other workspace by id, the same authority
 *     `list_workspaces` (`scope:'platform'`) already grants them. The id filter runs before the
 *     query, not after: a non-admin's query never even asks about another workspace's id.
 */

const graphStore = new SqlGraphStore();

type ResolvedRefKind =
  | 'object'
  | 'principal'
  | 'gatekeeper'
  | 'operation'
  | 'workerDefinition'
  | 'actionRequest'
  | 'task'
  | 'chat'
  | 'workspace';

interface ResolvedRef {
  readonly id: string;
  readonly kind: ResolvedRefKind;
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
  // object / gatekeeper / operation — one batched read over `objects` covers all three (both
  // Gatekeeper and Operation are typed Objects, `governance/gatekeepers/registry.ts`/
  // `manifest.ts`'s own module doc comments).
  // -----------------------------------------------------------------------------------------
  const objectsById = await graphStore.getObjectsByIds(client, workspaceId, uniqueIds);
  for (const object of objectsById.values()) {
    const kind: ResolvedRefKind =
      object.objectType === 'Gatekeeper'
        ? 'gatekeeper'
        : object.objectType === 'Operation'
          ? 'operation'
          : 'object';
    resolved.push({
      id: object.id,
      kind,
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

  // -----------------------------------------------------------------------------------------
  // task — workspace-wide (see this module's own doc comment); `name` is the Task's own
  // WorkerDefinition's name, joined on the exact (workspace_id, id, version) identity `tasks`
  // already carries — a Task has no name of its own.
  // -----------------------------------------------------------------------------------------
  const tasksResult = await client.query<{ id: string; name: string | null }>(
    `select t.id, wd.definition ->> 'name' as name
     from tasks t
     left join worker_definitions wd
       on wd.workspace_id = t.workspace_id
       and wd.id = t.worker_definition_id
       and wd.version = t.worker_definition_version
     where t.workspace_id = $1 and t.id = any($2::uuid[])`,
    [workspaceId, uniqueIds],
  );
  for (const row of tasksResult.rows) {
    resolved.push({
      id: row.id,
      kind: 'task',
      ...(row.name !== null && row.name !== '' ? { name: row.name } : {}),
    });
  }

  // -----------------------------------------------------------------------------------------
  // chat — RLS (`chats_visibility`) does the real narrowing here: `client` is already role-
  // switched into this call's workspace/principal by `dispatch.ts`'s `withWorkspace`, so a chat
  // belonging to someone else and not shared workspace-wide is simply absent from `chatsResult`
  // (see this module's own doc comment).
  // -----------------------------------------------------------------------------------------
  const chatsResult = await client.query<{ id: string; title: string | null }>(
    'select id, title from chats where workspace_id = $1 and id = any($2::uuid[])',
    [workspaceId, uniqueIds],
  );
  for (const row of chatsResult.rows) {
    resolved.push({
      id: row.id,
      kind: 'chat',
      ...(row.title !== null && row.title !== '' ? { name: row.title } : {}),
    });
  }

  // -----------------------------------------------------------------------------------------
  // workspace — no RLS to lean on (see this module's own doc comment): resolvable ids are
  // filtered *before* the query, not after — the caller's own workspace always, any other
  // workspace only for a platform administrator's console session.
  // -----------------------------------------------------------------------------------------
  const isPlatformAdmin = ctx.consoleUser?.platformRole === 'admin';
  const workspaceIds = uniqueIds.filter(
    (candidate) => candidate === workspaceId || isPlatformAdmin,
  );
  if (workspaceIds.length > 0) {
    const workspacesResult = await client.query<{ id: string; name: string }>(
      'select id, name from workspaces where id = any($1::uuid[])',
      [workspaceIds],
    );
    for (const row of workspacesResult.rows) {
      resolved.push({ id: row.id, kind: 'workspace', name: row.name });
    }
  }

  return { result: { items: resolved } };
};
