import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { entryScope, grantCapability } from '../../governance/capability/index.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { findWorkers } from '../task/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/execution-readiness-handler.integration: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) proof for `execution_readiness` (S8 W1-C) — same `dispatchCapability`
 * end-to-end style `members-flow.integration.test.ts` already established for this file's sibling
 * S3.11 capabilities.
 *
 * **The invariant this file pins** (dispatch's own instruction: "a fixture where readiness says
 * ready: true and the delegation path accepts, and one per missing code where it refuses"): every
 * `ready`/`delegable` assertion below is cross-checked against `findWorkers` — the *actual*
 * `find_workers` production dry run (`application/task/service.ts`), built from the caller's real,
 * freshly-read Grant coverage (`listActiveGrantResourceScopes`) rather than a hand-rolled scope —
 * so a future change to `computeChildHandleScope`'s own decision (which both `execution_readiness`
 * and `findWorkers` call) that silently diverges between the two call sites fails this test, not
 * just a unit test of `execution-readiness-handler.ts` in isolation.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

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

interface ExecutionReadinessResult {
  readonly principalId: string;
  readonly ready: boolean;
  readonly missing: readonly { readonly code: string; readonly gateId?: string }[];
  readonly gates: readonly {
    readonly gateId: string;
    readonly name: string;
    readonly granted: boolean;
    readonly publishedOperationCount: number;
  }[];
  readonly workers: readonly {
    readonly definitionId: string;
    readonly version: number;
    readonly name?: string;
    readonly delegable: boolean;
    readonly blockedBy: readonly { readonly code: string; readonly gateId?: string }[];
  }[];
}

