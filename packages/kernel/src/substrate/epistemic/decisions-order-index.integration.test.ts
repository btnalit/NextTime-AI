import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { DecisionViewer } from './decision-visibility.js';
import { findPrecedents, queryDecisions } from './decisions.js';

/**
 * Legacy 429 (core/0060): `query_decisions` and `find_precedents` read the newest Decisions from
 * `decisions_workspace_created_ms_idx` instead of sorting every Decision of the workspace. The
 * readers' own SQL is planned (a client that EXPLAINs what it is given, as
 * audit-resource-index.integration.test.ts does), so a read whose order stops matching the index
 * fails here rather than turning back into a sort on the host.
 *
 * The workspace gets {@link DECISIONS} Decisions of its own first, three to a millisecond (rows
 * one transaction writes share one), and the table is analyzed: with an empty workspace the
 * primary key and a sort cost as little as the index, and which the planner picks then depends on
 * whatever else the shared test database holds.
 * Integration (real Postgres; auto-skip without DATABASE_URL).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const INDEX = 'decisions_workspace_created_ms_idx';
const DECISIONS = 3000;
const ACTION_KIND = 'decisions_order_index.test';

describe.runIf(DATABASE_URL !== undefined)(
  'decisions_workspace_created_ms_idx (legacy 429)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;
    let owner: DecisionViewer;
    let member: DecisionViewer;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      memberId = randomUUID();
      owner = { principalId: ownerId, seesEveryGoalRun: true, seesEveryActionRequest: true };
      member = { principalId: memberId, seesEveryGoalRun: false, seesEveryActionRequest: false };
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'decisions-order-index-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'member')`,
            [workspaceId, ownerId, memberId],
          );
          const activity = await client.query<{ id: string }>(
            `insert into activities (workspace_id, kind, status, started_by)
           values ($1, 'test.decisions_order_index', 'completed', $2) returning id`,
            [workspaceId, ownerId],
          );
          // Three rows to a millisecond, microseconds apart within it: the page boundary must split
          // a millisecond by `id`, never skip a row of it.
          await client.query(
            `insert into decisions (workspace_id, status, activity_id, summary, rationale, created_at)
           select $1, 'approved', $2, 'decision ' || n, jsonb_build_object('actionKind', $4::text),
                  timestamptz '2026-11-01 00:00:00+00'
                    + make_interval(secs => (n / 3) * 0.001 + (n % 3) * 0.000001)
             from generate_series(1, $3::int) as n`,
            [workspaceId, activity.rows[0]?.id, DECISIONS, ACTION_KIND],
          );
        },
        { skipRoleSwitch: true },
      );
      await pool.query('analyze decisions');
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

    /** The plan reads the index in its order: the index is named and nothing sorts. */
    function expectIndexOrder(plans: readonly string[]): void {
      expect(plans).toHaveLength(1);
      expect(plans[0]).toContain(INDEX);
      expect(plans[0]).not.toContain('"Node Type":"Sort"');
      expect(plans[0]).not.toContain('"Node Type":"Incremental Sort"');
    }

    it('exists, is valid, and is keyed by the millisecond in UTC, newest first', async () => {
      const result = await pool.query<{ def: string; valid: boolean }>(
        `select pg_get_indexdef(i.indexrelid) as def, i.indisvalid as valid
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = 'decisions'::regclass and c.relname = $1`,
        [INDEX],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.valid).toBe(true);
      expect(result.rows[0]?.def).toMatch(
        /\(workspace_id, date_trunc\('milliseconds'::text, \(created_at AT TIME ZONE 'UTC'::text\)\) DESC, id DESC\)$/,
      );
    });

    it('serves query_decisions: the first page, a cursor page and since, for the owner and a member', async () => {
      const cursor = Buffer.from(
        `${new Date('2026-11-01T00:00:00.500Z').toISOString()}|${randomUUID()}`,
        'utf8',
      ).toString('base64url');
      for (const viewer of [owner, member]) {
        expectIndexOrder(
          await plansOf((client) => queryDecisions(client, workspaceId, { limit: 20 }, viewer)),
        );
        expectIndexOrder(
          await plansOf((client) =>
            queryDecisions(client, workspaceId, { limit: 20, cursor }, viewer),
          ),
        );
        expectIndexOrder(
          await plansOf((client) =>
            queryDecisions(
              client,
              workspaceId,
              { limit: 20, since: '2026-11-01T00:00:00.900Z' },
              viewer,
            ),
          ),
        );
      }
    });

    it('serves find_precedents by action kind', async () => {
      for (const viewer of [owner, member]) {
        expectIndexOrder(
          await plansOf((client) =>
            findPrecedents(client, workspaceId, { actionKindTag: ACTION_KIND, limit: 10 }, viewer),
          ),
        );
      }
    });

    it('pages every Decision once, in the order the old key gave, a millisecond split by id', async () => {
      /** Ids in the order the reads gave before 0060 (the session-zone key), and `since` as before. */
      const reference = (since: string | null) =>
        withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) =>
            (
              await client.query<{ id: string }>(
                `select id from decisions
                where workspace_id = $1 and ($2::timestamptz is null or created_at >= $2)
                order by date_trunc('milliseconds', created_at) desc, id desc`,
                [workspaceId, since],
              )
            ).rows.map((row) => row.id),
          { skipRoleSwitch: true },
        );
      const pageThrough = async (since?: string) => {
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
            queryDecisions(
              client,
              workspaceId,
              {
                limit: 100,
                ...(cursor === undefined ? {} : { cursor }),
                ...(since === undefined ? {} : { since }),
              },
              owner,
            ),
          );
          seen.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return seen;
      };

      const all = await reference(null);
      expect(all).toHaveLength(DECISIONS);
      expect(await pageThrough()).toEqual(all);
      // The last three milliseconds and a row: .998 (three rows), .999 (three), 1.000 (one).
      const recent = await reference('2026-11-01T00:00:00.998Z');
      expect(recent).toHaveLength(7);
      expect(await pageThrough('2026-11-01T00:00:00.998Z')).toEqual(recent);
    });
  },
);
