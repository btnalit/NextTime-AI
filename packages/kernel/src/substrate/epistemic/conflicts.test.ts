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
import { queryDecisions } from './decisions.js';
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

    it('S5.5 leftover 24: a re-read that blocks on a second supersede still lands on the chain tip — never an extra active Fact', async () => {
      // The interleaving STATUS leftover 24 describes, made deterministic with four transactions:
      //   F0 committed.
      //   TX  holds the identity's advisory lock (a stand-in for any other first-time asserter).
      //   T3  supersedes F0 → F1 and holds (F0's row lock, F1 uncommitted).
      //   T2  asserts: its first lookup blocks on F0 (T3's lock). T3 commits → the blocked
      //       statement rechecks F0 alone, now superseded → 0 rows → T2 goes for the advisory
      //       lock → blocks on TX.
      //   T4  supersedes F1 → F2 and holds (T4 found F1 on its first lookup, so it never touches
      //       the advisory lock).
      //   TX  commits → T2 takes the advisory lock → its re-read blocks on F1 (T4's lock).
      //   T4  commits → the re-read rechecks F1 alone, now superseded → 0 rows again, F2 outside
      //       that statement's snapshot. Before migration 0029 T2 inserted a fresh row here (two
      //       active Facts for one identity); now it sees F2 is the un-invalidated newest row,
      //       re-reads once more, finds F2 and supersedes it.
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
      const identity = {
        linkType: 'test.runs_on',
        sourceObjectId: objectBId,
        targetObjectId: objectAId,
      };
      const advisoryKey = `${workspaceId}:fact:${identity.linkType}:${identity.sourceObjectId}:${identity.targetObjectId}`;

      async function assertAs(client: PoolClient, port: number) {
        const activity = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: sourceS1.id,
          activityId: activity.id,
        });
        return store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          { ...identity, activityId: activity.id, properties: { port } },
        );
      }

      const fact0 = await asPrincipal(ownerId, (client) => assertAs(client, 80));

      // TX: holds the identity's advisory lock until released.
      const txLocked = deferred<void>();
      const releaseTx = deferred<void>();
      const tx = withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [advisoryKey]);
        txLocked.resolve();
        await releaseTx.promise;
      });
      await txLocked.promise;

      // T3: supersedes F0 → F1 and holds.
      const t3Asserted = deferred<Awaited<ReturnType<typeof store.assertFact>>>();
      const releaseT3 = deferred<void>();
      const t3 = withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        t3Asserted.resolve(await assertAs(client, 81));
        await releaseT3.promise;
      });
      const fact1 = await t3Asserted.promise;
      expect(fact1.supersedesId).toBe(fact0.id);

      // T2: blocks on F0's row lock inside its first lookup.
      const t2 = withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        assertAs(client, 82),
      );

      let fact2: Awaited<ReturnType<typeof store.assertFact>> | undefined;
      const releaseT4 = deferred<void>();
      let t4: Promise<void> | undefined;
      try {
        expect(await settledWithin300ms(t2)).toBe(false);
        releaseT3.resolve();
        await t3;
        // T2 woke up with 0 rows and is now waiting for the advisory lock TX holds.
        expect(await settledWithin300ms(t2)).toBe(false);

        // T4: supersedes F1 → F2 and holds F1's row lock.
        const t4Asserted = deferred<Awaited<ReturnType<typeof store.assertFact>>>();
        t4 = withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          t4Asserted.resolve(await assertAs(client, 83));
          await releaseT4.promise;
        });
        fact2 = await t4Asserted.promise;
        expect(fact2.supersedesId).toBe(fact1.id);

        // TX commits: T2 takes the advisory lock, re-reads, and blocks on F1 under T4.
        releaseTx.resolve();
        await tx;
        expect(await settledWithin300ms(t2)).toBe(false);
      } finally {
        releaseT3.resolve();
        releaseTx.resolve();
        releaseT4.resolve();
      }
      await t4;
      const fact3 = await t2;

      // The chain tip, not a duplicate: T2 built on F2 (same origin, changed content → supersede).
      expect(fact3.supersedesId).toBe(fact2?.id);
      expect(fact3.unchanged).toBeUndefined();

      await asPrincipal(ownerId, async (client) => {
        const activeRows = await client.query<{ id: string }>(
          `select id from links
           where workspace_id = $1 and link_type = $2
             and source_object_id = $3 and target_object_id = $4
             and superseded_at is null and invalidated_at is null`,
          [workspaceId, identity.linkType, identity.sourceObjectId, identity.targetObjectId],
        );
        expect(activeRows.rows.map((row) => row.id)).toEqual([fact3.id]);

        const page = await listConflicts(client, workspaceId, { status: 'open' });
        const involved = new Set([fact0.id, fact1.id, fact2?.id, fact3.id]);
        expect(
          page.items.filter((item) => involved.has(item.factAId) || involved.has(item.factBId)),
        ).toHaveLength(0);
      });
    });

    it('S5.5 leftover 23: two Conflicts / two Decisions in the same millisecond are not skipped at a page boundary', async () => {
      // The cursor carries a JS Date (milliseconds); the columns hold microseconds. Two rows at
      // 12:00:00.000456 and 12:00:00.000789 both encode as 12:00:00.000Z — with the old
      // `(opened_at, id) < (cursor)` comparison the second page never returned the other row.
      const { factAId, factBId, activityId } = await asPrincipal(ownerId, async (client) => {
        const objectA = await store.upsertObject(client, workspaceId, { objectType: 'test.host' });
        const objectB = await store.upsertObject(client, workspaceId, {
          objectType: 'test.service',
        });
        const activity = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        const factA = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.paging_a',
            sourceObjectId: objectB.id,
            targetObjectId: objectA.id,
            activityId: activity.id,
          },
        );
        const factB = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.paging_b',
            sourceObjectId: objectB.id,
            targetObjectId: objectA.id,
            activityId: activity.id,
          },
        );
        return { factAId: factA.id, factBId: factB.id, activityId: activity.id };
      });

      // Far in the past so nothing else in the shared database sorts between the pair, and two
      // distinct microsecond values inside one millisecond.
      const conflictIds: string[] = [randomUUID(), randomUUID()].sort();
      const decisionIds: string[] = [randomUUID(), randomUUID()].sort();
      await asPrincipal(ownerId, async (client) => {
        // `dismissed` so the paging below is isolated from the open Conflicts other cases leave
        // behind; a resolved status must carry `resolved_by` / `resolved_at` (0017's
        // `conflicts_resolved_fields_check`).
        await client.query(
          `insert into conflicts (workspace_id, id, conflict_type, status, link_a_id, link_b_id, activity_id, opened_at, resolved_by, resolved_at)
           values ($1, $2, 'value', 'dismissed', $4, $5, $6, '2001-01-01T00:00:00.000456Z', $7, '2001-01-01T00:00:01Z'),
                  ($1, $3, 'value', 'dismissed', $4, $5, $6, '2001-01-01T00:00:00.000789Z', $7, '2001-01-01T00:00:01Z')`,
          [workspaceId, conflictIds[0], conflictIds[1], factAId, factBId, activityId, ownerId],
        );
        await client.query(
          `insert into decisions (workspace_id, id, status, activity_id, summary, created_at)
           values ($1, $2, 'proposed', $4, 'paging a', '2001-01-01T00:00:00.000456Z'),
                  ($1, $3, 'proposed', $4, 'paging b', '2001-01-01T00:00:00.000789Z')`,
          [workspaceId, decisionIds[0], decisionIds[1], activityId],
        );
      });

      await asPrincipal(ownerId, async (client) => {
        const seenConflicts = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 50 && seenConflicts.size < 2; page++) {
          const result = await listConflicts(client, workspaceId, {
            status: 'dismissed',
            limit: 1,
            ...(cursor ? { cursor } : {}),
          });
          for (const item of result.items) {
            if (conflictIds.includes(item.id)) seenConflicts.add(item.id);
          }
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
        expect([...seenConflicts].sort()).toEqual(conflictIds);

        const seenDecisions = new Set<string>();
        cursor = undefined;
        for (let page = 0; page < 50 && seenDecisions.size < 2; page++) {
          const result = await queryDecisions(client, workspaceId, {
            limit: 1,
            ...(cursor ? { cursor } : {}),
          });
          for (const item of result.items) {
            if (decisionIds.includes(item.id)) seenDecisions.add(item.id);
          }
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
        expect([...seenDecisions].sort()).toEqual(decisionIds);
      });
    });
  },
);
