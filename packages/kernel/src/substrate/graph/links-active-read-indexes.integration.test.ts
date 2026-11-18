import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { GraphReadViewer } from './operation-draft-visibility.js';
import { encodeFactsCursor } from './queries.js';
import { SqlGraphStore } from './sql-store.js';
import { countGraphTypeUsage } from './type-usage.js';

/**
 * Legacy 146 (core/0063): `list_facts` reads one link type's newest active Facts from
 * `links_workspace_type_active_idx`, and `get_entry_context` the workspace's newest active Facts
 * from `links_workspace_recorded_active_idx`, instead of reading every active Fact of the workspace
 * and sorting it. The store's own SQL is planned as the application role (a client that EXPLAINs
 * what it is given, as decisions-order-index.integration.test.ts does), so a read whose order stops
 * matching its index fails here rather than on the host.
 *
 * The workspace gets {@link FACTS} Facts of its own first — {@link MAIN_TYPE} most of them, three
 * to a millisecond (rows one transaction writes share one), a quarter superseded — and the table
 * is analyzed: with an empty workspace a sort costs as little as the index, and which the planner
 * picks then depends on whatever else the shared test database holds.
 * Integration (real Postgres; auto-skip without DATABASE_URL).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const TYPE_INDEX = 'links_workspace_type_active_idx';
const RECENT_INDEX = 'links_workspace_recorded_active_idx';
const FACTS = 6000;
const MAIN_TYPE = 'list_facts_index_main';
const OTHER_TYPE = 'list_facts_index_other';

describe.runIf(DATABASE_URL !== undefined)(
  'core/0063 active-Fact read indexes (legacy 146)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let owner: GraphReadViewer;
    let member: GraphReadViewer;
    const store = new SqlGraphStore();

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      const memberId = randomUUID();
      owner = { principalId: ownerId, seesEveryDraft: true };
      member = { principalId: memberId, seesEveryDraft: false };
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'links-active-read-indexes-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'member')`,
            [workspaceId, ownerId, memberId],
          );
          const activity = await client.query<{ id: string }>(
            `insert into activities (workspace_id, kind, status, started_by)
           values ($1, 'test.links_active_read_indexes', 'completed', $2) returning id`,
            [workspaceId, ownerId],
          );
          await client.query(
            `insert into objects (workspace_id, object_type, properties)
           select $1, 'Host', jsonb_build_object('n', n) from generate_series(1, 50) as n`,
            [workspaceId],
          );
          // Five in six are MAIN_TYPE, three rows to a millisecond, microseconds apart within it: the
          // page boundary must split a millisecond by `id`, never skip a row of it. Every fourth row
          // is superseded (outside the partial index, and never listed).
          await client.query(
            `with objs as (select array_agg(id order by id) as ids from objects where workspace_id = $1)
           insert into links (workspace_id, link_type, source_object_id, target_object_id,
                              epistemic_status, activity_id, asserted_by, recorded_at, superseded_at)
           select $1, case when n % 6 = 0 then $5 else $4 end,
                  objs.ids[1 + (n % 50)], objs.ids[1 + ((n * 7) % 50)],
                  'asserted', $2, $3,
                  timestamptz '2026-11-01 00:00:00+00'
                    + make_interval(secs => (n / 3) * 0.001 + (n % 3) * 0.000001),
                  case when n % 4 = 0 then timestamptz '2026-11-02 00:00:00+00' end
             from objs, generate_series(1, $6::int) as n`,
            [workspaceId, activity.rows[0]?.id, ownerId, MAIN_TYPE, OTHER_TYPE, FACTS],
          );
        },
        { skipRoleSwitch: true },
      );
      await pool.query('analyze links');
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

    /** The `Index Cond` of the plan's one scan of `index`. */
    function indexCondOf(plan: string, index: string): string {
      const conds: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const child of node) walk(child);
        } else if (node !== null && typeof node === 'object') {
          const record = node as Record<string, unknown>;
          if (record['Index Name'] === index && typeof record['Index Cond'] === 'string') {
            conds.push(record['Index Cond']);
          }
          for (const value of Object.values(record)) walk(value);
        }
      };
      walk(JSON.parse(plan));
      expect(conds).toHaveLength(1);
      return conds[0] ?? '';
    }

    /** The plan reads only the one type's rows from the index: the index is named, with the type
     *  as an index condition. */
    function expectTypeIndex(plans: readonly string[], linkType: string): string {
      expect(plans).toHaveLength(1);
      const plan = plans[0] ?? '';
      expect(plan).toContain(TYPE_INDEX);
      expect(indexCondOf(plan, TYPE_INDEX)).toContain(`link_type = '${linkType}'::text`);
      return plan;
    }

    /** Nothing sorts: the rows come in the index's order. */
    function expectNoSort(plan: string): void {
      expect(plan).not.toContain('"Node Type":"Sort"');
      expect(plan).not.toContain('"Node Type":"Incremental Sort"');
    }

    /** The definition of `index` on `links`, which must be valid. */
    async function indexDefOf(index: string): Promise<string> {
      const result = await pool.query<{ def: string; valid: boolean }>(
        `select pg_get_indexdef(i.indexrelid) as def, i.indisvalid as valid
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = 'links'::regclass and c.relname = $1`,
        [index],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.valid).toBe(true);
      return result.rows[0]?.def ?? '';
    }

    it('both exist, are valid and partial on active Facts: by type, then the millisecond in UTC; and by recorded_at; newest first', async () => {
      expect(await indexDefOf(TYPE_INDEX)).toBe(
        [
          `CREATE INDEX ${TYPE_INDEX} ON public.links USING btree (workspace_id, link_type, `,
          "date_trunc('milliseconds'::text, (recorded_at AT TIME ZONE 'UTC'::text)) DESC, id DESC) ",
          'WHERE ((superseded_at IS NULL) AND (invalidated_at IS NULL))',
        ].join(''),
      );
      expect(await indexDefOf(RECENT_INDEX)).toBe(
        [
          `CREATE INDEX ${RECENT_INDEX} ON public.links USING btree (workspace_id, recorded_at DESC, id DESC) `,
          'WHERE ((superseded_at IS NULL) AND (invalidated_at IS NULL))',
        ].join(''),
      );
    });

    it("serves list_facts: a large type's first page in the index order, every page from its type alone, for the owner and a member", async () => {
      const cursor = encodeFactsCursor(new Date('2026-11-01T00:00:01.500Z'), randomUUID());
      for (const viewer of [owner, member]) {
        // The newest page of a type with many rows is the first rows of the index: no sort.
        expectNoSort(
          expectTypeIndex(
            await plansOf((client) =>
              store.listFactsPage(client, workspaceId, { linkType: MAIN_TYPE, limit: 50 }, viewer),
            ),
            MAIN_TYPE,
          ),
        );
        // Where the planner guesses the rows left are about a page — a small type, or a cursor page,
        // whose bound is a filter (row-level security; core/0063's note) — sorting them is as cheap as
        // walking the index, and which it picks depends on the table's size (at 100 000 rows of a type
        // a cursor page walks; see the PR). Either way it reads only the one type's rows.
        for (const input of [
          { linkType: MAIN_TYPE, limit: 50, cursor },
          { linkType: OTHER_TYPE, limit: 50 },
          { linkType: OTHER_TYPE, limit: 50, cursor },
        ]) {
          expectTypeIndex(
            await plansOf((client) => store.listFactsPage(client, workspaceId, input, viewer)),
            input.linkType,
          );
        }
      }
    });

    it('serves the type-usage count of a rollback dry run', async () => {
      const plans = await plansOf((client) =>
        countGraphTypeUsage(client, workspaceId, { objectTypes: [], linkTypes: [MAIN_TYPE] }, 100),
      );
      expect(plans).toHaveLength(1);
      expect(plans[0]).toContain(TYPE_INDEX);
    });

    it("serves get_entry_context's recent Facts (and the Explorer's, read without a viewer) in the index order", async () => {
      for (const viewer of [owner, member, undefined]) {
        const plans = await plansOf((client) =>
          store.listRecentFacts(client, workspaceId, undefined, viewer),
        );
        expect(plans).toHaveLength(1);
        const plan = plans[0] ?? '';
        expect(indexCondOf(plan, RECENT_INDEX)).toContain('workspace_id = ');
        expectNoSort(plan);
      }
    });

    it('pages every active Fact of a type once, in the order the session-zone key gave, a millisecond split by id, in any session TimeZone', async () => {
      /** Ids in the order `list_facts` gave before 0063 (the session-zone key). */
      const reference = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) =>
          (
            await client.query<{ id: string }>(
              `select id from links
              where workspace_id = $1 and link_type = $2
                and superseded_at is null and invalidated_at is null
              order by date_trunc('milliseconds', recorded_at) desc, id desc`,
              [workspaceId, MAIN_TYPE],
            )
          ).rows.map((row) => row.id),
        { skipRoleSwitch: true },
      );
      // 5000 MAIN_TYPE rows (n not a multiple of 6), 1000 of them superseded (multiples of 4 but
      // not of 12).
      expect(reference).toHaveLength(4000);

      // UTC, and a zone whose offset is not a whole hour.
      for (const timeZone of ['UTC', 'Asia/Kathmandu']) {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          // A cursor that stops advancing would page forever: fail at one page past the last.
          pages += 1;
          expect(pages).toBeLessThanOrEqual(reference.length / 200 + 1);
          const page = await withWorkspace(
            pool,
            { workspaceId, principalId: ownerId },
            async (client) => {
              await client.query(`set local timezone = '${timeZone}'`);
              return store.listFactsPage(
                client,
                workspaceId,
                { linkType: MAIN_TYPE, limit: 200, ...(cursor === undefined ? {} : { cursor }) },
                owner,
              );
            },
          );
          seen.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        expect(seen).toEqual(reference);
      }
    });
  },
);
