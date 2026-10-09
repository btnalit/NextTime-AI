import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type HandleBinding,
  type HandleBindingSource,
  createHandleBindingReader,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, splitSqlStatements } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { hashApiKey } from '../../application/gateway/index.js';
import {
  HANDLE_SIGNING_ALG,
  issueHandle,
  revokeHandle,
} from '../../governance/capability/index.js';
import { createServer } from '../../index.js';
import { createSourceBinding } from './source-binding.js';

/**
 * The source binding end to end (interfaces/source-binding, @nexttime/shared handle-binding.ts):
 * a real kernel server, real Postgres, real signed Handles — all minted here for a throwaway
 * workspace, so nothing in these tests is a deployment's Handle. The bindings file is an in-memory
 * `HandleBindingSource`; the TCP peer is Fastify's `inject({ remoteAddress })`.
 *
 * What it pins down:
 *   - an entry / worker_run Handle is accepted only from the address it is bound to, and refused
 *     whenever a request carries it itself (a copy is inert);
 *   - a `workers`-network peer acts with its binding and nothing else: no header, no fallback,
 *     only the agent-container routes;
 *   - expiry, revocation and scope still apply to a bound Handle.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const WORKERS_SUBNET = '203.0.113.0/24';
const CONTAINER_ADDRESS = '203.0.113.7';
const OTHER_CONTAINER_ADDRESS = '203.0.113.8';
const CONTROL_ADDRESS = '198.51.100.20';

describe.runIf(DATABASE_URL !== undefined)(
  'source binding — agent containers authenticate by address only (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let memberId: string;
    let memberApiKey: string;
    let objectId: string;
    let publicKey: CryptoKey;
    let privateKey: CryptoKey;

    /** The bindings file, in memory. */
    let bindings: Record<string, HandleBinding> = {};
    let bindingsVersion = 0;
    const source: HandleBindingSource = {
      version: () => String(bindingsVersion),
      read: () => JSON.stringify(bindings),
    };
    function bind(address: string, handle: string): void {
      bindings = {
        ...bindings,
        [address]: { handle, sourceId: `entry:${workspaceId}:${memberId}`, boundAt: 'now' },
      };
      bindingsVersion += 1;
    }

    function server() {
      return createServer(
        { pool, loadHandlePublicKey: async () => publicKey },
        {
          sourceBinding: createSourceBinding({
            workersSubnet: WORKERS_SUBNET,
            reader: createHandleBindingReader({ source, registrationWaitMs: 50, pollMs: 10 }),
          }),
        },
      );
    }

    async function mintHandle(
      kind: 'entry' | 'worker_run' | 'mcp_session',
      capabilities: readonly string[] = ['get_object'],
    ): Promise<{ token: string; jti: string }> {
      return withWorkspace(pool, { workspaceId, principalId: memberId }, async (client) => {
        const session = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, $2, 'active') returning id`,
          [workspaceId, memberId, kind],
        );
        const sessionId = session.rows[0]?.id;
        if (!sessionId) throw new Error('fixture: no session row');
        const issued = await issueHandle(client, {
          sessionId,
          scope: { capabilities: [...capabilities], resources: {} },
          ttlSeconds: 600,
          privateKey,
        });
        return { token: issued.token, jti: issued.jti };
      });
    }

    function getObject(
      app: ReturnType<typeof server>,
      remoteAddress: string,
      headers: Record<string, string> = {},
    ) {
      return app.inject({
        method: 'POST',
        url: '/api/cap/get_object',
        remoteAddress,
        headers,
        payload: { objectId },
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      ({ publicKey, privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      }));
      workspaceId = randomUUID();
      memberId = randomUUID();
      memberApiKey = `member-key-${randomUUID()}`;
      await withWorkspace(
        pool,
        { workspaceId, principalId: memberId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'source-binding-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
             values ($1, $2, 'human', 'member', 'member', $3)`,
            [workspaceId, memberId, hashApiKey(memberApiKey)],
          );
          const object = await client.query<{ id: string }>(
            `insert into objects (workspace_id, object_type, properties)
             values ($1, 'test.source-binding-thing', '{}'::jsonb) returning id`,
            [workspaceId],
          );
          objectId = object.rows[0]?.id ?? '';
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('an entry and a worker_run Handle work from the address they are bound to, with no header', async () => {
      const app = server();
      for (const kind of ['entry', 'worker_run'] as const) {
        const { token } = await mintHandle(kind);
        bind(CONTAINER_ADDRESS, token);
        const response = await getObject(app, CONTAINER_ADDRESS);
        expect(response.statusCode, kind).toBe(200);
        expect(response.json().result.id).toBe(objectId);
        // Node reports an IPv4 peer on a dual-stack listener as IPv4-mapped IPv6.
        expect((await getObject(app, `::ffff:${CONTAINER_ADDRESS}`)).statusCode, kind).toBe(200);
      }
    });

    it('a copy of a container-held Handle authorizes nothing: refused in a header from anywhere', async () => {
      const app = server();
      for (const kind of ['entry', 'worker_run'] as const) {
        const { token } = await mintHandle(kind);
        bind(CONTAINER_ADDRESS, token);
        const fromControl = await getObject(app, CONTROL_ADDRESS, {
          authorization: `Bearer ${token}`,
        });
        expect(fromControl.statusCode, kind).toBe(401);
        // From another, unbound container: no fallback to the header either.
        const fromOtherContainer = await getObject(app, OTHER_CONTAINER_ADDRESS, {
          authorization: `Bearer ${token}`,
        });
        expect(fromOtherContainer.statusCode, kind).toBe(401);
      }
    });

    it('a bearer Handle (issue_handle) keeps working in a header, and is refused as a binding', async () => {
      const app = server();
      const { token } = await mintHandle('mcp_session');
      const viaHeader = await getObject(app, CONTROL_ADDRESS, { authorization: `Bearer ${token}` });
      expect(viaHeader.statusCode).toBe(200);

      bind(CONTAINER_ADDRESS, token);
      expect((await getObject(app, CONTAINER_ADDRESS)).statusCode).toBe(401);
    });

    it('a bound container cannot add a credential of its own — its binding is the only identity it has', async () => {
      const app = server();
      const { token: entry } = await mintHandle('entry');
      const { token: bearer } = await mintHandle('mcp_session');
      bind(CONTAINER_ADDRESS, entry);
      for (const headers of [
        { authorization: `Bearer ${bearer}` } as Record<string, string>,
        { authorization: `Bearer ${memberApiKey}` },
        { cookie: 'nexttime_console_session=anything' },
      ]) {
        const response = await getObject(app, CONTAINER_ADDRESS, headers);
        expect(response.statusCode, Object.keys(headers)[0]).toBe(401);
      }
    });

    it('an unbound address on the workers network is refused, and a forwarded-for header changes nothing', async () => {
      const app = server();
      const { token } = await mintHandle('entry');
      bind(CONTAINER_ADDRESS, token);
      expect((await getObject(app, OTHER_CONTAINER_ADDRESS)).statusCode).toBe(401);
      expect(
        (await getObject(app, CONTROL_ADDRESS, { 'x-forwarded-for': CONTAINER_ADDRESS }))
          .statusCode,
      ).toBe(401);
    });

    it('revocation and scope still apply to a bound Handle', async () => {
      const app = server();
      const { token, jti } = await mintHandle('entry');
      bind(CONTAINER_ADDRESS, token);
      expect((await getObject(app, CONTAINER_ADDRESS)).statusCode).toBe(200);

      // Out of scope: the Handle lists only get_object.
      const outOfScope = await app.inject({
        method: 'POST',
        url: '/api/cap/traverse',
        remoteAddress: CONTAINER_ADDRESS,
        payload: { objectId },
      });
      expect(outOfScope.statusCode).toBe(403);

      await withWorkspace(pool, { workspaceId, principalId: memberId }, (client) =>
        revokeHandle(client, jti),
      );
      expect((await getObject(app, CONTAINER_ADDRESS)).statusCode).toBe(401);
    });

    it('migration 0018 revokes every unexpired entry / worker_run Handle (audited) and leaves bearer Handles alone', async () => {
      const sql = await readFile(
        path.join(MIGRATIONS_DIR, 'governance', '0018_container_held_handles_revoked.sql'),
        'utf8',
      );
      const entry = await mintHandle('entry');
      const workerRun = await mintHandle('worker_run');
      const bearer = await mintHandle('mcp_session');

      const run = () =>
        withWorkspace(pool, { workspaceId, principalId: memberId }, async (client) => {
          for (const statement of splitSqlStatements(sql)) await client.query(statement);
        });
      const state = () =>
        withWorkspace(pool, { workspaceId, principalId: memberId }, async (client) => {
          const handles = await client.query<{ jti: string; revoked_at: Date | null }>(
            'select jti, revoked_at from capability_handles where jti = any($1::uuid[])',
            [[entry.jti, workerRun.jti, bearer.jti]],
          );
          const audits = await client.query<{ payload: { revokedHandleCount: number } }>(
            `select payload from audit_records
              where workspace_id = $1 and action = 'principal.container_handles_revoked'`,
            [workspaceId],
          );
          return {
            revoked: Object.fromEntries(handles.rows.map((r) => [r.jti, r.revoked_at !== null])),
            audits: audits.rows.length,
          };
        });

      await run();
      const after = await state();
      expect(after.revoked).toEqual({
        [entry.jti]: true,
        [workerRun.jti]: true,
        [bearer.jti]: false,
      });
      expect(after.audits).toBe(1);

      // Idempotent: nothing left to revoke, no second audit record.
      await run();
      expect((await state()).audits).toBe(1);
    });

    it('the workers network reaches only the agent-container routes', async () => {
      const app = server();
      const { token } = await mintHandle('entry');
      bind(CONTAINER_ADDRESS, token);

      const health = await app.inject({
        method: 'GET',
        url: '/api/health',
        remoteAddress: CONTAINER_ADDRESS,
      });
      expect(health.statusCode).toBe(200);

      for (const request of [
        { method: 'POST' as const, url: '/mcp' },
        { method: 'GET' as const, url: '/api/auth/me' },
        { method: 'GET' as const, url: '/internal/handle-revocations' },
        { method: 'GET' as const, url: '/api/explorer/objects' },
        { method: 'GET' as const, url: '/no-such-route' },
      ]) {
        const response = await app.inject({
          ...request,
          remoteAddress: CONTAINER_ADDRESS,
          headers: { authorization: `Bearer ${memberApiKey}` },
        });
        expect(response.statusCode, request.url).toBe(403);
      }

      // The same API key from the control network is unaffected by the guard.
      const fromControl = await app.inject({
        method: 'POST',
        url: '/api/cap/get_object',
        remoteAddress: CONTROL_ADDRESS,
        headers: { authorization: `Bearer ${memberApiKey}` },
        payload: { objectId },
      });
      expect(fromControl.statusCode).toBe(200);
    });
  },
);
