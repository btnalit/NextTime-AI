import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../../adapters/db/pool.js';
import { newChat } from '../../../application/chat/index.js';
import {
  generateEphemeralHandleKeyPair,
  issueHandle,
} from '../../../governance/capability/index.js';
import type { LlmUsageRecord } from '../../../governance/llm-usage/index.js';
import { startActivity } from '../../../substrate/epistemic/index.js';
import { registerLlmUsageRoutes } from './llm-usage.js';

/**
 * Integration test (real Postgres; auto-skip without DATABASE_URL) for the actual fix in this
 * task (docs/development-tasks.md S1.7 补注, 2026-09 — `llm_usage.turn_id` was always NULL):
 * drives `POST /internal/llm-usage` through the real route with a real `recordUsage` (no
 * `deps.recordUsage` override, unlike `llm-usage.test.ts`'s route-shape-only tests), for a session
 * whose principal has a currently `running` `agent_turn` Activity, and asserts the inserted
 * `llm_usage` row's `turn_id` equals that Turn's id — the S1.7 acceptance line this task closes
 * ("`llm_usage` 记 provider / model / tokens / turn_id").
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'POST /internal/llm-usage (integration, real Postgres) — turn_id attribution',
  () => {
    let pool: Pool;
    let app: FastifyInstance | undefined;

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

    async function adminInsertPrincipal(workspaceId: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'member', 'p')",
            [workspaceId, id],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function insertSession(workspaceId: string, principalId: string): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, 'entry', $4, 'ready')`,
          [workspaceId, id, principalId, principalId],
        );
        return id;
      });
    }

    async function issueTestHandle(
      workspaceId: string,
      principalId: string,
      sessionId: string,
    ): Promise<string> {
      const { privateKey } = await generateEphemeralHandleKeyPair();
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const issued = await issueHandle(client, {
          sessionId,
          scope: { capabilities: [], resources: {} },
          ttlSeconds: 3600,
          privateKey,
        });
        return issued.jti;
      });
    }

    async function startRunningTurn(workspaceId: string, principalId: string): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const chat = await newChat(client, workspaceId, principalId, {});
        const turn = await startActivity(client, workspaceId, {
          kind: 'agent_turn',
          chatId: chat.id,
          principalId,
        });
        return turn.id;
      });
    }

    async function readTurnId(
      workspaceId: string,
      principalId: string,
      jti: string,
    ): Promise<string | null | undefined> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const res = await client.query<{ turn_id: string | null }>(
          'select turn_id from llm_usage where workspace_id = $1 and jti = $2',
          [workspaceId, jti],
        );
        return res.rows[0]?.turn_id;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool.end();
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it('attributes a usage report to its session principal running Turn', async () => {
      const workspaceId = await adminInsertWorkspace('llm-usage-route-turn-attribution-test');
      const principalId = await adminInsertPrincipal(workspaceId);
      const sessionId = await insertSession(workspaceId, principalId);
      const jti = await issueTestHandle(workspaceId, principalId, sessionId);
      const turnId = await startRunningTurn(workspaceId, principalId);

      app = Fastify();
      await registerLlmUsageRoutes(app, { pool });

      const record: LlmUsageRecord = {
        workspaceId,
        sessionId,
        jti,
        provider: 'example-provider',
        model: 'example-model',
        inputTokens: 100,
        outputTokens: 50,
        startedAt: new Date().toISOString(),
        status: 'completed',
      };

      const res = await app.inject({
        method: 'POST',
        url: '/internal/llm-usage',
        payload: [record],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, result: { inserted: 1 } });

      const turnIdColumn = await readTurnId(workspaceId, principalId, jti);
      expect(turnIdColumn).toBe(turnId);
    });

    it('records turn_id = null (never rejects) when the session has no running or recent Turn', async () => {
      const workspaceId = await adminInsertWorkspace('llm-usage-route-no-turn-test');
      const principalId = await adminInsertPrincipal(workspaceId);
      const sessionId = await insertSession(workspaceId, principalId);
      const jti = await issueTestHandle(workspaceId, principalId, sessionId);

      app = Fastify();
      await registerLlmUsageRoutes(app, { pool });

      const record: LlmUsageRecord = {
        workspaceId,
        sessionId,
        jti,
        provider: 'example-provider',
        model: 'example-model',
        inputTokens: 10,
        outputTokens: 5,
        startedAt: new Date().toISOString(),
        status: 'completed',
      };

      const res = await app.inject({
        method: 'POST',
        url: '/internal/llm-usage',
        payload: [record],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, result: { inserted: 1 } });

      const turnIdColumn = await readTurnId(workspaceId, principalId, jti);
      expect(turnIdColumn).toBeNull();
    });
  },
);
