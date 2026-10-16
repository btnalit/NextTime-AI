import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  readActionRequestFailureReasons,
  readActionRequestsInDoubt,
} from '../../governance/approval/service.js';
import { queryAuditPage } from './writer.js';

/**
 * Legacy 338 (core/0044): the reads of one resource's audit trail go through
 * `audit_records_resource_idx` instead of walking the workspace's whole trail. The readers' own
 * SQL is planned (a client that EXPLAINs what it is given), so a reader whose query stops
 * matching the partial index fails here rather than turning back into a scan on the host.
 *
 * The workspace gets a trail of its own first ({@link TRAIL_ROWS} rows, one resource each) and the
 * table is analyzed: an empty workspace makes every index on `workspace_id` look as cheap as this
 * one, and which of them the planner picks then depends on whatever else the shared test database
 * holds. With a trail, the other path (`audit_records_workspace_created_idx`, then a filter) reads
 * the whole trail, which is what the host would do without this index.
 * Integration (real Postgres; auto-skip without DATABASE_URL).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const INDEX = 'audit_records_resource_idx';
const TRAIL_ROWS = 5000;

describe.runIf(DATABASE_URL !== undefined)('audit_records_resource_idx (legacy 338)', () => {
  let pool: Pool;
  let workspaceId: string;
  let ownerId: string;

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
          'audit-resource-index-test-workspace',
        ]);
        await client.query(
          'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
          [workspaceId, ownerId, 'human', 'owner', 'owner'],
        );
        await client.query(
          `insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
           select $1, $2, case when n % 2 = 0 then 'action_request.fail' else 'action_request.outcome_in_doubt' end,
                  'action_request', gen_random_uuid(), '{}'::jsonb
             from generate_series(1, $3::int) as n`,
          [workspaceId, ownerId, TRAIL_ROWS],
        );
      },
      { skipRoleSwitch: true },
    );
    await pool.query('analyze audit_records');
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** The plans of every statement `read` sends, as the application role in the workspace, with
   *  sequential scans priced out so a usable index shows up in the plan. */
  async function plansOf(read: (client: PoolClient) => Promise<unknown>): Promise<string[]> {
    return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      await client.query('set local enable_seqscan = off');
      const plans: string[] = [];
      const explaining = {
        query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(`explain (format json) ${sql}`, params);
          plans.push(JSON.stringify(result.rows));
          return { rows: [], rowCount: 0 };
        },
      } as unknown as PoolClient;
      await read(explaining);
      return plans;
    });
  }

  it('exists, is valid, and covers only the rows that name a resource', async () => {
    const result = await pool.query<{ def: string; valid: boolean }>(
      `select pg_get_indexdef(i.indexrelid) as def, i.indisvalid as valid
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = 'audit_records'::regclass and c.relname = $1`,
      [INDEX],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.valid).toBe(true);
    expect(result.rows[0]?.def).toMatch(
      /\(workspace_id, resource_id, created_at\) WHERE \(resource_id IS NOT NULL\)$/,
    );
  });

  it('serves the failure-reason and in-doubt reads (legacy 329, 287)', async () => {
    const ids = [randomUUID(), randomUUID()];
    const failed = await plansOf((client) =>
      readActionRequestFailureReasons(
        client,
        workspaceId,
        ids.map((id) => ({ id, status: 'failed' as const })),
      ),
    );
    const inDoubt = await plansOf((client) => readActionRequestsInDoubt(client, workspaceId, ids));
    expect(failed).toHaveLength(1);
    expect(inDoubt).toHaveLength(1);
    expect(failed[0]).toContain(INDEX);
    expect(inDoubt[0]).toContain(INDEX);
  });

  it('serves an audit page filtered by resource (request_action read-back, reconstruction)', async () => {
    const plans = await plansOf((client) =>
      queryAuditPage(client, workspaceId, {
        resourceType: 'action_request',
        resourceId: randomUUID(),
        actions: ['action_request.complete', 'action_request.fail'],
        limit: 1,
      }),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toContain(INDEX);
  });
});
