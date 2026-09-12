import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ListEnvelope,
  PlatformWorkspaceWire,
  Role,
  UserMembershipWire,
  UserWire,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { addPrincipal } from '../../cli/bootstrap.js';
import {
  readAgentPolicy,
  readEffectiveAgentProfile,
} from '../../governance/agent-profile/index.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { createServer } from '../../index.js';
import { CONSOLE_SESSION_COOKIE, createPlatformAdmin, createUser } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { updatePlatformSettings } from '../platform/index.js';
import { getPublishedEntryDefinition } from '../worker/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { AgentProfileValidationError } from './agent-profile-handlers.js';
import { withAdminClient } from './auth.js';
import { dispatchCapability } from './dispatch.js';
import { PlatformAdminError } from './platform-handlers.js';
import type { PlatformErrorCode } from './platform-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/platform-workspaces.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL, the same `describe.runIf` pattern every other integration suite in this
 * package uses) coverage of the P-A2 `scope: 'platform'` workspace capabilities —
 * `list_workspaces` / `list_platform_models` / `create_workspace` / `update_workspace` /
 * `set_workspace_status` / `set_allowed_models` (application/gateway/platform-handlers.ts;
 * docs/platform-admin-design.md §2 "工作区配置归管理面", §5 "工作区配置").
 *
 * Structured exactly like its P-A1 sibling `platform-capabilities.integration.test.ts` — a private
 * database per file (`createIsolatedDatabase`, same reasoning: `list_workspaces` and the platform
 * audit read the whole database, so a shared one would see other files' workspaces), the bulk
 * driven through `dispatchCapability` with a `channel: 'platform'` caller, and real HTTP
 * (`createServer` + `app.inject`) only where the point of the case is *who* may reach the
 * capability or which credential still authenticates.
 *
 * Two things this file goes further on than its sibling, because they are what P-A2 actually
 * changed below the capability seam:
 *   - the *runtime* effect of a model change: `update_workspace(entryModel)` and
 *     `set_allowed_models` are asserted through `readEffectiveAgentProfile` (governance/
 *     agent-profile/resolve.ts's `resolveModel` cap), not only through the returned wire — the
 *     wire could be right while the container still resolved the old model.
 *   - the *credential* effect of disabling a workspace: the revoked `sessions` rows, the API key
 *     that stops authenticating (auth.ts's `lookupPrincipalByApiKeyHash` joins `workspaces.status`)
 *     and the membership that disappears from the console login.
 *
 * Cost note: only the two cases that need a real entry WorkerDefinition or a real owner API key
 * pay for `createWorkspaceWithOwner`'s meta-ontology seeding; every pure-configuration case runs
 * against a bare `insert into workspaces` row (`insertBareWorkspace`), the same shortcut
 * agent-profile-flow.integration.test.ts uses.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

const PASSWORD = 'correct horse battery staple';
const CSRF_HEADERS = { 'x-requested-with': 'nexttime', 'content-type': 'application/json' };

/** The two catalog models every case picks from, and one that is deliberately absent. */
const MODEL_A = 'anthropic/claude-sonnet-5';
const MODEL_B = 'anthropic/claude-haiku-5';
const MODEL_UNKNOWN = 'anthropic/claude-not-in-the-catalog';

/** `list_platform_models`'s item shape — `packages/shared`'s `ModelCatalogEntryWireSchema` is
 *  exported as a schema only, so the projection is spelled out here rather than `z.infer`red. */
interface WireModelCatalogEntry {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
}

/** Creates and migrates a database of this file's own (see the module doc comment), plus the
 *  `drop` that ends the pool and removes it again. */
async function createIsolatedDatabase(): Promise<{
  readonly pool: Pool;
  readonly drop: () => Promise<void>;
}> {
  if (DATABASE_URL === undefined) throw new Error('createIsolatedDatabase needs DATABASE_URL');
  const cluster = createPool();
  // Hex only — nothing here can be quoted-identifier trickery, and it stays under Postgres's
  // 63-byte identifier limit.
  const name = `nexttime_platform_ws_${randomUUID().replace(/-/g, '')}`;
  try {
    await cluster.query(`create database "${name}"`);
  } catch (err) {
    // Never leave the cluster pool open behind a failure (an open pool keeps the worker alive).
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
      // `with (force)` (Postgres 13+): never leave the database behind because a connection of
      // this file's own outlived the pool.
      await cluster.query(`drop database if exists "${name}" with (force)`);
      await cluster.end();
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'P-A2 platform workspace capabilities (integration, real Postgres)',
  () => {
    let pool: Pool;
    let dropDatabase: (() => Promise<void>) | undefined;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    /** The acting administrator, and the owner of the seeded (platform-default) workspace. */
    let admin: UserRow;
    let adminLogin: string;
    /** The platform default workspace — fully bootstrapped (owner Principal, meta-ontology, entry
     *  WorkerDefinition), because `list_workspaces` and the `default_workspace` guard both read it. */
    let seededWorkspaceId: string;
    /** An ordinary workspace Principal's API key — a credential that must never reach the platform
     *  plane. It lives in a bare workspace of its own so it never skews `memberCount` above. */
    let workspaceApiKey: string;
    let modelsJsonDir: string | undefined;
    const originalModelsJsonFile = process.env.MODELS_JSON_FILE;

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
      const match = new RegExp(`^${CONSOLE_SESSION_COOKIE}=([^;]*)`).exec(setCookie);
      if (!match?.[1]) throw new Error(`unexpected Set-Cookie: ${setCookie}`);
      return match[1];
    }

    async function loginAs(
      app: ReturnType<typeof createServer>,
      login: string,
      password: string,
    ): Promise<string> {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: CSRF_HEADERS,
        payload: { login, password },
      });
      if (response.statusCode !== 200) {
        throw new Error(`loginAs("${login}") failed: ${response.statusCode} ${response.body}`);
      }
      return cookieValue(setCookieHeader(response.headers));
    }

    /** The caller `resolvePlatformCaller` builds for an administrator's console session — no
     *  workspace, no Principal (application/gateway/caller.ts). */
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

    /** The caller `resolve-caller.ts` builds for a workspace member's console session — the shape
     *  agent-profile-flow.integration.test.ts already drives `set_agent_profile` with. */
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

    function callAs<T>(
      caller: ResolvedCaller,
      name: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      return dispatchCapability({ pool }, caller, name, params) as Promise<T>;
    }

    function callAsAdmin<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
      return callAs<T>(platformCaller(admin), name, params);
    }

    /** `PlatformAdminError` carries the code interfaces/http maps to 404/409 — assert the code,
     *  not the message. */
    async function expectPlatformError(
      call: () => Promise<unknown>,
      code: PlatformErrorCode,
    ): Promise<void> {
      const thrown = await call().then(
        () => {
          throw new Error(`expected PlatformAdminError("${code}"), but the call resolved`);
        },
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(PlatformAdminError);
      expect((thrown as PlatformAdminError).code).toBe(code);
    }

    /** A workspace row with nothing else — no owner Principal, no ontology, no entry definition.
     *  Everything the configuration capabilities touch (`workspaces`, `agent_policies`) exists
     *  already, and skipping the meta-ontology seed keeps these cases to milliseconds. */
    async function insertBareWorkspace(name: string): Promise<string> {
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

    async function insertHumanPrincipal(
      workspaceId: string,
      role: Role,
      displayName: string,
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', $3, $4)`,
            [workspaceId, id, role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    function inWorkspace<T>(
      workspaceId: string,
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    /** The model the runtime would actually give this principal's container — the AgentProfile
     *  resolved through `AgentPolicy.defaultModel` / `allowedModels`
     *  (governance/agent-profile/resolve.ts's `resolveModel`). */
    function effectiveModelOf(workspaceId: string, principalId: string): Promise<string> {
      return inWorkspace(workspaceId, principalId, async (client) => {
        const effective = await readEffectiveAgentProfile(client, workspaceId, principalId);
        return effective.model;
      });
    }

    async function readWorkspace(workspaceId: string): Promise<PlatformWorkspaceWire> {
      const listed = await callAsAdmin<ListEnvelope<PlatformWorkspaceWire>>('list_workspaces');
      const found = listed.items.find((item) => item.id === workspaceId);
      if (!found) throw new Error(`list_workspaces did not return workspace ${workspaceId}`);
      return found;
    }

    beforeAll(async () => {
      const isolated = await createIsolatedDatabase();
      pool = isolated.pool;
      dropDatabase = isolated.drop;
      await runMigrations(pool, MIGRATIONS_DIR);

      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;

      // `assertModelsInCatalog` (platform-handlers.ts) and `set_agent_profile`'s own model check
      // both read models.json through `readModelCatalog` — the same temp-catalog convention
      // agent-profile-flow.integration.test.ts uses, with two models so an allow-list can
      // meaningfully narrow.
      modelsJsonDir = await mkdtemp(path.join(tmpdir(), 'platform-workspaces-models-json-'));
      const modelsFile = path.join(modelsJsonDir, 'models.json');
      await writeFile(
        modelsFile,
        JSON.stringify({
          providers: {
            anthropic: {
              baseUrl: 'http://llm-proxy:8082/anthropic',
              apiKey: '$CAPABILITY_HANDLE',
              api: 'anthropic-messages',
              models: [{ id: 'claude-sonnet-5' }, { id: 'claude-haiku-5' }],
            },
          },
        }),
      );
      process.env.MODELS_JSON_FILE = modelsFile;

      adminLogin = `ws-admin-${randomUUID().slice(0, 8)}`;
      admin = await createPlatformAdmin(pool, {
        login: adminLogin,
        displayName: 'Workspace Admin',
        password: PASSWORD,
      });

      const created = await createWorkspaceWithOwner(pool, {
        name: 'platform-workspaces-test-workspace',
        owner: { userId: admin.id, displayName: 'Admin' },
        ontologyDir: ONTOLOGY_DIR,
      });
      seededWorkspaceId = created.workspaceId;

      const apiKeyWorkspaceId = await insertBareWorkspace('platform-workspaces-api-key-fixture');
      const fixture = await addPrincipal(pool, apiKeyWorkspaceId, 'API Key Fixture');
      workspaceApiKey = fixture.apiKey;
      // A fresh database plus the meta-ontology seeding of one workspace is well past Vitest's
      // 10s default hook timeout.
    }, 180_000);

    afterAll(async () => {
      if (modelsJsonDir) await rm(modelsJsonDir, { recursive: true, force: true });
      if (originalModelsJsonFile === undefined) {
        // biome-ignore lint/performance/noDelete: process.env coerces `= undefined` to the string "undefined" instead of unsetting the var; delete is the only way to make it actually absent.
        delete process.env.MODELS_JSON_FILE;
      } else {
        process.env.MODELS_JSON_FILE = originalModelsJsonFile;
      }
      await dropDatabase?.();
    }, 60_000);

    // ---- authorization -----------------------------------------------------------------------

    describe('authorization', () => {
      it('a workspace API key never reaches list_workspaces — 403', async () => {
        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/list_workspaces',
          headers: { ...CSRF_HEADERS, authorization: `Bearer ${workspaceApiKey}` },
          payload: {},
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      });
    });

    // ---- the read side -----------------------------------------------------------------------

    describe('list_workspaces', () => {
      it('lists the seeded workspace with its owner and active member count', async () => {
        const listed = await callAsAdmin<ListEnvelope<PlatformWorkspaceWire>>('list_workspaces');
        const seeded = listed.items.find((item) => item.id === seededWorkspaceId);

        expect(seeded).toBeDefined();
        expect(seeded?.name).toBe('platform-workspaces-test-workspace');
        expect(seeded?.status).toBe('active');
        expect(seeded?.owners.map((owner) => owner.login)).toContain(adminLogin);
        expect(seeded?.owners.map((owner) => owner.userId)).toContain(admin.id);
        // The bootstrapped owner is the one human membership so far.
        expect(seeded?.memberCount).toBe(1);
      });

      it('memberCount follows the human memberships add_membership creates', async () => {
        const before = await readWorkspace(seededWorkspaceId);
        const user = await createUser(pool, {
          login: `ws-counted-${randomUUID().slice(0, 8)}`,
          displayName: 'Counted Member',
        });
        await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId: seededWorkspaceId,
          role: 'member',
        });

        const after = await readWorkspace(seededWorkspaceId);
        expect(after.memberCount).toBe(before.memberCount + 1);
      });

      it('isDefault marks the workspace updatePlatformSettings points at, and only that one', async () => {
        const other = await insertBareWorkspace('platform-workspaces-not-default');

        // Before any default is configured, nothing is the default.
        expect((await readWorkspace(seededWorkspaceId)).isDefault).toBe(false);
        expect((await readWorkspace(other)).isDefault).toBe(false);

        await withAdminClient(pool, (client) =>
          updatePlatformSettings(client, { defaultWorkspaceId: seededWorkspaceId }, null),
        );

        expect((await readWorkspace(seededWorkspaceId)).isDefault).toBe(true);
        expect((await readWorkspace(other)).isDefault).toBe(false);
      });

      it('filters by status', async () => {
        const active = await callAsAdmin<ListEnvelope<PlatformWorkspaceWire>>('list_workspaces', {
          status: 'active',
        });
        expect(active.items.every((item) => item.status === 'active')).toBe(true);
        expect(active.items.map((item) => item.id)).toContain(seededWorkspaceId);
      });
    });

    describe('list_platform_models', () => {
      it('returns the llm-proxy catalog the administrator configures workspaces from', async () => {
        const listed =
          await callAsAdmin<ListEnvelope<WireModelCatalogEntry>>('list_platform_models');

        expect(listed.items.map((entry) => entry.id).sort()).toEqual([MODEL_B, MODEL_A].sort());
        expect(listed.items.every((entry) => entry.provider === 'anthropic')).toBe(true);
        expect(listed.items.find((entry) => entry.id === MODEL_A)?.model).toBe('claude-sonnet-5');
      });
    });

    // ---- create_workspace --------------------------------------------------------------------

    describe('create_workspace', () => {
      let ownerLogin: string;
      let owner: UserRow;

      beforeAll(async () => {
        ownerLogin = `ws-owner-${randomUUID().slice(0, 8)}`;
        owner = await createUser(pool, { login: ownerLogin, displayName: 'New Owner' });
      });

      it('bootstraps the workspace, its owner, its AgentPolicy and its entry WorkerDefinition', async () => {
        const name = `created-${randomUUID().slice(0, 8)}`;
        const created = await callAsAdmin<PlatformWorkspaceWire>('create_workspace', {
          name,
          ownerUserId: owner.id,
          entryModel: MODEL_A,
          allowedModels: [MODEL_A, MODEL_B],
        });

        // Phase 2's value is what the caller sees (dispatch.ts uses `afterCommit`'s result) — the
        // full `PlatformWorkspaceWire`, not the phase-1 `{workspaceId}` placeholder.
        expect(created.name).toBe(name);
        expect(created.status).toBe('active');
        expect(created.isDefault).toBe(false);
        expect(created.entryModel).toBe(MODEL_A);
        expect(created.allowedModels).toEqual([MODEL_A, MODEL_B]);
        expect(created.memberCount).toBe(1);
        expect(created.owners.map((entry) => entry.login)).toEqual([ownerLogin]);

        const ownerPrincipal = created.owners[0];
        if (!ownerPrincipal) throw new Error('create_workspace returned no owner');
        expect(ownerPrincipal.userId).toBe(owner.id);
        const principalRow = await withAdminClient(pool, (client) =>
          client.query<{ kind: string; role: string; user_id: string | null }>(
            'select kind, role, user_id from principals where workspace_id = $1 and id = $2',
            [created.id, ownerPrincipal.principalId],
          ),
        );
        expect(principalRow.rows[0]).toMatchObject({
          kind: 'human',
          role: 'owner',
          user_id: owner.id,
        });

        // The AgentPolicy is what the runtime reads (resolve.ts), so it must carry both values —
        // `workspaces.entry_model` alone would leave the container on pi's default.
        const policy = await inWorkspace(created.id, ownerPrincipal.principalId, (client) =>
          readAgentPolicy(client, created.id),
        );
        expect(policy.defaultModel).toBe(MODEL_A);
        expect(policy.allowedModels).toEqual([MODEL_A, MODEL_B]);

        const entryDefinition = await inWorkspace(
          created.id,
          ownerPrincipal.principalId,
          (client) => getPublishedEntryDefinition(client, created.id),
        );
        expect(entryDefinition).not.toBeNull();
        expect(entryDefinition?.status).toBe('published');
        expect(entryDefinition?.kind).toBe('entry');
        expect((entryDefinition?.definition as { model?: string } | undefined)?.model).toBe(
          MODEL_A,
        );

        // The audit row is written in phase 1, against the id fixed before the bootstrap ran.
        const audit = await withAdminClient(pool, (client) =>
          client.query<{ workspace_id: string | null; actor_user_id: string; resource_id: string }>(
            `select workspace_id, actor_user_id, resource_id from audit_records
              where action = 'create_workspace' and resource_id = $1`,
            [created.id],
          ),
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]?.workspace_id).toBeNull();
        expect(audit.rows[0]?.actor_user_id).toBe(admin.id);
        // The meta-ontology seed plus an entry WorkerDefinition publish is past Vitest's default.
      }, 120_000);

      it('rejects a model that is not in the llm-proxy catalog', async () => {
        await expectPlatformError(
          () =>
            callAsAdmin('create_workspace', {
              name: `unknown-model-${randomUUID().slice(0, 8)}`,
              ownerUserId: owner.id,
              entryModel: MODEL_UNKNOWN,
            }),
          'unknown_model',
        );
      });

      it('rejects an allowed list that excludes the entry model', async () => {
        await expectPlatformError(
          () =>
            callAsAdmin('create_workspace', {
              name: `bad-list-${randomUUID().slice(0, 8)}`,
              ownerUserId: owner.id,
              entryModel: MODEL_A,
              allowedModels: [MODEL_B],
            }),
          'entry_model_not_allowed',
        );
      });

      it('rejects a disabled owner', async () => {
        const disabled = await createUser(pool, {
          login: `ws-disabled-owner-${randomUUID().slice(0, 8)}`,
          displayName: 'Disabled Owner',
        });
        await callAsAdmin<UserWire>('set_user_status', {
          userId: disabled.id,
          status: 'disabled',
        });

        await expectPlatformError(
          () =>
            callAsAdmin('create_workspace', {
              name: `disabled-owner-${randomUUID().slice(0, 8)}`,
              ownerUserId: disabled.id,
            }),
          'user_disabled',
        );
      });

      it('rejects an owner that does not exist', async () => {
        await expectPlatformError(
          () =>
            callAsAdmin('create_workspace', {
              name: `no-owner-${randomUUID().slice(0, 8)}`,
              ownerUserId: randomUUID(),
            }),
          'user_not_found',
        );
      });
    });

    // ---- update_workspace --------------------------------------------------------------------

    describe('update_workspace', () => {
      let workspaceId: string;
      let memberPrincipalId: string;

      beforeAll(async () => {
        workspaceId = await insertBareWorkspace('platform-workspaces-update');
        memberPrincipalId = await insertHumanPrincipal(workspaceId, 'member', 'update member');
      });

      it('renames a workspace', async () => {
        const renamed = await callAsAdmin<PlatformWorkspaceWire>('update_workspace', {
          workspaceId,
          name: 'renamed-by-the-administrator',
        });
        expect(renamed.name).toBe('renamed-by-the-administrator');
        expect((await readWorkspace(workspaceId)).name).toBe('renamed-by-the-administrator');
      });

      it('sets the entry model on workspaces, on the AgentPolicy, and in what a member resolves', async () => {
        // A member who never picked a model resolves to nothing before an entry model exists.
        expect(await effectiveModelOf(workspaceId, memberPrincipalId)).toBe('');

        const updated = await callAsAdmin<PlatformWorkspaceWire>('update_workspace', {
          workspaceId,
          entryModel: MODEL_A,
        });
        expect(updated.entryModel).toBe(MODEL_A);

        const row = await withAdminClient(pool, (client) =>
          client.query<{ entry_model: string | null }>(
            'select entry_model from workspaces where id = $1',
            [workspaceId],
          ),
        );
        expect(row.rows[0]?.entry_model).toBe(MODEL_A);

        const policy = await inWorkspace(workspaceId, memberPrincipalId, (client) =>
          readAgentPolicy(client, workspaceId),
        );
        expect(policy.defaultModel).toBe(MODEL_A);

        // The point of mirroring into the AgentPolicy: the member's container now gets MODEL_A.
        expect(await effectiveModelOf(workspaceId, memberPrincipalId)).toBe(MODEL_A);
      });

      it('refuses an entry model outside a non-empty allowed list', async () => {
        await callAsAdmin<PlatformWorkspaceWire>('set_allowed_models', {
          workspaceId,
          allowedModels: [MODEL_A],
        });

        await expectPlatformError(
          () => callAsAdmin('update_workspace', { workspaceId, entryModel: MODEL_B }),
          'entry_model_not_allowed',
        );
        // The refused write left both stores untouched.
        expect((await readWorkspace(workspaceId)).entryModel).toBe(MODEL_A);
      });

      it('404s on a workspace that does not exist', async () => {
        await expectPlatformError(
          () => callAsAdmin('update_workspace', { workspaceId: randomUUID(), name: 'nope' }),
          'workspace_not_found',
        );
      });
    });

    // ---- set_allowed_models ------------------------------------------------------------------

    describe('set_allowed_models', () => {
      let workspaceId: string;
      let memberPrincipalId: string;

      function setOwnProfileModel(model: string | null): Promise<unknown> {
        return callAs(
          humanCaller(workspaceId, memberPrincipalId, 'member'),
          'set_agent_profile',
          model === null ? { model: null } : { model },
        );
      }

      beforeAll(async () => {
        workspaceId = await insertBareWorkspace('platform-workspaces-allowed-models');
        memberPrincipalId = await insertHumanPrincipal(workspaceId, 'member', 'models member');
      });

      it('refuses to restrict a workspace that has no entry model yet', async () => {
        // Without an entry model the cap would resolve every member to `''` — i.e. straight back
        // to pi's own default, a model the administrator just said the workspace may not use.
        await expectPlatformError(
          () => callAsAdmin('set_allowed_models', { workspaceId, allowedModels: [MODEL_A] }),
          'entry_model_not_allowed',
        );
      });

      it('narrows the list and pulls a member already on an excluded model back to the entry model', async () => {
        await callAsAdmin<PlatformWorkspaceWire>('update_workspace', {
          workspaceId,
          entryModel: MODEL_A,
        });
        // While the list is unrestricted the member may pick the other catalog model.
        await setOwnProfileModel(MODEL_B);
        expect(await effectiveModelOf(workspaceId, memberPrincipalId)).toBe(MODEL_B);

        const narrowed = await callAsAdmin<PlatformWorkspaceWire>('set_allowed_models', {
          workspaceId,
          allowedModels: [MODEL_A],
        });
        expect(narrowed.allowedModels).toEqual([MODEL_A]);
        expect(narrowed.entryModel).toBe(MODEL_A);

        // The profile row still says MODEL_B; the *cap* is what the runtime resolves through.
        expect(await effectiveModelOf(workspaceId, memberPrincipalId)).toBe(MODEL_A);
      });

      it('makes set_agent_profile reject a model outside the list', async () => {
        const thrown = await setOwnProfileModel(MODEL_B).then(
          () => {
            throw new Error('expected set_agent_profile to reject a model outside allowedModels');
          },
          (err: unknown) => err,
        );
        expect(thrown).toBeInstanceOf(AgentProfileValidationError);
        expect((thrown as Error).message).toMatch(/allowedModels/);
      });

      it('an empty list is unrestricted again', async () => {
        const cleared = await callAsAdmin<PlatformWorkspaceWire>('set_allowed_models', {
          workspaceId,
          allowedModels: [],
        });
        expect(cleared.allowedModels).toEqual([]);

        await setOwnProfileModel(MODEL_B);
        expect(await effectiveModelOf(workspaceId, memberPrincipalId)).toBe(MODEL_B);
      });

      it('rejects a model that is not in the llm-proxy catalog', async () => {
        await expectPlatformError(
          () => callAsAdmin('set_allowed_models', { workspaceId, allowedModels: [MODEL_UNKNOWN] }),
          'unknown_model',
        );
      });
    });

    // ---- set_workspace_status ----------------------------------------------------------------

    describe('set_workspace_status', () => {
      let workspaceId: string;
      let ownerApiKey: string;
      let ownerPrincipalId: string;
      let memberLogin: string;
      let member: UserRow;
      let sessionId: string;

      beforeAll(async () => {
        const ownerUser = await createUser(pool, {
          login: `ws-status-owner-${randomUUID().slice(0, 8)}`,
          displayName: 'Status Owner',
        });
        // The one case that needs a real owner API key, so it pays for the full bootstrap.
        const created = await createWorkspaceWithOwner(pool, {
          name: `status-${randomUUID().slice(0, 8)}`,
          owner: { userId: ownerUser.id, displayName: 'Status Owner', issueApiKey: true },
          ontologyDir: ONTOLOGY_DIR,
        });
        workspaceId = created.workspaceId;
        ownerPrincipalId = created.ownerPrincipalId;
        if (!created.apiKey) throw new Error('issueApiKey: true did not return an API key');
        ownerApiKey = created.apiKey;

        memberLogin = `ws-status-member-${randomUUID().slice(0, 8)}`;
        member = await createUser(pool, {
          login: memberLogin,
          displayName: 'Status Member',
          password: PASSWORD,
        });
        await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: member.id,
          workspaceId,
          role: 'member',
        });

        // An active session of the kind disabling must revoke (design §5: "entry, Worker, MCP,
        // service" — the column set is the same for all of them).
        sessionId = await inWorkspace(workspaceId, ownerPrincipalId, async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'entry', $2, 'active') returning id`,
            [workspaceId, ownerPrincipalId],
          );
          const id = result.rows[0]?.id;
          if (!id) throw new Error('failed to insert the fixture session');
          return id;
        });
      }, 120_000);

      function callWithOwnerApiKey(app: ReturnType<typeof createServer>) {
        return app.inject({
          method: 'POST',
          url: '/api/cap/get_workspace',
          headers: { ...CSRF_HEADERS, authorization: `Bearer ${ownerApiKey}` },
          payload: {},
        });
      }

      it('refuses to disable the platform default workspace', async () => {
        await expectPlatformError(
          () =>
            callAsAdmin('set_workspace_status', {
              workspaceId: seededWorkspaceId,
              status: 'disabled',
            }),
          'default_workspace',
        );
        expect((await readWorkspace(seededWorkspaceId)).status).toBe('active');
      });

      it('disabling closes every channel into the workspace and re-enabling reopens them', async () => {
        const app = appWithKeys();

        // Before: the owner's API key works and the member's login sees the membership.
        expect((await callWithOwnerApiKey(app)).statusCode).toBe(200);
        const cookie = await loginAs(app, memberLogin, PASSWORD);
        const meBefore = await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
        });
        expect(meBefore.statusCode).toBe(200);
        expect(
          (meBefore.json().result.memberships as { workspaceId: string }[]).map(
            (m) => m.workspaceId,
          ),
        ).toContain(workspaceId);

        // The `afterCommit` container stop is best-effort and a no-op with no task runtime
        // configured (`getConfiguredTaskRuntime` throws and `stopEntryContainers` returns) — the
        // capability must still resolve.
        const disabled = await callAsAdmin<PlatformWorkspaceWire>('set_workspace_status', {
          workspaceId,
          status: 'disabled',
        });
        expect(disabled.status).toBe('disabled');

        const sessions = await withAdminClient(pool, (client) =>
          client.query<{ status: string }>('select status from sessions where id = $1', [
            sessionId,
          ]),
        );
        expect(sessions.rows[0]?.status).toBe('revoked');

        // auth.ts's `lookupPrincipalByApiKeyHash` now joins `workspaces.status`.
        expect((await callWithOwnerApiKey(app)).statusCode).toBe(401);

        const meAfter = await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
        });
        expect(meAfter.statusCode).toBe(200);
        expect(
          (meAfter.json().result.memberships as { workspaceId: string }[]).map(
            (m) => m.workspaceId,
          ),
        ).not.toContain(workspaceId);

        // The administrator's own directory still shows the membership, marked disabled.
        const users = await callAsAdmin<ListEnvelope<UserWire>>('list_users', {
          query: memberLogin,
        });
        const listedMember = users.items.find((user) => user.id === member.id);
        expect(
          listedMember?.memberships.find((m) => m.workspaceId === workspaceId)?.workspaceStatus,
        ).toBe('disabled');

        const reEnabled = await callAsAdmin<PlatformWorkspaceWire>('set_workspace_status', {
          workspaceId,
          status: 'active',
        });
        expect(reEnabled.status).toBe('active');
        expect((await callWithOwnerApiKey(app)).statusCode).toBe(200);
        // Two password verifies (scrypt) plus the HTTP round-trips above.
      }, 60_000);
    });
  },
);
