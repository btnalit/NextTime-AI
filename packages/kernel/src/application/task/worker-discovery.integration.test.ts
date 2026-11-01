import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Operation,
  type OutputSchema,
  WORKER_HINT_MIN_SAMPLE,
  WORKER_HINT_WINDOW_DAYS,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { entryScope } from '../../governance/capability/index.js';
import { importManifest, publishOperation } from '../../governance/gatekeepers/manifest.js';
import { registerGatekeeper } from '../../governance/gatekeepers/registry.js';
import { NO_OBSERVE_EXCLUSIONS } from '../gates/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { type FindMeansCaller, findWorkers } from './service.js';
import { readWorkerHints } from './worker-discovery.js';

/**
 * application/task/worker-discovery.integration.test (S11 GO13): `find_workers`' contract, gate
 * access, hints and empty-result reason, and `readWorkerHints` over Task records. DB-gated (real
 * Postgres; auto-skip without DATABASE_URL); its own workspace. Task and outcome fixtures are
 * inserted directly with the guards off — their write paths are other modules'; what is under
 * test is how the read counts them.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const DAY_MS = 24 * 60 * 60 * 1000;

function uniqueNeed(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '')}`;
}

const REPORT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: { summary: { type: 'string' }, hosts: { type: 'array', items: { type: 'string' } } },
  required: ['summary'],
};
const INPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: { host: { type: 'string', description: 'which host to check' } },
  required: ['host'],
};

function observeOperation(name: string): Operation {
  return {
    name,
    binding: { kind: 'http', method: 'GET', path: '/stock' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/task worker discovery (S11 GO13, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

    async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    const raw = async (sql: string, params: readonly unknown[] = []): Promise<void> => {
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('set local session_replication_role = replica');
          await client.query(sql, [...params]);
        },
        { skipRoleSwitch: true },
      );
    };

    async function newActivity(): Promise<string> {
      return inTx(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.worker-discovery', 'running', $2) returning id`,
          [workspaceId, ownerId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('failed to insert test activity');
        return row.id;
      });
    }

    async function gate(name: string, observable: boolean): Promise<string> {
      const act = await newActivity();
      const registered = await inTx((client) =>
        registerGatekeeper(client, workspaceId, {
          name,
          transportKind: 'http',
          target: 'example-system',
          endpoint: 'https://gate.example.invalid',
          activityId: act,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );
      if (observable) {
        const op = observeOperation(`test.observe.${randomUUID()}`);
        const opAct = await newActivity();
        await inTx((client) =>
          importManifest(client, workspaceId, {
            gatekeeperId: registered.gatekeeperId,
            operations: [op],
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: opAct,
          }),
        );
        await inTx((client) =>
          publishOperation(client, workspaceId, {
            gatekeeperId: registered.gatekeeperId,
            name: op.name,
          }),
        );
      }
      return registered.gatekeeperId;
    }

    async function publishedWorker(
      name: string,
      extra: Record<string, unknown> = {},
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

    interface TaskFixture {
      readonly definitionId: string;
      readonly status: 'completed' | 'failed' | 'running';
      readonly tokens: number;
      readonly endedDaysAgo?: number;
      readonly purpose?: 'evaluation';
      readonly turnOutcome?: 'achieved' | 'not_achieved';
      readonly agentOutcome?: 'achieved' | 'not_achieved';
    }

    async function task(fixture: TaskFixture): Promise<void> {
      const id = randomUUID();
      const ended = new Date(Date.now() - (fixture.endedDaysAgo ?? 1) * DAY_MS);
      let turnId: string | null = null;
      if (fixture.turnOutcome) {
        turnId = randomUUID();
        await raw(
          `insert into turn_outcomes (workspace_id, turn_id, outcome, given_by, given_at)
           values ($1, $2, $3, $4, $5)`,
          [workspaceId, turnId, fixture.turnOutcome, ownerId, ended],
        );
      }
      await raw(
        `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id,
           worker_definition_version, tokens_used, completed_at, failed_at, created_by_activity_id,
           objective_outcome, outcome_given_by, outcome_given_at, outcome_revision, purpose,
           observe_scope)
         values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::uuid[])`,
        [
          workspaceId,
          id,
          fixture.status,
          ownerId,
          fixture.definitionId,
          fixture.tokens,
          fixture.status === 'completed' ? ended : null,
          fixture.status === 'failed' ? ended : null,
          turnId,
          fixture.agentOutcome ?? null,
          fixture.agentOutcome ? ownerId : null,
          fixture.agentOutcome ? ended : null,
          fixture.agentOutcome ? 1 : null,
          fixture.purpose ?? null,
          fixture.purpose ? [] : null,
        ],
      );
    }

    const find = (caller: FindMeansCaller, need: string) =>
      inTx((client) => findWorkers(client, workspaceId, caller, need));

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
            'worker-discovery-test',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('an empty result says why', () => {
      it('no published Worker matches: no_match', async () => {
        const result = await find({ parentAuthority: entryScope() }, uniqueNeed('nothing'));
        expect(result).toEqual({ items: [], emptyReason: { kind: 'no_match' } });
      });

      it('matches the caller cannot delegate to: all_filtered, counted by reason, none named', async () => {
        const need = uniqueNeed('filtered');
        const excludedA = await publishedWorker(`${need}excludeda`);
        const excludedB = await publishedWorker(`${need}excludedb`);
        // `request_action` is execute-class: an entry Handle with no gate cannot delegate it.
        await publishedWorker(`${need}executes`, { capabilities: ['request_action'] });

        const result = await find(
          { parentAuthority: entryScope(), excludedWorkerDefinitionIds: [excludedA, excludedB] },
          need,
        );
        expect(result).toEqual({
          items: [],
          emptyReason: { kind: 'all_filtered', notDelegable: 1, excludedByProfile: 2 },
        });
      });

      it('a result with items carries no emptyReason', async () => {
        const need = uniqueNeed('found');
        const usable = await publishedWorker(`${need}usable`);
        await publishedWorker(`${need}executes`, { capabilities: ['request_action'] });

        const result = await find({ parentAuthority: entryScope() }, need);
        expect(result.items.map((item) => item.definitionId)).toEqual([usable]);
        expect(result).not.toHaveProperty('emptyReason');
      });
    });

    it('a result carries the contract the Worker declares, and none when it declares none', async () => {
      const need = uniqueNeed('contract');
      const declared = await publishedWorker(`${need}declared`, {
        inputSchema: INPUT_SCHEMA,
        outputSchema: REPORT_SCHEMA,
      });
      const plain = await publishedWorker(`${need}plain`);

      const { items } = await find({ parentAuthority: entryScope() }, need);
      const byId = new Map(items.map((item) => [item.definitionId, item]));
      expect(byId.get(declared)).toMatchObject({
        inputSchema: INPUT_SCHEMA,
        outputSchema: REPORT_SCHEMA,
      });
      expect(byId.get(plain)).not.toHaveProperty('inputSchema');
      expect(byId.get(plain)).not.toHaveProperty('outputSchema');
    });

    it('per declared gate, what a delegated Worker could do there for this caller', async () => {
      const need = uniqueNeed('gates');
      const held = await gate(`${need}-held`, true);
      const readable = await gate(`${need}-readable`, true);
      const excluded = await gate(`${need}-excluded`, true);
      const nothing = await gate(`${need}-nothing`, false);
      // A Worker that requests actions is delegable only with every gate it declares held
      // (`computeChildHandleScope`), so its gates are all `act`.
      const acting = await publishedWorker(`${need}acting`, {
        capabilities: ['request_action', 'observe_operation'],
        gates: [held],
      });
      // One that only observes is delegable whatever it declares: per gate, what it can read.
      const reading = await publishedWorker(`${need}reading`, {
        gates: [held, readable, excluded, nothing],
      });

      const { items } = await find(
        {
          parentAuthority: entryScope({ resources: { gatekeeper: [held] } }),
          observeExclusions: { ...NO_OBSERVE_EXCLUSIONS, profileExcludedGatekeepers: [excluded] },
        },
        need,
      );
      const byId = new Map(items.map((item) => [item.definitionId, item]));
      expect(byId.get(acting)?.gates).toEqual([
        { gatekeeperId: held, name: `${need}-held`, access: 'act' },
      ]);
      expect(byId.get(reading)?.gates).toEqual([
        { gatekeeperId: held, name: `${need}-held`, access: 'observe' },
        { gatekeeperId: readable, name: `${need}-readable`, access: 'observe' },
        {
          gatekeeperId: excluded,
          name: `${need}-excluded`,
          access: 'none',
          reason: 'excluded_by_profile',
        },
        {
          gatekeeperId: nothing,
          name: `${need}-nothing`,
          access: 'none',
          reason: 'no_observable_operation',
        },
      ]);
    });

    describe('hints', () => {
      it('the median tokens and primary outcomes of the version’s ordinary Tasks that ended in the window', async () => {
        const worker = await publishedWorker(uniqueNeed('hinted'));
        for (const [tokens, outcome] of [
          [100, 'achieved'],
          [200, 'achieved'],
          [300, 'not_achieved'],
          [400, 'achieved'],
          [500, 'achieved'],
        ] as const) {
          await task({ definitionId: worker, status: 'completed', tokens, turnOutcome: outcome });
        }
        await task({ definitionId: worker, status: 'failed', tokens: 600 });
        // Not counted: an evaluation's Task, one that ended before the window, one still running,
        // and an agent's own report (a proxy outcome).
        await task({
          definitionId: worker,
          status: 'completed',
          tokens: 9_000,
          purpose: 'evaluation',
        });
        await task({
          definitionId: worker,
          status: 'completed',
          tokens: 9_000,
          endedDaysAgo: WORKER_HINT_WINDOW_DAYS + 1,
          turnOutcome: 'not_achieved',
        });
        await task({ definitionId: worker, status: 'running', tokens: 9_000 });
        await task({
          definitionId: worker,
          status: 'completed',
          tokens: 350,
          agentOutcome: 'achieved',
        });

        const hints = await inTx((client) =>
          readWorkerHints(client, workspaceId, [{ definitionId: worker, version: 1 }]),
        );
        // Tokens 100 200 300 350 400 500 600: the median is 350.
        expect(hints.get(`${worker}@1`)).toEqual({
          windowDays: WORKER_HINT_WINDOW_DAYS,
          minSample: WORKER_HINT_MIN_SAMPLE,
          cost: { medianTokens: 350, tasks: 7, sufficient: true },
          outcomes: { achieved: 4, total: 5, sufficient: true },
        });
      });

      it('exactly the minimum sample is enough: the median is given (#493 on #880)', async () => {
        const worker = await publishedWorker(uniqueNeed('edge'));
        const tokens = [10, 20, 30, 40, 50].slice(0, WORKER_HINT_MIN_SAMPLE);
        for (const [index, used] of tokens.entries()) {
          await task({
            definitionId: worker,
            status: 'completed',
            tokens: used,
            // One short of the sample for outcomes: that side stays insufficient.
            ...(index > 0 ? { turnOutcome: 'achieved' as const } : {}),
          });
        }
        const hints = await inTx((client) =>
          readWorkerHints(client, workspaceId, [{ definitionId: worker, version: 1 }]),
        );
        expect(hints.get(`${worker}@1`)).toEqual({
          windowDays: WORKER_HINT_WINDOW_DAYS,
          minSample: WORKER_HINT_MIN_SAMPLE,
          cost: { medianTokens: 30, tasks: WORKER_HINT_MIN_SAMPLE, sufficient: true },
          outcomes: {
            achieved: WORKER_HINT_MIN_SAMPLE - 1,
            total: WORKER_HINT_MIN_SAMPLE - 1,
            sufficient: false,
          },
        });
      });

      it('below the minimum sample: marked insufficient, and no median', async () => {
        const need = uniqueNeed('sparse');
        const worker = await publishedWorker(need);
        await task({
          definitionId: worker,
          status: 'completed',
          tokens: 100,
          turnOutcome: 'achieved',
        });
        await task({ definitionId: worker, status: 'failed', tokens: 300 });

        const { items } = await find({ parentAuthority: entryScope() }, need);
        expect(items.find((item) => item.definitionId === worker)?.hints).toEqual({
          windowDays: WORKER_HINT_WINDOW_DAYS,
          minSample: WORKER_HINT_MIN_SAMPLE,
          cost: { medianTokens: null, tasks: 2, sufficient: false },
          outcomes: { achieved: 1, total: 1, sufficient: false },
        });
      });
    });
  },
);
