import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { grantCapability } from '../../governance/capability/index.js';
import { importManifest, registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ConsoleUser, ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/resolve-refs-handler.integration: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) end-to-end proof for `resolve_refs` (S8 W1-C, leftover 48; S8 W1-A6 added
 * operation/task/chat/workspace). Covers every reference kind, an unknown id (silently omitted,
 * never a 404), and the kinds with a real sub-workspace visibility rule (`actionRequest` I14,
 * `chat` RLS, `workspace` platform-admin-only cross-workspace read).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const graphStore = new SqlGraphStore();

function testOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    name: `test.op.${randomUUID()}`,
    description: 'A test operation.',
    binding: { kind: 'http', method: 'GET', path: '/stock' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
    ...overrides,
  };
}

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role,
  user?: ConsoleUser,
): ResolvedCaller {
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
    ...(user ? { user } : {}),
  };
}

/** A minimal `ConsoleUser` for the `workspace` kind's platform-admin test — only `platformRole`
 *  is read by `resolveRefsHandler`, but the full shape keeps this a valid `ResolvedCaller`. */
function consoleUser(platformRole: 'admin' | 'user'): ConsoleUser {
  return {
    id: randomUUID(),
    login: `test-${platformRole}-${randomUUID()}`,
    displayName: 'Test console user',
    platformRole,
    mustChangePassword: false,
    consoleSessionId: randomUUID(),
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
  let otherWorkspaceId: string;
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

  async function adminInsertChat(
    ownerPrincipalId: string,
    visibility: 'private' | 'workspace',
    title: string,
  ): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: ownerPrincipalId },
      async (client) => {
        await client.query(
          `insert into chats (workspace_id, id, owner_principal_id, title, visibility)
           values ($1, $2, $3, $4, $5)`,
          [workspaceId, id, ownerPrincipalId, title, visibility],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  /** A bare Task row referencing a real, published WorkerDefinition — no Turn/invoke_worker
   *  machinery needed for this handler's own read. */
  async function adminInsertTask(
    onBehalfOf: string,
    workerDefinitionId: string,
    workerDefinitionVersion: number,
  ): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: onBehalfOf },
      async (client) => {
        await client.query(
          `insert into tasks (workspace_id, id, on_behalf_of, worker_definition_id, worker_definition_version)
           values ($1, $2, $3, $4, $5)`,
          [workspaceId, id, onBehalfOf, workerDefinitionId, workerDefinitionVersion],
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
    otherWorkspaceId = await adminInsertWorkspace('resolve-refs-test-other-workspace');
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

  it('resolves operation and task kinds (task named from its own WorkerDefinition)', async () => {
    const gatekeeperId = await adminRegisterGatekeeper('gate-operation');
    const operation = testOperation({ name: 'test.op.stock' });
    const { imported } = await withWorkspace(
      pool,
      { workspaceId, principalId: ownerId },
      async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.import_manifest',
          principalId: ownerId,
        });
        return importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [operation],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
      },
    );
    const operationId = imported[0]?.id;
    expect(operationId).toBeDefined();

    const { definitionId, version } = await withWorkspace(
      pool,
      { workspaceId, principalId: ownerId },
      async (client) => {
        const draft = await proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'Do the task.', name: 'resolve-refs-task-worker' },
        });
        const published = await publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: draft.id,
          version: draft.version,
        });
        return { definitionId: published.id, version: published.version };
      },
    );
    const taskId = await adminInsertTask(ownerId, definitionId, version);

    const owner = humanCaller(workspaceId, ownerId, 'owner');
    const result = (await dispatchCapability({ pool }, owner, 'resolve_refs', {
      ids: [operationId as string, taskId],
    })) as { items: readonly ResolvedRefRow[] };
    const byId = new Map(result.items.map((item) => [item.id, item]));

    expect(byId.get(operationId as string)).toEqual({
      id: operationId,
      kind: 'operation',
      name: 'test.op.stock',
      typeName: 'Operation',
    });
    expect(byId.get(taskId)).toEqual({
      id: taskId,
      kind: 'task',
      name: 'resolve-refs-task-worker',
    });
  });

  it('chat: RLS hides a private chat from a non-owner, a workspace-visibility chat is visible to any member', async () => {
    const privateChatId = await adminInsertChat(memberId, 'private', 'my private chat');
    const sharedChatId = await adminInsertChat(memberId, 'workspace', 'shared chat');

    const owner = humanCaller(workspaceId, memberId, 'member');
    const ownResult = (await dispatchCapability({ pool }, owner, 'resolve_refs', {
      ids: [privateChatId, sharedChatId],
    })) as { items: readonly ResolvedRefRow[] };
    expect(new Map(ownResult.items.map((item) => [item.id, item.name]))).toEqual(
      new Map([
        [privateChatId, 'my private chat'],
        [sharedChatId, 'shared chat'],
      ]),
    );

    const other = humanCaller(workspaceId, otherMemberId, 'member');
    const otherResult = (await dispatchCapability({ pool }, other, 'resolve_refs', {
      ids: [privateChatId, sharedChatId],
    })) as { items: readonly ResolvedRefRow[] };
    const otherById = new Map(otherResult.items.map((item) => [item.id, item]));
    expect(otherById.has(privateChatId)).toBe(false);
    expect(otherById.get(sharedChatId)).toEqual({
      id: sharedChatId,
      kind: 'chat',
      name: 'shared chat',
    });
  });

  it('workspace: resolves the caller’s own workspace for any member; another workspace only for a platform administrator', async () => {
    const member = humanCaller(workspaceId, memberId, 'member');
    const ownResult = (await dispatchCapability({ pool }, member, 'resolve_refs', {
      ids: [workspaceId, otherWorkspaceId],
    })) as { items: readonly ResolvedRefRow[] };
    expect(ownResult.items).toEqual([
      { id: workspaceId, kind: 'workspace', name: 'resolve-refs-test-workspace' },
    ]);

    const admin = humanCaller(workspaceId, memberId, 'member', consoleUser('admin'));
    const adminResult = (await dispatchCapability({ pool }, admin, 'resolve_refs', {
      ids: [workspaceId, otherWorkspaceId],
    })) as { items: readonly ResolvedRefRow[] };
    const adminById = new Map(adminResult.items.map((item) => [item.id, item]));
    expect(adminById.get(workspaceId)).toEqual({
      id: workspaceId,
      kind: 'workspace',
      name: 'resolve-refs-test-workspace',
    });
    expect(adminById.get(otherWorkspaceId)).toEqual({
      id: otherWorkspaceId,
      kind: 'workspace',
      name: 'resolve-refs-test-other-workspace',
    });

    // A console session that is signed in but not a platform administrator gets no extra reach.
    const nonAdmin = humanCaller(workspaceId, memberId, 'member', consoleUser('user'));
    const nonAdminResult = (await dispatchCapability({ pool }, nonAdmin, 'resolve_refs', {
      ids: [otherWorkspaceId],
    })) as { items: readonly ResolvedRefRow[] };
    expect(nonAdminResult.items).toEqual([]);
  });
});
