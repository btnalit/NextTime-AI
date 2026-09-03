import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import { IllegalTransition } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { importManifest, publishOperation } from '../../governance/gatekeepers/manifest.js';
import { registerGatekeeper } from '../../governance/gatekeepers/registry.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from './definitions.js';
import {
  ProcedureNotFoundError,
  ProcedureStepReferenceError,
  deprecateProcedure,
  listProcedures,
  proposeProcedure,
  publishProcedure,
} from './procedures.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL — same pattern as
 * application/worker/definitions.test.ts / skills.test.ts) for the Procedure registry:
 * propose/publish/deprecate, publish-time step reference validation against the graph
 * (docs/development-tasks.md S2.14 acceptance: "Procedure 的步骤引用不存在的 Operation 时发布被拒"),
 * draft read-privacy (I16), and the publish-time `Procedure --steps--> …` graph links.
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
  'application/worker/procedures (integration, real Postgres)',
  () => {
    let pool: Pool;
    const graphStore = new SqlGraphStore();
    let workspaceId: string;
    let ownerId: string;
    let proposerId: string;
    let otherPrincipalId: string;
    let gatekeeperId: string;
    let publishedOperationName: string;
    let publishedWorkerDefinitionId: string;
    let publishedWorkerDefinitionVersion: number;

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

    async function adminInsertPrincipal(kind: string, displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, 'member', $4)",
            [workspaceId, id, kind, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function inTx<T>(
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    async function newActivity(): Promise<string> {
      return inTx(ownerId, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.procedures', 'running', $2) returning id`,
          [workspaceId, ownerId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('failed to insert test activity');
        return row.id;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('procedures-test-workspace');
      ownerId = await adminInsertPrincipal('human', 'owner');
      proposerId = await adminInsertPrincipal('agent', 'proposer-agent');
      otherPrincipalId = await adminInsertPrincipal('human', 'other-user');

      const act = await newActivity();
      const gate = await inTx(ownerId, (client) =>
        registerGatekeeper(client, workspaceId, {
          name: 'procedures-test-gate',
          transportKind: 'http',
          target: 'example-system',
          endpoint: 'https://gate.example.invalid',
          activityId: act,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );
      gatekeeperId = gate.gatekeeperId;

      const op = testOperation();
      publishedOperationName = op.name;
      const importAct = await newActivity();
      await inTx(ownerId, (client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [op],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: importAct,
        }),
      );
      await inTx(ownerId, (client) =>
        publishOperation(client, workspaceId, { gatekeeperId, name: op.name }),
      );

      const workerDraft = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You are a plain worker.' },
        }),
      );
      const workerDef = await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: workerDraft.id,
          version: workerDraft.version,
        }),
      );
      publishedWorkerDefinitionId = workerDef.id;
      publishedWorkerDefinitionVersion = workerDef.version;
    });

    afterAll(async () => {
      await pool.end();
    });

    function operationStepProcedure(name: string) {
      return {
        name,
        description: 'A procedure with one operation step.',
        steps: [
          {
            kind: 'operation' as const,
            gatekeeperId,
            operationName: publishedOperationName,
          },
        ],
      };
    }

    describe('propose', () => {
      it('creates a draft version-1 row owned by the proposer', async () => {
        const row = await inTx(proposerId, (client) =>
          proposeProcedure(
            client,
            workspaceId,
            proposerId,
            operationStepProcedure(`proc-${randomUUID()}`),
          ),
        );
        expect(row.version).toBe(1);
        expect(row.status).toBe('draft');
        expect(row.proposedBy).toBe(proposerId);
      });

      it('propose does not validate step references (a bogus reference is accepted as a draft)', async () => {
        const row = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            name: `proc-bogus-${randomUUID()}`,
            description: 'References nothing real.',
            steps: [
              { kind: 'operation', gatekeeperId: randomUUID(), operationName: 'does.not.exist' },
            ],
          }),
        );
        expect(row.status).toBe('draft');
      });
    });

    describe('draft privacy (I16)', () => {
      it('a draft Procedure is visible to its own proposer via listProcedures but not to another principal', async () => {
        const unique = `proc-private-${randomUUID()}`;
        await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, operationStepProcedure(unique)),
        );

        const ownList = await inTx(proposerId, (client) =>
          listProcedures(client, workspaceId, proposerId),
        );
        expect(ownList.some((p) => p.name === unique)).toBe(true);

        const otherList = await inTx(otherPrincipalId, (client) =>
          listProcedures(client, workspaceId, otherPrincipalId),
        );
        expect(otherList.some((p) => p.name === unique)).toBe(false);
      });

      it('after publish, the Procedure becomes visible to every principal', async () => {
        const unique = `proc-published-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, operationStepProcedure(unique)),
        );
        await inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, draft.id));

        const otherList = await inTx(otherPrincipalId, (client) =>
          listProcedures(client, workspaceId, otherPrincipalId),
        );
        expect(otherList.some((p) => p.name === unique && p.status === 'published')).toBe(true);
      });
    });

    describe('publish — step reference validation', () => {
      it('publishes a procedure whose operation step resolves to a published Operation, and projects steps links', async () => {
        const unique = `proc-valid-op-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, operationStepProcedure(unique)),
        );
        const published = await inTx(ownerId, (client) =>
          publishProcedure(client, workspaceId, ownerId, draft.id),
        );
        expect(published.status).toBe('published');

        const procedureObject = await inTx(ownerId, (client) =>
          graphStore.getObjectByIdentity(client, workspaceId, 'Procedure', {
            procedureId: draft.id,
            version: draft.version,
          }),
        );
        expect(procedureObject).not.toBeNull();

        const neighbors = await inTx(ownerId, (client) =>
          graphStore.neighbors(client, workspaceId, {
            objectId: procedureObject?.id as string,
            direction: 'out',
            linkType: 'steps',
          }),
        );
        expect(neighbors).toHaveLength(1);
      });

      it('publishes a procedure whose worker step resolves to a published WorkerDefinition', async () => {
        const unique = `proc-valid-worker-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            name: unique,
            description: 'A procedure with one worker step.',
            steps: [
              {
                kind: 'worker',
                definitionId: publishedWorkerDefinitionId,
                version: publishedWorkerDefinitionVersion,
              },
            ],
          }),
        );
        const published = await inTx(ownerId, (client) =>
          publishProcedure(client, workspaceId, ownerId, draft.id),
        );
        expect(published.status).toBe('published');
      });

      it('publishes a procedure whose approval/verify steps have no external reference', async () => {
        const unique = `proc-approval-verify-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            name: unique,
            description: 'Approval and verify steps only, plus one real operation step.',
            steps: [
              { kind: 'operation', gatekeeperId, operationName: publishedOperationName },
              { kind: 'approval', description: 'A human must approve.' },
              { kind: 'verify', description: 'Confirm the effect took.' },
            ],
          }),
        );
        const published = await inTx(ownerId, (client) =>
          publishProcedure(client, workspaceId, ownerId, draft.id),
        );
        expect(published.status).toBe('published');
      });

      it('rejects publishing a procedure with zero steps', async () => {
        const draft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            name: `proc-empty-${randomUUID()}`,
            description: 'No steps.',
            steps: [],
          }),
        );
        await expect(
          inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, draft.id)),
        ).rejects.toThrow(ProcedureStepReferenceError);
      });

      it('rejects publishing a procedure whose operation step references a nonexistent Operation, leaving the row in draft', async () => {
        const draft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            name: `proc-bad-op-${randomUUID()}`,
            description: 'References an Operation that does not exist.',
            steps: [
              { kind: 'operation', gatekeeperId, operationName: `nonexistent.${randomUUID()}` },
            ],
          }),
        );
        await expect(
          inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, draft.id)),
        ).rejects.toThrow(ProcedureStepReferenceError);

        const stillDraft = await inTx(ownerId, (client) =>
          listProcedures(client, workspaceId, ownerId),
        );
        expect(stillDraft.find((p) => p.id === draft.id)).toBeUndefined(); // draft, not owned by ownerId
      });

      it('rejects publishing a procedure whose operation step references an unpublished (draft) Operation', async () => {
        const draftOp = testOperation();
        const importAct = await newActivity();
        await inTx(ownerId, (client) =>
          importManifest(client, workspaceId, {
            gatekeeperId,
            operations: [draftOp],
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: importAct,
          }),
        );

        const draft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            name: `proc-draft-op-${randomUUID()}`,
            description: 'References a draft (unpublished) Operation.',
            steps: [{ kind: 'operation', gatekeeperId, operationName: draftOp.name }],
          }),
        );
        await expect(
          inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, draft.id)),
        ).rejects.toThrow(ProcedureStepReferenceError);
      });

      it('rejects publishing a procedure whose worker step references an unpublished WorkerDefinition', async () => {
        const unpublishedWorker = await inTx(ownerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, ownerId, {
            kind: 'worker',
            definition: { systemPrompt: 'Never published.' },
          }),
        );
        const draft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            name: `proc-draft-worker-${randomUUID()}`,
            description: 'References a draft (unpublished) WorkerDefinition.',
            steps: [
              {
                kind: 'worker',
                definitionId: unpublishedWorker.id,
                version: unpublishedWorker.version,
              },
            ],
          }),
        );
        await expect(
          inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, draft.id)),
        ).rejects.toThrow(ProcedureStepReferenceError);
      });
    });

    describe('deprecate', () => {
      it('deprecates a published version, and rejects deprecating a draft', async () => {
        const unique = `proc-deprecate-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, operationStepProcedure(unique)),
        );
        await expect(
          inTx(ownerId, (client) => deprecateProcedure(client, workspaceId, draft.id)),
        ).rejects.toThrow(IllegalTransition);

        await inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, draft.id));
        const deprecated = await inTx(ownerId, (client) =>
          deprecateProcedure(client, workspaceId, draft.id),
        );
        expect(deprecated.status).toBe('deprecated');
      });

      it('throws ProcedureNotFoundError for a nonexistent id', async () => {
        await expect(
          inTx(ownerId, (client) => deprecateProcedure(client, workspaceId, randomUUID())),
        ).rejects.toThrow(ProcedureNotFoundError);
      });
    });
  },
);
