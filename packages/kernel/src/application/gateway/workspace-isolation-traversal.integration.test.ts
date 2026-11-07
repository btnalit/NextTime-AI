import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_REGISTRY, type Capability, type Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Batch D1 (docs/test-coverage-gaps-2026-11-06.md §6, gap G12): what workspace A holds never
 * reaches workspace B through any read. Isolation is a design floor ("隔离与审计只增不减") and RLS
 * is where it is enforced, but nothing walked every read a B member can make and looked for A's
 * data in the answer — 37 test files touch cross-workspace cases, each for its own feature.
 *
 * The invariant, over the whole registry rather than per capability: workspace A gets one of each
 * kind of row a read could return (objects of several types, a chat, an action request), every
 * one carrying a marker string in what a reader would see. Then B's owner — the widest role —
 * calls every workspace `observe` capability through `dispatchCapability`, with params built from
 * the capability's own schema and every id-shaped field pointed at A's rows. Whatever comes back
 * must name neither the marker, nor A's workspace id, nor any of A's row ids. A call may fail (an
 * unknown id, a param the builder could not satisfy) — failing is not leaking — but enough must
 * succeed that the walk proves something, so the count of answered reads is asserted too.
 *
 * A new `observe` capability is walked the moment it is registered; nothing here names one.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** Below this, the walk answered too few reads to mean anything (98 workspace reads today, 56 of
 *  them without required params). */
const MIN_ANSWERED = 50;

/** Every read a workspace member can make; platform reads are a different trust boundary. */
const WORKSPACE_READS = CAPABILITY_REGISTRY.filter(
  (capability: Capability) => capability.mode === 'observe' && capability.scope !== 'platform',
);

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
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

/** A's rows, by the id field names a read's params use for them. */
interface Seeded {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly marker: string;
  readonly chatId: string;
  readonly gatekeeperId: string;
  readonly operationId: string;
  readonly actionRequestId: string;
}

/** What a read's free-text params get: never the marker, so a marker in an answer is A's data. */
const PROBE = 'isolation-probe';

function ids(a: Seeded): string[] {
  return [a.chatId, a.gatekeeperId, a.operationId, a.actionRequestId];
}

function idFor(key: string, a: Seeded): string | undefined {
  if (key === 'chatId') return a.chatId;
  if (key === 'gatekeeperId' || key === 'gateId') return a.gatekeeperId;
  if (key === 'actionRequestId') return a.actionRequestId;
  if (/^(objectId|entityId|nodeId|fromId|toId|id|definitionId)$/.test(key)) return a.operationId;
  return undefined;
}

