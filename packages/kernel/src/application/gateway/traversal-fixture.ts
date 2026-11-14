import { randomUUID } from 'node:crypto';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import type { ZodType } from 'zod';
import { withWorkspace } from '../../adapters/db/pool.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/traversal-fixture: test support for the batch D registry walks
 * (docs/test-coverage-gaps-2026-11-06.md §5.7) — a seeded workspace, a caller for any role, and
 * params built from a capability's own schema with every id-shaped field pointed at the seeded
 * rows. Not used by any production path.
 */

/** A human caller of `role` in `workspaceId`, as resolve-caller.ts builds one for an API key (no
 *  console login behind it: legacy 712 re-checks the Principal's key when it issues a Handle, so
 *  {@link newWorkspace} gives every Principal one). */
export function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
    session: {
      workspaceId,
      id: randomUUID(),
      principalId,
      kind: 'web',
      onBehalfOf: principalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

/** A new workspace with one human Principal per role given (the first is its owner), each with an
 *  API key (a synthetic hash; the key itself exists nowhere). */
export async function newWorkspace(
  pool: Pool,
  name: string,
  roles: readonly Role[] = ['owner'],
): Promise<{ workspaceId: string; principals: ReadonlyMap<Role, string> }> {
  const workspaceId = randomUUID();
  const principals = new Map<Role, string>(roles.map((role) => [role, randomUUID()]));
  await withWorkspace(
    pool,
    { workspaceId, principalId: principals.values().next().value as string },
    async (client) => {
      await client.query('insert into workspaces (id, name) values ($1, $2)', [workspaceId, name]);
      for (const [role, id] of principals) {
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
           values ($1, $2, 'human', $3, $4, md5(random()::text) || md5(random()::text))`,
          [workspaceId, id, role, `${name} ${role}`],
        );
      }
    },
    { skipRoleSwitch: true },
  );
  return { workspaceId, principals };
}

/** One of each kind of row a read could return, every one carrying `marker` where a reader sees it. */
export interface Seeded {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly marker: string;
  readonly chatId: string;
  readonly gatekeeperId: string;
  readonly operationId: string;
  readonly actionRequestId: string;
}

/** Seeds `workspaceId` (whose owner is `ownerId`): a chat titled with the marker, through the
 *  capabilities a person uses; a gate, a published Operation on it and a pending request for it —
 *  the shape the CI e2e seed writes (.github/workflows/e2e.yml "Prepare the always-allow seed"). */
export async function seedWorkspace(
  pool: Pool,
  workspaceId: string,
  ownerId: string,
  marker: string,
): Promise<Seeded> {
  const owner = humanCaller(workspaceId, ownerId, 'owner');
  const chat = (await dispatchCapability({ pool }, owner, 'new_chat', {})) as { id: string };
  await dispatchCapability({ pool }, owner, 'rename_chat', { chatId: chat.id, title: marker });

  const gatekeeperId = randomUUID();
  const rows = await withWorkspace(
    pool,
    { workspaceId, principalId: ownerId },
    async (client) => {
      await client.query(
        "insert into objects (workspace_id, id, object_type, properties) values ($1, $2, 'Gatekeeper', $3)",
        [workspaceId, gatekeeperId, { name: marker }],
      );
      const operation = await client.query<{ id: string }>(
        `insert into objects (workspace_id, object_type, identity_key, properties)
         values ($1, 'Operation', $2, $3) returning id`,
        [
          workspaceId,
          { gatekeeperId, name: marker, version: 1 },
          {
            name: marker,
            description: marker,
            status: 'published',
            version: 1,
            origin: 'import',
            mode: 'execute',
          },
        ],
      );
      const request = await client.query<{ id: string }>(
        `insert into action_requests
           (workspace_id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
            policy_decision, await_decision, on_behalf_of, actor_runtime, params)
         values ($1, 'pending_approval', $2::uuid, $3, $2::text, 'medium', 'require_approval',
                 false, $4, 'worker', $5)
         returning id`,
        [workspaceId, gatekeeperId, marker, ownerId, { note: marker }],
      );
      return {
        operationId: operation.rows[0]?.id ?? '',
        actionRequestId: request.rows[0]?.id ?? '',
      };
    },
    { skipRoleSwitch: true },
  );
  return { workspaceId, ownerId, marker, chatId: chat.id, gatekeeperId, ...rows };
}

/** Makes the seeded gate a registered one — a transport, target and endpoint, what
 *  `getGatekeeper` needs to find it — for a call that refuses an unregistered gate
 *  (`connect_gatekeeper`). Nothing reaches the endpoint. */
export async function registerSeededGatekeeper(pool: Pool, seed: Seeded): Promise<void> {
  await withWorkspace(
    pool,
    { workspaceId: seed.workspaceId, principalId: seed.ownerId },
    async (client) => {
      await client.query(
        `update objects set properties = properties || $3::jsonb
         where workspace_id = $1 and id = $2`,
        [
          seed.workspaceId,
          seed.gatekeeperId,
          {
            transportKind: 'http',
            target: seed.marker,
            endpoint: 'http://seeded-gate.invalid:8090',
          },
        ],
      );
    },
    { skipRoleSwitch: true },
  );
}

/** The seeded rows' ids. */
export function seededIds(seed: Seeded): string[] {
  return [seed.chatId, seed.gatekeeperId, seed.operationId, seed.actionRequestId];
}

/** What free-text params get: never the marker, so a marker in an answer is seeded data. */
export const PROBE = 'traversal-probe';

function idFor(key: string, seed: Seeded): string | undefined {
  if (key === 'chatId') return seed.chatId;
  if (key === 'gatekeeperId' || key === 'gateId') return seed.gatekeeperId;
  if (key === 'actionRequestId') return seed.actionRequestId;
  if (/^(objectId|entityId|nodeId|fromId|toId|id|definitionId)$/.test(key)) return seed.operationId;
  return undefined;
}

/** A zod v4 schema's def, read by its `type` tag (no class checks — the walk only needs shapes). */
interface Def {
  readonly type: string;
  readonly innerType?: ZodType;
  readonly in?: ZodType;
  readonly shape?: Record<string, ZodType>;
  readonly entries?: Record<string, string | number>;
  readonly values?: readonly unknown[];
  readonly format?: string;
}

function defOf(schema: ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

/** Strips optional / nullable / default / pipe wrappers down to the shape a value must have. */
function unwrap(schema: ZodType): Def {
  let def = defOf(schema);
  for (;;) {
    const next = def.innerType ?? (def.type === 'pipe' ? def.in : undefined);
    if (next === undefined) return def;
    def = defOf(next);
  }
}

/** A value for one field: a seeded id where the name says it is one, else the simplest the type takes. */
function valueFor(key: string, schema: ZodType, seed: Seeded, probe: string): unknown {
  const def = unwrap(schema);
  switch (def.type) {
    case 'array':
      return [idFor(key.replace(/s$/, 'Id'), seed) ?? seed.operationId];
    case 'string':
      return (
        idFor(key, seed) ?? (/Id$/.test(key) || def.format === 'uuid' ? seed.operationId : probe)
      );
    case 'number':
    case 'int':
      return 1;
    case 'boolean':
      return false;
    case 'enum':
      return Object.values(def.entries ?? {})[0];
    case 'literal':
      return def.values?.[0];
    case 'object':
      return paramsFor(schema, seed, probe);
    default:
      return undefined;
  }
}

/** Params for a capability: every field its schema declares (optional ones too, so an id filter
 *  is set); free-text fields get `probe`. */
export function paramsFor(
  schema: ZodType,
  seed: Seeded,
  probe: string = PROBE,
): Record<string, unknown> {
  const def = unwrap(schema);
  if (def.type !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(def.shape ?? {})) {
    const value = valueFor(key, field, seed, probe);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * A digest of every row `workspaceId` owns, table by table: each `public` table with a
 * `workspace_id` column, its rows in that workspace as text, hashed. Two equal digests mean no
 * row was added, removed or changed in between. Reads as the pool's own role (RLS does not apply).
 */
export async function workspaceDigest(
  pool: Pool,
  workspaceId: string,
): Promise<Record<string, string>> {
  const tables = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.columns
     where table_schema = 'public' and column_name = 'workspace_id'
       and table_name in (select table_name from information_schema.tables
                          where table_schema = 'public' and table_type = 'BASE TABLE')
     order by table_name`,
  );
  const digest: Record<string, string> = {};
  for (const { table_name } of tables.rows) {
    const result = await pool.query<{ digest: string }>(
      `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest
       from "${table_name}" t where workspace_id = $1`,
      [workspaceId],
    );
    digest[table_name] = result.rows[0]?.digest ?? '';
  }
  return digest;
}
