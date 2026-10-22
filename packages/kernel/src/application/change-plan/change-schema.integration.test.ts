import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANGE_SEGMENT_EDGES, CHANGE_SEGMENT_STATUS_VALUES } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';

/**
 * application/change-plan — change-schema.integration (S11 P1, migrations/governance/0025): what
 * the database refuses. The segment's edge set equals the shared transition table pair by pair; a
 * segment is created `applied`, keeps what it applied and who applied it, moves along an edge only
 * and is final once rolled back; its items are written by the transaction that applies it and never
 * change, and a widening item is confirmed by the person applying it — written as `nexttime_app`
 * (the role every kernel write path uses) and, for the guards, as the login role too.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe.runIf(DATABASE_URL !== undefined)(
  'application/change-plan — change_segments, change_items (S11 P1, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;

    /** As `nexttime_app` under the workspace's RLS. */
    const asApp = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    const sql = (text: string, params: readonly unknown[] = []) =>
      asApp((client) => client.query(text, [...params]));
    /** As the login role (no `nexttime_app` grants in the way): the triggers alone. */
    const asOwnerRole = (text: string, params: readonly unknown[] = []) =>
      withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => client.query(text, [...params]),
        { skipRoleSwitch: true },
      );

    const INSERT_SEGMENT = `insert into change_segments
        (workspace_id, plan_id, channel, source_kind, source_name, source_version, source_digest,
         reviewed_digest, proposed_by, applied_by)
      values ($1, gen_random_uuid(), 'human', 'pack', 'test-pack', '1', $2, $2, $3, $3)
      returning id`;
    const insertSegmentIn = async (client: PoolClient): Promise<string> =>
      (await client.query(INSERT_SEGMENT, [workspaceId, DIGEST, ownerId])).rows[0]?.id as string;

    const INSERT_ITEM = `insert into change_items
        (workspace_id, segment_id, ordinal, kind, target, before, after, classification, widening,
         confirmed_by)
      values ($1, $2, $3, $4, '{"family":"f"}'::jsonb, null, '{"definitionDigest":"d"}'::jsonb, $5,
              $6::jsonb, $7)`;
    const insertItemIn = (
      client: PoolClient,
      segmentId: string,
      fields: {
        ordinal?: number;
        kind?: string;
        classification?: string;
        widening?: readonly unknown[];
        confirmedBy?: string | null;
      } = {},
    ) =>
      client.query(INSERT_ITEM, [
        workspaceId,
        segmentId,
        fields.ordinal ?? 1,
        fields.kind ?? 'ontology_version',
        fields.classification ?? 'not_widening',
        JSON.stringify(fields.widening ?? []),
        fields.confirmedBy ?? null,
      ]);

    /** An applied segment with one not-widening item, in a transaction of its own. */
    const appliedSegment = () =>
      asApp(async (client) => {
        const id = await insertSegmentIn(client);
        await insertItemIn(client, id);
        return id;
      });

    const setSegment = (id: string, set: string, params: readonly unknown[] = []) =>
      sql(`update change_segments set ${set} where workspace_id = $1 and id = $2`, [
        workspaceId,
        id,
        ...params,
      ]);

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      memberId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1-change-schema',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'member')`,
            [workspaceId, ownerId, memberId],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('change_segment_transition_allowed equals CHANGE_SEGMENT_EDGES, every (from, to) pair', async () => {
      const statuses = [...CHANGE_SEGMENT_STATUS_VALUES];
      const result = await sql(
        `select f, t, change_segment_transition_allowed(f, t) as allowed
           from unnest($1::text[]) as f cross join unnest($1::text[]) as t`,
        [statuses],
      );
      const legal = new Set(CHANGE_SEGMENT_EDGES.map((edge) => `${edge.from}->${edge.to}`));
      expect(result.rows).toHaveLength(statuses.length * statuses.length);
      for (const row of result.rows as { f: string; t: string; allowed: boolean }[]) {
        expect(row.allowed, `${row.f}->${row.t}`).toBe(legal.has(`${row.f}->${row.t}`));
      }
    });

    describe('change_segments', () => {
      it('is created applied, never verified or rolled back already', async () => {
        await expect(
          sql(
            `insert into change_segments
               (workspace_id, plan_id, channel, source_kind, source_name, source_version,
                source_digest, reviewed_digest, proposed_by, applied_by, status, verified_at,
                verification)
             values ($1, gen_random_uuid(), 'human', 'pack', 'p', '1', $2, $2, $3, $3, 'verified',
                     now(), '{}')`,
            [workspaceId, DIGEST, ownerId],
          ),
        ).rejects.toThrow(/created applied/);
        await expect(
          sql(
            `insert into change_segments
               (workspace_id, plan_id, channel, source_kind, source_name, source_version,
                source_digest, reviewed_digest, proposed_by, applied_by, verified_at)
             values ($1, gen_random_uuid(), 'human', 'pack', 'p', '1', $2, $2, $3, $3, now())`,
            [workspaceId, DIGEST, ownerId],
          ),
        ).rejects.toThrow(/not been verified or rolled back/);
      });

      it('refuses a digest that is not sha256:<64 hex>, a source kind other than pack and a channel other than human or platform', async () => {
        const insert = (channel: string, sourceKind: string, reviewedDigest: string) =>
          sql(
            `insert into change_segments
               (workspace_id, plan_id, channel, source_kind, source_name, source_version,
                source_digest, reviewed_digest, proposed_by, applied_by)
             values ($1, gen_random_uuid(), $2, $3, 'p', '1', $4, $5, $6, $6)`,
            [workspaceId, channel, sourceKind, DIGEST, reviewedDigest, ownerId],
          );
        await expect(insert('human', 'pack', 'abc')).rejects.toThrow(/check constraint/);
        await expect(insert('human', 'agent', DIGEST)).rejects.toThrow(/check constraint/);
        await expect(insert('agent', 'pack', DIGEST)).rejects.toThrow(/check constraint/);
        await expect(insert('platform', 'pack', DIGEST)).resolves.toBeDefined();
      });

      it("records the applying transaction's time, whatever the writer passed", async () => {
        const forged = "'2020-01-01T00:00:00Z'";
        const { segment, item, now } = await asApp(async (client) => {
          const inserted = await client.query(
            `insert into change_segments
               (workspace_id, plan_id, channel, source_kind, source_name, source_version,
                source_digest, reviewed_digest, proposed_by, applied_by, created_at, applied_at,
                updated_at)
             values ($1, gen_random_uuid(), 'human', 'pack', 'p', '1', $2, $2, $3, $3, ${forged},
                     ${forged}, ${forged})
             returning id`,
            [workspaceId, DIGEST, ownerId],
          );
          const id = inserted.rows[0]?.id as string;
          await client.query(
            `insert into change_items
               (workspace_id, segment_id, ordinal, kind, target, after, classification, created_at)
             values ($1, $2, 1, 'ontology_version', '{}'::jsonb, '{}'::jsonb, 'not_widening',
                     ${forged})`,
            [workspaceId, id],
          );
          const segmentRow = await client.query(
            'select created_at, applied_at, updated_at from change_segments where id = $1',
            [id],
          );
          const itemRow = await client.query(
            'select created_at from change_items where segment_id = $1',
            [id],
          );
          const nowRow = await client.query('select now() as now');
          return { segment: segmentRow.rows[0], item: itemRow.rows[0], now: nowRow.rows[0]?.now };
        });
        expect(segment.created_at).toEqual(now);
        expect(segment.applied_at).toEqual(now);
        expect(segment.updated_at).toEqual(now);
        expect(item.created_at).toEqual(now);
      });

      it.each([
        ['source_name', "source_name = 'other'"],
        ['source_version', "source_version = '2'"],
        ['source_digest', `source_digest = '${`sha256:${'b'.repeat(64)}`}'`],
        ['reviewed_digest', `reviewed_digest = '${`sha256:${'b'.repeat(64)}`}'`],
        ['applied_by', `applied_by = '${'00000000-0000-0000-0000-000000000000'}'`],
        ['channel', "channel = 'platform'"],
        ['plan_id', 'plan_id = gen_random_uuid()'],
        ['applied_at', "applied_at = now() - interval '1 day'"],
      ])('never changes %s', async (column, set) => {
        const id = await appliedSegment();
        await expect(setSegment(id, set)).rejects.toThrow(new RegExp(`never changes \\(${column}`));
      });

      it('moves along an edge only, and a verification is stamped with the time of its run', async () => {
        const id = await appliedSegment();
        const timesOf = async () =>
          (
            await sql(
              `select verified_at, updated_at, now() as now from change_segments
                where workspace_id = $1 and id = $2`,
              [workspaceId, id],
            )
          ).rows[0] as { verified_at: Date | null; updated_at: Date; now: Date };
        // The CHECK: verified needs a verification run.
        await expect(setSegment(id, "status = 'verified'")).rejects.toThrow(/check constraint/);
        // The writer's verified_at is replaced by the transaction's time.
        await setSegment(
          id,
          `status = 'verified', verified_at = '2020-01-01T00:00:00Z',
           verification = '{"items":[]}'::jsonb`,
        );
        const verified = await timesOf();
        expect(verified.verified_at).not.toEqual(new Date('2020-01-01T00:00:00Z'));
        expect(verified.verified_at?.getTime()).toBeGreaterThan(
          new Date('2020-01-02T00:00:00Z').getTime(),
        );
        await expect(setSegment(id, "status = 'applied'")).rejects.toThrow(
          /illegal transition verified -> applied/,
        );
        // The time never moves without a new result.
        await expect(setSegment(id, "verified_at = now() + interval '1 day'")).rejects.toThrow(
          /time of a verification run/,
        );
        await setSegment(
          id,
          `status = 'verification_failed', verification = '{"items":[1]}'::jsonb`,
        );
        const failed = await timesOf();
        expect(failed.verified_at?.getTime()).toBeGreaterThanOrEqual(
          verified.verified_at?.getTime() ?? Number.POSITIVE_INFINITY,
        );
        await setSegment(id, `status = 'verified', verification = '{"items":[]}'::jsonb`);
        // updated_at is the last write's, whatever the writer passed.
        await setSegment(id, "updated_at = '2020-01-01T00:00:00Z'");
        expect((await timesOf()).updated_at.getTime()).toBeGreaterThanOrEqual(
          failed.verified_at?.getTime() ?? Number.POSITIVE_INFINITY,
        );
      });

      it('is final once rolled back', async () => {
        const id = await appliedSegment();
        await expect(setSegment(id, "status = 'rolled_back'")).rejects.toThrow(/check constraint/);
        await expect(
          setSegment(id, "status = 'rolled_back', rolled_back_at = now()"),
        ).rejects.toThrow(/check constraint/);
        // rolled_back_at is the rolling-back transaction's, whatever the writer passed.
        await setSegment(
          id,
          "status = 'rolled_back', rolled_back_by = $3, rolled_back_at = '2020-01-01T00:00:00Z'",
          [ownerId],
        );
        const rolledBack = await sql(
          'select rolled_back_at from change_segments where workspace_id = $1 and id = $2',
          [workspaceId, id],
        );
        expect(rolledBack.rows[0]?.rolled_back_at).not.toEqual(new Date('2020-01-01T00:00:00Z'));
        await expect(
          setSegment(id, `status = 'verified', verified_at = now(), verification = '{}'::jsonb`),
        ).rejects.toThrow(/rolled back segment is final/);
        await expect(
          setSegment(id, "rolled_back_at = now() + interval '1 second'"),
        ).rejects.toThrow(/rolled back segment is final/);
        await setSegment(id, 'updated_at = now()');
      });

      it('is never deleted by the application role, and is invisible to another workspace', async () => {
        const id = await appliedSegment();
        await expect(
          sql('delete from change_segments where workspace_id = $1 and id = $2', [workspaceId, id]),
        ).rejects.toThrow(/permission denied/);
        const other = await withWorkspace(
          pool,
          { workspaceId: randomUUID(), principalId: randomUUID() },
          (client) => client.query('select id from change_segments where id = $1', [id]),
        );
        expect(other.rows).toHaveLength(0);
      });
    });

    describe('change_items', () => {
      it('is written by the transaction that applies its segment, never afterwards', async () => {
        const id = await appliedSegment();
        await expect(asApp((client) => insertItemIn(client, id, { ordinal: 2 }))).rejects.toThrow(
          /transaction that applies their segment/,
        );
      });

      it('never changes or goes away: no grant to the application role, and the trigger for any other', async () => {
        const id = await appliedSegment();
        await expect(
          sql('update change_items set ordinal = 5 where workspace_id = $1 and segment_id = $2', [
            workspaceId,
            id,
          ]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          sql('delete from change_items where workspace_id = $1 and segment_id = $2', [
            workspaceId,
            id,
          ]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          asOwnerRole(
            "update change_items set classification = 'not_widening' where workspace_id = $1 and segment_id = $2",
            [workspaceId, id],
          ),
        ).rejects.toThrow(/an applied item never changes/);
        await expect(
          asOwnerRole('delete from change_items where workspace_id = $1 and segment_id = $2', [
            workspaceId,
            id,
          ]),
        ).rejects.toThrow(/an applied item never changes/);
      });

      it('a widening item lists why and is confirmed by the person applying the segment (I-A4)', async () => {
        const widening = [{ path: 'actionTypes[x]', reason: 'added' }];
        await expect(
          asApp(async (client) => {
            const id = await insertSegmentIn(client);
            await insertItemIn(client, id, { classification: 'authority_widening', widening });
          }),
        ).rejects.toThrow(/change_items_confirmed/);
        await expect(
          asApp(async (client) => {
            const id = await insertSegmentIn(client);
            await insertItemIn(client, id, {
              classification: 'authority_widening',
              confirmedBy: ownerId,
            });
          }),
        ).rejects.toThrow(/change_items_widening/);
        await expect(
          asApp(async (client) => {
            const id = await insertSegmentIn(client);
            await insertItemIn(client, id, { widening });
          }),
        ).rejects.toThrow(/change_items_widening/);
        await expect(
          asApp(async (client) => {
            const id = await insertSegmentIn(client);
            await insertItemIn(client, id, {
              classification: 'authority_widening',
              widening,
              confirmedBy: memberId,
            });
          }),
        ).rejects.toThrow(/confirmed by the person applying its segment/);
        await asApp(async (client) => {
          const id = await insertSegmentIn(client);
          await insertItemIn(client, id, {
            classification: 'authority_widening',
            widening,
            confirmedBy: ownerId,
          });
        });
      });

      it('refuses an item kind outside CHANGE_ITEM_KIND_VALUES and a repeated ordinal', async () => {
        await expect(
          asApp(async (client) => {
            const id = await insertSegmentIn(client);
            await insertItemIn(client, id, { kind: 'operation' });
          }),
        ).rejects.toThrow(/check constraint/);
        await expect(
          asApp(async (client) => {
            const id = await insertSegmentIn(client);
            await insertItemIn(client, id);
            await insertItemIn(client, id);
          }),
        ).rejects.toThrow(/duplicate key/);
      });
    });
  },
);
