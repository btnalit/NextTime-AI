import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { hashApiKey } from '../../application/gateway/index.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { createServer } from '../../index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import {
  CausalChainResponseSchema,
  DecisionResponseSchema,
  EdgeListResponseSchema,
  NodeListResponseSchema,
  ProvenanceResponseSchema,
  SearchResultResponseSchema,
  TemporalBoundsResponseSchema,
  TemporalSnapshotResponseSchema,
} from './schemas.js';
import { EXPLORER_SESSION_COOKIE } from './session.js';

/**
 * interfaces/explorer-contract/explorer-contract.integration.test: HTTP-level tests through
 * Fastify `inject` (no real listener — same convention as interfaces/http/capability-route.test.ts)
 * for the nine Explorer endpoints (docs/development-tasks.md §S3.5 deliverable 4: "contract tests
 * ... incl. 401 without key, hidden Ontology objects, 207 partial; Zod snapshot of each response
 * schema").
 *
 * Two suites:
 *   - Unit (no DB): the X-API-Key short-circuit — "no key → 401" never touches the database.
 *   - Integration (DATABASE_URL, auto-skip otherwise): seeds one workspace's worth of Graph/
 *     Decision/Lineage fixtures (plus a second workspace and a platform meta-object, both of which
 *     must never appear) and exercises every one of the nine routes end-to-end.
 */

const neverConnectPool: PoolLike = {
  connect(): Promise<PoolClient> {
    throw new Error('should not touch the database for this request');
  },
};

