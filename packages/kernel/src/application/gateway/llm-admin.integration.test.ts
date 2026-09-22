import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmAdminTokenWire, Role } from '@nexttime/shared';
import {
  HandleTokenInvalid,
  LLM_ADMIN_TOKEN_TTL_SECONDS,
  internalAuthorizationHeader,
  verifyHandleToken,
  verifyLlmAdminToken,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG, issueHandle } from '../../governance/capability/index.js';
import { createServer } from '../../index.js';
import { createPlatformAdmin } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/llm-admin.integration.test: DB-gated coverage of S6-B's kernel share
 * (docs/console-completion-plan.md §5.4 / §6) — `issue_llm_admin_token` (administrator only,
 * 5-minute expiry, distinct from a Handle, `platform.llm_admin_token_issued` audit row with the
 * jti), the model proxy's per-mutation `POST /internal/llm-admin-audit` (internal token required,
 * one platform audit row, unknown actor refused), and the leftover-19 signal `GET /internal/
 * llm-budget-exhausted` (a workspace over its `task.daily_cost_budget_usd` quota is listed with
 * the next UTC midnight; an unlimited (JSON null) quota never is; the token axis follows
 * `LLM_DAILY_TOKEN_BUDGET`).
 *
 * Same scaffolding as platform-gate-host.integration.test.ts (private database per file).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');
const INTERNAL_TOKEN = 's6b-internal-token-0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';

