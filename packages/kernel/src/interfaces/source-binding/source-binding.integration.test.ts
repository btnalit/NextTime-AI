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
    function bind(address: string, handle: string, containerId?: string): void {
      bindings = {
        ...bindings,
        [address]: {
          handle,
          sourceId: `entry:${workspaceId}:${memberId}`,
          boundAt: 'now',
          ...(containerId !== undefined ? { containerId } : {}),
        },
      };
      bindingsVersion += 1;
    }
    function unbind(address: string): void {
      const { [address]: _dropped, ...rest } = bindings;
      bindings = rest;
      bindingsVersion += 1;
    }

    function server(bindingSource: HandleBindingSource = source) {
      return createServer(
        { pool, loadHandlePublicKey: async () => publicKey },
        {
          sourceBinding: createSourceBinding({
            workersSubnet: WORKERS_SUBNET,
            reader: createHandleBindingReader({
              source: bindingSource,
              registrationWaitMs: 50,
              pollMs: 10,
            }),
          }),
        },
      );
    }

    function selfCheck(app: ReturnType<typeof server>, remoteAddress: string) {
      return app.inject({ method: 'GET', url: '/api/source-binding', remoteAddress });
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
      // The marker an older runtime image's extension forwards is not a credential.
      const marker = await getObject(app, CONTAINER_ADDRESS, {
        authorization: 'Bearer source-bound',
      });
      expect(marker.statusCode).toBe(200);
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

    it('address reuse: an address authenticates as whichever container is bound there now, and as nothing once unbound', async () => {
      const app = server();
      const dead = await mintHandle('entry');
      const next = await mintHandle('entry');

      // The first container at this address; its Handle is the one used (revoking it refuses).
      bind(CONTAINER_ADDRESS, dead.token, 'container-a');
      expect((await selfCheck(app, CONTAINER_ADDRESS)).json()).toEqual({
        ok: true,
        containerId: 'container-a',
      });
      await withWorkspace(pool, { workspaceId, principalId: memberId }, (client) =>
        revokeHandle(client, dead.jti),
      );
      expect((await getObject(app, CONTAINER_ADDRESS)).statusCode).toBe(401);

      // Docker hands the address to a new container and worker-supervisor binds it: the dead
      // container's Handle is gone from it, the new one is what authenticates.
      bind(CONTAINER_ADDRESS, next.token, 'container-b');
      expect((await selfCheck(app, CONTAINER_ADDRESS)).json()).toEqual({
        ok: true,
        containerId: 'container-b',
      });
      expect((await getObject(app, CONTAINER_ADDRESS)).statusCode).toBe(200);

      // Unbound (the container stopped): refused, and the self-check says so.
      unbind(CONTAINER_ADDRESS);
      expect((await getObject(app, CONTAINER_ADDRESS)).statusCode).toBe(401);
      const unbound = await selfCheck(app, CONTAINER_ADDRESS);
      expect(unbound.statusCode).toBe(401);
      expect(unbound.json().error.code).toBe('unbound_source');
    });

    it('the self-check names the bound container only, and only to the workers network', async () => {
      const app = server();
      const { token } = await mintHandle('entry');
      bind(CONTAINER_ADDRESS, token, 'container-a');
      const own = await selfCheck(app, CONTAINER_ADDRESS);
      expect(own.statusCode).toBe(200);
      expect(own.body).not.toContain(token);
      expect((await selfCheck(app, OTHER_CONTAINER_ADDRESS)).statusCode).toBe(401);
      expect((await selfCheck(app, CONTROL_ADDRESS)).statusCode).toBe(403);
      // A binding written without a container id never matches any container.
      bind(OTHER_CONTAINER_ADDRESS, token);
      expect((await selfCheck(app, OTHER_CONTAINER_ADDRESS)).json()).toEqual({
        ok: true,
        containerId: null,
      });
    });

    it('a missing or unreadable bindings file refuses every agent container (fail closed)', async () => {
      const { token: entry } = await mintHandle('entry');
      const { token: bearer } = await mintHandle('mcp_session');
      const missing = server({ version: () => undefined, read: () => '{}' });
      const unreadable = server({
        version: () => 'v1',
        read: () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      });
      for (const [name, app] of [
        ['missing', missing],
        ['unreadable', unreadable],
      ] as const) {
        expect((await getObject(app, CONTAINER_ADDRESS)).statusCode, name).toBe(401);
        expect(
          (await getObject(app, CONTAINER_ADDRESS, { authorization: 'Bearer source-bound' }))
            .statusCode,
          name,
        ).toBe(401);
        // No fallback to a credential the container presents.
        expect(
          (await getObject(app, CONTAINER_ADDRESS, { authorization: `Bearer ${bearer}` }))
            .statusCode,
          name,
        ).toBe(401);
        expect(
          (await getObject(app, CONTAINER_ADDRESS, { authorization: `Bearer ${entry}` }))
            .statusCode,
          name,
        ).toBe(401);
        expect((await selfCheck(app, CONTAINER_ADDRESS)).statusCode, name).toBe(401);
      }
    });

    it('host-network topology: a peer outside the workers subnet is never authenticated by a binding', async () => {
      // If agent containers shared the host's network (Docker `--network host`), their peer
      // address would be loopback or the host's own — not on the workers network. Even a binding
      // written for such an address authenticates nothing: agent containers are then refused
      // outright (unusable, never open).
      const app = server();
      const { token } = await mintHandle('entry');
      for (const address of ['127.0.0.1', '::1', CONTROL_ADDRESS]) {
        bind(address, token, 'container-a');
        expect((await getObject(app, address)).statusCode, address).toBe(401);
        expect(
          (await getObject(app, address, { authorization: 'Bearer source-bound' })).statusCode,
          address,
        ).toBe(401);
        expect(
          (await getObject(app, address, { authorization: `Bearer ${token}` })).statusCode,
          address,
        ).toBe(401);
        expect((await selfCheck(app, address)).statusCode, address).toBe(403);
      }
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
      expect((await selfCheck(app, CONTAINER_ADDRESS)).statusCode).toBe(200);

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