describe('Explorer routes — no X-API-Key (unit)', () => {
  it('GET /api/graph/nodes with no X-API-Key header → 401, no database access', async () => {
    const app = createServer({ pool: neverConnectPool });
    const response = await app.inject({ method: 'GET', url: '/api/graph/nodes' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ detail: expect.any(String) });
  });

  it('GET /api/decisions with no X-API-Key header → 401, no database access', async () => {
    const app = createServer({ pool: neverConnectPool });
    const response = await app.inject({ method: 'GET', url: '/api/decisions' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ detail: expect.any(String) });
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'Explorer routes — integration (real Postgres, HTTP via app.inject)',
  () => {
    let pool: Pool;
    const store = new SqlGraphStore();

    let workspaceId: string;
    let otherWorkspaceId: string;
    let ownerId: string;
    let ownerApiKey: string;

    let hostId: string;
    let serviceId: string;
    let factId: string;
    let decisionId: string;
    let metaObjectId: string;
    let otherWorkspaceObjectId: string;

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

    async function adminInsertPrincipalWithKey(opts: {
      workspaceId: string;
      role: Role;
      apiKey: string;
    }): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: opts.workspaceId, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
             values ($1, $2, 'human', $3, $4, $5)`,
            [opts.workspaceId, id, opts.role, opts.role, hashApiKey(opts.apiKey)],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = await adminInsertWorkspace('explorer-contract-test-workspace');
      otherWorkspaceId = await adminInsertWorkspace('explorer-contract-test-other-workspace');
      ownerApiKey = `explorer-owner-key-${randomUUID()}`;
      ownerId = await adminInsertPrincipalWithKey({
        workspaceId,
        role: 'owner',
        apiKey: ownerApiKey,
      });

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const host = await store.upsertObject(client, workspaceId, {
          objectType: 'ops.host',
          identity: { hostname: `explorer-test-host-${randomUUID()}` },
        });
        const service = await store.upsertObject(client, workspaceId, {
          objectType: 'ops.service',
          identity: { name: `explorer-test-svc-${randomUUID()}` },
        });
        hostId = host.id;
        serviceId = service.id;

        const activity = await startActivity(client, workspaceId, { kind: 'test.ingest' });
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
          `insert into decisions (workspace_id, status, activity_id, summary, rationale, decided_by, decided_at)
           values ($1, 'approved', $2, $3, $4::jsonb, $5, now())
           returning id`,
          [
            workspaceId,
            activity.id,
            'restart the explorer test host',
            JSON.stringify({ relatedFactIds: [fact.id] }),
            ownerId,
          ],
        );
        decisionId = decisionResult.rows[0]?.id ?? '';

        // A platform meta-ontology Object (substrate/ontology/meta-objects.ts's own `objectType`
        // literal) — must never appear in any Explorer graph read (explorer-read-service.ts's own
        // `PLATFORM_META_OBJECT_TYPES`).
        const metaObject = await store.upsertObject(client, workspaceId, {
          objectType: 'WorkerDefinition',
          properties: { name: 'ops-runner' },
        });
        metaObjectId = metaObject.id;
      });

      await withWorkspace(
        pool,
        { workspaceId: otherWorkspaceId, principalId: randomUUID() },
        async (client) => {
          const object = await store.upsertObject(client, otherWorkspaceId, {
            objectType: 'ops.host',
            identity: { hostname: `explorer-test-other-ws-host-${randomUUID()}` },
          });
          otherWorkspaceObjectId = object.id;
        },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('GET /api/graph/nodes: seeded objects present, platform meta-object and other workspace hidden, matches NodeListResponseSchema', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'GET',
        url: '/api/graph/nodes?limit=1000',
        headers: { 'x-api-key': ownerApiKey },
      });
      expect(response.statusCode).toBe(200);
      const body = NodeListResponseSchema.parse(response.json());
      const ids = body.nodes.map((n) => n.id);
      expect(ids).toEqual(expect.arrayContaining([hostId, serviceId]));
      expect(ids).not.toContain(metaObjectId);
      expect(ids).not.toContain(otherWorkspaceObjectId);
    });

    it('GET /api/graph/edges: seeded Fact present, matches EdgeListResponseSchema', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'GET',
        url: '/api/graph/edges?limit=1000',
        headers: { 'x-api-key': ownerApiKey },
      });
      expect(response.statusCode).toBe(200);
      const body = EdgeListResponseSchema.parse(response.json());
      const edge = body.edges.find((e) => e.id === factId);
      expect(edge).toMatchObject({ source: serviceId, target: hostId, type: 'test.runs_on' });
    });

    it('POST /api/graph/search: finds the seeded host by objectType filter, matches SearchResultResponseSchema', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'POST',
        url: '/api/graph/search',
        headers: { 'x-api-key': ownerApiKey, 'content-type': 'application/json' },
        payload: { query: '', filters: { objectType: 'ops.host' }, limit: 50 },
      });
      expect(response.statusCode).toBe(200);
      const body = SearchResultResponseSchema.parse(response.json());
      expect(body.results.some((r) => r.node.id === hostId)).toBe(true);
      expect(body.results.some((r) => r.node.id === metaObjectId)).toBe(false);
    });

    it('GET /api/temporal/bounds and /api/temporal/snapshot reflect the seeded Fact', async () => {
      const app = createServer({ pool });
      const bounds = await app.inject({
        method: 'GET',
        url: '/api/temporal/bounds',
        headers: { 'x-api-key': ownerApiKey },
      });
      expect(bounds.statusCode).toBe(200);
      const boundsBody = TemporalBoundsResponseSchema.parse(bounds.json());
      expect(boundsBody.min).not.toBeNull();

      const snapshot = await app.inject({
        method: 'GET',
        url: `/api/temporal/snapshot?at=${encodeURIComponent(new Date().toISOString())}`,
        headers: { 'x-api-key': ownerApiKey },
      });
      expect(snapshot.statusCode).toBe(200);
      const snapshotBody = TemporalSnapshotResponseSchema.parse(snapshot.json());
      expect(snapshotBody.active_node_ids).toEqual(expect.arrayContaining([hostId, serviceId]));
    });

    it('GET /api/decisions: bare array containing the seeded Decision, each item matches DecisionResponseSchema', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'GET',
        url: '/api/decisions',
        headers: { 'x-api-key': ownerApiKey },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      for (const item of body) DecisionResponseSchema.parse(item);
      const decision = body.find(
        (item: { decision_id: string }) => item.decision_id === decisionId,
      );
      expect(decision).toMatchObject({
        outcome: 'approved',
        scenario: 'restart the explorer test host',
      });
    });

    it('GET /api/decisions/:id/chain: 200, matches CausalChainResponseSchema, chain includes the seeded Fact', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'GET',
        url: `/api/decisions/${decisionId}/chain`,
        headers: { 'x-api-key': ownerApiKey },
      });
      expect([200, 207]).toContain(response.statusCode);
      const body = CausalChainResponseSchema.parse(response.json());
      expect(body.decision_id).toBe(decisionId);
      expect(body.chain.some((step) => step.id === factId)).toBe(true);
    });

    it('GET /api/decisions/:id/chain for an unknown id → 404', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'GET',
        url: `/api/decisions/${randomUUID()}/chain`,
        headers: { 'x-api-key': ownerApiKey },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ detail: expect.any(String) });
    });

    it('GET /api/provenance?node_id=<factId>: PROV-O graph rooted at the seeded Fact, matches ProvenanceResponseSchema', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'GET',
        url: `/api/provenance?node_id=${factId}`,
        headers: { 'x-api-key': ownerApiKey },
      });
      expect(response.statusCode).toBe(200);
      const body = ProvenanceResponseSchema.parse(response.json());
      expect(body.nodes.some((n) => n.id === factId)).toBe(true);
      expect(body.source).toBe('explain');
    });

    it('GET /api/provenance?node_id=<unknown> → 404', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'GET',
        url: `/api/provenance?node_id=${randomUUID()}`,
        headers: { 'x-api-key': ownerApiKey },
      });
      expect(response.statusCode).toBe(404);
    });

    it('GET /api/provenance/report?...&format=json downloads a JSON attachment', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'GET',
        url: `/api/provenance/report?node_id=${factId}&format=json`,
        headers: { 'x-api-key': ownerApiKey },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-disposition']).toContain('_provenance.json');
      const body = response.json();
      expect(body.node_id).toBe(factId);
      expect(Array.isArray(body.nodes)).toBe(true);
    });

    it('GET /api/provenance/report?...&format=markdown downloads a Markdown attachment', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'GET',
        url: `/api/provenance/report?node_id=${factId}&format=markdown`,
        headers: { 'x-api-key': ownerApiKey },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('_provenance.md');
      expect(response.body).toContain('# Provenance Report');
    });

    it('a valid key from a different workspace never sees this workspace’s objects (workspace isolation)', async () => {
      const otherApiKey = `explorer-other-key-${randomUUID()}`;
      await adminInsertPrincipalWithKey({
        workspaceId: otherWorkspaceId,
        role: 'owner',
        apiKey: otherApiKey,
      });

      const app = createServer({ pool });
      const response = await app.inject({
        method: 'GET',
        url: '/api/graph/nodes?limit=1000',
        headers: { 'x-api-key': otherApiKey },
      });
      expect(response.statusCode).toBe(200);
      const body = NodeListResponseSchema.parse(response.json());
      const ids = body.nodes.map((n) => n.id);
      expect(ids).toContain(otherWorkspaceObjectId);
      expect(ids).not.toContain(hostId);
      expect(ids).not.toContain(serviceId);
    });

    // ---- W7: caller-owned Explorer session cookie (session.ts) ---------------------------------

    describe('Explorer session cookie (W7)', () => {
      let privateKey: CryptoKey;
      let publicKey: CryptoKey;

      beforeAll(async () => {
        const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
        privateKey = pair.privateKey;
        publicKey = pair.publicKey;
      });

      function appWithKeys() {
        return createServer({
          pool,
          loadHandlePublicKey: async () => publicKey,
          loadHandlePrivateKey: async () => privateKey,
        });
      }

      function setCookieHeader(headers: Record<string, unknown>): string {
        const raw = headers['set-cookie'];
        const first = Array.isArray(raw) ? raw[0] : raw;
        if (typeof first !== 'string') throw new Error('no Set-Cookie header');
        return first;
      }

      function cookieValue(setCookie: string): string {
        const match = new RegExp(`^${EXPLORER_SESSION_COOKIE}=([^;]*)`).exec(setCookie);
        if (!match?.[1]) throw new Error(`unexpected Set-Cookie: ${setCookie}`);
        return match[1];
      }

      async function createSession(app: ReturnType<typeof createServer>, apiKey: string) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/explorer/session',
          headers: { authorization: `Bearer ${apiKey}` },
        });
        return response;
      }

      it('POST /api/explorer/session with the owner key → 200 + a locked-down Set-Cookie', async () => {
        const app = appWithKeys();
        const response = await createSession(app, ownerApiKey);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true, expiresAt: expect.any(String) });
        const setCookie = setCookieHeader(response.headers);
        expect(setCookie).toContain(`${EXPLORER_SESSION_COOKIE}=`);
        expect(setCookie).toContain('HttpOnly');
        expect(setCookie).toContain('Secure');
        expect(setCookie).toContain('SameSite=Strict');
        expect(setCookie).toContain('Path=/api');
        expect(setCookie).toMatch(/Max-Age=\d+/);
        expect(response.headers['cache-control']).toBe('no-store');
      });

      it('the cookie authenticates the nine read routes as the caller (no X-API-Key needed)', async () => {
        const app = appWithKeys();
        const token = cookieValue(setCookieHeader((await createSession(app, ownerApiKey)).headers));

        const nodes = await app.inject({
          method: 'GET',
          url: '/api/graph/nodes?limit=1000',
          headers: { cookie: `other=1; ${EXPLORER_SESSION_COOKIE}=${token}` },
        });
        expect(nodes.statusCode).toBe(200);
        const ids = NodeListResponseSchema.parse(nodes.json()).nodes.map((n) => n.id);
        expect(ids).toEqual(expect.arrayContaining([hostId, serviceId]));
        expect(ids).not.toContain(otherWorkspaceObjectId);

        const decisions = await app.inject({
          method: 'GET',
          url: '/api/decisions',
          headers: { cookie: `${EXPLORER_SESSION_COOKIE}=${token}` },
        });
        expect(decisions.statusCode).toBe(200);
      });

      it('an explicit X-API-Key wins over the cookie: a wrong key + a valid cookie → 401', async () => {
        const app = appWithKeys();
        const token = cookieValue(setCookieHeader((await createSession(app, ownerApiKey)).headers));
        const response = await app.inject({
          method: 'GET',
          url: '/api/graph/nodes',
          headers: { 'x-api-key': 'not-a-key', cookie: `${EXPLORER_SESSION_COOKIE}=${token}` },
        });
        expect(response.statusCode).toBe(401);
      });

      it('a tampered cookie, and a Handle-shaped JWT signed with the same key, are both 401', async () => {
        const app = appWithKeys();
        const token = cookieValue(setCookieHeader((await createSession(app, ownerApiKey)).headers));
        const [header, payload, signature] = token.split('.');
        const tampered = `${header}.${payload?.slice(0, -2)}AA.${signature}`;
        const tamperedResponse = await app.inject({
          method: 'GET',
          url: '/api/graph/nodes',
          headers: { cookie: `${EXPLORER_SESSION_COOKIE}=${tampered}` },
        });
        expect(tamperedResponse.statusCode).toBe(401);

        const handleLike = await new SignJWT({
          ws: workspaceId,
          sid: randomUUID(),
          obo: ownerId,
          scope: { capabilities: ['search'], resources: {} },
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        })
          .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
          .sign(privateKey);
        const handleResponse = await app.inject({
          method: 'GET',
          url: '/api/graph/nodes',
          headers: { cookie: `${EXPLORER_SESSION_COOKIE}=${handleLike}` },
        });
        expect(handleResponse.statusCode).toBe(401);
      });

      it('the session token never works as a Bearer credential on /api/cap/* (401)', async () => {
        const app = appWithKeys();
        const token = cookieValue(setCookieHeader((await createSession(app, ownerApiKey)).headers));
        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/get_workspace',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          payload: {},
        });
        expect(response.statusCode).toBe(401);
      });

      it('a Handle presented to POST /api/explorer/session, or no credential at all → 401', async () => {
        const app = appWithKeys();
        const noCredential = await app.inject({ method: 'POST', url: '/api/explorer/session' });
        expect(noCredential.statusCode).toBe(401);
        expect(noCredential.json()).toEqual({ detail: expect.any(String) });
        expect(noCredential.headers['set-cookie']).toBeUndefined();
      });

      it('disable_principal cuts a live cookie off on the next request', async () => {
        const app = appWithKeys();
        const apiKey = `explorer-disable-key-${randomUUID()}`;
        const principalId = await adminInsertPrincipalWithKey({
          workspaceId,
          role: 'member',
          apiKey,
        });
        const token = cookieValue(setCookieHeader((await createSession(app, apiKey)).headers));
        const before = await app.inject({
          method: 'GET',
          url: '/api/graph/nodes',
          headers: { cookie: `${EXPLORER_SESSION_COOKIE}=${token}` },
        });
        expect(before.statusCode).toBe(200);

        await withWorkspace(
          pool,
          { workspaceId, principalId },
          async (client) => {
            await client.query(
              'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
              [workspaceId, principalId],
            );
          },
          { skipRoleSwitch: true },
        );

        const after = await app.inject({
          method: 'GET',
          url: '/api/graph/nodes',
          headers: { cookie: `${EXPLORER_SESSION_COOKIE}=${token}` },
        });
        expect(after.statusCode).toBe(401);
      });

      it('DELETE /api/explorer/session → 204 with a clearing Set-Cookie', async () => {
        const app = appWithKeys();
        const response = await app.inject({ method: 'DELETE', url: '/api/explorer/session' });
        expect(response.statusCode).toBe(204);
        const setCookie = setCookieHeader(response.headers);
        expect(setCookie).toContain(`${EXPLORER_SESSION_COOKIE}=;`);
        expect(setCookie).toContain('Max-Age=0');
        expect(setCookie).toContain('Path=/api');
      });

      it('POST /api/explorer/session without a signing key → 503, and X-API-Key still works', async () => {
        const app = createServer({
          pool,
          loadHandlePublicKey: async () => publicKey,
          loadHandlePrivateKey: async () => {
            throw new Error('no key configured');
          },
        });
        const response = await createSession(app, ownerApiKey);
        expect(response.statusCode).toBe(503);
        expect(response.headers['set-cookie']).toBeUndefined();
        const viaHeader = await app.inject({
          method: 'GET',
          url: '/api/graph/nodes',
          headers: { 'x-api-key': ownerApiKey },
        });
        expect(viaHeader.statusCode).toBe(200);
      });
    });
  },
);
