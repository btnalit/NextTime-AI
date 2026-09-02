import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IllegalTransition } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { startActivity } from '../epistemic/activities.js';
import { SqlGraphStore } from './sql-store.js';
import { EpistemicStatusOverrideError, FactNotFoundError, type GraphObject } from './store.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL — same pattern as
 * packages/kernel/src/substrate/invariants.test.ts) for SqlGraphStore, covering the
 * docs/development-tasks.md S1.2 acceptance criteria: upsert-by-identity dedupes; state_at(t0)
 * survives a later supersede; traverse stops at depth 3; invalidate hides a Fact from current
 * views but not from a state_at before the invalidation; a failed assertFact leaves no partial
 * rows; assertFact's outbox row exists.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)('SqlGraphStore (integration, real Postgres)', () => {
  let pool: Pool;
  const store = new SqlGraphStore();

  let workspaceId: string;
  let ownerId: string;
  let agentId: string;
  const humanCaller = () => ({ id: ownerId, kind: 'human' as const });

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

  async function adminInsertPrincipal(opts: { kind: string; role: string; displayName: string }) {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: id },
      async (client) => {
        await client.query(
          'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
          [workspaceId, id, opts.kind, opts.role, opts.displayName],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
  }

  async function makeObject(client: PoolClient, name: string): Promise<GraphObject> {
    return store.upsertObject(client, workspaceId, {
      objectType: 'test.thing',
      properties: { name },
    });
  }

  async function makeActivity(client: PoolClient) {
    return startActivity(client, workspaceId, { kind: 'test.run', principalId: ownerId });
  }

  /** DB-clock "now" — avoids client/server clock skew in the state_at tests below. */
  async function dbNow(): Promise<Date> {
    return inTx(async (client) => {
      const result = await client.query<{ now: Date }>('select now() as now');
      const row = result.rows[0];
      if (!row) throw new Error('select now() produced no row');
      return row.now;
    });
  }

  async function countRows(table: 'links' | 'outbox'): Promise<number> {
    return inTx(async (client) => {
      const result = await client.query<{ n: string }>(
        `select count(*)::text as n from ${table} where workspace_id = $1`,
        [workspaceId],
      );
      return Number(result.rows[0]?.n ?? 0);
    });
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);

    workspaceId = await adminInsertWorkspace('graph-store-test-workspace');
    ownerId = await adminInsertPrincipal({ kind: 'human', role: 'owner', displayName: 'owner' });
    agentId = await adminInsertPrincipal({ kind: 'agent', role: 'member', displayName: 'agent' });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('upsertObject — identity keys (§16)', () => {
    it('two upserts with the same (object_type, identity) produce exactly one Object', async () => {
      const identity = { org: 'example', repo: `widgets-${randomUUID()}` };

      const { first, second } = await inTx(async (client) => {
        const firstObj = await store.upsertObject(client, workspaceId, {
          objectType: 'test.repo',
          identity,
          properties: { stars: 1 },
        });
        const secondObj = await store.upsertObject(client, workspaceId, {
          objectType: 'test.repo',
          identity,
          properties: { stars: 2 },
        });
        return { first: firstObj, second: secondObj };
      });

      expect(second.id).toBe(first.id);
      expect(second.properties).toMatchObject({ stars: 2 });

      const count = await inTx(async (client) => {
        const result = await client.query<{ n: string }>(
          'select count(*)::text as n from objects where workspace_id = $1 and object_type = $2 and identity_key = $3::jsonb',
          [workspaceId, 'test.repo', JSON.stringify(identity)],
        );
        return Number(result.rows[0]?.n ?? 0);
      });
      expect(count).toBe(1);
    });

    it('upserts with no identity always insert a new Object', async () => {
      const { first, second } = await inTx(async (client) => {
        const firstObj = await store.upsertObject(client, workspaceId, {
          objectType: 'test.thing',
        });
        const secondObj = await store.upsertObject(client, workspaceId, {
          objectType: 'test.thing',
        });
        return { first: firstObj, second: secondObj };
      });
      expect(second.id).not.toBe(first.id);
    });
  });

  describe('assertFact — epistemic_status by caller kind, I3, outbox', () => {
    it('human caller → asserted; agent caller → inferred', async () => {
      const { humanFact, agentFact } = await inTx(async (client) => {
        const a = await makeObject(client, 'A');
        const b = await makeObject(client, 'B');
        const activity = await makeActivity(client);
        const humanFact = await store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.rel',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        });
        const agentFact = await store.assertFact(
          client,
          workspaceId,
          { id: agentId, kind: 'agent' },
          {
            linkType: 'test.rel',
            sourceObjectId: a.id,
            targetObjectId: b.id,
            activityId: activity.id,
          },
        );
        return { humanFact, agentFact };
      });

      expect(humanFact.epistemicStatus).toBe('asserted');
      expect(agentFact.epistemicStatus).toBe('inferred');
    });

    it('rejects a caller-supplied epistemic status', async () => {
      await expect(
        inTx(async (client) => {
          const a = await makeObject(client, 'A');
          const b = await makeObject(client, 'B');
          const activity = await makeActivity(client);
          const input = {
            linkType: 'test.rel',
            sourceObjectId: a.id,
            targetObjectId: b.id,
            activityId: activity.id,
            epistemicStatus: 'verified',
          };
          // biome-ignore lint/suspicious/noExplicitAny: deliberately smuggling a field the type omits
          return store.assertFact(client, workspaceId, humanCaller(), input as any);
        }),
      ).rejects.toThrow(EpistemicStatusOverrideError);
    });

    it('enqueues a FactAsserted outbox row in the same transaction', async () => {
      const fact = await inTx(async (client) => {
        const a = await makeObject(client, 'A');
        const b = await makeObject(client, 'B');
        const activity = await makeActivity(client);
        return store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.rel',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        });
      });

      const outboxRows = await inTx(async (client) => {
        const result = await client.query<{ event_type: string; payload: { factId: string } }>(
          "select event_type, payload from outbox where workspace_id = $1 and event_type = 'FactAsserted' and payload->>'factId' = $2",
          [workspaceId, fact.id],
        );
        return result.rows;
      });
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]?.event_type).toBe('FactAsserted');
    });

    it('a failed assertFact (activity_id FK violation) leaves no partial rows', async () => {
      const beforeLinks = await countRows('links');
      const beforeOutbox = await countRows('outbox');

      await expect(
        inTx(async (client) => {
          const a = await makeObject(client, 'A');
          const b = await makeObject(client, 'B');
          return store.assertFact(client, workspaceId, humanCaller(), {
            linkType: 'test.rel',
            sourceObjectId: a.id,
            targetObjectId: b.id,
            activityId: randomUUID(), // no such Activity — FK violation
          });
        }),
      ).rejects.toThrow();

      expect(await countRows('links')).toBe(beforeLinks);
      expect(await countRows('outbox')).toBe(beforeOutbox);
    });
  });

  describe('supersedeFact / stateAt — bitemporal read across a supersede (§5.5, §9.3)', () => {
    it('state_at(t0) still returns the old Fact after a later supersede', async () => {
      const { a, fact1 } = await inTx(async (client) => {
        const a = await makeObject(client, 'A');
        const b = await makeObject(client, 'B');
        const activity = await makeActivity(client);
        const fact1 = await store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.rel',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
          properties: { v: 1 },
        });
        return { a, b, activity, fact1 };
      });

      const t0 = await dbNow();

      const { fact2 } = await inTx(async (client) => {
        const activity = await makeActivity(client);
        const fact2 = await store.supersedeFact(client, workspaceId, humanCaller(), {
          factId: fact1.id,
          linkType: 'test.rel',
          sourceObjectId: fact1.sourceObjectId,
          targetObjectId: fact1.targetObjectId,
          activityId: activity.id,
          properties: { v: 2 },
        });
        return { fact2 };
      });

      const stateAtT0 = await inTx((client) =>
        store.stateAt(client, workspaceId, { objectId: a.id, at: t0 }),
      );
      expect(stateAtT0.facts.map((f) => f.id)).toContain(fact1.id);
      expect(stateAtT0.facts.map((f) => f.id)).not.toContain(fact2.id);
      expect(stateAtT0.facts.find((f) => f.id === fact1.id)?.properties).toEqual({ v: 1 });

      const stateAtNow = await inTx((client) =>
        store.stateAt(client, workspaceId, { objectId: a.id, at: new Date() }),
      );
      expect(stateAtNow.facts.map((f) => f.id)).toContain(fact2.id);
      expect(stateAtNow.facts.map((f) => f.id)).not.toContain(fact1.id);
    });

    it('supersedeFact on a missing Fact throws FactNotFoundError', async () => {
      await expect(
        inTx((client) =>
          store.supersedeFact(client, workspaceId, humanCaller(), {
            factId: randomUUID(),
            linkType: 'test.rel',
            sourceObjectId: randomUUID(),
            targetObjectId: randomUUID(),
            activityId: randomUUID(),
          }),
        ),
      ).rejects.toThrow(FactNotFoundError);
    });

    it('supersedeFact on an already-superseded Fact throws IllegalTransition (FactLifecycle)', async () => {
      const { fact1 } = await inTx(async (client) => {
        const a = await makeObject(client, 'A');
        const b = await makeObject(client, 'B');
        const activity = await makeActivity(client);
        const fact1 = await store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.rel',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        });
        await store.supersedeFact(client, workspaceId, humanCaller(), {
          factId: fact1.id,
          linkType: 'test.rel',
          sourceObjectId: fact1.sourceObjectId,
          targetObjectId: fact1.targetObjectId,
          activityId: activity.id,
        });
        return { fact1 };
      });

      await expect(
        inTx(async (client) => {
          const activity = await makeActivity(client);
          return store.supersedeFact(client, workspaceId, humanCaller(), {
            factId: fact1.id,
            linkType: 'test.rel',
            sourceObjectId: fact1.sourceObjectId,
            targetObjectId: fact1.targetObjectId,
            activityId: activity.id,
          });
        }),
      ).rejects.toThrow(IllegalTransition);
    });
  });

  describe('invalidateFact', () => {
    it('hides the Fact from current views (neighbors) but state_at before invalidation still sees it', async () => {
      const { a, fact1 } = await inTx(async (client) => {
        const a = await makeObject(client, 'A');
        const b = await makeObject(client, 'B');
        const activity = await makeActivity(client);
        const fact1 = await store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.rel',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        });
        return { a, b, fact1 };
      });

      const t0 = await dbNow();

      await inTx((client) =>
        store.invalidateFact(client, workspaceId, humanCaller(), { factId: fact1.id }),
      );

      const currentNeighbors = await inTx((client) =>
        store.neighbors(client, workspaceId, { objectId: a.id }),
      );
      expect(currentNeighbors.map((f) => f.id)).not.toContain(fact1.id);

      const stateAtT0 = await inTx((client) =>
        store.stateAt(client, workspaceId, { objectId: a.id, at: t0 }),
      );
      expect(stateAtT0.facts.map((f) => f.id)).toContain(fact1.id);
    });

    it('invalidateFact on an already-invalidated Fact throws IllegalTransition', async () => {
      const { fact1 } = await inTx(async (client) => {
        const a = await makeObject(client, 'A');
        const b = await makeObject(client, 'B');
        const activity = await makeActivity(client);
        const fact1 = await store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.rel',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        });
        await store.invalidateFact(client, workspaceId, humanCaller(), { factId: fact1.id });
        return { fact1 };
      });

      await expect(
        inTx((client) =>
          store.invalidateFact(client, workspaceId, humanCaller(), { factId: fact1.id }),
        ),
      ).rejects.toThrow(IllegalTransition);
    });

    it('persists a given reason on invalidationReason; omitting it leaves invalidationReason null', async () => {
      const { fact1, fact2 } = await inTx(async (client) => {
        const a = await makeObject(client, 'A');
        const b = await makeObject(client, 'B');
        const activity = await makeActivity(client);
        const fact1 = await store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.rel',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        });
        const fact2 = await store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.rel2',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        });
        return { fact1, fact2 };
      });

      const invalidatedWithReason = await inTx((client) =>
        store.invalidateFact(client, workspaceId, humanCaller(), {
          factId: fact1.id,
          reason: 'superseded by external correction',
        }),
      );
      expect(invalidatedWithReason.invalidationReason).toBe('superseded by external correction');

      const invalidatedWithoutReason = await inTx((client) =>
        store.invalidateFact(client, workspaceId, humanCaller(), { factId: fact2.id }),
      );
      expect(invalidatedWithoutReason.invalidationReason).toBeNull();
    });
  });

  describe('traverse — depth ≤ 3, direction, link_type filter (§9.3)', () => {
    it('walks a chain A→B→C→D and stops at depth 3, never reaching a depth-4 node', async () => {
      const { a, b, c, d, e } = await inTx(async (client) => {
        const a = await makeObject(client, 'A');
        const b = await makeObject(client, 'B');
        const c = await makeObject(client, 'C');
        const d = await makeObject(client, 'D');
        const e = await makeObject(client, 'E');
        const activity = await makeActivity(client);
        const link = async (from: GraphObject, to: GraphObject) =>
          store.assertFact(client, workspaceId, humanCaller(), {
            linkType: 'test.chain',
            sourceObjectId: from.id,
            targetObjectId: to.id,
            activityId: activity.id,
          });
        await link(a, b); // depth 1
        await link(b, c); // depth 2
        await link(c, d); // depth 3
        await link(d, e); // depth 4 — out of range for depth: 3
        return { a, b, c, d, e };
      });

      const result = await inTx((client) =>
        store.traverse(client, workspaceId, { fromId: a.id, direction: 'out', depth: 3 }),
      );

      expect(result.nodes).toEqual(expect.arrayContaining([b.id, c.id, d.id]));
      expect(result.nodes).not.toContain(e.id);
      expect(result.edges).toHaveLength(3);
      expect(Math.max(...result.edges.map((edge) => edge.depth))).toBe(3);
    });

    it('respects an explicit link_type filter', async () => {
      const { a, matching, other } = await inTx(async (client) => {
        const a = await makeObject(client, 'A');
        const matching = await makeObject(client, 'M');
        const other = await makeObject(client, 'O');
        const activity = await makeActivity(client);
        await store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.wanted',
          sourceObjectId: a.id,
          targetObjectId: matching.id,
          activityId: activity.id,
        });
        await store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.unwanted',
          sourceObjectId: a.id,
          targetObjectId: other.id,
          activityId: activity.id,
        });
        return { a, matching, other };
      });

      const result = await inTx((client) =>
        store.traverse(client, workspaceId, {
          fromId: a.id,
          direction: 'out',
          linkType: 'test.wanted',
          depth: 1,
        }),
      );

      expect(result.nodes).toContain(matching.id);
      expect(result.nodes).not.toContain(other.id);
    });
  });

  describe('search — S1 minimal ILIKE (§9.1)', () => {
    it('finds an Object by a substring of its properties', async () => {
      const marker = `findme-${randomUUID()}`;
      await inTx(async (client) => {
        await store.upsertObject(client, workspaceId, {
          objectType: 'test.searchable',
          properties: { label: marker },
        });
      });

      const results = await inTx((client) => store.search(client, workspaceId, { query: marker }));
      expect(results.some((obj) => obj.properties.label === marker)).toBe(true);
    });
  });

  describe('listRecentFacts — S1.4 get_entry_context', () => {
    it('returns currently-active facts newest-first, excluding a superseded one, respecting limit', async () => {
      const [a, b] = await inTx(async (client) => [
        await makeObject(client, `recent-a-${randomUUID()}`),
        await makeObject(client, `recent-b-${randomUUID()}`),
      ]);
      if (!a || !b) throw new Error('makeObject produced no object');

      const originalFactId = await inTx(async (client) => {
        const activity = await makeActivity(client);
        const fact = await store.assertFact(client, workspaceId, humanCaller(), {
          linkType: 'test.recent',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        });
        return fact.id;
      });

      // Supersede the first fact, then assert a second, unrelated fact — the superseded original
      // must never appear in listRecentFacts.
      const newFactId = await inTx(async (client) => {
        const activity = await makeActivity(client);
        const fact = await store.supersedeFact(client, workspaceId, humanCaller(), {
          factId: originalFactId,
          linkType: 'test.recent',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        });
        return fact.id;
      });

      const recent = await inTx((client) => store.listRecentFacts(client, workspaceId, 500));
      const ids = recent.map((fact) => fact.id);
      expect(ids).toContain(newFactId);
      expect(ids).not.toContain(originalFactId);
      expect(recent.every((fact) => typeof fact.epistemicStatus === 'string')).toBe(true);

      const limited = await inTx((client) => store.listRecentFacts(client, workspaceId, 1));
      expect(limited).toHaveLength(1);
    });
  });
});