describe.runIf(DATABASE_URL !== undefined)(
  'execution_readiness (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;

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
          target: `execution-readiness-test-system-${name}`,
          endpoint: `https://gate.execution-readiness-test.invalid/${name}`,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        return gatekeeperId;
      });
    }

    /** Publishes a `kind=worker` WorkerDefinition declaring `request_action` (execute-class) and
     *  `gates: [gatekeeperId]` — the shape `computeChildHandleScope` rejects unless the caller's
     *  own scope already covers `gatekeeperId` (see `handle-mint.ts`'s own doc comment: an
     *  execute-class declared need is never silently dropped). */
    async function adminPublishExecuteWorker(
      name: string,
      gatekeeperId: string,
    ): Promise<{ definitionId: string; version: number }> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const draft = await proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: {
            systemPrompt: 'You act on the registered gate.',
            name,
            capabilities: ['request_action'],
            gates: [gatekeeperId],
          },
        });
        const published = await publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: draft.id,
          version: draft.version,
        });
        return { definitionId: published.id, version: published.version };
      });
    }

    /** The real `find_workers` production dry run (`application/task/service.ts`'s `findWorkers`)
     *  against `principalId`'s *current, freshly-read* Grant coverage — the independent
     *  cross-check this file's own module doc comment describes. */
    async function definitionIsFindable(
      principalId: string,
      role: Role,
      definitionId: string,
    ): Promise<boolean> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const grantedResult = await client.query<{ resource_id: string }>(
          `select distinct resource_id from capability_grants
           where workspace_id = $1 and principal_id = $2 and resource_type = 'gatekeeper'
             and status = 'active' and (expires_at is null or expires_at > now())
             and resource_id is not null`,
          [workspaceId, principalId],
        );
        const gatekeeperIds = grantedResult.rows.map((row) => row.resource_id);
        const parentAuthority = entryScope(
          gatekeeperIds.length > 0 ? { resources: { gatekeeper: gatekeeperIds } } : {},
          { role },
        );
        const matches = await findWorkers(client, workspaceId, { parentAuthority }, '');
        return matches.some((match) => match.definitionId === definitionId);
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('execution-readiness-test-workspace');
      ownerId = await adminInsertPrincipal('owner', 'owner');
      memberId = await adminInsertPrincipal('member', 'member-one');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('no enabled gate and no published worker: ready:false with both structural missing codes', async () => {
      const freshWorkspaceId = await adminInsertWorkspace('execution-readiness-empty-workspace');
      const freshOwnerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: freshWorkspaceId, principalId: freshOwnerId },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [freshWorkspaceId, freshOwnerId],
          );
        },
        { skipRoleSwitch: true },
      );
      const owner = humanCaller(freshWorkspaceId, freshOwnerId, 'owner');

      const result = (await dispatchCapability(
        { pool },
        owner,
        'execution_readiness',
        {},
      )) as ExecutionReadinessResult;

      expect(result.principalId).toBe(freshOwnerId);
      expect(result.ready).toBe(false);
      expect(result.gates).toEqual([]);
      expect(result.workers).toEqual([]);
      expect(result.missing).toEqual(
        expect.arrayContaining([{ code: 'no_enabled_gate' }, { code: 'no_published_worker' }]),
      );
    });

    it('published worker + registered gate, no grant: ready:false, no_grant, agrees with findWorkers refusing', async () => {
      const gatekeeperId = await adminRegisterGatekeeper('gate-ungranted');
      const { definitionId } = await adminPublishExecuteWorker('worker-ungranted', gatekeeperId);

      const member = humanCaller(workspaceId, memberId, 'member');
      const result = (await dispatchCapability(
        { pool },
        member,
        'execution_readiness',
        {},
      )) as ExecutionReadinessResult;

      const gate = result.gates.find((g) => g.gateId === gatekeeperId);
      expect(gate).toEqual({
        gateId: gatekeeperId,
        name: 'gate-ungranted',
        granted: false,
        publishedOperationCount: 0,
      });

      const worker = result.workers.find((w) => w.definitionId === definitionId);
      expect(worker?.delegable).toBe(false);
      expect(worker?.blockedBy).toEqual([
        { code: 'no_grant', gateId: gatekeeperId, workerDefinitionId: definitionId },
      ]);
      expect(result.missing).toEqual(
        expect.arrayContaining([{ code: 'no_grant', gateId: gatekeeperId }]),
      );
      expect(result.ready).toBe(false);

      // Pin: findWorkers (the real find_workers dry run) agrees this definition is not usable.
      expect(await definitionIsFindable(memberId, 'member', definitionId)).toBe(false);
    });

    it('after grant_capability for the gate: ready:true, delegable:true, agrees with findWorkers accepting', async () => {
      const gatekeeperId = await adminRegisterGatekeeper('gate-granted');
      const { definitionId } = await adminPublishExecuteWorker('worker-granted', gatekeeperId);

      // Confirm the pre-grant refusal once more for this fresh gate/worker pair (same shape as
      // the previous test, scoped to this test's own fixtures).
      const memberBefore = humanCaller(workspaceId, memberId, 'member');
      const before = (await dispatchCapability(
        { pool },
        memberBefore,
        'execution_readiness',
        {},
      )) as ExecutionReadinessResult;
      expect(before.workers.find((w) => w.definitionId === definitionId)?.delegable).toBe(false);

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        grantCapability(client, workspaceId, {
          principalId: memberId,
          resourceType: 'gatekeeper',
          resourceId: gatekeeperId,
          grantedBy: ownerId,
        }),
      );

      const member = humanCaller(workspaceId, memberId, 'member');
      const result = (await dispatchCapability(
        { pool },
        member,
        'execution_readiness',
        {},
      )) as ExecutionReadinessResult;

      const gate = result.gates.find((g) => g.gateId === gatekeeperId);
      expect(gate?.granted).toBe(true);

      const worker = result.workers.find((w) => w.definitionId === definitionId);
      expect(worker?.delegable).toBe(true);
      expect(worker?.blockedBy).toEqual([]);
      expect(result.ready).toBe(true);
      expect(result.missing.some((m) => m.code === 'no_grant' && m.gateId === gatekeeperId)).toBe(
        false,
      );

      // Pin: findWorkers (the real find_workers dry run) now agrees this definition is usable.
      expect(await definitionIsFindable(memberId, 'member', definitionId)).toBe(true);
    });

    it('defaults to the caller’s own readiness; an operator+ may read another principal’s, a plain member may not', async () => {
      const operatorId = await adminInsertPrincipal('operator', 'operator-one');
      const otherMemberId = await adminInsertPrincipal('member', 'member-two');

      const self = humanCaller(workspaceId, memberId, 'member');
      const selfResult = (await dispatchCapability(
        { pool },
        self,
        'execution_readiness',
        {},
      )) as ExecutionReadinessResult;
      expect(selfResult.principalId).toBe(memberId);

      const operator = humanCaller(workspaceId, operatorId, 'operator');
      const asOperator = (await dispatchCapability({ pool }, operator, 'execution_readiness', {
        principalId: memberId,
      })) as ExecutionReadinessResult;
      expect(asOperator.principalId).toBe(memberId);

      const otherMember = humanCaller(workspaceId, otherMemberId, 'member');
      await expect(
        dispatchCapability({ pool }, otherMember, 'execution_readiness', {
          principalId: memberId,
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  },
);
