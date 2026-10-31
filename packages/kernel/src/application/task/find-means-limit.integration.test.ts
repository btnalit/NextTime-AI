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
  deprecateWorkerDefinition,
  proposeProcedure,
  proposeWorkerDefinition,
  publishProcedure,
  publishWorkerDefinition,
} from '../worker/index.js';
import {
  FIND_MEANS_CANDIDATE_PAGE_SIZE,
  findOperations,
  findProcedures,
  findWorkers,
} from './service.js';

/**
 * application/task/find-means-limit.integration.test: legacy 291 — `find_workers` /
 * `find_operations` / `find_procedures` apply their result `limit` *after* the caller filters, so
 * candidates the caller cannot use never take result slots. Every fixture publishes the usable
 * candidate first and the filtered ones afterwards: the candidate query ranks equal-rank rows by
 * `updated_at desc`, so the filtered ones come first — exactly the order that used to hide the
 * usable one behind them. DB-gated (real Postgres; auto-skip without DATABASE_URL); its own
 * workspace so no other suite's rows share the ranking.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** One keyword token (see find-procedures.integration.test.ts's `uniqueNeed` for why). */
function uniqueNeed(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '')}`;
}

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
  'application/task find_* limit after filtering (legacy 291, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;

    async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function newActivity(): Promise<string> {
      return inTx(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.find-means-limit', 'running', $2) returning id`,
          [workspaceId, ownerId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('failed to insert test activity');
        return row.id;
      });
    }

    /** Each publish in its own transaction, so `updated_at` (now()) strictly increases. */
    async function publishedWorker(
      name: string,
      extra: { capabilities?: string[]; gates?: string[] } = {},
    ): Promise<string> {
      const draft = await inTx((client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'A test worker.', name, ...extra },
        }),
      );
      await inTx((client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: draft.id,
          version: draft.version,
        }),
      );
      return draft.id;
    }

    async function publishedOperation(mode: 'observe' | 'execute', name: string): Promise<string> {
      const op = testOperation({ mode, name });
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
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'find-means-limit-test',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      const act = await newActivity();
      const gate = await inTx((client) =>
        registerGatekeeper(client, workspaceId, {
          name: 'find-means-limit-gate',
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

    it('find_workers: excluded, deprecated and non-invocable definitions do not take result slots', async () => {
      const need = uniqueNeed('limitworkers');
      const usableA = await publishedWorker(`${need}a`);
      const usableB = await publishedWorker(`${need}b`);
      const excluded = await publishedWorker(`${need}excluded`);
      await publishedWorker(`${need}execute`, {
        capabilities: ['<gate>.<op>:execute'],
        gates: [gatekeeperId],
      });
      const deprecated = await publishedWorker(`${need}deprecated`);
      await inTx((client) =>
        deprecateWorkerDefinition(client, workspaceId, { definitionId: deprecated, version: 1 }),
      );

      const matches = await inTx((client) =>
        findWorkers(
          client,
          workspaceId,
          { parentAuthority: entryScope(), excludedWorkerDefinitionIds: [excluded] },
          need,
          2,
        ),
      );

      expect(matches.map((m) => m.definitionId).sort()).toEqual([usableA, usableB].sort());
    });

    it('find_workers: a usable match behind more than one candidate page of filtered ones is still found', async () => {
      const need = uniqueNeed('limitpages');
      const usable = await publishedWorker(`${need}usable`);
      const excluded: string[] = [];
      for (let i = 0; i < FIND_MEANS_CANDIDATE_PAGE_SIZE + 5; i += 1) {
        excluded.push(await publishedWorker(`${need}excluded${i}`));
      }

      const matches = await inTx((client) =>
        findWorkers(
          client,
          workspaceId,
          { parentAuthority: entryScope(), excludedWorkerDefinitionIds: excluded },
          need,
        ),
      );

      expect(matches.map((m) => m.definitionId)).toEqual([usable]);
    });

    it('find_operations: execute Operations outside the caller scope do not take result slots', async () => {
      const need = uniqueNeed('limitops');
      const observeName = await publishedOperation('observe', `${need}.observe`);
      for (let i = 0; i < 3; i += 1) {
        await publishedOperation('execute', `${need}.execute${i}`);
      }

      const matches = await inTx((client) =>
        findOperations(client, workspaceId, { parentAuthority: entryScope() }, need, 1),
      );

      expect(matches.map((m) => m.identityKey?.name)).toEqual([observeName]);
    });

    it('find_procedures: Procedures with a step the caller cannot run do not take result slots', async () => {
      const need = uniqueNeed('limitprocs');
      const observeOp = await publishedOperation('observe', `${need}.observestep`);
      const executeWorker = await publishedWorker(`${need}executeworker`, {
        capabilities: ['<gate>.<op>:execute'],
        gates: [gatekeeperId],
      });

      const usable = await inTx((client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: `${need}usable`,
          description: 'Observe only.',
          steps: [{ kind: 'operation', gatekeeperId, operationName: observeOp }],
        }),
      );
      await inTx((client) => publishProcedure(client, workspaceId, ownerId, usable.id));
      for (let i = 0; i < 3; i += 1) {
        const blocked = await inTx((client) =>
          proposeProcedure(client, workspaceId, ownerId, {
            name: `${need}blocked${i}`,
            description: 'A worker step the caller could never invoke.',
            steps: [{ kind: 'worker', definitionId: executeWorker, version: 1 }],
          }),
        );
        await inTx((client) => publishProcedure(client, workspaceId, ownerId, blocked.id));
      }

      // The caller's gate scope covers the observe step; the worker step needs execute-class
      // capabilities an entry scope never holds.
      const matches = await inTx((client) =>
        findProcedures(
          client,
          workspaceId,
          { parentAuthority: entryScope({ resources: { gatekeeper: [gatekeeperId] } }) },
          need,
          1,
        ),
      );

      expect(matches.map((m) => m.procedureId)).toEqual([usable.id]);
    });

    it('a limit of zero returns nothing without reading candidates', async () => {
      const matches = await inTx((client) =>
        findWorkers(client, workspaceId, { parentAuthority: entryScope() }, '', 0),
      );
      expect(matches).toEqual([]);
    });
  },
);
