import type { PrincipalKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { registerGatekeeperObject } from '../../substrate/ontology/index.js';

/**
 * governance/gatekeepers/registry: Gatekeeper instance registration + lookup (design doc §5.1.4
 * Gatekeeper/Connection, §7.5; docs/development-tasks.md S2.4 "kernel gatekeepers/{client,
 * registry,manifest}.ts").
 *
 * Module placement (task brief: "governance/connections/ or a new governance/gatekeepers/ — pick
 * one, say why"): a new module. §7.1's module table assigns "门实例注册、清单导入草稿" to
 * `connections`, but `governance/connections/index.ts` is still S2.13's placeholder — that task's
 * own deliverable is the *human-facing* `request_connection` card flow (`request_connection` →
 * card → human fills credentials → `create_connection`/`publish_manifest`/`connect_gatekeeper`).
 * This module ships the *lower-level* primitives S2.13 will call into: register a Gatekeeper
 * instance's endpoint/transport, import/publish its Operation manifest. Keeping them in their own
 * module (rather than reaching into S2.13's not-yet-written module) avoids two tasks racing to
 * define the same module's internals, and matches the existing precedent of `governance/policy`
 * and `governance/capability` being separate sibling modules `governance/approval` calls into
 * through their own published service interfaces (§7.10 module contract) — S2.13 does the same
 * here once it lands, rather than this module reaching into `connections`.
 *
 * This module owns no table of its own (design doc §9.2 "gatekeeper_instances ... 作为平台元本体存于
 * objects / links" — S2.1's own deviation note already established there is no dedicated
 * `gatekeepers` relational table) — a registered Gatekeeper is entirely a graph Object
 * (`substrate/ontology`'s `registerGatekeeperObject`) plus a lazily-created shared service
 * Principal (`service-principal.ts`).
 */

const graphStore = new SqlGraphStore();

export interface RegisterGatekeeperInput {
  /** Omit to register a new instance; given, re-registers (upserts) the same one. */
  readonly gatekeeperId?: string;
  readonly name: string;
  readonly transportKind: 'http' | 'mcp' | 'cli' | 'ssh';
  readonly target: string;
  readonly endpoint: string;
  /** The connected system's own Object id (design doc §5.1.4 Connection "产生 Gatekeeper 实例对象、
   *  系统对象与 connects_to 边"). When omitted, a lightweight `ConnectedSystem` Object is created
   *  from `name`/`target` — the common case for this task's own tests and for a gate registered
   *  without a prior, separately-modeled system Object; S2.13's real connection flow is expected
   *  to create a richer system Object first and pass its id here instead. */
  readonly systemObjectId?: string;
  readonly activityId: string;
  readonly registeredBy: { readonly id: string; readonly kind: PrincipalKind };
}

export interface RegisterGatekeeperResult {
  readonly gatekeeperId: string;
}

export async function registerGatekeeper(
  client: PoolClient,
  workspaceId: string,
  input: RegisterGatekeeperInput,
): Promise<RegisterGatekeeperResult> {
  const systemObjectId =
    input.systemObjectId ??
    (
      await graphStore.upsertObject(client, workspaceId, {
        objectType: 'ConnectedSystem',
        identity: { name: input.name },
        properties: { target: input.target },
      })
    ).id;

  const result = await registerGatekeeperObject(client, workspaceId, {
    gatekeeperId: input.gatekeeperId,
    transportKind: input.transportKind,
    target: input.target,
    name: input.name,
    endpoint: input.endpoint,
    systemObjectId,
    activityId: input.activityId,
    registeredBy: input.registeredBy,
  });

  return { gatekeeperId: result.gatekeeperObjectId };
}

export interface GatekeeperRecord {
  readonly gatekeeperId: string;
  readonly name: string;
  readonly transportKind: 'http' | 'mcp' | 'cli' | 'ssh';
  readonly target: string;
  readonly endpoint: string;
  /** S3.11 addition (`get_gatekeeper`'s own wire shape needs it) — the underlying Object's own
   *  `created_at`, purely additive to every pre-existing caller of this function. */
  readonly createdAt: Date;
}

/** Reads a registered Gatekeeper's connection config from its Object properties, or `null` if it
 *  does not exist / is not a `Gatekeeper`-typed Object. */
export async function getGatekeeper(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<GatekeeperRecord | null> {
  const object = await graphStore.getObject(client, workspaceId, gatekeeperId);
  if (!object || object.objectType !== 'Gatekeeper') return null;
  const props = object.properties as {
    transportKind?: string;
    target?: string;
    name?: string;
    endpoint?: string;
  };
  if (!props.transportKind || !props.target || !props.endpoint) return null;
  return {
    gatekeeperId: object.id,
    name: props.name ?? object.id,
    transportKind: props.transportKind as GatekeeperRecord['transportKind'],
    target: props.target,
    endpoint: props.endpoint,
    createdAt: object.createdAt,
  };
}

/**
 * Thrown by callers that need a registered Gatekeeper and got `null` from `getGatekeeper`
 * (`application/gateway/request-action-handler.ts`, `governance/connections/service.ts`). One
 * class, owned here by the module that owns the Gatekeeper Object, so `interfaces/http` and
 * `interfaces/ws` map a single `instanceof` to 404 — before S2.13 each consumer declared its own
 * same-named class and only the request_action one was mapped.
 */
export class GatekeeperNotFoundError extends Error {
  constructor(gatekeeperId: string) {
    super(`Gatekeeper not found: ${gatekeeperId}`);
    this.name = 'GatekeeperNotFoundError';
  }
}

// -------------------------------------------------------------------------------------------
// listGatekeepers (S3.11, docs/development-tasks.md "中台控制面" — `list_gatekeepers`'s service
// half): every registered Gatekeeper instance, direct SQL over `objects` — same style
// `governance/gatekeepers/manifest.ts`'s `listPublishedOperationsForGatekeepers`/
// `listDraftOperationsForGatekeeper` already established for this table (no dedicated relational
// table exists for a Gatekeeper, §9.2 — see this file's own module doc comment).
// -------------------------------------------------------------------------------------------

export interface GatekeeperListEntry {
  readonly gatekeeperId: string;
  readonly name: string;
  readonly transportKind: 'http' | 'mcp' | 'cli' | 'ssh';
  readonly endpoint: string | null;
  readonly createdAt: Date;
}

interface GatekeeperObjectRow {
  id: string;
  properties: Record<string, unknown>;
  created_at: Date;
}

/** Every `Gatekeeper` Object in the workspace, oldest first — the raw rows `application/gateway`'s
 *  `list_gatekeepers`/`get_gatekeeper` handlers project to the wire shape (operation counts and
 *  live health are that layer's concern, not this one's, same "governance owns storage,
 *  application projects" split `getGatekeeper`/`getOperation` above already follow). */
export async function listGatekeepers(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly GatekeeperListEntry[]> {
  const result = await client.query<GatekeeperObjectRow>(
    `select id, properties, created_at
     from objects
     where workspace_id = $1 and object_type = 'Gatekeeper'
     order by created_at asc`,
    [workspaceId],
  );
  return result.rows.map((row) => {
    const props = row.properties as {
      transportKind?: string;
      name?: string;
      endpoint?: string;
    };
    return {
      gatekeeperId: row.id,
      name: props.name ?? row.id,
      transportKind: (props.transportKind as GatekeeperListEntry['transportKind']) ?? 'http',
      endpoint: props.endpoint ?? null,
      createdAt: row.created_at,
    };
  });
}

/** `get_workspace`'s own summary count (S3.11, `application/gateway/members-handlers.ts`) — a
 *  plain count over the same `objects` slice `listGatekeepers` reads, kept as its own query
 *  (rather than `(await listGatekeepers(...)).length`) so a workspace with many registered
 *  Gatekeepers does not pay for every row's `properties` just to report a number. */
export async function countGatekeepers(client: PoolClient, workspaceId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::bigint as count from objects where workspace_id = $1 and object_type = 'Gatekeeper'`,
    [workspaceId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
