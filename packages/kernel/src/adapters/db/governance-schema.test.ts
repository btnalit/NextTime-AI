import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, splitSqlStatements } from './migrate.js';
import { createPool, withWorkspace } from './pool.js';

/**
 * adapters/db/governance-schema: integration tests for the S2.1 governance/task/worker table
 * invariants (design doc §5.4 I6/I7/I12/I13/I14, §5.5 state machines;
 * docs/development-tasks.md S2.1), plus a static (no-DB) check that every enum-shaped CHECK
 * constraint in the new migration files matches its packages/shared `*_VALUES` source of truth —
 * same two-part structure as packages/kernel/src/substrate/invariants.test.ts.
 *
 * The DB-backed suite auto-skips when `DATABASE_URL` is unset, matching every other integration
 * test in this package.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const SHARED_ENUMS_PATH = path.resolve(KERNEL_ROOT, '..', 'shared', 'src', 'enums.ts');

const NEW_MIGRATION_FILES = [
  path.join(MIGRATIONS_DIR, 'governance', '0002_policy.sql'),
  path.join(MIGRATIONS_DIR, 'governance', '0003_action_requests.sql'),
  path.join(MIGRATIONS_DIR, 'task', '0001_tasks.sql'),
  path.join(MIGRATIONS_DIR, 'worker', '0001_worker_definitions.sql'),
];

// ---------------------------------------------------------------------------------------------
// Static check: SQL CHECK (<col> IN (...)) constraints vs. packages/shared *_VALUES — same
// extraction approach as substrate/invariants.test.ts, duplicated locally (not imported) since
// that file's helpers are not exported and this suite intentionally covers a disjoint set of
// migration files.
// ---------------------------------------------------------------------------------------------

interface TableCheck {
  table: string;
  column: string;
  values: string[];
}

function stripLeadingLineComments(text: string): string {
  let result = text;
  for (;;) {
    const trimmed = result.replace(/^\s+/, '');
    if (!trimmed.startsWith('--')) return trimmed;
    const newlineIndex = trimmed.indexOf('\n');
    result = newlineIndex === -1 ? '' : trimmed.slice(newlineIndex + 1);
  }
}

function extractTableChecks(sql: string): TableCheck[] {
  const checks: TableCheck[] = [];
  const checkRe = /check\s*\(\s*(\w+)\s+in\s*\(([^()]*)\)\s*\)/gi;

  for (const statement of splitSqlStatements(sql)) {
    const table = /^create table (?:if not exists )?(\w+)/i.exec(
      stripLeadingLineComments(statement),
    )?.[1];
    if (!table) continue;

    checkRe.lastIndex = 0;
    let match: RegExpExecArray | null = checkRe.exec(statement);
    while (match !== null) {
      const column = match[1];
      const rawValues = match[2];
      if (column && rawValues !== undefined) {
        const values = rawValues
          .split(',')
          .map((v) => v.trim().replace(/^'|'$/g, ''))
          .filter((v) => v.length > 0);
        checks.push({ table, column, values });
      }
      match = checkRe.exec(statement);
    }
  }

  return checks;
}

function extractSharedEnumValues(source: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const arrayRe = /export const (\w+_VALUES)\s*=\s*\[([\s\S]*?)\]\s*as const;/g;
  let match: RegExpExecArray | null = arrayRe.exec(source);
  while (match !== null) {
    const name = match[1];
    const body = match[2];
    if (name && body !== undefined) {
      const values = [...body.matchAll(/'([^']*)'/g)]
        .map((m) => m[1])
        .filter((v): v is string => v !== undefined);
      result[name] = values;
    }
    match = arrayRe.exec(source);
  }
  return result;
}

const EXPECTED_ENUM_CHECKS: ReadonlyArray<{ table: string; column: string; enumExport: string }> = [
  { table: 'policies', column: 'blast_radius', enumExport: 'BLAST_RADIUS_VALUES' },
  { table: 'capability_grants', column: 'status', enumExport: 'GRANT_STATUS_VALUES' },
  { table: 'action_requests', column: 'status', enumExport: 'ACTION_REQUEST_STATUS_VALUES' },
  { table: 'action_requests', column: 'blast_radius', enumExport: 'BLAST_RADIUS_VALUES' },
  { table: 'tasks', column: 'status', enumExport: 'TASK_STATUS_VALUES' },
  { table: 'worker_runs', column: 'status', enumExport: 'WORKER_RUN_STATUS_VALUES' },
  { table: 'worker_definitions', column: 'kind', enumExport: 'WORKER_DEFINITION_KIND_VALUES' },
  { table: 'worker_definitions', column: 'status', enumExport: 'PUBLISHABLE_STATUS_VALUES' },
];

/**
 * `table.column` pairs with a CHECK but no packages/shared counterpart — documented, not missed.
 * `action_requests.policy_decision` (`'allow' | 'require_approval' | 'deny'`) has no
 * packages/shared enum export yet (docs/development-tasks.md S2.1 "Read first" §6: "if none
 * exist, define the SQL CHECK lists ... and list them in your report so later tasks can mirror
 * them" — reported in the PR body; S2.2's policy engine is the natural owner of a future
 * `POLICY_DECISION_VALUES` export).
 */
