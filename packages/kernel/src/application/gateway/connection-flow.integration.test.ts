import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConnectedAccountCredentialResolver,
  ConnectedAccountStore,
  GatekeeperBase,
  HttpTransport,
  InMemoryIdempotencyStore,
  createGatekeeperServer,
} from '@nexttime/gatekeeper-base';
import type { Role } from '@nexttime/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HttpGatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import { listActiveGrantResourceScopes } from '../../governance/capability/index.js';
import { GATEKEEPER_RESOURCE_SCOPE_KEY } from '../../governance/policy/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { findOperations } from '../task/index.js';
import { setConnectionHandlerDeps } from './connection-handlers.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/connection-flow.integration.test: DB-gated (real Postgres + a real fake
 * OpenAPI target system + a real `@nexttime/gatekeeper-base` gate server; auto-skip without
 * DATABASE_URL) end-to-end test for the whole S2.13 flow (docs/development-tasks.md S2.13
 * acceptance): `request_connection` → `create_connection` (manifestSource OpenAPI import,
 * credential → the gate's own ConnectedAccount store) → `find_operations("stock")` empty before
 * publish → `publish_operation` → `find_operations("stock")` hits → `connect_gatekeeper` flows
 * into `listActiveGrantResourceScopes` (the exact read `ensureEntryHandle` performs at Handle
 * issuance — agent-host-runtime.test.ts's own unit test proves the write side with a fake pool;
 * this proves the real end-to-end DB state a real issuance would read) → the credential string
 * appears in no `public` schema table, anywhere, ever.
 *
 * Two real HTTP servers, both on `127.0.0.1` (an RFC 5737-safe, CI-guard-legal loopback address —
 * see `scripts/check-egress-sources.*`/`ci:guards`): a *fake OpenAPI target system* (plain
 * Fastify, not gatekeeper-base — serves `GET /openapi.json` and `GET /stocks`, the task brief's
 * own fixture) and a *real* `@nexttime/gatekeeper-base` gate server in front of it (real
 * `HttpTransport` + real `ConnectedAccountStore`), exercising the actual wire protocol this task
 * added (`POST /gate/connected-accounts`) rather than an in-process fake.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const CREDENTIAL_SECRET = 'super-secret-connection-token-value';

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
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

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/** Builds the fake OpenAPI target system (task brief's own fixture: "a fake OpenAPI server
 *  (Fastify inject or local listener) exposing a `/stocks` GET"). */
function buildFakeOpenApiTargetSystem(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/openapi.json', async () => ({
    openapi: '3.0.0',
    paths: { '/stocks': { get: {} } },
  }));
  app.get('/stocks', async () => ({ items: [{ sku: 'X1', qty: 7 }] }));
  return app;
}

/** Every `public`-schema base table's `table_name` — the "grep every kernel table" surface for
 *  the credential-never-persisted proof (docs/development-tasks.md S2.13: "凭证只在门 ... 内核数据库
 *  任何表中不存在凭证明文", "prove it with a test that greps every kernel table for the credential
 *  string after the flow"). */
async function listPublicTables(pool: Pool): Promise<readonly string[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    return result.rows.map((row) => row.table_name);
  } finally {
    client.release();
  }
}

/** Whole-row-to-text ILIKE over one table — catches the needle regardless of which column or
 *  jsonb path it might be hiding in. */
