import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG, issueHandle } from '../../governance/capability/index.js';
import { createServer } from '../../index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';

/**
 * interfaces/mcp/index.test: two suites, matching the pattern established elsewhere in this
 * package (e.g. interfaces/http/capability-route.test.ts):
 *
 *   - Unit (no DB): the Authorization-header/method short-circuits — 401/405 never touch the
 *     database.
 *   - Integration (DATABASE_URL, auto-skip otherwise): a real `@modelcontextprotocol/sdk` client
 *     over `StreamableHTTPClientTransport` against the Fastify app's real HTTP listener —
 *     `tools/list` shape, a `traverse` call reaching seeded graph data, and an out-of-scope call.
 */

const neverConnectPool: PoolLike = {
  connect(): Promise<PoolClient> {
    throw new Error('should not touch the database for this request');
  },
};

describe('POST /mcp — no database access when unauthenticated (unit)', () => {
  it('no Authorization header → 401', async () => {
    const app = createServer({ pool: neverConnectPool });
    const response = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('a non-Bearer Authorization header → 401', async () => {
    const app = createServer({ pool: neverConnectPool });
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Basic dGVzdA==' },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('no Handle-signing key configured at all → 500, never misreported as 401', async () => {
    // This file's own module doc comment: "any other error is a 500, not a 401 — conflating the
    // two would misreport a real outage as 'your credential is bad'". No loadHandlePublicKey
    // override here — the default loader reads HANDLE_PRIVATE_KEY_FILE/HANDLE_PUBLIC_KEY_FILE from
    // process.env, unset in this test process, so it fails with HandleKeyConfigError — a
    // configuration/outage class of error, not a caller-credential one.
    const app = createServer({ pool: neverConnectPool });
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer not-a-real-jwt' },
      payload: {},
    });
    expect(response.statusCode).toBe(500);
  });
});

describe('GET|DELETE /mcp — this transport is stateless (unit, no DB)', () => {
  it('GET /mcp → 405 with Allow: POST', async () => {
    const app = createServer({ pool: neverConnectPool });
    const response = await app.inject({ method: 'GET', url: '/mcp' });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe('POST');
  });

  it('DELETE /mcp → 405', async () => {
    const app = createServer({ pool: neverConnectPool });
    const response = await app.inject({ method: 'DELETE', url: '/mcp' });
    expect(response.statusCode).toBe(405);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'POST /mcp — integration (real Postgres, real MCP client)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

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

    async function adminInsertPrincipal(role: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', $3, $4)`,
            [workspaceId, id, role, role],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** Mints a real Handle for a fresh `kind='mcp_session'` session — the same shape
     *  `issue-handle-handler.ts` itself creates, built directly here (not through the `issue_handle`
     *  capability) so this suite stays focused on the MCP transport/auth/tool-projection contract;
     *  `issue_handle`'s own DB behavior (session creation, scope intersection) has its own dedicated
     *  integration test (application/gateway/issue-handle-handler.integration.test.ts). */
    async function mintInteractiveHandle(opts: {
      readonly privateKey: CryptoKey;
      readonly capabilities: readonly string[];
    }): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const sessionResult = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, 'mcp_session', $2, 'active') returning id`,
          [workspaceId, ownerId],
        );
        const sessionRow = sessionResult.rows[0];
        if (!sessionRow) throw new Error('fixture: session insert produced no row');
        const issued = await issueHandle(client, {
          sessionId: sessionRow.id,
          scope: { capabilities: [...opts.capabilities], resources: {} },
          ttlSeconds: 3600,
          privateKey: opts.privateKey,
        });
        return issued.token;
      });
    }

    /** Seeds two Objects and one `depends_on` Link between them — the graph `traverse` reads. */
    async function seedGraph(): Promise<{ sourceId: string; targetId: string }> {
      const store = new SqlGraphStore();
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.mcp-fixture',
          principalId: ownerId,
        });
        const source = await store.upsertObject(client, workspaceId, {
          objectType: 'test.mcp-thing',
          properties: { name: 'source' },
        });
        const target = await store.upsertObject(client, workspaceId, {
          objectType: 'test.mcp-thing',
          properties: { name: 'target' },
        });
        await store.assertFact(
          client,
          workspaceId,
          { id: ownerId },
          {
            linkType: 'depends_on',
            sourceObjectId: source.id,
            targetObjectId: target.id,
            activityId: activity.id,
          },
        );
        return { sourceId: source.id, targetId: target.id };
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('mcp-index-test-workspace');
      ownerId = await adminInsertPrincipal('owner');
    });

    afterAll(async () => {
      await pool.end();
    });

    async function startListeningServer(
      publicKey: CryptoKey,
    ): Promise<{ url: string; close: () => Promise<void> }> {
      const app = createServer({ pool, loadHandlePublicKey: async () => publicKey });
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      return { url: `${address}/mcp`, close: () => app.close() };
    }

    it('a garbage bearer token → 401 (HandleInvalid) — `authenticateHandle` always opens a DB transaction first (createDbRevocationCheck), so this genuinely needs the real pool, unlike the missing-header/non-Bearer cases above', async () => {
      const { publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const { url, close } = await startListeningServer(publicKey);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { authorization: 'Bearer not-a-real-jwt', 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(response.status).toBe(401);
      } finally {
        await close();
      }
    });

    it('tools/list = the connecting Handle’s own scope ∩ handle-channel set, plus applicable Semantica aliases', async () => {
      const { publicKey, privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const token = await mintInteractiveHandle({
        privateKey,
        capabilities: ['get_object', 'traverse', 'search', 'explain'],
      });
      const { url, close } = await startListeningServer(publicKey);

      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: 'nexttime-mcp-test-client', version: '0.0.0' });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        // 4 native (get_object/traverse/search/explain) + 2 Semantica aliases whose target capability
        // is in scope (search→search_graph, explain→get_provenance) — see reference-tool-aliases.ts's own
        // documented table.
        expect(names).toEqual(
          ['explain', 'get_object', 'get_provenance', 'search', 'search_graph', 'traverse'].sort(),
        );
      } finally {
        await client.close();
        await close();
      }
    });

    it('Claude Code (a real MCP client) reaches the same graph via `traverse` on seeded data', async () => {
      const { publicKey, privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const { sourceId, targetId } = await seedGraph();
      const token = await mintInteractiveHandle({ privateKey, capabilities: ['traverse'] });
      const { url, close } = await startListeningServer(publicKey);

      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: 'nexttime-mcp-test-client', version: '0.0.0' });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'traverse', arguments: { fromId: sourceId } });
        expect(result.isError).not.toBe(true);
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
        const parsed = JSON.parse(text) as { edges: Array<{ targetObjectId: string }> };
        expect(parsed.edges.some((edge) => edge.targetObjectId === targetId)).toBe(true);
      } finally {
        await client.close();
        await close();
      }
    });

    it('a tool call outside the Handle’s own scope → isError result, not a thrown protocol error', async () => {
      const { publicKey, privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const token = await mintInteractiveHandle({ privateKey, capabilities: ['get_object'] });
      const { url, close } = await startListeningServer(publicKey);

      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: 'nexttime-mcp-test-client', version: '0.0.0' });
      try {
        await client.connect(transport);
        // `traverse` is not in this Handle's scope — tools/list never advertised it, and calling it
        // by name anyway resolves to nothing in the catalog (unknown tool), not a capability dispatch.
        const result = await client.callTool({
          name: 'traverse',
          arguments: { fromId: randomUUID() },
        });
        expect(result.isError).toBe(true);
      } finally {
        await client.close();
        await close();
      }
    });
  },
);
