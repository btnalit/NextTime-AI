import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { SqlGraphStore } from '../graph/index.js';
import { startActivity } from './activities.js';
import { listConflicts } from './conflicts.js';
import { recordSourceObservation, registerPrivateSource } from './sources.js';

/**
 * substrate/epistemic/conflicts.test: integration tests (real Postgres; auto-skip without
 * DATABASE_URL) for S3.2 冲突检测 (docs/development-tasks.md S3.2). Covers the v0.1 "T0.4"
 * three-step scenario the S3.2 dispatch names verbatim ("assert A from source S1; assert
 * conflicting A' from S1 → supersede; assert A'' from source S2 → Conflict open") plus the
 * private-Source visibility rule (§5.6) — both exercised through `SqlGraphStore.assertFact`
 * directly (the single seam every Fact writer goes through, `conflicts.ts`'s own module doc
 * comment), the same level `explain.test.ts` already tests at.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'conflict detection (integration, real Postgres)',
  () => {
    let pool: Pool;
    const store = new SqlGraphStore();
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;

    async function asPrincipal<T>(
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

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
            'conflicts-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, ownerId, 'human', 'owner', 'owner'],
          );
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, memberId, 'human', 'member', 'member'],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('T0.4: same-source re-assertion supersedes; different-source re-assertion opens a Conflict(open)', async () => {
      const { factA, factA2, factA3 } = await asPrincipal(ownerId, async (client) => {
        const objectA = await store.upsertObject(client, workspaceId, { objectType: 'test.host' });
        const objectB = await store.upsertObject(client, workspaceId, {
          objectType: 'test.service',
        });

        const sourceS1 = await registerPrivateSource(client, workspaceId, {
          kind: 'test.collector',
          ownerPrincipalId: ownerId,
        });
        const sourceS2 = await registerPrivateSource(client, workspaceId, {
          kind: 'test.collector',
          ownerPrincipalId: ownerId,
        });

        // Step 1: assert A from source S1.
        const activity1 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS1.id,
          activityId: activity1.id,
        });
        const factA = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectB.id,
            targetObjectId: objectA.id,
            activityId: activity1.id,
            properties: { port: 80 },
          },
        );
        expect(factA.supersedesId).toBeNull();

        // Step 2: assert conflicting A' from the *same* source S1 → supersede.
        const activity2 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS1.id,
          activityId: activity2.id,
        });
        const factA2 = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectB.id,
            targetObjectId: objectA.id,
            activityId: activity2.id,
            properties: { port: 8080 },
          },
        );
        expect(factA2.supersedesId).toBe(factA.id);

        // Step 3: assert A'' from a *different* source S2 → keep both, open a Conflict(open).
        const activity3 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS2.id,
          activityId: activity3.id,
        });
        const factA3 = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectB.id,
            targetObjectId: objectA.id,
            activityId: activity3.id,
            properties: { port: 9090 },
          },
        );
        expect(factA3.supersedesId).toBeNull();

        return { factA, factA2, factA3 };
      });

      await asPrincipal(ownerId, async (client) => {
        // factA (step 1) is now superseded by factA2 — re-fetch to confirm.
        const factARow = await client.query<{ superseded_at: Date | null }>(
          'select superseded_at from links where workspace_id = $1 and id = $2',
          [workspaceId, factA.id],
        );
        expect(factARow.rows[0]?.superseded_at).not.toBeNull();

        // factA2 and factA3 are *both* still `recorded` (I5 "keep both").
        const activeRows = await client.query<{ id: string; superseded_at: Date | null }>(
          'select id, superseded_at from links where workspace_id = $1 and id = any($2::uuid[])',
          [workspaceId, [factA2.id, factA3.id]],
        );
        for (const row of activeRows.rows) expect(row.superseded_at).toBeNull();

        // Exactly one open Conflict, referencing factA2 and factA3.
        const page = await listConflicts(client, workspaceId, { status: 'open' });
        const conflict = page.items.find(
          (item) =>
            (item.factAId === factA2.id && item.factBId === factA3.id) ||
            (item.factAId === factA3.id && item.factBId === factA2.id),
        );
        expect(conflict).toBeDefined();
        expect(conflict?.status).toBe('open');
        expect(conflict?.activityId).toBeTruthy();
      });
    });

    it('S3.2 followup: a same-origin re-assertion with identical content is a no-op, not a supersede — no new Fact row, no Conflict', async () => {
      await asPrincipal(ownerId, async (client) => {
        const objectA = await store.upsertObject(client, workspaceId, { objectType: 'test.host' });
        const objectB = await store.upsertObject(client, workspaceId, {
          objectType: 'test.service',
        });

        const sourceS1 = await registerPrivateSource(client, workspaceId, {
          kind: 'test.collector',
          ownerPrincipalId: ownerId,
        });

        // Step 1: assert A from source S1.
        const activity1 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS1.id,
          activityId: activity1.id,
        });
        const factA = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectB.id,
            targetObjectId: objectA.id,
            activityId: activity1.id,
            properties: { port: 80 },
          },
        );
        expect(factA.supersedesId).toBeNull();

        // Step 2: re-assert the *same* content, from the *same* source S1 → no-op, not a supersede.
        const activity2 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS1.id,
          activityId: activity2.id,
        });
        const factA2 = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectB.id,
            targetObjectId: objectA.id,
            activityId: activity2.id,
            properties: { port: 80 }, // identical to step 1
          },
        );
        expect(factA2.unchanged).toBe(true);
        expect(factA2.id).toBe(factA.id);

        // factA is still the one and only active Fact — never superseded.
        const activeRows = await client.query<{ id: string; superseded_at: Date | null }>(
          'select id, superseded_at from links where workspace_id = $1 and id = $2',
          [workspaceId, factA.id],
        );
        expect(activeRows.rows[0]?.superseded_at).toBeNull();

        // No Conflict was opened either.
        const page = await listConflicts(client, workspaceId, { status: 'open' });
        const conflict = page.items.find(
          (item) => item.factAId === factA.id || item.factBId === factA.id,
        );
        expect(conflict).toBeUndefined();
      });
    });

    it('different-source re-assertion with identical content is a corroboration: no new Fact, no Conflict', async () => {
      await asPrincipal(ownerId, async (client) => {
        const objectA = await store.upsertObject(client, workspaceId, { objectType: 'test.host' });
        const objectB = await store.upsertObject(client, workspaceId, {
          objectType: 'test.service',
        });

        const sourceS1 = await registerPrivateSource(client, workspaceId, {
          kind: 'test.collector',
          ownerPrincipalId: ownerId,
        });
        const sourceS2 = await registerPrivateSource(client, workspaceId, {
          kind: 'test.collector',
          ownerPrincipalId: ownerId,
        });

        // Step 1: assert A from source S1.
        const activity1 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS1.id,
          activityId: activity1.id,
        });
        const factA = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectB.id,
            targetObjectId: objectA.id,
            activityId: activity1.id,
            properties: { port: 80 },
          },
        );
        expect(factA.supersedesId).toBeNull();

        // Step 2: re-assert the *same* content, from a *different* source S2 — W5.5 (STATUS
        // leftover 16): different origin + identical content is corroboration, not disagreement, so
        // this must be a no-op returning the prior Fact `unchanged`, not a Conflict.
        const activity2 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS2.id,
          activityId: activity2.id,
        });
        const factA2 = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectB.id,
            targetObjectId: objectA.id,
            activityId: activity2.id,
            properties: { port: 80 }, // identical to step 1
          },
        );
        expect(factA2.unchanged).toBe(true);
        expect(factA2.id).toBe(factA.id);

        // factA is still the one and only active Fact.
        const activeRows = await client.query<{ id: string; superseded_at: Date | null }>(
          'select id, superseded_at from links where workspace_id = $1 and id = $2',
          [workspaceId, factA.id],
        );
        expect(activeRows.rows[0]?.superseded_at).toBeNull();

        // No Conflict was opened.
        const pageAfterCorroboration = await listConflicts(client, workspaceId, { status: 'open' });
        const noConflict = pageAfterCorroboration.items.find(
          (item) => item.factAId === factA.id || item.factBId === factA.id,
        );
        expect(noConflict).toBeUndefined();

        // Step 3: assert *different* content from S2 — confirms the corroboration path above did
        // not disable Conflict detection for this identity.
        const activity3 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS2.id,
          activityId: activity3.id,
        });
        const factA3 = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectB.id,
            targetObjectId: objectA.id,
            activityId: activity3.id,
            properties: { port: 81 }, // differs from step 1/2
          },
        );
        expect(factA3.supersedesId).toBeNull();

        const pageAfterConflict = await listConflicts(client, workspaceId, { status: 'open' });
        const conflict = pageAfterConflict.items.find(
          (item) =>
            (item.factAId === factA.id && item.factBId === factA3.id) ||
            (item.factAId === factA3.id && item.factBId === factA.id),
        );
        expect(conflict).toBeDefined();
        expect(conflict?.status).toBe('open');
      });
    });

    it('a Conflict involving a private-source Fact is visible only to that source’s owner', async () => {
      // Object/link identity shared by both assertions.
      const { objectAId, objectBId } = await asPrincipal(ownerId, async (client) => {
        const objectA = await store.upsertObject(client, workspaceId, {
          objectType: 'test.host',
          identity: { hostname: `visibility-${randomUUID()}` },
        });
        const objectB = await store.upsertObject(client, workspaceId, {
          objectType: 'test.service',
          identity: { name: `visibility-svc-${randomUUID()}` },
        });
        return { objectAId: objectA.id, objectBId: objectB.id };
      });

      // owner asserts from their own private Source.
      const factPrivate = await asPrincipal(ownerId, async (client) => {
        const privateSource = await registerPrivateSource(client, workspaceId, {
          kind: 'test.private-collector',
          ownerPrincipalId: ownerId,
        });
        const activity = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: privateSource.id,
          activityId: activity.id,
        });
        return store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectBId,
            targetObjectId: objectAId,
            activityId: activity.id,
            // W5.5: content must differ — identical content from another origin is a corroboration.
            properties: { port: 80 },
          },
        );
      });

      // `member` (a different principal, no Source at all — falls back to the asserting principal,
      // which differs from `owner`, so this is a different origin) asserts the same identity from
      // *their own* transaction — deliberately not `owner`'s, so the INSERT that opens the Conflict
      // runs with `app_principal() = memberId`, which cannot see `factPrivate` under
      // `conflicts_visibility`'s `using` clause. This is exactly the asymmetric using/with check
      // migrations/core/0017 documents — the regression this test locks in.
      await asPrincipal(memberId, async (client) => {
        const activity = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await store.assertFact(
          client,
          workspaceId,
          { id: memberId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectBId,
            targetObjectId: objectAId,
            activityId: activity.id,
            properties: { port: 81 },
          },
        );
      });

      const ownerConflictId = await asPrincipal(ownerId, async (client) => {
        const page = await listConflicts(client, workspaceId, { status: 'open' });
        const conflict = page.items.find(
          (item) => item.factAId === factPrivate.id || item.factBId === factPrivate.id,
        );
        return conflict?.id;
      });

      expect(ownerConflictId).toBeDefined();

      // `member` cannot see it: the private-source side hides the whole Conflict row from them.
      const memberSees = await asPrincipal(memberId, async (client) => {
        const page = await listConflicts(client, workspaceId, { status: 'open' });
        return page.items.some((item) => item.id === ownerConflictId);
      });
      expect(memberSees).toBe(false);
    });

    /** Small promise helper for the two concurrency tests below — no external libs. */
    function deferred<T = void>(): {
      readonly promise: Promise<T>;
      readonly resolve: (value: T) => void;
    } {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    /** Races `candidate` against a ~300ms timer and reports which one won, without ever leaving
     *  an unhandled rejection behind if `candidate` eventually rejects. */
    async function settledWithin300ms(candidate: Promise<unknown>): Promise<boolean> {
      const outcome = await Promise.race([
        candidate.then(
          () => 'settled' as const,
          () => 'settled' as const,
        ),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300)),
      ]);
      return outcome === 'settled';
    }

    it('two concurrent first assertions of one identity from different sources serialize and open exactly one Conflict', async () => {
      const { objectAId, objectBId, sourceS1, sourceS2 } = await asPrincipal(
        ownerId,
        async (client) => {
          const objectA = await store.upsertObject(client, workspaceId, {
            objectType: 'test.host',
          });
          const objectB = await store.upsertObject(client, workspaceId, {
            objectType: 'test.service',
          });
          const sourceS1 = await registerPrivateSource(client, workspaceId, {
            kind: 'test.collector',
            ownerPrincipalId: ownerId,
          });
          const sourceS2 = await registerPrivateSource(client, workspaceId, {
            kind: 'test.collector',
            ownerPrincipalId: ownerId,
          });
          return { objectAId: objectA.id, objectBId: objectB.id, sourceS1, sourceS2 };
        },
      );

      const t1Asserted = deferred<Awaited<ReturnType<typeof store.assertFact>>>();
      const releaseT1 = deferred<void>();

      // T1: asserts, signals it has asserted, then holds its transaction open until released.
      const t1 = withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity1 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS1.id,
          activityId: activity1.id,
        });
        const fact1 = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectBId,
            targetObjectId: objectAId,
            activityId: activity1.id,
            properties: { port: 80 },
          },
        );
        t1Asserted.resolve(fact1);
        await releaseT1.promise;
      });

      const fact1 = await t1Asserted.promise;

      // T2: starts only after T1 has asserted (and is still holding its transaction open) — it
      // must block on the advisory lock T1 took for this identity's first-assertion path.
      const t2 = withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity2 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS2.id,
          activityId: activity2.id,
        });
        return store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectBId,
            targetObjectId: objectAId,
            activityId: activity2.id,
            properties: { port: 81 },
          },
        );
      });

      // try/finally: if the `settledWithin300ms` assertion below throws, T1's `fn` is still
      // waiting on `releaseT1.promise` — without releasing it here too, T1's `withWorkspace` never
      // COMMITs, its client is never released back to the pool, and `afterAll`'s `pool.end()`
      // hangs until vitest's hook timeout, masking the real assertion failure.
      try {
        expect(await settledWithin300ms(t2)).toBe(false);
      } finally {
        releaseT1.resolve();
      }
      await t1;
      const fact2 = await t2;

      expect(fact2.id).not.toBe(fact1.id);
      expect(fact2.supersedesId).toBeNull();

      await asPrincipal(ownerId, async (client) => {
        const activeRows = await client.query<{ id: string }>(
          `select id from links
           where workspace_id = $1 and link_type = $2
             and source_object_id = $3 and target_object_id = $4
             and superseded_at is null and invalidated_at is null`,
          [workspaceId, 'test.runs_on', objectBId, objectAId],
        );
        expect(activeRows.rows.map((row) => row.id).sort()).toEqual([fact1.id, fact2.id].sort());

        const page = await listConflicts(client, workspaceId, { status: 'open' });
        const matching = page.items.filter(
          (item) =>
            (item.factAId === fact1.id && item.factBId === fact2.id) ||
            (item.factAId === fact2.id && item.factBId === fact1.id),
        );
        expect(matching).toHaveLength(1);
        expect(matching[0]?.status).toBe('open');
      });
    });

    it('two concurrent first assertions of one identity, same source and identical content: the second serializes behind the first and comes back unchanged', async () => {
      // Deliberately the *same* Source (S1) for both T1 and T2 here, not two different sources:
      // `resolveFactOrigin`/`sameFactOrigin` (conflicts.ts) key the unchanged-vs-Conflict decision
      // on origin, and a *different*-origin re-assertion always opens a Conflict regardless of
      // whether the content matches (see assertFact's priorRow branch in sql-store.ts) — so a
      // same-content, different-origin race would still open a Conflict, not return `unchanged`.
      // To actually exercise the no-op branch under the same lock-then-reread race, T2 must share
      // T1's origin.
      const { objectAId, objectBId, sourceS1 } = await asPrincipal(ownerId, async (client) => {
        const objectA = await store.upsertObject(client, workspaceId, { objectType: 'test.host' });
        const objectB = await store.upsertObject(client, workspaceId, {
          objectType: 'test.service',
        });
        const sourceS1 = await registerPrivateSource(client, workspaceId, {
          kind: 'test.collector',
          ownerPrincipalId: ownerId,
        });
        return { objectAId: objectA.id, objectBId: objectB.id, sourceS1 };
      });

      const t1Asserted = deferred<Awaited<ReturnType<typeof store.assertFact>>>();
      const releaseT1 = deferred<void>();

      const t1 = withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity1 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS1.id,
          activityId: activity1.id,
        });
        const fact1 = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectBId,
            targetObjectId: objectAId,
            activityId: activity1.id,
            properties: { port: 80 },
          },
        );
        t1Asserted.resolve(fact1);
        await releaseT1.promise;
      });

      const fact1 = await t1Asserted.promise;

      const t2 = withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity2 = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS1.id,
          activityId: activity2.id,
        });
        return store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: objectBId,
            targetObjectId: objectAId,
            activityId: activity2.id,
            properties: { port: 80 }, // identical to T1
          },
        );
      });

      // See the sibling test above for why this is try/finally rather than a bare assert-then-release.
      try {
        expect(await settledWithin300ms(t2)).toBe(false);
      } finally {
        releaseT1.resolve();
      }
      await t1;
      const fact2 = await t2;

      expect(fact2.unchanged).toBe(true);
      expect(fact2.id).toBe(fact1.id);

      await asPrincipal(ownerId, async (client) => {
        const activeRows = await client.query<{ id: string }>(
          `select id from links
           where workspace_id = $1 and link_type = $2
             and source_object_id = $3 and target_object_id = $4
             and superseded_at is null and invalidated_at is null`,
          [workspaceId, 'test.runs_on', objectBId, objectAId],
        );
        expect(activeRows.rows.map((row) => row.id)).toEqual([fact1.id]);

        const page = await listConflicts(client, workspaceId, { status: 'open' });
        const matching = page.items.filter(
          (item) => item.factAId === fact1.id || item.factBId === fact1.id,
        );
        expect(matching).toHaveLength(0);
      });
    });
  },
);
