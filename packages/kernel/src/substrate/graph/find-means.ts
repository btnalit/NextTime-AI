import type { PoolClient } from 'pg';
import type { GraphObject } from './store.js';

/**
 * substrate/graph/find-means: `find_operations` / `find_workers` / `find_procedures`'s pure graph
 * half (design doc §5.1.2 "入口 agent 找手段 = 一次 traverse（find_operations / find_workers /
 * find_procedures）", §8.4 "手段发现", §9.3 "find_* 与调用者 Grant 取交集"; docs/development-tasks.md
 * S2.7 "one traversal over the meta-ontology objects (published only) ... intersected with what
 * the caller may use").
 *
 * **Layering note (why this file never touches Grants):** substrate may depend only on the domain
 * layer (`.dependency-cruiser.cjs` `kernel-substrate-may-only-depend-on-domain`) — it cannot import
 * `governance/capability`'s `hasActiveGrant`/Handle-scope logic. The "intersected with the
 * caller's Grant" half of `find_*` is therefore the *handler's* job
 * (`application/gateway/handlers.ts`'s `findOperationsHandler`/`findWorkersHandler`/
 * `findProceduresHandler`, which may import both this module and `governance/capability`): this
 * file returns *candidates* (every matching, already-published meta-ontology Object — see below
 * for why no extra "published" filter is needed here), and the handler narrows that list to what
 * the caller may actually use.
 *
 * **"published only" is free for `WorkerDefinition` and `Procedure`, not for `Operation` (S2.13
 * correction of this file's own earlier claim):** every `WorkerDefinition` Object this file can
 * find was written by a *publish*-time projection (`substrate/ontology/meta-objects.ts`'s
 * `projectWorkerDefinitionObject`, called only from `application/worker/definitions.ts`'s
 * `publishWorkerDefinition` — never from `propose`), so a `WorkerDefinition` row in `objects` is
 * non-draft by construction (the same invariant `application/gateway/meta-ontology-guard.ts`'s own
 * doc comment relies on for I16) — no extra filter needed for that one type. `Procedure` (S2.14)
 * follows the identical shape: `projectProcedureObject` is called only from `application/worker/
 * procedures.ts`'s `publishProcedure`, never from `proposeProcedure`, and writes no `status`
 * property at all (`{name, description}` only) — a filter on `properties ->> 'status'` here would
 * therefore incorrectly exclude *every* Procedure, published or not (this was a real bug in an
 * earlier version of this file, caught by find-procedures.integration.test.ts once S2.14 landed
 * real Procedure fixtures to run it against). `Operation` turned out *not* to follow either shape
 * once S2.4 actually landed it: `registerOperationDraftObject` upserts the Object at
 * **import/propose** time, `status: 'draft'` in `properties`, and `setOperationStatusObject` only
 * flips that same row's `properties.status` in place — so a draft Operation is already sitting in
 * `objects` the moment it is imported, long before anyone publishes it. Returning it here would
 * violate I16/I17 ("未发布的清单对 agent 不可见" — docs/development-tasks.md S2.13 acceptance) the
 * first time a manifest is imported. This function therefore adds an explicit
 * `properties ->> 'status' = 'published'` filter for `Operation` only — never for
 * `WorkerDefinition`/`Procedure`, whose Objects carry no `status` property at all (adding the
 * filter there would silently return zero rows for every published one, not narrow correctly).
 *
 * **"one traversal" is a text search, not a graph walk, and that is deliberate for S2.7's actual
 * data shape:** a real `traverse` (`substrate/graph/store.ts`) walks Links outward from one
 * anchor Object — but "find something matching a free-text need" has no anchor to start from; the
 * anchor *is* the search itself. `search`'s own ILIKE-over-properties primitel (`queries.ts`
 * `buildSearchQuery`) is reused in spirit here (bounded to the three meta-ontology ObjectTypes,
 * with a simple match-quality ranking `search()` itself does not offer: a hit in `name` ranks
 * above a hit in `description`, which ranks above a hit only in the identity key or another
 * property). Once S2.4/S2.14 project real `exposes`/`can_act_on`/`steps` Links (design doc §5.1.2)
 * between these Objects, a genuine `traverse`-based `find_*` (e.g. "operations reachable from
 * Gatekeepers the caller can act on") can be layered on top of these same candidate queries without
 * changing this file's public shape.
 */