async function waitForNoConnections(cluster: Pool, name: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { rows } = await cluster.query<{ n: string }>(
      'select count(*)::text as n from pg_stat_activity where datname = $1',
      [name],
    );
    if (rows[0]?.n === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createIsolatedDatabase(): Promise<{ pool: Pool; drop: () => Promise<void> }> {
  if (DATABASE_URL === undefined) throw new Error('createIsolatedDatabase needs DATABASE_URL');
  const cluster = createPool();
  const name = `nexttime_llm_admin_${randomUUID().replace(/-/g, '')}`;
  try {
    await cluster.query(`create database "${name}"`);
  } catch (err) {
    await cluster.end();
    throw err;
  }
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool({ connectionString: url.toString() });
  return {
    pool,
    drop: async () => {
      await pool.end();
      await waitForNoConnections(cluster, name);
      await cluster.query(`drop database if exists "${name}" with (force)`);
      await cluster.end();
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)('S6-B llm admin (integration, real Postgres)', () => {
  let pool: Pool;
  let dropDatabase: (() => Promise<void>) | undefined;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let admin: UserRow;
  let workspaceId: string;
  let ownerPrincipalId: string;

  function app() {
    return createServer(
      {
        pool,
        loadHandlePublicKey: async () => publicKey,
        loadHandlePrivateKey: async () => privateKey,
      },
      { internalAuth: { token: INTERNAL_TOKEN } },
    );
  }

  function platformCaller(user: UserRow): ResolvedCaller {
    return {
      channel: 'platform',
      user: {
        id: user.id,
        login: user.login,
        displayName: user.displayName,
        platformRole: 'admin',
        mustChangePassword: false,
        consoleSessionId: randomUUID(),
      },
    };
  }

  function humanCaller(principalId: string, role: Role): ResolvedCaller {
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

  function callAsAdmin<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    return dispatchCapability({ pool }, platformCaller(admin), name, params) as Promise<T>;
  }

  async function auditRows(action: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query<Record<string, unknown>>(
      'select actor_user_id, resource_type, resource_id, payload from audit_records where action = $1 order by created_at',
      [action],
    );
    return rows;
  }

  beforeAll(async () => {
    const isolated = await createIsolatedDatabase();
    pool = isolated.pool;
    dropDatabase = isolated.drop;
    await runMigrations(pool, MIGRATIONS_DIR);
    const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    configureTaskRuntime({
      pool,
      privateKey,
      supervisorClient: {
        spawn: async () => {
          throw new Error('not used');
        },
        terminate: async () => false,
        status: async () => undefined,
      },
    });
    admin = await createPlatformAdmin(pool, {
      login: `llm-admin-${randomUUID().slice(0, 8)}`,
      displayName: 'LLM Admin',
      password: PASSWORD,
    });
    const created = await createWorkspaceWithOwner(pool, {
      name: 'llm-admin-test-workspace',
      owner: { userId: admin.id, displayName: 'Admin' },
      ontologyDir: ONTOLOGY_DIR,
    });
    workspaceId = created.workspaceId;
    ownerPrincipalId = created.ownerPrincipalId;
  }, 180_000);

  afterAll(async () => {
    resetTaskRuntimeForTests();
    await dropDatabase?.();
  }, 60_000);

  it('a. issue_llm_admin_token: admin only; a 5-minute token that verifies as an admin token and never as a Handle; audited with its jti', async () => {
    const minted = await callAsAdmin<LlmAdminTokenWire>('issue_llm_admin_token');
    expect(minted.url).toBe('/api/llm-admin');
    expect(minted.token.length).toBeGreaterThan(20);

    const claims = await verifyLlmAdminToken(minted.token, publicKey);
    expect(claims).toMatchObject({ aud: 'llm-admin', sub: admin.id, jti: minted.jti });
    expect(claims.exp - claims.iat).toBe(LLM_ADMIN_TOKEN_TTL_SECONDS);
    expect(new Date(minted.expiresAt).getTime()).toBe(claims.exp * 1000);
    await expect(verifyHandleToken(minted.token, publicKey)).rejects.toThrow(HandleTokenInvalid);

    // Two rows: dispatch's own capability row and the dedicated issuance row with the jti.
    const issued = await auditRows('platform.llm_admin_token_issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      actor_user_id: admin.id,
      resource_type: 'llm_admin_token',
      resource_id: minted.jti,
    });
    expect(issued[0]?.payload).toMatchObject({ jti: minted.jti, channel: 'platform' });
    expect(JSON.stringify(issued[0]?.payload)).not.toContain(minted.token);
    expect(await auditRows('issue_llm_admin_token')).toHaveLength(1);

    // A workspace owner (human channel) is refused — platform scope, administrators only.
    await expect(
      dispatchCapability(
        { pool },
        humanCaller(ownerPrincipalId, 'owner'),
        'issue_llm_admin_token',
        {},
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('b. POST /internal/llm-admin-audit: internal token required; writes one platform audit row keyed by the jti; unknown actor is 400', async () => {
    const minted = await callAsAdmin<LlmAdminTokenWire>('issue_llm_admin_token');
    const server = app();
    const event = {
      action: 'provider_created',
      providerId: 'acme',
      actorUserId: admin.id,
      tokenJti: minted.jti,
      details: { api: 'openai-completions', models: ['m1'], apiKeyEnv: 'ACME_KEY' },
    };

    const noToken = await server.inject({
      method: 'POST',
      url: '/internal/llm-admin-audit',
      payload: event,
    });
    expect(noToken.statusCode).toBe(401);

    const ok = await server.inject({
      method: 'POST',
      url: '/internal/llm-admin-audit',
      headers: { authorization: internalAuthorizationHeader(INTERNAL_TOKEN) },
      payload: event,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, result: { auditId: expect.any(String) } });

    const rows = await auditRows('platform.llm_provider_created');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: admin.id,
      resource_type: 'llm_provider',
      resource_id: null,
    });
    expect(rows[0]?.payload).toMatchObject({
      tokenJti: minted.jti,
      resourceRef: 'acme',
      apiKeyEnv: 'ACME_KEY',
      via: 'llm_admin_token',
    });

    const unknownActor = await server.inject({
      method: 'POST',
      url: '/internal/llm-admin-audit',
      headers: { authorization: internalAuthorizationHeader(INTERNAL_TOKEN) },
      payload: { ...event, actorUserId: randomUUID() },
    });
    expect(unknownActor.statusCode).toBe(400);
    expect(unknownActor.json()).toMatchObject({ ok: false, error: { code: 'unknown_actor' } });

    const badBody = await server.inject({
      method: 'POST',
      url: '/internal/llm-admin-audit',
      headers: { authorization: internalAuthorizationHeader(INTERNAL_TOKEN) },
      payload: { ...event, action: 'provider_secret_written' },
    });
    expect(badBody.statusCode).toBe(400);
    await server.close();
  });

  it('c. GET /internal/llm-budget-exhausted (leftover 19): lists a workspace over its daily cost quota until the next UTC midnight; unlimited quotas never', async () => {
    const server = app();
    const headers = { authorization: internalAuthorizationHeader(INTERNAL_TOKEN) };

    expect(
      (await server.inject({ method: 'GET', url: '/internal/llm-budget-exhausted' })).statusCode,
    ).toBe(401);

    const before = await server.inject({
      method: 'GET',
      url: '/internal/llm-budget-exhausted',
      headers,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ exhausted: [], now: expect.any(String) });

    // A $5 daily cost budget on the workspace, then $6 of usage today (on a real session row —
    // `llm_usage` references `sessions`).
    await withWorkspace(pool, { workspaceId, principalId: ownerPrincipalId }, async (client) => {
      await client.query(
        `insert into quotas (workspace_id, key, value, updated_by) values ($1, 'task.daily_cost_budget_usd', $2::jsonb, $3)`,
        [workspaceId, JSON.stringify(5), ownerPrincipalId],
      );
      const sessionId = randomUUID();
      await client.query(
        `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, $3, 'entry', $3, 'ready')`,
        [workspaceId, sessionId, ownerPrincipalId],
      );
      const issued = await issueHandle(client, {
        sessionId,
        scope: { capabilities: [], resources: {} },
        ttlSeconds: 3600,
        privateKey,
      });
      await client.query(
        `insert into llm_usage (workspace_id, session_id, jti, provider, model, input_tokens, output_tokens, cost_usd, started_at, status)
         values ($1, $2, $3, 'p', 'm', 10, 5, 6.0, now(), 'completed')`,
        [workspaceId, sessionId, issued.jti],
      );
    });

    const after = await server.inject({
      method: 'GET',
      url: '/internal/llm-budget-exhausted',
      headers,
    });
    const body = after.json() as { exhausted: Array<Record<string, unknown>>; now: string };
    expect(body.exhausted).toHaveLength(1);
    expect(body.exhausted[0]).toMatchObject({
      workspaceId,
      scope: 'workspace_daily_cost',
      budget: 5,
      spent: 6,
    });
    const until = new Date(body.exhausted[0]?.until as string);
    expect(until.getUTCHours()).toBe(0);
    expect(until.getTime()).toBeGreaterThan(Date.parse(body.now));
    expect(until.getTime() - Date.parse(body.now)).toBeLessThanOrEqual(24 * 3600 * 1000);

    // Raising the budget releases the workspace; an "unlimited" (JSON null) quota never lists it.
    await withWorkspace(pool, { workspaceId, principalId: ownerPrincipalId }, async (client) => {
      await client.query(
        `update quotas set value = 'null'::jsonb where workspace_id = $1 and key = 'task.daily_cost_budget_usd'`,
        [workspaceId],
      );
    });
    const released = await server.inject({
      method: 'GET',
      url: '/internal/llm-budget-exhausted',
      headers,
    });
    expect((released.json() as { exhausted: unknown[] }).exhausted).toEqual([]);
    await server.close();
  });
});
