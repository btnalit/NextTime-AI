import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { generateEphemeralHandleKeyPair, issueHandle } from '../capability/index.js';
import { type LlmUsageRecord, LlmUsageValidationError, recordUsage } from './service.js';

/**
 * governance/llm-usage/service.test: DB-gated only (docs/development-tasks.md S1.7 "Kernel
 * llm-usage service tests DB-gated") — `recordUsage`'s idempotency key and RLS policy are real
 * Postgres behavior, not something a fake `PoolClient` can exercise meaningfully. Auto-skips
 * without `DATABASE_URL` (see vitest.config.ts / CI's `test` job, which runs against a real
 * `pgvector/pgvector:pg17` service container).
 *
 * Setup mirrors governance/capability/handles.test.ts's integration suite: an admin-inserted
 * workspace/principal/session, then a real `issueHandle` call (ephemeral keypair) to get a real
 * `capability_handles` row — `llm_usage.jti` foreign-keys into it, so a fabricated jti would fail
 * on the FK rather than exercising `recordUsage` itself.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)('recordUsage — integration (real Postgres)', () => {
  let pool: Pool;
  let workspaceId: string;
  let ownerId: string;
  let sessionId: string;

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

  async function adminInsertPrincipal(ws: string, displayName: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId: ws, principalId: id },
      async (client) => {
        await client.query(
          "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'member', $3)",
          [ws, id, displayName],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function insertSession(ws: string, principalId: string): Promise<string> {
    return withWorkspace(pool, { workspaceId: ws, principalId }, async (client) => {
      const id = randomUUID();
      await client.query(
        `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, $3, 'entry', $4, 'ready')`,
        [ws, id, principalId, principalId],
      );
      return id;
    });
  }

  async function issueTestHandle(ws: string, principalId: string, sid: string): Promise<string> {
    const { privateKey } = await generateEphemeralHandleKeyPair();
    return withWorkspace(pool, { workspaceId: ws, principalId }, async (client) => {
      const issued = await issueHandle(client, {
        sessionId: sid,
        scope: { capabilities: [], resources: {} },
        ttlSeconds: 3600,
        privateKey,
      });
      return issued.jti;
    });
  }

  function baseRecord(overrides: Partial<LlmUsageRecord> = {}): LlmUsageRecord {
    return {
      workspaceId,
      sessionId,
      jti: overrides.jti ?? randomUUID(),
      provider: 'example-provider',
      model: 'example-model',
      inputTokens: 100,
      outputTokens: 50,
      startedAt: new Date().toISOString(),
      status: 'completed',
      ...overrides,
    };
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);

    workspaceId = await adminInsertWorkspace('llm-usage-test-workspace');
    ownerId = await adminInsertPrincipal(workspaceId, 'owner');
    sessionId = await insertSession(workspaceId, ownerId);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('inserts a record and resolveTurnId default writes turn_id = null', async () => {
    const jti = await issueTestHandle(workspaceId, ownerId, sessionId);
    const record = baseRecord({ jti });

    const result = await withWorkspace(pool, { workspaceId, principalId: sessionId }, (client) =>
      recordUsage(client, [record]),
    );
    expect(result.inserted).toBe(1);

    const row = await withWorkspace(
      pool,
      { workspaceId, principalId: sessionId },
      async (client) => {
        const res = await client.query<{ turn_id: string | null; provider: string; model: string }>(
          'select turn_id, provider, model from llm_usage where workspace_id = $1 and jti = $2',
          [workspaceId, jti],
        );
        return res.rows[0];
      },
    );
    expect(row?.turn_id).toBeNull();
    expect(row?.provider).toBe('example-provider');
    expect(row?.model).toBe('example-model');
  });

  it('resolveTurnId, when provided, is used to fill turn_id', async () => {
    const jti = await issueTestHandle(workspaceId, ownerId, sessionId);
    const record = baseRecord({ jti });
    const fakeTurnId = randomUUID();

    await withWorkspace(pool, { workspaceId, principalId: sessionId }, (client) =>
      recordUsage(client, [record], { resolveTurnId: () => fakeTurnId }),
    );

    const row = await withWorkspace(
      pool,
      { workspaceId, principalId: sessionId },
      async (client) => {
        const res = await client.query<{ turn_id: string | null }>(
          'select turn_id from llm_usage where workspace_id = $1 and jti = $2',
          [workspaceId, jti],
        );
        return res.rows[0];
      },
    );
    expect(row?.turn_id).toBe(fakeTurnId);
  });

  it('is idempotent on (workspace_id, jti, started_at): replaying the same record inserts 0 rows the second time', async () => {
    const jti = await issueTestHandle(workspaceId, ownerId, sessionId);
    const record = baseRecord({ jti });

    const first = await withWorkspace(pool, { workspaceId, principalId: sessionId }, (client) =>
      recordUsage(client, [record]),
    );
    const second = await withWorkspace(pool, { workspaceId, principalId: sessionId }, (client) =>
      recordUsage(client, [record]),
    );

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);

    const count = await withWorkspace(
      pool,
      { workspaceId, principalId: sessionId },
      async (client) => {
        const res = await client.query<{ count: string }>(
          'select count(*)::text as count from llm_usage where workspace_id = $1 and jti = $2',
          [workspaceId, jti],
        );
        return Number(res.rows[0]?.count ?? 0);
      },
    );
    expect(count).toBe(1);
  });

  it('rejects a batch mixing more than one workspaceId', async () => {
    const jti = await issueTestHandle(workspaceId, ownerId, sessionId);
    const record = baseRecord({ jti });
    const otherWorkspaceRecord = { ...record, jti: randomUUID(), workspaceId: randomUUID() };

    await expect(
      withWorkspace(pool, { workspaceId, principalId: sessionId }, (client) =>
        recordUsage(client, [record, otherWorkspaceRecord]),
      ),
    ).rejects.toThrow(LlmUsageValidationError);
  });

  it('enqueues exactly one BudgetWarning on the batch that crosses 80% of the daily budget, not again below it', async () => {
    const freshWorkspaceId = await adminInsertWorkspace('llm-usage-budget-test-workspace');
    const freshOwnerId = await adminInsertPrincipal(freshWorkspaceId, 'owner');
    const freshSessionId = await insertSession(freshWorkspaceId, freshOwnerId);

    async function record(tokens: number) {
      const jti = await issueTestHandle(freshWorkspaceId, freshOwnerId, freshSessionId);
      return {
        workspaceId: freshWorkspaceId,
        sessionId: freshSessionId,
        jti,
        provider: 'example-provider',
        model: 'example-model',
        inputTokens: tokens,
        outputTokens: 0,
        startedAt: new Date().toISOString(),
        status: 'completed',
      } satisfies LlmUsageRecord;
    }

    // Budget 1000 tokens; 80% = 800. First batch (700) stays under; second batch (+200 = 900)
    // crosses; a third batch (+50 = 950, still >=80%) must not fire again.
    const below = await record(700);
    const crossing = await record(200);
    const stillAbove = await record(50);

    const r1 = await withWorkspace(
      pool,
      { workspaceId: freshWorkspaceId, principalId: freshSessionId },
      (client) => recordUsage(client, [below], { dailyTokenBudgetTokens: 1000 }),
    );
    expect(r1.budgetWarning).toBeUndefined();

    const r2 = await withWorkspace(
      pool,
      { workspaceId: freshWorkspaceId, principalId: freshSessionId },
      (client) => recordUsage(client, [crossing], { dailyTokenBudgetTokens: 1000 }),
    );
    expect(r2.budgetWarning?.percent).toBeCloseTo(90, 5);

    const r3 = await withWorkspace(
      pool,
      { workspaceId: freshWorkspaceId, principalId: freshSessionId },
      (client) => recordUsage(client, [stillAbove], { dailyTokenBudgetTokens: 1000 }),
    );
    expect(r3.budgetWarning).toBeUndefined();

    const outboxCount = await withWorkspace(
      pool,
      { workspaceId: freshWorkspaceId, principalId: freshSessionId },
      async (client) => {
        const res = await client.query<{ count: string }>(
          "select count(*)::text as count from outbox where workspace_id = $1 and event_type = 'BudgetWarning'",
          [freshWorkspaceId],
        );
        return Number(res.rows[0]?.count ?? 0);
      },
    );
    expect(outboxCount).toBe(1);
  });
});
