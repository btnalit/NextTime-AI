import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../../adapters/db/pool.js';
import {
  HANDLE_SIGNING_ALG,
  issueHandle,
  revokeSession,
} from '../../../governance/capability/index.js';
import { registerHandleRevocationRoutes } from './handle-revocations.js';

/**
 * interfaces/http/internal/handle-revocations.integration.test: review 2026-10-02 R-14 against
 * real Postgres (auto-skipped without DATABASE_URL). One `revokeSession` gives every Handle it
 * touches the same `revoked_at`, which is exactly the case a millisecond (or `revoked_at`-only)
 * cursor gets wrong; the route runs with a page size of 3 so seven such Handles span three pages.
 * The database is shared with other suites, so assertions look only at this file's own `jti`s.
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

interface Page {
  readonly revoked: readonly { readonly jti: string; readonly revokedAt: string }[];
  readonly now: string;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

describe.runIf(DATABASE_URL !== undefined)(
  'GET /internal/handle-revocations paging (R-14, real Postgres)',
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    const workspaceId = randomUUID();
    const principalId = randomUUID();
    const issuedJtis: string[] = [];
    let before: Date;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const { privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      await withWorkspace(
        pool,
        { workspaceId, principalId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            `handle-revocations-paging-${workspaceId.slice(0, 8)}`,
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'service', 'member', 'paging fixture')`,
            [workspaceId, principalId],
          );
          const session = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'service', $2, 'active') returning id`,
            [workspaceId, principalId],
          );
          const sessionId = session.rows[0]?.id;
          if (!sessionId) throw new Error('no session row');
          for (let i = 0; i < 7; i++) {
            const issued = await issueHandle(client, {
              sessionId,
              scope: { capabilities: ['search'], resources: {} },
              ttlSeconds: 3600,
              privateKey,
            });
            issuedJtis.push(issued.jti);
          }
          const clock = await client.query<{ now: Date }>('select now() as now');
          before = new Date((clock.rows[0]?.now ?? new Date()).getTime() - 1000);
          // One statement, one `revoked_at` for all seven.
          await revokeSession(client, sessionId);
        },
        { skipRoleSwitch: true },
      );
      app = Fastify();
      await registerHandleRevocationRoutes(app, { pool, revocationPageSize: 3 });
    }, 60_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
    });

    it('pages through Handles revoked in the same instant: each exactly once, then hasMore false', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        pages += 1;
        if (pages > 50) throw new Error('paging did not terminate');
        const query = new URLSearchParams({ since: before.toISOString() });
        if (cursor !== undefined) query.set('cursor', cursor);
        const res = await app.inject({
          method: 'GET',
          url: `/internal/handle-revocations?${query.toString()}`,
        });
        expect(res.statusCode).toBe(200);
        const page = res.json() as Page;
        expect(page.revoked.length).toBeLessThanOrEqual(3);
        seen.push(...page.revoked.map((row) => row.jti));
        if (!page.hasMore) {
          expect(page.nextCursor).toBeUndefined();
          break;
        }
        expect(page.nextCursor).toBeDefined();
        cursor = page.nextCursor;
      }

      const mine = seen.filter((jti) => issuedJtis.includes(jti));
      expect(new Set(mine)).toEqual(new Set(issuedJtis));
      expect(mine).toHaveLength(issuedJtis.length);
      expect(new Set(seen).size).toBe(seen.length);
      expect(pages).toBeGreaterThanOrEqual(3);
    });
  },
);