/** A zod v4 schema's def, read by its `type` tag (no class checks — the walk only needs shapes). */
interface Def {
  readonly type: string;
  readonly innerType?: ZodType;
  readonly in?: ZodType;
  readonly shape?: Record<string, ZodType>;
  readonly element?: ZodType;
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

/** A value for one field: A's id where the name says it is one, else the simplest the type takes. */
function valueFor(key: string, schema: ZodType, a: Seeded): unknown {
  const def = unwrap(schema);
  switch (def.type) {
    case 'array':
      return [idFor(key.replace(/s$/, 'Id'), a) ?? a.operationId];
    case 'string':
      return idFor(key, a) ?? (/Id$/.test(key) || def.format === 'uuid' ? a.operationId : PROBE);
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
      return paramsFor(schema, a);
    default:
      return undefined;
  }
}

/** Params for a read: every field its schema declares (optional ones too, so an id filter is set). */
function paramsFor(schema: ZodType, a: Seeded): Record<string, unknown> {
  const def = unwrap(schema);
  if (def.type !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(def.shape ?? {})) {
    const value = valueFor(key, field, a);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

describe.runIf(DATABASE_URL !== undefined)(
  'workspace isolation over every read — batch D1 / G12 (integration, real Postgres)',
  () => {
    let pool: Pool;
    let a: Seeded;
    let workspaceB: string;
    let ownerIdB: string;

    async function newWorkspace(name: string): Promise<{ workspaceId: string; ownerId: string }> {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            name,
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', $3)",
            [workspaceId, ownerId, name],
          );
        },
        { skipRoleSwitch: true },
      );
      return { workspaceId, ownerId };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const marker = `leak-marker-${randomUUID()}`;
      const { workspaceId, ownerId } = await newWorkspace(`isolation-a ${marker}`);

      // A chat, through the capability a person uses, titled with the marker.
      const ownerA = humanCaller(workspaceId, ownerId, 'owner');
      const chat = (await dispatchCapability({ pool }, ownerA, 'new_chat', {})) as { id: string };
      await dispatchCapability({ pool }, ownerA, 'rename_chat', { chatId: chat.id, title: marker });

      // A gate, a published Operation on it, and a pending request for it — the shape the CI e2e
      // seed writes (.github/workflows/e2e.yml "Prepare the always-allow seed").
      const gatekeeperId = randomUUID();
      const seeded = await withWorkspace(
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
      a = { workspaceId, ownerId, marker, chatId: chat.id, gatekeeperId, ...seeded };

      const b = await newWorkspace('isolation-b');
      workspaceB = b.workspaceId;
      ownerIdB = b.ownerId;
    });

    afterAll(async () => {
      await pool?.end();
    });

    /** Calls every workspace read as `caller`, with `paramsOf`'s params; returns which reads
     *  answered and which answers named any of `forbidden`. */
    async function walk(
      caller: ResolvedCaller,
      paramsOf: (capability: Capability) => Record<string, unknown>,
      forbidden: readonly string[],
    ): Promise<{ answered: Set<string>; hits: string[] }> {
      const answered = new Set<string>();
      const hits: string[] = [];
      for (const capability of WORKSPACE_READS) {
        const params = paramsOf(capability);
        let result: unknown;
        try {
          result = await dispatchCapability({ pool }, caller, capability.name, params);
        } catch {
          continue; // refused, or params the builder could not satisfy — not a leak
        }
        answered.add(capability.name);
        const text = JSON.stringify(result) ?? '';
        for (const value of forbidden) {
          if (text.includes(value))
            hits.push(`${capability.name}(${JSON.stringify(params)}) → ${value}`);
        }
      }
      return { answered, hits };
    }

    const byId = (capability: Capability): Record<string, unknown> =>
      paramsFor(capability.paramsSchema, a);

    it("the same walk, as A's own owner, finds A's rows — the seed is reachable and the check bites", async () => {
      const ownerA = humanCaller(a.workspaceId, a.ownerId, 'owner');
      const listed = await walk(ownerA, () => ({}), [a.marker]);
      const fetched = await walk(ownerA, byId, [a.marker]);
      const found = new Set([...listed.hits, ...fetched.hits].map((hit) => hit.split('(')[0]));
      // Lists and by-id reads alike: the chat, the gate, the Operation and the request each surface.
      for (const name of [
        'list_chats',
        'list_gatekeepers',
        'list_pending',
        'get_object',
        'get_action',
      ]) {
        expect(found).toContain(name);
      }
    });

    it("no read a B owner can make answers with anything of A's", async () => {
      const ownerB = humanCaller(workspaceB, ownerIdB, 'owner');
      // Pass 1, no params: nothing B asked for names A, so none of A's ids may come back either.
      const listed = await walk(ownerB, () => ({}), [a.marker, a.workspaceId, ...ids(a)]);
      // Pass 2, every id-shaped param pointed at A's rows. Each B call is itself audited in B with
      // its params (dispatch.ts), so B's own audit reads now echo A's ids back — that is B's record
      // of what B asked, not A's data. A's data is what carries the marker, which no param ever
      // holds (strings get PROBE), and A's workspace id, which no param names.
      const fetched = await walk(ownerB, byId, [a.marker, a.workspaceId]);

      expect([...listed.hits, ...fetched.hits]).toEqual([]);
      expect(new Set([...listed.answered, ...fetched.answered]).size).toBeGreaterThanOrEqual(
        MIN_ANSWERED,
      );
    });
  },
);
