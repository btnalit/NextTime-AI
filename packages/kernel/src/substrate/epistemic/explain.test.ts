import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { SqlGraphStore } from '../graph/index.js';
import { startActivity } from './activities.js';
import { ExplainNodeNotFoundError, explain, explainByNodeId } from './explain.js';

/**
 * substrate/epistemic/explain.test: integration tests (real Postgres; auto-skip without
 * DATABASE_URL) covering docs/development-tasks.md S1.3's acceptance criterion "任一 Fact / Turn
 * 的 explain 到 Source 与 Principal" — a Fact's chain reaches a Source and a Principal, and an
 * Activity (standing in for a Turn, `kind='agent_turn'`, before S1.4 exists to create real ones)
 * does too.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)('explain (integration, real Postgres)', () => {
  let pool: Pool;
  const store = new SqlGraphStore();
  let workspaceId: string;
  let ownerId: string;

  async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
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
          'explain-test-workspace',
        ]);
        await client.query(
          'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
          [workspaceId, ownerId, 'human', 'owner', 'owner'],
        );
      },
      { skipRoleSwitch: true },
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('explain(factId) reaches an Activity, its Observation/Source, and the asserting Principal', async () => {
    const { factId, sourceId, activityId } = await inTx(async (client) => {
      const sourceResult = await client.query<{ id: string }>(
        `insert into sources (workspace_id, kind, owner_principal_id, visibility, uri)
         values ($1, 'document', $2, 'workspace', 'https://example.test/doc')
         returning id`,
        [workspaceId, ownerId],
      );
      const sourceRow = sourceResult.rows[0];
      if (!sourceRow) throw new Error('fixture: source insert produced no row');
      const sourceId = sourceRow.id;

      const activity = await startActivity(client, workspaceId, {
        kind: 'test.ingest',
        principalId: ownerId,
      });

      await client.query(
        `insert into observations (workspace_id, source_id, activity_id, content)
         values ($1, $2, $3, $4::jsonb)`,
        [workspaceId, sourceId, activity.id, JSON.stringify({ note: 'observed something' })],
      );

      const a = await store.upsertObject(client, workspaceId, { objectType: 'test.thing' });
      const b = await store.upsertObject(client, workspaceId, { objectType: 'test.thing' });
      const fact = await store.assertFact(
        client,
        workspaceId,
        { id: ownerId, kind: 'human' },
        {
          linkType: 'test.rel',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        },
      );

      return { factId: fact.id, sourceId, activityId: activity.id };
    });

    const result = await inTx((client) => explain(client, workspaceId, { factId }));

    expect(result.nodeType).toBe('fact');
    expect(result.fact?.id).toBe(factId);
    // human-asserted Fact → epistemic_status 'asserted' (S1.2 deriveEpistemicStatus).
    expect(result.fact?.epistemicStatus).toBe('asserted');
    expect(result.fact?.assertedByPrincipal?.id).toBe(ownerId);
    expect(result.activity?.id).toBe(activityId);
    expect(result.activity?.startedByPrincipal?.id).toBe(ownerId);
    expect(result.activity?.observations).toHaveLength(1);
    expect(result.activity?.observations[0]?.source?.id).toBe(sourceId);
    expect(result.activity?.observations[0]?.source?.ownerPrincipal?.id).toBe(ownerId);
  });

  it('explain(activityId) reaches Source and Principal for a Turn-shaped Activity (kind=agent_turn)', async () => {
    const { activityId, sourceId } = await inTx(async (client) => {
      const sourceResult = await client.query<{ id: string }>(
        `insert into sources (workspace_id, kind, owner_principal_id, visibility, uri)
         values ($1, 'agent_session', $2, 'private', null)
         returning id`,
        [workspaceId, ownerId],
      );
      const sourceRow = sourceResult.rows[0];
      if (!sourceRow) throw new Error('fixture: source insert produced no row');
      const sourceId = sourceRow.id;

      // kind='agent_turn' — design doc §5.1.3 "Turn = kind=agent_turn Activity" (S1.4 creates
      // these for real; explain must already work generically for any Activity id).
      const activity = await startActivity(client, workspaceId, {
        kind: 'agent_turn',
        principalId: ownerId,
      });
      await client.query(
        `insert into observations (workspace_id, source_id, activity_id, content) values ($1, $2, $3, '{}'::jsonb)`,
        [workspaceId, sourceId, activity.id],
      );

      return { activityId: activity.id, sourceId };
    });

    const result = await inTx((client) => explain(client, workspaceId, { activityId }));

    expect(result.nodeType).toBe('activity');
    expect(result.activity?.kind).toBe('agent_turn');
    expect(result.activity?.startedByPrincipal?.id).toBe(ownerId);
    expect(result.activity?.observations[0]?.source?.id).toBe(sourceId);
  });

  it('explain(decisionId) reaches its Source and the deciding Principal', async () => {
    const { decisionId, sourceId } = await inTx(async (client) => {
      const activity = await startActivity(client, workspaceId, {
        kind: 'test.decide',
        principalId: ownerId,
      });
      const sourceResult = await client.query<{ id: string }>(
        `insert into sources (workspace_id, kind, owner_principal_id, visibility)
         values ($1, 'document', $2, 'workspace') returning id`,
        [workspaceId, ownerId],
      );
      const sourceRow = sourceResult.rows[0];
      if (!sourceRow) throw new Error('fixture: source insert produced no row');
      const sourceId = sourceRow.id;

      const decisionResult = await client.query<{ id: string }>(
        `insert into decisions (workspace_id, activity_id, source_id, summary, decided_by)
         values ($1, $2, $3, 'a test decision', $4) returning id`,
        [workspaceId, activity.id, sourceId, ownerId],
      );
      const decisionRow = decisionResult.rows[0];
      if (!decisionRow) throw new Error('fixture: decision insert produced no row');

      return { decisionId: decisionRow.id, sourceId };
    });

    const result = await inTx((client) => explain(client, workspaceId, { decisionId }));

    expect(result.nodeType).toBe('decision');
    expect(result.decision?.id).toBe(decisionId);
    expect(result.decision?.decidedByPrincipal?.id).toBe(ownerId);
    expect(result.decision?.source?.id).toBe(sourceId);
  });

  it('explain throws ExplainNodeNotFoundError for an id that names nothing', async () => {
    await expect(
      inTx((client) => explain(client, workspaceId, { factId: randomUUID() })),
    ).rejects.toThrow(ExplainNodeNotFoundError);
  });

  it("explainByNodeId resolves a bare nodeId (the explain capability's wire param) to the right kind", async () => {
    const { factId } = await inTx(async (client) => {
      const activity = await startActivity(client, workspaceId, {
        kind: 'test.ingest',
        principalId: ownerId,
      });
      const a = await store.upsertObject(client, workspaceId, { objectType: 'test.thing' });
      const b = await store.upsertObject(client, workspaceId, { objectType: 'test.thing' });
      const fact = await store.assertFact(
        client,
        workspaceId,
        { id: ownerId, kind: 'human' },
        {
          linkType: 'test.rel2',
          sourceObjectId: a.id,
          targetObjectId: b.id,
          activityId: activity.id,
        },
      );
      return { factId: fact.id };
    });

    const result = await inTx((client) => explainByNodeId(client, workspaceId, factId));
    expect(result.nodeType).toBe('fact');
    expect(result.fact?.id).toBe(factId);
  });

  it('explainByNodeId throws ExplainNodeNotFoundError when nodeId names no Fact/Activity/Decision', async () => {
    await expect(
      inTx((client) => explainByNodeId(client, workspaceId, randomUUID())),
    ).rejects.toThrow(ExplainNodeNotFoundError);
  });
});
