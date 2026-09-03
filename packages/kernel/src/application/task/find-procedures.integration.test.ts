import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { entryScope } from '../../governance/capability/index.js';
import { importManifest, publishOperation } from '../../governance/gatekeepers/manifest.js';
import { registerGatekeeper } from '../../governance/gatekeepers/registry.js';
import {
  deprecateProcedure,
  proposeProcedure,
  proposeWorkerDefinition,
  publishProcedure,
  publishWorkerDefinition,
} from '../worker/index.js';
import { findProcedures } from './service.js';

/**
 * application/task/find-procedures.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) tests for `find_procedures`'s Grant-intersection half (S2.14; design doc §9.3
 * "find_* 与调用者 Grant 取交集", mirroring reaper.integration.test.ts's own `find_workers` describe
 * block for `findWorkers`). Split into its own file rather than added to that one — a Procedure
 * needs a real Gatekeeper + Operation fixture `find_workers`'s tests do not, and reaper.
 * integration.test.ts's own scope is the ActionRequest routing consumer, not `find_*`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function testOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    name: `test.op.${randomUUID()}`,
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

describe.runIf(DATABASE_URL !== undefined)(
  'application/task find_procedures (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;

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

    async function adminInsertPrincipal(displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', $3)",
            [workspaceId, id, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function newActivity(): Promise<string> {
      return inTx(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.find-procedures', 'running', $2) returning id`,
          [workspaceId, ownerId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('failed to insert test activity');
        return row.id;
      });
    }

    async function publishedOperation(mode: 'observe' | 'execute'): Promise<string> {
      const op = testOperation({ mode });
      const act = await newActivity();
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [op],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: act,
        }),
      );
      await inTx((client) =>
        publishOperation(client, workspaceId, { gatekeeperId, name: op.name }),
      );
      return op.name;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('find-procedures-test-workspace');
      ownerId = await adminInsertPrincipal('owner');

      const act = await newActivity();
      const gate = await inTx((client) =>
        registerGatekeeper(client, workspaceId, {
          name: 'find-procedures-test-gate',
          transportKind: 'http',
          target: 'example-system',
          endpoint: 'https://gate.example.invalid',
          activityId: act,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );
      gatekeeperId = gate.gatekeeperId;
    });

    afterAll(async () => {
      await pool.end();
    });

    it('finds a published Procedure by need matching its name/description', async () => {
      const opName = await publishedOperation('observe');
      const unique = `restock-alert-${randomUUID()}`;
      const draft = await inTx((client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: unique,
          description: 'Checks stock levels and alerts when low.',
          steps: [{ kind: 'operation', gatekeeperId, operationName: opName }],
        }),
      );
      await inTx((client) => publishProcedure(client, workspaceId, ownerId, draft.id));

      const matches = await inTx((client) =>
        findProcedures(client, workspaceId, { parentAuthority: entryScope() }, unique),
      );
      expect(matches.some((m) => m.procedureId === draft.id)).toBe(true);
    });

    it('excludes a draft Procedure (never published)', async () => {
      const opName = await publishedOperation('observe');
      const unique = `draft-only-${randomUUID()}`;
      await inTx((client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: unique,
          description: 'Never published.',
          steps: [{ kind: 'operation', gatekeeperId, operationName: opName }],
        }),
      );

      const matches = await inTx((client) =>
        findProcedures(client, workspaceId, { parentAuthority: entryScope() }, unique),
      );
      expect(matches).toEqual([]);
    });

    it('excludes a deprecated Procedure', async () => {
      const opName = await publishedOperation('observe');
      const unique = `deprecated-${randomUUID()}`;
      const draft = await inTx((client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: unique,
          description: 'Will be deprecated.',
          steps: [{ kind: 'operation', gatekeeperId, operationName: opName }],
        }),
      );
      await inTx((client) => publishProcedure(client, workspaceId, ownerId, draft.id));
      await inTx((client) => deprecateProcedure(client, workspaceId, draft.id));

      const matches = await inTx((client) =>
        findProcedures(client, workspaceId, { parentAuthority: entryScope() }, unique),
      );
      expect(matches).toEqual([]);
    });

    it('includes a Procedure whose only step is an observe-mode Operation, for an entry (no-gate) caller', async () => {
      const opName = await publishedOperation('observe');
      const unique = `observe-only-${randomUUID()}`;
      const draft = await inTx((client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: unique,
          description: 'Read-only.',
          steps: [{ kind: 'operation', gatekeeperId, operationName: opName }],
        }),
      );
      await inTx((client) => publishProcedure(client, workspaceId, ownerId, draft.id));

      // entryScope() never holds any gatekeeper resource — an observe-mode step must still pass
      // (design doc §11 "observation is ungated by design").
      const matches = await inTx((client) =>
        findProcedures(client, workspaceId, { parentAuthority: entryScope() }, unique),
      );
      expect(matches.some((m) => m.procedureId === draft.id)).toBe(true);
    });

    it('excludes a Procedure whose step is an execute-mode Operation, for a caller whose scope does not cover that Gatekeeper', async () => {
      const opName = await publishedOperation('execute');
      const unique = `execute-ungranted-${randomUUID()}`;
      const draft = await inTx((client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: unique,
          description: 'Writes something.',
          steps: [{ kind: 'operation', gatekeeperId, operationName: opName }],
        }),
      );
      await inTx((client) => publishProcedure(client, workspaceId, ownerId, draft.id));

      const matches = await inTx((client) =>
        findProcedures(client, workspaceId, { parentAuthority: entryScope() }, unique),
      );
      expect(matches.some((m) => m.procedureId === draft.id)).toBe(false);
    });

    it('includes a Procedure whose step is an execute-mode Operation, for a caller whose scope already covers that Gatekeeper', async () => {
      const opName = await publishedOperation('execute');
      const unique = `execute-granted-${randomUUID()}`;
      const draft = await inTx((client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: unique,
          description: 'Writes something the caller may actually do.',
          steps: [{ kind: 'operation', gatekeeperId, operationName: opName }],
        }),
      );
      await inTx((client) => publishProcedure(client, workspaceId, ownerId, draft.id));

      const grantedScope = {
        capabilities: ['request_action'],
        resources: { gatekeeper: [gatekeeperId] },
      };
      const matches = await inTx((client) =>
        findProcedures(client, workspaceId, { parentAuthority: grantedScope }, unique),
      );
      expect(matches.some((m) => m.procedureId === draft.id)).toBe(true);
    });

    it('excludes a Procedure whose worker step the caller could never invoke (execute-class need it does not hold)', async () => {
      const workerDraft = await inTx((client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: {
            systemPrompt: 'You need real gate access.',
            capabilities: ['<gate>.<op>:execute'],
            gates: ['gk-somewhere'],
          },
        }),
      );
      const workerDef = await inTx((client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: workerDraft.id,
          version: workerDraft.version,
        }),
      );

      const unique = `worker-step-ungranted-${randomUUID()}`;
      const draft = await inTx((client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: unique,
          description: 'A worker step the caller cannot invoke.',
          steps: [{ kind: 'worker', definitionId: workerDef.id, version: workerDef.version }],
        }),
      );
      await inTx((client) => publishProcedure(client, workspaceId, ownerId, draft.id));

      const matches = await inTx((client) =>
        findProcedures(client, workspaceId, { parentAuthority: entryScope() }, unique),
      );
      expect(matches.some((m) => m.procedureId === draft.id)).toBe(false);
    });

    it('is unconstrained (includes everything usable) for an "unconstrained" caller (owner, human channel)', async () => {
      const opName = await publishedOperation('execute');
      const unique = `unconstrained-${randomUUID()}`;
      const draft = await inTx((client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: unique,
          description: 'Only an unconstrained caller sees this without an explicit grant.',
          steps: [{ kind: 'operation', gatekeeperId, operationName: opName }],
        }),
      );
      await inTx((client) => publishProcedure(client, workspaceId, ownerId, draft.id));

      const matches = await inTx((client) =>
        findProcedures(client, workspaceId, { parentAuthority: 'unconstrained' }, unique),
      );
      expect(matches.some((m) => m.procedureId === draft.id)).toBe(true);
    });
  },
);
