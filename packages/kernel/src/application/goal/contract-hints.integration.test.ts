import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_OUTPUT_PROBLEMS, type OutputSchema } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { createGoalRun } from './service.js';

/**
 * application/goal/contract-hints (S11 GO13, forks F1 = A, F2 = A): what a proposed plan's
 * confirmation says about its steps and the contracts their Workers declare — advice only, the
 * plan is proposed as written. DB-gated (real Postgres; auto-skip without DATABASE_URL); its own
 * workspace.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const INPUT: OutputSchema = {
  type: 'object',
  properties: { host: { type: 'string' }, port: { type: 'integer' } },
  required: ['host'],
};
const REPORT: OutputSchema = {
  type: 'object',
  properties: { summary: { type: 'string' }, host: { type: 'string' } },
  required: ['summary'],
};
const BUDGET = { maxTokens: 100_000, maxSteps: 10, maxRevisions: 3, maxWallClockSeconds: 3600 };

describe.runIf(DATABASE_URL !== undefined)(
  'application/goal contract hints (S11 GO13, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let contracted: { definitionId: string; version: number };
    let plain: { definitionId: string; version: number };

    const inTx = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);

    async function publish(definition: Record<string, unknown>) {
      const draft = await inTx((client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, { kind: 'worker', definition }),
      );
      await inTx((client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: draft.id,
          version: draft.version,
        }),
      );
      return { definitionId: draft.id, version: draft.version };
    }

    const propose = (steps: readonly Record<string, unknown>[]) =>
      inTx((client) =>
        createGoalRun(client, workspaceId, {
          requesterId: ownerId,
          proposedBy: ownerId,
          statement: 'check the hosts',
          plan: { steps },
          budget: BUDGET,
        }),
      );

    const contractHints = (hints: readonly { code: string }[]) =>
      hints.filter(
        (hint) =>
          hint.code === 'step_output_contract_unused' || hint.code === 'step_input_mismatch',
      );

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
            'contract-hints-test',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      contracted = await publish({
        systemPrompt: 'You check a host.',
        inputSchema: INPUT,
        outputSchema: REPORT,
      });
      plain = await publish({ systemPrompt: 'You check anything.' });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a step that leaves its Worker’s output contract unset is told so; one that sets an output schema is not', async () => {
      const created = await propose([
        { key: 'unset', worker: contracted, input: { host: 'web-1' } },
        { key: 'set', worker: contracted, input: { host: 'web-2' }, outputSchema: REPORT },
        { key: 'other', worker: plain, input: { anything: true } },
      ]);
      expect(contractHints(created.hints)).toEqual([
        expect.objectContaining({ code: 'step_output_contract_unused', stepKey: 'unset' }),
      ]);
      // Advice only: the plan is proposed as written, no schema inherited.
      expect(created.status).toBe('proposed');
      expect(created.plan.steps[0]).not.toHaveProperty('outputSchema');
    });

    it('a step whose input does not match its Worker’s input contract is told where, never the values', async () => {
      const created = await propose([
        {
          key: 'wrong',
          worker: contracted,
          input: { port: 'eighty', note: 'secret-looking value' },
          outputSchema: REPORT,
        },
      ]);
      const [hint, ...more] = contractHints(created.hints);
      expect(more).toEqual([]);
      expect(hint).toMatchObject({ code: 'step_input_mismatch', stepKey: 'wrong' });
      const problems = (hint as { inputProblems?: { path: string }[] }).inputProblems ?? [];
      expect(problems.map((problem) => problem.path).sort()).toEqual(['input.host', 'input.port']);
      expect(hint).toHaveProperty('inputProblemCount', 2);
      expect(JSON.stringify(hint)).not.toContain('eighty');
      expect(JSON.stringify(hint)).not.toContain('secret-looking value');
    });

    it('past the listed places, the count is still exact (#493 on #880)', async () => {
      const names = Array.from({ length: MAX_OUTPUT_PROBLEMS + 5 }, (_, index) => `f${index}`);
      const many = await publish({
        systemPrompt: 'You need many fields.',
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
          required: names,
        },
      });
      const created = await propose([{ key: 'bare', worker: many, input: {} }]);
      const [hint, ...more] = contractHints(created.hints);
      expect(more).toEqual([]);
      expect(hint).toMatchObject({ code: 'step_input_mismatch', stepKey: 'bare' });
      expect((hint as { inputProblems?: unknown[] }).inputProblems).toHaveLength(
        MAX_OUTPUT_PROBLEMS,
      );
      expect(hint).toHaveProperty('inputProblemCount', names.length);
    });

    it('a step with bindings is not checked against the input contract (its input is assembled when it starts)', async () => {
      const created = await propose([
        { key: 'scan', worker: contracted, input: { host: 'web-1' }, outputSchema: REPORT },
        {
          key: 'follow',
          worker: contracted,
          dependsOn: ['scan'],
          input: {},
          bindings: [{ to: 'host', from: 'scan', path: 'host' }],
          outputSchema: REPORT,
        },
      ]);
      expect(contractHints(created.hints)).toEqual([]);
    });

    it('a Worker without a contract, or a matching input, adds no hint', async () => {
      const created = await propose([
        { key: 'plain', worker: plain, input: {} },
        {
          key: 'fits',
          worker: contracted,
          input: { host: 'web-1', port: 22 },
          outputSchema: REPORT,
        },
      ]);
      expect(contractHints(created.hints)).toEqual([]);
    });
  },
);
