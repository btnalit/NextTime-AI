import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { getOrCreateGatekeeperServicePrincipal } from '../../governance/gatekeepers/index.js';
import { runInvariantChecks } from '../../substrate/audit/invariant-checks.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { writeObservedFacts } from './observed-facts.js';

/**
 * application/gateway/observed-facts.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) coverage of S5.2's "every gate observation names its Source" (I-S5-2; docs/
 * development-tasks.md §5b S5.2). Bare workspace fixture (raw SQL, no published ontology — the
 * S5.1 guard's documented "unadopted workspace is not enforced" boundary), same pattern as
 * substrate/ontology/meta-objects.test.ts: this file is about Source / Observation threading, not
 * the ontology.
 *
 *   1. a gate's first observation registers its Source (`kind: 'gatekeeper'`), records one
 *      Observation on the Activity, and the Fact / Object carry it (`observation_id`,
 *      `last_observed_at`);
 *   2. the same gate observing the same target again: same Source (no duplicate), Fact unchanged,
 *      `last_observation_id` advanced to the new Observation;
 *   3. a pre-S5.2-shaped `observed` Fact (shared principal, no Observation) is corroborated, not
 *      touched — and I-S5-2 counts exactly that row, never the gate's Source-backed ones.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

interface LinkRow {
  id: string;
  epistemic_status: string;
  observation_id: string | null;
  last_observation_id: string | null;
  last_observed_at: Date | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/gateway/observed-facts — gate observations name their Source (integration)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperObjectId: string;
    const graphStore = new SqlGraphStore();

    function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function newActivity(): Promise<string> {
      return inTx(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'gatekeeper_observe',
          principalId: ownerId,
        });
        return activity.id;
      });
    }

    async function linkRow(id: string): Promise<LinkRow | undefined> {
      const result = await inTx((client) =>
        client.query<LinkRow>(
          `select id, epistemic_status, observation_id, last_observation_id, last_observed_at
             from links where workspace_id = $1 and id = $2`,
          [workspaceId, id],
        ),
      );
      return result.rows[0];
    }

    async function gateSources(): Promise<{ id: string; owner_principal_id: string }[]> {
      const result = await inTx((client) =>
        client.query<{ id: string; owner_principal_id: string }>(
          `select id, owner_principal_id from sources
            where workspace_id = $1 and kind = 'gatekeeper' and metadata ->> 'gatekeeperId' = $2`,
          [workspaceId, gatekeeperObjectId],
        ),
      );
      return result.rows;
    }

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
            'observed-facts-test-workspace',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      gatekeeperObjectId = await inTx(async (client) => {
        const gate = await graphStore.upsertObject(client, workspaceId, {
          objectType: 'Gatekeeper',
          identity: { gatekeeperId: randomUUID() },
          properties: { transportKind: 'http' },
        });
        return gate.id;
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    let firstFactId: string;
    let firstObservationId: string | null;
    let firstObservedAt: Date | null;

    it('first observation: one gatekeeper Source, one Observation on the Activity, Fact and Object carry it', async () => {
      const activityId = await newActivity();
      const written = await inTx((client) =>
        writeObservedFacts(
          client,
          workspaceId,
          gatekeeperObjectId,
          [{ objectType: 'KnowledgeBase', identity: { id: 'kb-1' }, properties: { name: 'one' } }],
          activityId,
        ),
      );
      expect(written).toHaveLength(1);
      const fact = written[0]?.fact;
      firstFactId = fact?.id ?? '';
      expect(fact?.epistemicStatus).toBe('observed');
      expect(fact?.observationId).not.toBeNull();
      expect(fact?.lastObservationId).toBe(fact?.observationId);
      firstObservationId = fact?.observationId ?? null;
      firstObservedAt = fact?.lastObservedAt ?? null;
      expect(firstObservedAt).not.toBeNull();
      expect(written[0]?.object.lastObservedAt).not.toBeNull();

      const sources = await gateSources();
      expect(sources).toHaveLength(1);
      const servicePrincipalId = await inTx((client) =>
        getOrCreateGatekeeperServicePrincipal(client, workspaceId),
      );
      expect(sources[0]?.owner_principal_id).toBe(servicePrincipalId);

      const observations = await inTx((client) =>
        client.query<{ source_id: string }>(
          'select source_id from observations where workspace_id = $1 and activity_id = $2',
          [workspaceId, activityId],
        ),
      );
      expect(observations.rows.map((row) => row.source_id)).toEqual([sources[0]?.id]);
    });

    it('the same gate again: same Source, Fact unchanged, last observation advanced', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const activityId = await newActivity();
      const written = await inTx((client) =>
        writeObservedFacts(
          client,
          workspaceId,
          gatekeeperObjectId,
          [{ objectType: 'KnowledgeBase', identity: { id: 'kb-1' }, properties: { name: 'one' } }],
          activityId,
        ),
      );
      expect(written[0]?.fact.id).toBe(firstFactId);
      expect(written[0]?.fact.unchanged).toBe(true);
      expect(await gateSources()).toHaveLength(1);

      const row = await linkRow(firstFactId);
      expect(row?.observation_id).toBe(firstObservationId);
      expect(row?.last_observation_id).not.toBe(firstObservationId);
      expect(row?.last_observed_at?.getTime()).toBeGreaterThan(firstObservedAt?.getTime() ?? 0);
    });

    it('a pre-S5.2 observed Fact (no Observation) is corroborated, not touched — and is what I-S5-2 counts', async () => {
      const baseline = await runInvariantChecks(pool);
      const baselineIS52 = baseline.find((result) => result.invariant === 'I-S5-2');
      expect(baselineIS52).toBeDefined();

      // The shape every gate Fact had before S5.2: asserted by the shared service principal on an
      // Activity with no Observation.
      const legacy = await inTx(async (client) => {
        const servicePrincipalId = await getOrCreateGatekeeperServicePrincipal(client, workspaceId);
        const target = await graphStore.upsertObject(client, workspaceId, {
          objectType: 'KnowledgeBase',
          identity: { id: 'kb-legacy' },
          properties: {},
        });
        const activity = await startActivity(client, workspaceId, {
          kind: 'gatekeeper_observe',
          principalId: ownerId,
        });
        return graphStore.assertFact(
          client,
          workspaceId,
          { id: servicePrincipalId, kind: 'service' },
          {
            linkType: 'observed',
            sourceObjectId: gatekeeperObjectId,
            targetObjectId: target.id,
            activityId: activity.id,
          },
        );
      });
      expect(legacy.epistemicStatus).toBe('observed');
      expect(legacy.observationId).toBeNull();

      const counted = await runInvariantChecks(pool);
      const is52 = counted.find((result) => result.invariant === 'I-S5-2');
      expect(is52?.violations).toBe((baselineIS52?.violations ?? 0) + 1);
      expect(is52?.sample.some((entry) => entry.includes(legacy.id))).toBe(true);
      expect(is52?.sample.some((entry) => entry.includes(firstFactId))).toBe(false);

      // The gate now observes the same target: a different origin (Source vs. principal) with
      // identical content is corroboration — the legacy row comes back unchanged and untouched.
      const activityId = await newActivity();
      const written = await inTx((client) =>
        writeObservedFacts(
          client,
          workspaceId,
          gatekeeperObjectId,
          [{ objectType: 'KnowledgeBase', identity: { id: 'kb-legacy' } }],
          activityId,
        ),
      );
      expect(written[0]?.fact.id).toBe(legacy.id);
      expect(written[0]?.fact.unchanged).toBe(true);
      const row = await linkRow(legacy.id);
      expect(row?.observation_id).toBeNull();
      expect(row?.last_observed_at).toBeNull();
    });
  },
);
