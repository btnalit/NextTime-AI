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
import { discardDraft } from './draft-lifecycle.js';
import { FamilyDraftPendingError } from './family-version.js';
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
    let entryDefinitionId: string;
    let entryDefinitionVersion: number;

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

      // Legacy 486: an entry definition, published — never a step.
      const entryDraft = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'entry',
          definition: { systemPrompt: 'You are the entry agent.', capabilities: ['get_object'] },
        }),
      );
      const entryDef = await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: entryDraft.id,
          version: entryDraft.version,
        }),
      );
      entryDefinitionId = entryDef.id;
      entryDefinitionVersion = entryDef.version;
    });

    /** Legacy 486: a draft written as the kernel wrote it before propose checked a worker step's
     *  kind. */
    async function legacyDraft(steps: readonly unknown[]): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: proposerId },
        async (client) => {
          await client.query(
            `insert into procedures (workspace_id, id, version, status, name, description, steps, proposed_by)
             values ($1, $2, 1, 'draft', $3, 'Written before propose checked the kind.', $4::jsonb, $5)`,
            [workspaceId, id, `proc-legacy-${id}`, JSON.stringify(steps), proposerId],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

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

    describe('a worker step names a worker-kind definition (legacy 486)', () => {
      it('propose refuses a worker step naming an entry definition, and writes nothing', async () => {
        const name = `proc-entry-step-${randomUUID()}`;
        const refused = inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            name,
            description: 'Runs the entry agent as a step.',
            steps: [
              { kind: 'approval', description: 'A human approves.' },
              { kind: 'worker', definitionId: entryDefinitionId, version: entryDefinitionVersion },
            ],
          }),
        );
        await expect(refused).rejects.toThrow(ProcedureStepReferenceError);
        await expect(refused).rejects.toMatchObject({
          stepIndex: 1,
          message: expect.stringMatching(
            /is entry-kind: a step runs only a worker-kind WorkerDefinition/,
          ),
        });
        // Any version of an entry family: its kind never changes.
        await expect(
          inTx(proposerId, (client) =>
            proposeProcedure(client, workspaceId, proposerId, {
              name,
              description: 'Names a version the entry family does not have yet.',
              steps: [{ kind: 'worker', definitionId: entryDefinitionId, version: 99 }],
            }),
          ),
        ).rejects.toThrow(/is entry-kind/);
        const written = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query('select 1 from procedures where workspace_id = $1 and name = $2', [
              workspaceId,
              name,
            ]),
          { skipRoleSwitch: true },
        );
        expect(written.rowCount).toBe(0);
      });

      it('propose still takes a worker step naming a definition not visible yet (publish decides)', async () => {
        const row = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            name: `proc-unknown-worker-${randomUUID()}`,
            description: 'Names a WorkerDefinition that does not exist yet.',
            steps: [{ kind: 'worker', definitionId: randomUUID(), version: 1 }],
          }),
        );
        expect(row.status).toBe('draft');
      });

      it('propose reads the family as its proposer sees it: another principal’s entry draft reads as an id nothing has (I16, review #493 N1)', async () => {
        const othersDraft = await inTx(otherPrincipalId, (client) =>
          proposeWorkerDefinition(client, workspaceId, otherPrincipalId, {
            kind: 'entry',
            definition: { systemPrompt: 'A private entry draft.', capabilities: ['get_object'] },
          }),
        );
        const propose = (principalId: string, definitionId: string, version: number) =>
          inTx(principalId, (client) =>
            proposeProcedure(client, workspaceId, principalId, {
              name: `proc-draft-family-${randomUUID()}`,
              description: 'Names a WorkerDefinition family that has only a draft.',
              steps: [{ kind: 'worker', definitionId, version }],
            }),
          );
        // Someone else's draft family and an id nothing has are answered alike: publish decides.
        expect((await propose(proposerId, othersDraft.id, othersDraft.version)).status).toBe(
          'draft',
        );
        expect((await propose(proposerId, randomUUID(), othersDraft.version)).status).toBe('draft');
        // Its own proposer sees the draft, and its kind.
        await expect(
          propose(otherPrincipalId, othersDraft.id, othersDraft.version),
        ).rejects.toThrow(/is entry-kind/);
      });

      it('publish refuses a draft written before propose checked the kind, and leaves it a draft', async () => {
        const id = await legacyDraft([
          { kind: 'worker', definitionId: entryDefinitionId, version: entryDefinitionVersion },
        ]);
        const refused = inTx(ownerId, (client) =>
          publishProcedure(client, workspaceId, ownerId, id),
        );
        await expect(refused).rejects.toThrow(ProcedureStepReferenceError);
        await expect(refused).rejects.toMatchObject({
          stepIndex: 0,
          message: expect.stringMatching(/is entry-kind/),
        });
        const status = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query<{ status: string }>(
              'select status from procedures where workspace_id = $1 and id = $2',
              [workspaceId, id],
            ),
          { skipRoleSwitch: true },
        );
        expect(status.rows[0]?.status).toBe('draft');
      });
    });

    describe('draft privacy (I16)', () => {
      it('a draft Procedure is visible to its own proposer via listProcedures but not to another principal', async () => {
        const unique = `proc-private-${randomUUID()}`;
        await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, operationStepProcedure(unique)),
        );

        const ownList = await inTx(proposerId, (client) =>
          listProcedures(client, workspaceId, { principalId: proposerId, role: 'member' }),
        );
        expect(ownList.items.some((p) => p.name === unique)).toBe(true);

        const otherList = await inTx(otherPrincipalId, (client) =>
          listProcedures(client, workspaceId, { principalId: otherPrincipalId, role: 'member' }),
        );
        expect(otherList.items.some((p) => p.name === unique)).toBe(false);
      });

      it('after publish, the Procedure becomes visible to every principal', async () => {
        const unique = `proc-published-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, operationStepProcedure(unique)),
        );
        await inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, draft.id));

        const otherList = await inTx(otherPrincipalId, (client) =>
          listProcedures(client, workspaceId, { principalId: otherPrincipalId, role: 'member' }),
        );
        expect(otherList.items.some((p) => p.name === unique && p.status === 'published')).toBe(
          true,
        );
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
          listProcedures(client, workspaceId, { principalId: ownerId, role: 'member' }),
        );
        expect(stillDraft.items.find((p) => p.id === draft.id)).toBeUndefined(); // draft, not owned by ownerId
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

    describe('next version of a family (propose_procedure{procedureId}, S11 W1a E2-0)', () => {
      it('proposes version 2 under the same id, and may change the name (a Procedure is addressed by id)', async () => {
        const name = `proc-family-${randomUUID()}`;
        const v1 = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, operationStepProcedure(name)),
        );
        await inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, v1.id));
        const v2 = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            ...operationStepProcedure(`${name}-renamed`),
            procedureId: v1.id,
          }),
        );
        expect(v2).toMatchObject({
          id: v1.id,
          version: 2,
          status: 'draft',
          name: `${name}-renamed`,
        });
      });

      it('an unknown procedureId is not found', async () => {
        await expect(
          inTx(proposerId, (client) =>
            proposeProcedure(client, workspaceId, proposerId, {
              ...operationStepProcedure(`proc-unknown-${randomUUID()}`),
              procedureId: randomUUID(),
            }),
          ),
        ).rejects.toThrow(ProcedureNotFoundError);
      });

      it('refuses while the latest version is a draft (draft_pending) until it is published or discarded; a deprecated family may get a new version', async () => {
        const name = `proc-pending-${randomUUID()}`;
        const v1 = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, operationStepProcedure(name)),
        );
        const next = () =>
          inTx(proposerId, (client) =>
            proposeProcedure(client, workspaceId, proposerId, {
              ...operationStepProcedure(name),
              procedureId: v1.id,
            }),
          );
        await expect(next()).rejects.toMatchObject({
          code: 'draft_pending',
          kind: 'procedure',
          familyId: v1.id,
          draftVersion: 1,
        });

        await inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, v1.id));
        expect((await next()).version).toBe(2);
        await expect(next()).rejects.toThrow(FamilyDraftPendingError);

        await inTx(proposerId, (client) =>
          discardDraft(client, workspaceId, proposerId, {
            kind: 'procedure',
            id: v1.id,
            version: 2,
          }),
        );
        await inTx(ownerId, (client) => deprecateProcedure(client, workspaceId, v1.id));
        expect((await next()).version).toBe(2);
      });

      it('two concurrent next-version proposals: one draft, the other draft_pending', async () => {
        const name = `proc-race-${randomUUID()}`;
        const v1 = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, operationStepProcedure(name)),
        );
        await inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, v1.id));
        const results = await Promise.allSettled(
          [0, 1].map(() =>
            inTx(proposerId, (client) =>
              proposeProcedure(client, workspaceId, proposerId, {
                ...operationStepProcedure(name),
                procedureId: v1.id,
              }),
            ),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          FamilyDraftPendingError,
        );
      });
    });

    describe('next version while the latest draft is being discarded (review #493 on #764, P3-2)', () => {
      it('two proposals waiting on the discard: one draft, the other draft_pending — never a primary-key error', async () => {
        // Holds with the row lock alone too (Postgres moves the lock to v1 once v2 is deleted); the
        // family's advisory lock keeps it from depending on that.
        const name = `proc-discard-race-${randomUUID()}`;
        const v1 = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, operationStepProcedure(name)),
        );
        await inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, v1.id));
        await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, {
            ...operationStepProcedure(name),
            procedureId: v1.id,
          }),
        );

        // The discard deletes v2 and holds its transaction open while two proposals queue up.
        let deleted!: () => void;
        const whenDeleted = new Promise<void>((resolve) => {
          deleted = resolve;
        });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const discard = inTx(proposerId, async (client) => {
          await discardDraft(client, workspaceId, proposerId, {
            kind: 'procedure',
            id: v1.id,
            version: 2,
          });
          deleted();
          await released;
        });
        await whenDeleted;
        const proposals = [0, 1].map(() =>
          inTx(proposerId, (client) =>
            proposeProcedure(client, workspaceId, proposerId, {
              ...operationStepProcedure(name),
              procedureId: v1.id,
            }),
          ),
        );
        // Both are waiting on a lock before the discard commits.
        for (let waited = 0; waited < 100; waited += 1) {
          const waiting = await pool.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
             where wait_event_type = 'Lock' and datname = current_database()`,
          );
          if ((waiting.rows[0]?.n ?? 0) >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        release();
        await discard;

        const results = await Promise.allSettled(proposals);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        expect(fulfilled).toHaveLength(1);
        expect((fulfilled[0] as PromiseFulfilledResult<{ version: number }>).value.version).toBe(2);
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          FamilyDraftPendingError,
        );
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
