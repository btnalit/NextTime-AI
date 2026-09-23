import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { grantCapability } from '../../governance/capability/index.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/resolve-refs-handler.integration: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) end-to-end proof for `resolve_refs` (S8 W1-C, leftover 48). Covers every
 * reference kind, an unknown id (silently omitted, never a 404), and the one kind with a real
 * sub-workspace visibility rule (`actionRequest`, I14).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const graphStore = new SqlGraphStore();

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

interface ResolvedRefRow {
  readonly id: string;
  readonly kind: string;
  readonly name?: string;
  readonly typeName?: string;
}

describe.runIf(DATABASE_URL !== undefined)('resolve_refs (integration, real Postgres)', () => {
  let pool: Pool;
  let workspaceId: string;
  let ownerId: string;
  let memberId: string;
  let otherMemberId: string;

  async function adminInsertWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId: id, principalId: randomUUID() },
      async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function adminInsertPrincipal(role: Role, displayName: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: id },
      async (client) => {
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', $3, $4)`,
          [workspaceId, id, role, displayName],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function adminRegisterGatekeeper(name: string): Promise<string> {
    return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      const activity = await startActivity(client, workspaceId, {
        kind: 'test.register_gatekeeper',
        principalId: ownerId,
      });
      const { gatekeeperId } = await registerGatekeeper(client, workspaceId, {
        name,
        transportKind: 'http',
        target: `resolve-refs-test-system-${name}`,
        endpoint: `https://gate.resolve-refs-test.invalid/${name}`,
        activityId: activity.id,
        registeredBy: { id: ownerId, kind: 'human' },
      });
      return gatekeeperId;
    });
  }

  /** `status='pending_approval'` requires a non-null `policy_decision` on file (I6 — this table's
   *  own CHECK: "every state past `proposed` was reached via `evaluate_policy`, which always sets
   *  `policy_decision` in the same write"). `require_approval` is the one that naturally pairs
   *  with `pending_approval`. */
  async function adminInsertActionRequest(
    gatekeeperId: string,
    actionKind: string,
  ): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: ownerId },
      async (client) => {
        await client.query(
          `insert into action_requests
             (workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
              policy_decision, await_decision, on_behalf_of, actor_runtime, requested_at)
           values
             ($1, $2, 'pending_approval', $3::uuid, $4, $3::text, 'low', 'require_approval', true,
              $5, 'human', now())`,
          [workspaceId, id, gatekeeperId, actionKind, ownerId],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    workspaceId = await adminInsertWorkspace('resolve-refs-test-workspace');
    ownerId = await adminInsertPrincipal('owner', 'The Owner');
    memberId = await adminInsertPrincipal('member', 'Granted Member');
    otherMemberId = await adminInsertPrincipal('member', 'Ungranted Member');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('resolves object, gatekeeper, principal and workerDefinition kinds; omits an unknown id', async () => {
    const objectId = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      graphStore
        .upsertObject(client, workspaceId, {
          objectType: 'Widget',
          properties: { name: 'Test Widget' },
        })
        .then((o) => o.id),
    );
    const gatekeeperId = await adminRegisterGatekeeper('gate-resolve');
    const { definitionId } = await withWorkspace(
      pool,
      { workspaceId, principalId: ownerId },
      async (client) => {
        const draft = await proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'Do the thing.', name: 'resolve-refs-worker' },
        });
        const published = await publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: draft.id,
          version: draft.version,
        });
        return { definitionId: published.id };
      },
    );
    const unknownId = randomUUID();

    const owner = humanCaller(workspaceId, ownerId, 'owner');
    const result = (await dispatchCapability({ pool }, owner, 'resolve_refs', {
      ids: [objectId, gatekeeperId, memberId, definitionId, unknownId],
    })) as { items: readonly ResolvedRefRow[] };

    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get(objectId)).toEqual({
      id: objectId,
      kind: 'object',
      name: 'Test Widget',
      typeName: 'Widget',
    });
    expect(byId.get(gatekeeperId)).toEqual({
      id: gatekeeperId,
      kind: 'gatekeeper',
      name: 'gate-resolve',
      typeName: 'Gatekeeper',
    });
    expect(byId.get(memberId)).toEqual({
      id: memberId,
      kind: 'principal',
      name: 'Granted Member',
      typeName: 'human',
    });
    expect(byId.get(definitionId)).toEqual({
      id: definitionId,
      kind: 'workerDefinition',
      name: 'resolve-refs-worker',
      typeName: 'worker',
    });
    // An id resolve_refs has no row for is simply absent — never a 404, never a null entry.
    expect(byId.has(unknownId)).toBe(false);
    expect(result.items).toHaveLength(4);
  });

  it('actionRequest: I14-visible to a principal holding a matching grant, invisible to one that does not', async () => {
    const gatekeeperId = await adminRegisterGatekeeper('gate-i14');
    const actionRequestId = await adminInsertActionRequest(gatekeeperId, 'test.i14_action');

    await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      grantCapability(client, workspaceId, {
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: gatekeeperId,
        grantedBy: ownerId,
      }),
    );

    const granted = humanCaller(workspaceId, memberId, 'member');
    const grantedResult = (await dispatchCapability({ pool }, granted, 'resolve_refs', {
      ids: [actionRequestId],
    })) as { items: readonly ResolvedRefRow[] };
    expect(grantedResult.items).toEqual([
      { id: actionRequestId, kind: 'actionRequest', name: 'test.i14_action' },
    ]);

    const ungranted = humanCaller(workspaceId, otherMemberId, 'member');
    const ungrantedResult = (await dispatchCapability({ pool }, ungranted, 'resolve_refs', {
      ids: [actionRequestId],
    })) as { items: readonly ResolvedRefRow[] };
    expect(ungrantedResult.items).toEqual([]);

    // The workspace owner always sees it (I14: owner counts as holding every scope).
    const owner = humanCaller(workspaceId, ownerId, 'owner');
    const ownerResult = (await dispatchCapability({ pool }, owner, 'resolve_refs', {
      ids: [actionRequestId],
    })) as { items: readonly ResolvedRefRow[] };
    expect(ownerResult.items).toEqual([
      { id: actionRequestId, kind: 'actionRequest', name: 'test.i14_action' },
    ]);
  });
});