const KNOWN_UNMAPPED_CHECKS = new Set(['action_requests.policy_decision']);

describe('S2.1 governance/task/worker migrations — CHECK enum lists match packages/shared (static, no DB)', () => {
  it('every enum-shaped CHECK constraint matches its packages/shared *_VALUES array exactly', async () => {
    const allChecks: TableCheck[] = [];
    for (const filePath of NEW_MIGRATION_FILES) {
      const content = await readFile(filePath, 'utf8');
      allChecks.push(...extractTableChecks(content));
    }

    const enumsSource = await readFile(SHARED_ENUMS_PATH, 'utf8');
    const sharedEnums = extractSharedEnumValues(enumsSource);

    for (const expectation of EXPECTED_ENUM_CHECKS) {
      const found = allChecks.find(
        (c) => c.table === expectation.table && c.column === expectation.column,
      );
      expect(
        found,
        `expected a CHECK on ${expectation.table}.${expectation.column} in the new migrations`,
      ).toBeDefined();

      const expectedValues = sharedEnums[expectation.enumExport];
      expect(
        expectedValues,
        `expected packages/shared/src/enums.ts to export ${expectation.enumExport}`,
      ).toBeDefined();

      expect(new Set(found?.values ?? [])).toEqual(new Set(expectedValues ?? []));
    }

    const expectedKeys = new Set(EXPECTED_ENUM_CHECKS.map((e) => `${e.table}.${e.column}`));
    for (const check of allChecks) {
      const key = `${check.table}.${check.column}`;
      if (!expectedKeys.has(key)) {
        expect(KNOWN_UNMAPPED_CHECKS.has(key), `unexpected/unmapped CHECK: ${key}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// DB-backed invariant tests (auto-skip without DATABASE_URL)
// ---------------------------------------------------------------------------------------------

describe.runIf(DATABASE_URL !== undefined)(
  'governance/task/worker schema invariants (integration, real Postgres)',
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

    async function adminInsertPrincipal(
      ws: string,
      opts: { kind: string; role: string; displayName: string },
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: ws, principalId: id },
        async (client) => {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [ws, id, opts.kind, opts.role, opts.displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function insertObject(ws: string, principalId: string): Promise<string> {
      return withWorkspace(pool, { workspaceId: ws, principalId }, async (client) => {
        const id = randomUUID();
        await client.query(
          "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
          [ws, id],
        );
        return id;
      });
    }

    async function insertActivity(ws: string, principalId: string): Promise<string> {
      return withWorkspace(pool, { workspaceId: ws, principalId }, async (client) => {
        const id = randomUUID();
        await client.query(
          "insert into activities (workspace_id, id, kind, status, started_by) values ($1, $2, 'test.run', 'completed', $3)",
          [ws, id, principalId],
        );
        return id;
      });
    }

    async function insertDecision(
      ws: string,
      principalId: string,
      activityId: string,
    ): Promise<string> {
      return withWorkspace(pool, { workspaceId: ws, principalId }, async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into decisions (workspace_id, id, status, activity_id, decided_by)
           values ($1, $2, 'approved', $3, $4)`,
          [ws, id, activityId, principalId],
        );
        return id;
      });
    }

    interface ActionRequestFixture {
      workspaceId: string;
      gatekeeperId: string;
      onBehalfOf: string;
    }

    async function makeActionRequestFixture(): Promise<ActionRequestFixture> {
      const gatekeeperId = await insertObject(workspaceId, ownerId);
      return { workspaceId, gatekeeperId, onBehalfOf: ownerId };
    }

    async function insertActionRequest(
      fixture: ActionRequestFixture,
      overrides: {
        status?: string;
        policyDecision?: string | null;
        approvalDecisionId?: string | null;
        blastRadius?: string;
        idempotencyKey?: string | null;
      } = {},
    ): Promise<string> {
      return withWorkspace(
        pool,
        { workspaceId: fixture.workspaceId, principalId: ownerId },
        async (client) => {
          const id = randomUUID();
          await client.query(
            `insert into action_requests
               (workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
                policy_decision, approval_decision_id, await_decision, on_behalf_of, actor_runtime,
                idempotency_key)
             values ($1, $2, $3, $4, 'test.action', 'test-scope', $5, $6, $7, false, $8, 'pi', $9)`,
            [
              fixture.workspaceId,
              id,
              overrides.status ?? 'proposed',
              fixture.gatekeeperId,
              overrides.blastRadius ?? 'low',
              overrides.policyDecision === undefined ? null : overrides.policyDecision,
              overrides.approvalDecisionId === undefined ? null : overrides.approvalDecisionId,
              fixture.onBehalfOf,
              overrides.idempotencyKey === undefined ? null : overrides.idempotencyKey,
            ],
          );
          return id;
        },
      );
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = await adminInsertWorkspace('governance-schema-test-workspace');
      ownerId = await adminInsertPrincipal(workspaceId, {
        kind: 'human',
        role: 'owner',
        displayName: 'owner',
      });
      memberId = await adminInsertPrincipal(workspaceId, {
        kind: 'human',
        role: 'member',
        displayName: 'member',
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('action_requests — status/policy_decision CHECKs', () => {
      it('rejects an invalid status', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(
          insertActionRequest(fixture, { status: 'not_a_real_status' }),
        ).rejects.toThrow();
      });

      it('rejects an invalid policy_decision', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(
          insertActionRequest(fixture, { status: 'policy_evaluated', policyDecision: 'maybe' }),
        ).rejects.toThrow();
      });

      it('accepts a proposed row with no policy_decision at all', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(insertActionRequest(fixture)).resolves.toBeDefined();
      });

      it('rejects a non-proposed row with no policy_decision (I6 support check)', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(
          insertActionRequest(fixture, { status: 'policy_evaluated', policyDecision: null }),
        ).rejects.toThrow();
      });
    });

    describe('action_requests — I7 (执行前必有 Policy 决策记录)', () => {
      it('rejects an executing row with no policy_decision', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(
          insertActionRequest(fixture, { status: 'executing', policyDecision: null }),
        ).rejects.toThrow();
      });

      it('rejects an executed row whose policy_decision is deny', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(
          insertActionRequest(fixture, { status: 'executed', policyDecision: 'deny' }),
        ).rejects.toThrow();
      });

      it('rejects an executing row whose policy_decision is require_approval with no approval_decision_id', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(
          insertActionRequest(fixture, {
            status: 'executing',
            policyDecision: 'require_approval',
            approvalDecisionId: null,
          }),
        ).rejects.toThrow();
      });

      it('accepts an executing row whose policy_decision is allow', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(
          insertActionRequest(fixture, { status: 'executing', policyDecision: 'allow' }),
        ).resolves.toBeDefined();
      });

      it('accepts an executed row whose policy_decision is require_approval with an approval_decision_id set', async () => {
        const fixture = await makeActionRequestFixture();
        const activityId = await insertActivity(workspaceId, ownerId);
        const decisionId = await insertDecision(workspaceId, ownerId, activityId);
        await expect(
          insertActionRequest(fixture, {
            status: 'executed',
            policyDecision: 'require_approval',
            approvalDecisionId: decisionId,
          }),
        ).resolves.toBeDefined();
      });

      it('a denied (terminal, non-executing) row with policy_decision=deny is valid', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(
          insertActionRequest(fixture, { status: 'denied', policyDecision: 'deny' }),
        ).resolves.toBeDefined();
      });
    });

    describe('action_requests — I7/I11: a human decision state (approved/rejected) must carry its Decision', () => {
      it('rejects an approved row with no approval_decision_id', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(
          insertActionRequest(fixture, {
            status: 'approved',
            policyDecision: 'require_approval',
            approvalDecisionId: null,
          }),
        ).rejects.toThrow();
      });

      it('accepts an approved row with a real approval_decision_id', async () => {
        const fixture = await makeActionRequestFixture();
        const activityId = await insertActivity(workspaceId, ownerId);
        const decisionId = await insertDecision(workspaceId, ownerId, activityId);
        await expect(
          insertActionRequest(fixture, {
            status: 'approved',
            policyDecision: 'require_approval',
            approvalDecisionId: decisionId,
          }),
        ).resolves.toBeDefined();
      });

      it('rejects a rejected row with no approval_decision_id', async () => {
        const fixture = await makeActionRequestFixture();
        await expect(
          insertActionRequest(fixture, {
            status: 'rejected',
            policyDecision: 'require_approval',
            approvalDecisionId: null,
          }),
        ).rejects.toThrow();
      });

      it('accepts a rejected row with a real approval_decision_id', async () => {
        const fixture = await makeActionRequestFixture();
        const activityId = await insertActivity(workspaceId, ownerId);
        const decisionId = await insertDecision(workspaceId, ownerId, activityId);
        await expect(
          insertActionRequest(fixture, {
            status: 'rejected',
            policyDecision: 'require_approval',
            approvalDecisionId: decisionId,
          }),
        ).resolves.toBeDefined();
      });

      it('leaves expired/denied/auto_approved unconstrained — no human decision involved, so no approval_decision_id required', async () => {
        for (const status of ['expired', 'denied', 'auto_approved']) {
          const fixture = await makeActionRequestFixture();
          await expect(
            insertActionRequest(fixture, {
              status,
              policyDecision: status === 'denied' ? 'deny' : 'allow',
              approvalDecisionId: null,
            }),
          ).resolves.toBeDefined();
        }
      });
    });

    describe('action_requests — idempotency_key uniqueness per workspace', () => {
      it('rejects a second row in the same workspace with the same idempotency_key', async () => {
        const fixture = await makeActionRequestFixture();
        const key = `idem-${randomUUID()}`;
        await insertActionRequest(fixture, { idempotencyKey: key });
        await expect(insertActionRequest(fixture, { idempotencyKey: key })).rejects.toThrow();
      });

      it('allows the same idempotency_key to repeat in a different workspace', async () => {
        const otherWorkspaceId = await adminInsertWorkspace('governance-schema-test-workspace-2');
        const otherOwnerId = await adminInsertPrincipal(otherWorkspaceId, {
          kind: 'human',
          role: 'owner',
          displayName: 'owner-2',
        });
        const otherGatekeeperId = await insertObject(otherWorkspaceId, otherOwnerId);

        const key = `idem-shared-${randomUUID()}`;
        const fixtureA = await makeActionRequestFixture();
        await insertActionRequest(fixtureA, { idempotencyKey: key });

        await expect(
          insertActionRequest(
            {
              workspaceId: otherWorkspaceId,
              gatekeeperId: otherGatekeeperId,
              onBehalfOf: otherOwnerId,
            },
            { idempotencyKey: key },
          ),
        ).resolves.toBeDefined();
      });

      it('allows multiple rows with no idempotency_key at all', async () => {
        const fixture = await makeActionRequestFixture();
        await insertActionRequest(fixture, { idempotencyKey: null });
        await expect(insertActionRequest(fixture, { idempotencyKey: null })).resolves.toBeDefined();
      });
    });

    describe('action_requests — RLS workspace isolation', () => {
      it('a row inserted in one workspace is invisible from another', async () => {
        const fixture = await makeActionRequestFixture();
        const id = await insertActionRequest(fixture);

        const otherWorkspaceId = await adminInsertWorkspace('governance-schema-test-workspace-3');
        const otherOwnerId = await adminInsertPrincipal(otherWorkspaceId, {
          kind: 'human',
          role: 'owner',
          displayName: 'owner-3',
        });

        const seen = await withWorkspace(
          pool,
          { workspaceId: otherWorkspaceId, principalId: otherOwnerId },
          async (client) => {
            const result = await client.query('select id from action_requests where id = $1', [id]);
            return result.rows;
          },
        );
        expect(seen).toHaveLength(0);
      });
    });

    describe('tasks / worker_runs — status CHECKs', () => {
      async function insertTask(status = 'created'): Promise<string> {
        return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const id = randomUUID();
          await client.query(
            `insert into tasks
               (workspace_id, id, status, on_behalf_of, worker_definition_id, worker_definition_version)
             values ($1, $2, $3, $4, $5, 1)`,
            [workspaceId, id, status, ownerId, randomUUID()],
          );
          return id;
        });
      }

      it('rejects an invalid Task status', async () => {
        await expect(insertTask('not_a_real_status')).rejects.toThrow();
      });

      it('accepts every valid Task status', async () => {
        for (const status of [
          'created',
          'queued',
          'running',
          'waiting_approval',
          'completed',
          'failed',
          'cancelled',
        ]) {
          await expect(insertTask(status)).resolves.toBeDefined();
        }
      });

      it('rejects an invalid WorkerRun status', async () => {
        const taskId = await insertTask();
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into worker_runs (workspace_id, id, status, task_id)
               values ($1, $2, 'not_a_real_status', $3)`,
              [workspaceId, randomUUID(), taskId],
            );
          }),
        ).rejects.toThrow();
      });

      it('accepts a valid WorkerRun status and a self-referential parent_worker_run_id', async () => {
        const taskId = await insertTask();
        const parentId = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) => {
            const id = randomUUID();
            await client.query(
              `insert into worker_runs (workspace_id, id, status, task_id)
               values ($1, $2, 'running', $3)`,
              [workspaceId, id, taskId],
            );
            return id;
          },
        );

        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into worker_runs (workspace_id, id, status, task_id, parent_worker_run_id)
               values ($1, $2, 'provisioning', $3, $4)`,
              [workspaceId, randomUUID(), taskId, parentId],
            );
          }),
        ).resolves.toBeUndefined();
      });
    });

    describe('worker_definitions — status CHECK and I12 (published is read-only except → deprecated)', () => {
      async function insertWorkerDefinition(
        status: 'draft' | 'published' | 'deprecated',
        version = 1,
      ): Promise<string> {
        return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const id = randomUUID();
          await client.query(
            `insert into worker_definitions
               (workspace_id, id, version, kind, status, definition, proposed_by, published_by)
             values ($1, $2, $3, 'worker', $4, $5, $6, $7)`,
            [
              workspaceId,
              id,
              version,
              status,
              JSON.stringify({ modelAllowlist: [] }),
              ownerId,
              status === 'draft' ? null : ownerId,
            ],
          );
          return id;
        });
      }

      it('rejects an invalid status', async () => {
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into worker_definitions
                 (workspace_id, id, version, kind, status, definition, proposed_by)
               values ($1, $2, 1, 'worker', 'not_a_real_status', $3, $4)`,
              [workspaceId, randomUUID(), JSON.stringify({}), ownerId],
            );
          }),
        ).rejects.toThrow();
      });

      it('rejects an invalid kind', async () => {
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into worker_definitions
                 (workspace_id, id, version, kind, status, definition, proposed_by)
               values ($1, $2, 1, 'not_a_real_kind', 'draft', $3, $4)`,
              [workspaceId, randomUUID(), JSON.stringify({}), ownerId],
            );
          }),
        ).rejects.toThrow();
      });

      it('allows updating a draft row freely', async () => {
        const id = await insertWorkerDefinition('draft');
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `update worker_definitions set definition = $1
               where workspace_id = $2 and id = $3 and version = 1`,
              [JSON.stringify({ modelAllowlist: ['fake/echo'] }), workspaceId, id],
            );
          }),
        ).resolves.toBeUndefined();
      });

      it('rejects updating a published row’s definition (I12)', async () => {
        const id = await insertWorkerDefinition('published');
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `update worker_definitions set definition = $1
               where workspace_id = $2 and id = $3 and version = 1`,
              [JSON.stringify({ modelAllowlist: ['tampered'] }), workspaceId, id],
            );
          }),
        ).rejects.toThrow();
      });

      it('rejects moving a published row directly to draft (I12: only → deprecated is allowed)', async () => {
        const id = await insertWorkerDefinition('published');
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `update worker_definitions set status = 'draft'
               where workspace_id = $1 and id = $2 and version = 1`,
              [workspaceId, id],
            );
          }),
        ).rejects.toThrow();
      });

      it('allows deprecating a published row', async () => {
        const id = await insertWorkerDefinition('published');
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `update worker_definitions set status = 'deprecated'
               where workspace_id = $1 and id = $2 and version = 1`,
              [workspaceId, id],
            );
          }),
        ).resolves.toBeUndefined();
      });

      it('rejects updating a deprecated row’s definition (I12: deprecated is exactly as content-immutable as published)', async () => {
        const id = await insertWorkerDefinition('deprecated');
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `update worker_definitions set definition = $1
               where workspace_id = $2 and id = $3 and version = 1`,
              [JSON.stringify({ modelAllowlist: ['tampered'] }), workspaceId, id],
            );
          }),
        ).rejects.toThrow();
      });

      it('rejects moving a deprecated row back to published (I12: deprecated is terminal)', async () => {
        const id = await insertWorkerDefinition('deprecated');
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `update worker_definitions set status = 'published'
               where workspace_id = $1 and id = $2 and version = 1`,
              [workspaceId, id],
            );
          }),
        ).rejects.toThrow();
      });

      it('rejects moving a deprecated row back to draft (I12: deprecated is terminal)', async () => {
        const id = await insertWorkerDefinition('deprecated');
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `update worker_definitions set status = 'draft'
               where workspace_id = $1 and id = $2 and version = 1`,
              [workspaceId, id],
            );
          }),
        ).rejects.toThrow();
      });
    });

    describe('policies — I8 double-signal: high blast_radius can never be auto_approve', () => {
      it('rejects blast_radius=high with auto_approve=true', async () => {
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into policies (workspace_id, id, action_kind, blast_radius, auto_approve, set_by)
               values ($1, $2, 'test.high_action', 'high', true, $3)`,
              [workspaceId, randomUUID(), ownerId],
            );
          }),
        ).rejects.toThrow();
      });

      it('accepts blast_radius=low with auto_approve=true', async () => {
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into policies (workspace_id, id, action_kind, blast_radius, auto_approve, set_by)
               values ($1, $2, 'test.low_action', 'low', true, $3)`,
              [workspaceId, randomUUID(), ownerId],
            );
          }),
        ).resolves.toBeUndefined();
      });

      it('rejects a second row for the same (workspace, action_kind)', async () => {
        const actionKind = `test.dup_action_${randomUUID()}`;
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          await client.query(
            `insert into policies (workspace_id, id, action_kind, auto_approve, set_by)
             values ($1, $2, $3, false, $4)`,
            [workspaceId, randomUUID(), actionKind, ownerId],
          );
        });
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into policies (workspace_id, id, action_kind, auto_approve, set_by)
               values ($1, $2, $3, false, $4)`,
              [workspaceId, randomUUID(), actionKind, ownerId],
            );
          }),
        ).rejects.toThrow();
      });
    });

    describe('capability_grants — status CHECK and workspace isolation', () => {
      it('rejects an invalid status', async () => {
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into capability_grants (workspace_id, id, principal_id, capability, status, granted_by)
               values ($1, $2, $3, 'test.capability', 'not_a_real_status', $4)`,
              [workspaceId, randomUUID(), memberId, ownerId],
            );
          }),
        ).rejects.toThrow();
      });

      it('accepts a grant with default status active and jsonb scope', async () => {
        const grantId = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) => {
            const id = randomUUID();
            await client.query(
              `insert into capability_grants (workspace_id, id, principal_id, capability, scope, granted_by)
             values ($1, $2, $3, 'test.capability', $4, $5)`,
              [workspaceId, id, memberId, JSON.stringify({ resourceScope: 'gk-1' }), ownerId],
            );
            return id;
          },
        );

        const row = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) => {
            const result = await client.query<{ status: string }>(
              'select status from capability_grants where workspace_id = $1 and id = $2',
              [workspaceId, grantId],
            );
            return result.rows[0];
          },
        );
        expect(row?.status).toBe('active');
      });
    });

    describe('capability_handles.parent_jti / on_behalf_of — columns already present since governance/0001 (S2.1 dispatch: "alter table capability_handles add column parent_jti …, add column on_behalf_of …" is a no-op here — see PR body "已知偏离")', () => {
      async function insertSessionFor(principalId: string): Promise<string> {
        return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const id = randomUUID();
          await client.query(
            `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, $3, 'entry', $4, 'ready')`,
            [workspaceId, id, ownerId, principalId],
          );
          return id;
        });
      }

      it('parent_jti accepts NULL — a root Handle row (no parent) inserts cleanly', async () => {
        const sessionId = await insertSessionFor(ownerId);

        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into capability_handles (workspace_id, jti, session_id, on_behalf_of, scope, expires_at)
               values ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
              [
                workspaceId,
                randomUUID(),
                sessionId,
                ownerId,
                JSON.stringify({ capabilities: [], resources: {} }),
              ],
            );
          }),
        ).resolves.toBeUndefined();
      });

      it('parent_jti accepts a real parent — an attenuated child Handle records its lineage', async () => {
        const sessionId = await insertSessionFor(ownerId);

        const parentJti = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) => {
            const jti = randomUUID();
            await client.query(
              `insert into capability_handles (workspace_id, jti, session_id, on_behalf_of, scope, expires_at)
             values ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
              [
                workspaceId,
                jti,
                sessionId,
                ownerId,
                JSON.stringify({ capabilities: [], resources: {} }),
              ],
            );
            return jti;
          },
        );

        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into capability_handles (workspace_id, jti, session_id, on_behalf_of, parent_jti, scope, expires_at)
               values ($1, $2, $3, $4, $5, $6, now() + interval '1 hour')`,
              [
                workspaceId,
                randomUUID(),
                sessionId,
                ownerId,
                parentJti,
                JSON.stringify({ capabilities: [], resources: {} }),
              ],
            );
          }),
        ).resolves.toBeUndefined();
      });

      it('on_behalf_of is required (I13) — NOT NULL, unlike parent_jti', async () => {
        const sessionId = await insertSessionFor(ownerId);

        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            await client.query(
              `insert into capability_handles (workspace_id, jti, session_id, on_behalf_of, scope, expires_at)
               values ($1, $2, $3, null, $4, now() + interval '1 hour')`,
              [
                workspaceId,
                randomUUID(),
                sessionId,
                JSON.stringify({ capabilities: [], resources: {} }),
              ],
            );
          }),
        ).rejects.toThrow();
      });
    });
  },
);
