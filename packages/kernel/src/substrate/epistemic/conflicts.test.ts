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
  },
);