async function tableContainsSubstring(pool: Pool, table: string, needle: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `select 1 from "${table}" where "${table}"::text ilike $1 limit 1`,
      [`%${needle}%`],
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  'S2.13 connection flow (integration, real Postgres + fake OpenAPI system + real gate server)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;

    let targetSystemApp: FastifyInstance;
    let targetSystemEndpoint: string;
    let gateApp: FastifyInstance;
    let gateEndpoint: string;
    let connectedAccountStore: ConnectedAccountStore;
    let connectedAccountDir: string;

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

    async function adminInsertPrincipal(role: string, displayName: string): Promise<string> {
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
      workspaceId = await adminInsertWorkspace('connection-flow-test-workspace');
      ownerId = await adminInsertPrincipal('owner', 'owner');
      memberId = await adminInsertPrincipal('member', 'member');

      targetSystemApp = buildFakeOpenApiTargetSystem();
      targetSystemEndpoint = await listen(targetSystemApp);

      connectedAccountDir = await mkdtemp(join(tmpdir(), 'gate-connected-account-'));
      const keyFilePath = join(connectedAccountDir, 'store.key');
      await writeFile(keyFilePath, 'a-passphrase-not-32-bytes-long');
      connectedAccountStore = new ConnectedAccountStore({
        dataDir: connectedAccountDir,
        keyFilePath,
      });

      const gate = new GatekeeperBase({
        manifest: [], // deliberately empty — this test imports via manifestSource, not describe_operations.
        transport: new HttpTransport({ baseUrl: targetSystemEndpoint }),
        credentialResolver: new ConnectedAccountCredentialResolver(connectedAccountStore),
        idempotencyStore: new InMemoryIdempotencyStore(),
      });
      gateApp = createGatekeeperServer({ gate, connectedAccountStore });
      gateEndpoint = await listen(gateApp);

      setConnectionHandlerDeps({ gatekeeperClient: new HttpGatekeeperClient() });
    });

    afterAll(async () => {
      await gateApp.close();
      await targetSystemApp.close();
      await rm(connectedAccountDir, { recursive: true, force: true });
      await pool.end();
    });

    it('runs the full request_connection → create_connection → publish → connect_gatekeeper flow with no credential ever persisted in the kernel', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');

      // 1. request_connection — Handle-channel capability, human caller allowed (§9.3 "human 通道
      //    调用同样允许", same reading proposeOperationHandler's own doc comment documents).
      const requested = (await dispatchCapability({ pool }, owner, 'request_connection', {
        kind: 'http',
        target: 'example-system',
      })) as { connectionRequestId: string; status: string };
      expect(requested.status).toBe('requested');

      const queueBeforeCompletion = (await dispatchCapability(
        { pool },
        owner,
        'list_connection_requests',
        { status: 'requested' },
      )) as { connectionRequests: readonly { id: string }[] };
      expect(
        queueBeforeCompletion.connectionRequests.some(
          (r) => r.id === requested.connectionRequestId,
        ),
      ).toBe(true);

      // 2. create_connection ("complete_connection") — manifestSource OpenAPI import + credential
      //    → the gate's ConnectedAccount store, keyed by `onBehalfOf` (memberId, not the owner
      //    completing the connection — design doc §5.1.4 ConnectedAccount "按 on_behalf_of 取用").
      const created = (await dispatchCapability({ pool }, owner, 'create_connection', {
        connectionRequestId: requested.connectionRequestId,
        kind: 'http',
        target: 'example-system',
        endpoint: gateEndpoint,
        manifestSource: `${targetSystemEndpoint}/openapi.json`,
        credentials: { token: CREDENTIAL_SECRET },
        credentialKind: 'connected_account',
        onBehalfOf: memberId,
      })) as { gatekeeperId: string; importedOperationNames: readonly string[] };

      expect(created.importedOperationNames).toContain('get_stocks');

      const queueAfterCompletion = (await dispatchCapability(
        { pool },
        owner,
        'list_connection_requests',
        { status: 'completed' },
      )) as { connectionRequests: readonly { id: string; gatekeeperId: string | null }[] };
      const completedRow = queueAfterCompletion.connectionRequests.find(
        (r) => r.id === requested.connectionRequestId,
      );
      expect(completedRow?.gatekeeperId).toBe(created.gatekeeperId);

      // The credential really did reach the gate's own store, decrypted correctly under the
      // Principal it was filed for.
      expect(await connectedAccountStore.get(memberId)).toEqual({ token: CREDENTIAL_SECRET });

      // 3. I16/I17 — before publish, find_operations("stock") is empty (unpublished manifest
      //    invisible to an agent). `'unconstrained'` (owner, human, no Handle) sees every
      //    *published* candidate — draft is filtered regardless of caller authority.
      const beforePublish = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          findOperations(client, workspaceId, { parentAuthority: 'unconstrained' }, 'stock'),
      );
      expect(beforePublish).toEqual([]);

      // 4. publish_operation (owner's explicit per-Operation publish, per the task brief: "publish
      //    remains the owner's explicit publish_operation (I16/I17)").
      await dispatchCapability({ pool }, owner, 'publish_operation', {
        gatekeeperId: created.gatekeeperId,
        name: 'get_stocks',
      });

      // 5. After publish, find_operations("stock") hits.
      const afterPublish = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          findOperations(client, workspaceId, { parentAuthority: 'unconstrained' }, 'stock'),
      );
      expect(afterPublish).toHaveLength(1);
      expect(afterPublish[0]?.identityKey).toEqual({
        gatekeeperId: created.gatekeeperId,
        name: 'get_stocks',
      });

      // 6. connect_gatekeeper → the exact read `ensureEntryHandle` performs at Handle issuance
      //    (governance/capability/grants.ts's listActiveGrantResourceScopes) now returns this
      //    Gatekeeper for `memberId` — the "known seam" this task closes, proven against real DB
      //    state (agent-host-runtime.test.ts's own unit test proves the write side with a fake
      //    pool that seeds exactly this read).
      await dispatchCapability({ pool }, owner, 'connect_gatekeeper', {
        gatekeeperId: created.gatekeeperId,
        principalId: memberId,
      });
      const grantedGatekeeperIds = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          listActiveGrantResourceScopes(client, workspaceId, {
            principalId: memberId,
            capability: GATEKEEPER_RESOURCE_SCOPE_KEY,
          }),
      );
      expect(grantedGatekeeperIds).toContain(created.gatekeeperId);

      // 7. Redaction proof, part 1: the create_connection audit row never carries the credential.
      const auditRows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, { action: 'create_connection' }),
      );
      expect(auditRows).toHaveLength(1);
      const auditedParams = (auditRows[0]?.payload as { params?: { credentials?: unknown } })
        .params;
      expect(auditedParams?.credentials).toBe('[redacted]');
      expect(JSON.stringify(auditRows[0]?.payload)).not.toContain(CREDENTIAL_SECRET);

      // 8. Redaction proof, part 2: the credential string appears in NO `public`-schema table —
      //    every kernel table, not just the ones this test happens to know about.
      const tables = await listPublicTables(pool);
      expect(tables.length).toBeGreaterThan(5); // sanity: the migrations really did run
      const offendingTables: string[] = [];
      for (const table of tables) {
        if (await tableContainsSubstring(pool, table, CREDENTIAL_SECRET)) {
          offendingTables.push(table);
        }
      }
      expect(offendingTables).toEqual([]);
    });
  },
);