export interface FindMeansInput {
  readonly need: string;
  readonly limit?: number;
}

export const DEFAULT_FIND_MEANS_LIMIT = 20;

const OBJECT_COLUMNS =
  'workspace_id, id, object_type, identity_key, properties, created_at, updated_at';

interface ObjectRow {
  workspace_id: string;
  id: string;
  object_type: string;
  identity_key: Record<string, unknown> | null;
  properties: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function mapObjectRow(row: ObjectRow): GraphObject {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    objectType: row.object_type,
    identityKey: row.identity_key,
    properties: row.properties,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Every meta-ontology Object of `objectType` whose `properties.name`, `properties.description`,
 * `properties` (as a whole, for anything else declared on it), or `identity_key` contains
 * `input.need` (case-insensitive substring — same ILIKE convention as `graphStore.search`), most
 * relevant first: a `name` hit ranks above a `description` hit, which ranks above any other match,
 * ties broken by most-recently-updated. An empty `need` matches every candidate (ILIKE '%%'),
 * which is a deliberate, useful default ("list everything of this kind"), not a special case.
 */
async function findMetaOntologyObjects(
  client: PoolClient,
  workspaceId: string,
  objectType: 'WorkerDefinition' | 'Operation' | 'Procedure',
  input: FindMeansInput,
): Promise<readonly GraphObject[]> {
  const pattern = `%${input.need}%`;
  const limit = input.limit ?? DEFAULT_FIND_MEANS_LIMIT;
  // S2.13: see this file's own module doc comment ("published only is free for WorkerDefinition
  // and Procedure, not for Operation") for why this filter exists at all and why it must apply to
  // Operation only.
  const publishedOnly = objectType === 'Operation';
  const result = await client.query<ObjectRow>(
    `select ${OBJECT_COLUMNS}
     from objects
     where workspace_id = $1
       and object_type = $2
       and (
         properties::text ilike $3
         or coalesce(identity_key::text, '') ilike $3
       )
       and (not $5::boolean or properties ->> 'status' = 'published')
     order by
       case
         when properties ->> 'name' ilike $3 then 0
         when properties ->> 'description' ilike $3 then 1
         else 2
       end,
       updated_at desc
     limit $4`,
    [workspaceId, objectType, pattern, limit, publishedOnly],
  );
  return result.rows.map(mapObjectRow);
}

/** Candidates for `find_operations` — `Gatekeeper --exposes--> Operation` (design doc §5.1.2),
 *  published only (I16/I17 — see `findMetaOntologyObjects`'s own doc comment above). */
export function findOperationCandidates(
  client: PoolClient,
  workspaceId: string,
  input: FindMeansInput,
): Promise<readonly GraphObject[]> {
  return findMetaOntologyObjects(client, workspaceId, 'Operation', input);
}

/** Candidates for `find_workers` — every published `WorkerDefinition@version` (design doc §5.1.4)
 *  matching `need`. */
export function findWorkerDefinitionCandidates(
  client: PoolClient,
  workspaceId: string,
  input: FindMeansInput,
): Promise<readonly GraphObject[]> {
  return findMetaOntologyObjects(client, workspaceId, 'WorkerDefinition', input);
}

/** Candidates for `find_procedures` — `Procedure --steps--> Operation | WorkerDefinition` (design
 *  doc §5.1.2), published only for free (S2.14's `projectProcedureObject` is publish-time-only,
 *  same shape as `WorkerDefinition` — see `findMetaOntologyObjects`'s own doc comment above). */
export function findProcedureCandidates(
  client: PoolClient,
  workspaceId: string,
  input: FindMeansInput,
): Promise<readonly GraphObject[]> {
  return findMetaOntologyObjects(client, workspaceId, 'Procedure', input);
}
