import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExportProvResult, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { createServer } from '../../index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { hashApiKey } from './auth.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/export-prov-handler.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) proof that `export_prov` (docs/development-tasks.md §S3.5) is wired
 * end-to-end through `dispatchCapability` — same convention `epistemic-handlers.integration.
 * test.ts` already established for its own seven capabilities.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role = 'auditor',
): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
    session: {
      workspaceId,
      id: randomUUID(),
      principalId,
      kind: 'web',
      onBehalfOf: principalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'export_prov (integration, real Postgres, dispatchCapability + HTTP)',
  () => {
    let pool: Pool;
    const store = new SqlGraphStore();
    let workspaceId: string;
    let ownerId: string;
    let factId: string;
    let decisionId: string;
    let activityId: string;

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

    async function adminInsertPrincipal(displayName: string, role: Role): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, id, 'human', role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('export-prov-test-workspace');
      ownerId = await adminInsertPrincipal('owner', 'owner');

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const host = await store.upsertObject(client, workspaceId, {
          objectType: 'ops.host',
          identity: { hostname: `export-prov-host-${randomUUID()}` },
        });
        const service = await store.upsertObject(client, workspaceId, {
          objectType: 'ops.service',
          identity: { name: `export-prov-svc-${randomUUID()}` },
        });
        const activity = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        activityId = activity.id;
        const fact = await store.assertFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: service.id,
            targetObjectId: host.id,
            activityId: activity.id,
          },
        );
        factId = fact.id;

        const decisionResult = await client.query<{ id: string }>(
          `insert into decisions (workspace_id, status, activity_id, summary, decided_by, decided_at)
           values ($1, 'approved', $2, $3, $4, now())
           returning id`,
          [workspaceId, activity.id, 'export_prov test decision', ownerId],
        );
        decisionId = decisionResult.rows[0]?.id ?? '';
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('export_prov({factId}) returns a prov-json document rooted at that Fact', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const result = (await dispatchCapability({ pool }, caller, 'export_prov', {
        factId,
      })) as ExportProvResult;
      expect(result.format).toBe('prov-json');
      expect(Object.keys(result.document.entity)).toContain(factId);
      expect(Object.keys(result.document.activity)).toContain(activityId);
      expect(Object.keys(result.document.wasGeneratedBy).length).toBeGreaterThan(0);
    });

    it('export_prov({decisionId}) returns a prov-json document rooted at that Decision', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const result = (await dispatchCapability({ pool }, caller, 'export_prov', {
        decisionId,
      })) as ExportProvResult;
      expect(result.format).toBe('prov-json');
      expect(Object.keys(result.document.entity)).toContain(decisionId);
    });

    it('export_prov({activityId}) returns a prov-json document with no wasGeneratedBy relations', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const result = (await dispatchCapability({ pool }, caller, 'export_prov', {
        activityId,
      })) as ExportProvResult;
      expect(result.format).toBe('prov-json');
      expect(Object.keys(result.document.activity)).toContain(activityId);
      expect(Object.keys(result.document.wasGeneratedBy)).toHaveLength(0);
    });

    it('export_prov({}) — none of factId/decisionId/activityId — rejects', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      await expect(dispatchCapability({ pool }, caller, 'export_prov', {})).rejects.toThrow(
        /exactly one of/,
      );
    });

    it('export_prov({factId, decisionId}) — more than one — rejects', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      await expect(
        dispatchCapability({ pool }, caller, 'export_prov', { factId, decisionId }),
      ).rejects.toThrow(/exactly one of/);
    });

    it('POST /api/cap/export_prov with an unknown factId → 404 (ExplainNodeNotFoundError)', async () => {
      const apiKey = `export-prov-key-${randomUUID()}`;
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query(
            'update principals set api_key_hash = $1 where workspace_id = $2 and id = $3',
            [hashApiKey(apiKey), workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );

      const app = createServer({ pool });
      const response = await app.inject({
        method: 'POST',
        url: '/api/cap/export_prov',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { factId: randomUUID() },
      });
      expect(response.statusCode).toBe(404);
    });

    it('POST /api/cap/export_prov with zero of factId/decisionId/activityId → 400', async () => {
      const apiKey = `export-prov-key-2-${randomUUID()}`;
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query(
            'update principals set api_key_hash = $1 where workspace_id = $2 and id = $3',
            [hashApiKey(apiKey), workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );

      const app = createServer({ pool });
      const response = await app.inject({
        method: 'POST',
        url: '/api/cap/export_prov',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_params');
    });
  },
);
