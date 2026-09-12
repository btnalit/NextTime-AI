import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateHostTokenWire, GateInstanceWire, Operation, Role } from '@nexttime/shared';
import { internalAuthorizationHeader, verifyGateHostToken } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { createServer } from '../../index.js';
import { createPlatformAdmin } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { dispatchCapability } from './dispatch.js';
import { GateInstanceNotAvailableError } from './gate-instance-handlers.js';
import { PlatformAdminError } from './platform-handlers.js';
import type { PlatformErrorCode } from './platform-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/platform-gate-host.integration.test: DB-gated coverage of P-B2a (docs/
 * platform-admin-design.md §6.3 "通用门宿主"; development-tasks.md P-B 决定 ⑥–⑬) — the
 * administrator-created gate-host instance lifecycle: create/delete, the internal
 * `/internal/gate-host/instances` pull route, the freeze-exemption on a hosted instance's first
 * announcement, `enable_gate_instance`'s `gate_not_ready` refusal, and both `issue_gate_host_token`
 * (platform, shared slot) and `issue_gate_credential_token` (workspace, connected_account slot).
 *
 * A sibling of platform-gates.integration.test.ts rather than an addition to it (per task
 * instructions) — copies that file's minimal DB/server/caller scaffolding instead of extending its
 * already-large fixture. Private database per file, same reasons.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');
const INTERNAL_TOKEN = 'p-b2a-internal-token-0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';

const HOSTED_OBSERVE_OP: Operation = {
  name: 'list_widgets',
  binding: { kind: 'mcp', tool_name: 'list_widgets' },
  params_schema: { type: 'object', properties: {} },
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
  read_only_hint: true,
};
const HOSTED_EXECUTE_OP: Operation = {
  name: 'restart_widget',
  binding: { kind: 'mcp', tool_name: 'restart_widget' },
  params_schema: { type: 'object', properties: {} },
  mode: 'execute',
  blast_radius: 'medium',
  reversibility: false,
  auto_approvable: true,
  await_decision: true,
  reads: [],
  writes: [],
  destructive_hint: false,
  idempotent_hint: true,
};

async function createIsolatedDatabase(): Promise<{ pool: Pool; drop: () => Promise<void> }> {
  if (DATABASE_URL === undefined) throw new Error('createIsolatedDatabase needs DATABASE_URL');
  const cluster = createPool();
  const name = `nexttime_platform_gate_host_${randomUUID().replace(/-/g, '')}`;
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
      await cluster.query(`drop database if exists "${name}" with (force)`);
      await cluster.end();
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'P-B2a gate-host instances (integration, real Postgres)',
  () => {
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
    function callAsOwner<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
      return dispatchCapability(
        { pool },
        humanCaller(ownerPrincipalId, 'owner'),
        name,
        params,
      ) as Promise<T>;
    }

    async function expectPlatformError(call: () => Promise<unknown>, code: PlatformErrorCode) {
      const thrown = await call().then(
        () => {
          throw new Error(`expected PlatformAdminError("${code}"), but the call resolved`);
        },
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(PlatformAdminError);
      expect((thrown as PlatformAdminError).code).toBe(code);
    }

    async function expectNotAvailable(
      call: () => Promise<unknown>,
      code: GateInstanceNotAvailableError['code'],
    ) {
      const thrown = await call().then(
        () => {
          throw new Error(
            `expected GateInstanceNotAvailableError("${code}"), but the call resolved`,
          );
        },
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(GateInstanceNotAvailableError);
      expect((thrown as GateInstanceNotAvailableError).code).toBe(code);
    }

    async function announce(body: Record<string, unknown>) {
      const server = app();
      return server.inject({
        method: 'POST',
        url: '/internal/gates/announce',
        headers: {
          'content-type': 'application/json',
          authorization: internalAuthorizationHeader(INTERNAL_TOKEN),
        },
        payload: body,
      });
    }

    function hostedAnnounceBody(gateId: string, endpoint: string) {
      return {
        gateId,
        connector: 'mcp',
        transportKind: 'mcp',
        target: 'http://mcp.internal.test/',
        endpoint,
        operations: [HOSTED_OBSERVE_OP, HOSTED_EXECUTE_OP],
      };
    }

    const PACKAGED_GATE_ID = 'fixture-b2a-packaged';
    const packagedAnnounceBody = {
      gateId: PACKAGED_GATE_ID,
      connector: 'fixture-b2a-mcp',
      transportKind: 'mcp',
      target: 'http://fixture-b2a:9000',
      endpoint: 'http://127.0.0.1:1',
      displayName: 'Fixture B2a Packaged',
      operations: [HOSTED_OBSERVE_OP, HOSTED_EXECUTE_OP],
    };

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
        login: `gate-host-admin-${randomUUID().slice(0, 8)}`,
        displayName: 'Gate Host Admin',
        password: PASSWORD,
      });
      const created = await createWorkspaceWithOwner(pool, {
        name: 'platform-gate-host-test-workspace',
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

    it('a. create_gate_instance lands enabled/unknown/no-heartbeat; a second create with the same id is refused', async () => {
      const created = await callAsAdmin<GateInstanceWire>('create_gate_instance', {
        gateId: 'hosted-mcp',
        transportKind: 'mcp',
        target: 'http://mcp.internal.test/',
        credentialMode: 'shared',
      });
      expect(created).toMatchObject({
        gateId: 'hosted-mcp',
        hosted: true,
        status: 'discovered',
        health: 'unknown',
        lastSeenAt: null,
        endpoint: '',
      });
      // Review finding: the administrator enables after the host has spoken (parity with packaged
      // gates); enabling early is allowed and keeps the freeze exemption meaningful.
      const enabledEarly = await callAsAdmin<GateInstanceWire>('update_gate_instance', {
        gateId: 'hosted-mcp',
        status: 'enabled',
      });
      expect(enabledEarly.status).toBe('enabled');
      expect(created.definition).toMatchObject({
        transportKind: 'mcp',
        target: 'http://mcp.internal.test/',
        credentialMode: 'shared',
        manifestSource: null,
      });

      await expectPlatformError(
        () =>
          callAsAdmin('create_gate_instance', {
            gateId: 'hosted-mcp',
            transportKind: 'mcp',
            target: 'http://mcp.internal.test/',
            credentialMode: 'shared',
          }),
        'gate_id_taken',
      );
    });

    it('b. GET /internal/gate-host/instances requires the internal token and lists only hosted definitions', async () => {
      // A packaged (announced) instance must not appear in the host's pull list.
      const packagedResp = await announce(packagedAnnounceBody);
      expect(packagedResp.statusCode).toBe(200);

      const server = app();
      const noToken = await server.inject({ method: 'GET', url: '/internal/gate-host/instances' });
      expect(noToken.statusCode).toBe(401);

      const withToken = await server.inject({
        method: 'GET',
        url: '/internal/gate-host/instances',
        headers: { authorization: internalAuthorizationHeader(INTERNAL_TOKEN) },
      });
      expect(withToken.statusCode).toBe(200);
      const items = withToken.json().result.items as Array<{ gateId: string; definition: unknown }>;
      const hostedItem = items.find((i) => i.gateId === 'hosted-mcp');
      expect(hostedItem).toMatchObject({
        gateId: 'hosted-mcp',
        definition: {
          transportKind: 'mcp',
          target: 'http://mcp.internal.test/',
          credentialMode: 'shared',
          manifestSource: null,
        },
      });
      expect(items.find((i) => i.gateId === PACKAGED_GATE_ID)).toBeUndefined();
    });

    it('c. enable_gate_instance refuses gate_not_ready once mcp is preset (still refuses cli)', async () => {
      await expectPlatformError(
        () => callAsAdmin('set_connector_mode', { name: 'cli', mode: 'platform_preset' }),
        'connector_mode_not_allowed',
      );
      const mcpConnector = await callAsAdmin<{ mode: string }>('set_connector_mode', {
        name: 'mcp',
        mode: 'platform_preset',
      });
      expect(mcpConnector.mode).toBe('platform_preset');

      await expectNotAvailable(
        () => callAsOwner('enable_gate_instance', { gateId: 'hosted-mcp' }),
        'gate_not_ready',
      );
    });

    it('d. the first announce fills identity in (freeze exemption); a later mismatched endpoint is frozen out', async () => {
      // A first announce whose kind / connector contradict the administrator's definition is refused
      // outright (nothing written) — only the endpoint is the host's to fill in.
      const wrongKind = await announce({
        ...hostedAnnounceBody('hosted-mcp', 'http://gate-host:8083/i/hosted-mcp'),
        connector: 'http',
        transportKind: 'http',
      });
      expect(wrongKind.statusCode).toBe(409);
      expect(wrongKind.json().error.code).toBe('identity_mismatch');
      const untouched = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: 'hosted-mcp',
      });
      expect(untouched.lastSeenAt).toBeNull();
      expect(untouched.endpoint).toBe('');

      const first = await announce(
        hostedAnnounceBody('hosted-mcp', 'http://gate-host:8083/i/hosted-mcp'),
      );
      expect(first.statusCode).toBe(200);

      const afterFirst = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: 'hosted-mcp',
      });
      expect(afterFirst.lastSeenAt).not.toBeNull();
      expect(afterFirst.endpoint).toBe('http://gate-host:8083/i/hosted-mcp');
      expect(afterFirst.status).toBe('enabled');
      expect(afterFirst.health).toBe('ok');

      const second = await announce(
        hostedAnnounceBody('hosted-mcp', 'http://gate-host:9999/i/hosted-mcp'),
      );
      expect(second.statusCode).toBe(200);
      const afterSecond = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: 'hosted-mcp',
      });
      expect(afterSecond.endpoint).toBe('http://gate-host:8083/i/hosted-mcp');
      expect(afterSecond.health).toBe('unknown');
    });

    it('e. enable_gate_instance now succeeds and publishes both operations', async () => {
      const enabled = await callAsOwner<{
        gatekeeperId: string;
        publishedOperationNames: string[];
      }>('enable_gate_instance', { gateId: 'hosted-mcp' });
      expect(enabled.publishedOperationNames.sort()).toEqual(['list_widgets', 'restart_widget']);
    });

    it('f. issue_gate_host_token mints a shared-slot token; mismatched mode / non-hosted are refused', async () => {
      const minted = await callAsAdmin<GateHostTokenWire>('issue_gate_host_token', {
        gateId: 'hosted-mcp',
      });
      expect(minted).toMatchObject({
        gateId: 'hosted-mcp',
        url: '/gate-host/i/hosted-mcp/gate/connected-accounts',
        onBehalfOf: '__shared__',
        credentialMode: 'shared',
      });
      expect(minted.token.length).toBeGreaterThan(20);
      const claims = await verifyGateHostToken(minted.token, publicKey, {
        expectedGateId: 'hosted-mcp',
      });
      expect(claims).toMatchObject({ gate: 'hosted-mcp', obo: '__shared__' });

      await callAsAdmin('create_gate_instance', {
        gateId: 'hosted-mcp-ca',
        transportKind: 'mcp',
        target: 'http://mcp.internal.test/',
        credentialMode: 'connected_account',
      });
      await expectPlatformError(
        () => callAsAdmin('issue_gate_host_token', { gateId: 'hosted-mcp-ca' }),
        'credential_mode_mismatch',
      );

      await expectPlatformError(
        () => callAsAdmin('issue_gate_host_token', { gateId: PACKAGED_GATE_ID }),
        'gate_not_hosted',
      );
    });

    it('g. issue_gate_credential_token (workspace, member channel): obo is the caller, refused when not linked', async () => {
      await expectNotAvailable(
        () => callAsOwner('issue_gate_credential_token', { gateId: 'hosted-mcp-ca' }),
        'gate_not_linked',
      );

      const announced = await announce(
        hostedAnnounceBody('hosted-mcp-ca', 'http://gate-host:8083/i/hosted-mcp-ca'),
      );
      expect(announced.statusCode).toBe(200);
      await callAsOwner('enable_gate_instance', { gateId: 'hosted-mcp-ca' });

      const minted = await callAsOwner<GateHostTokenWire>('issue_gate_credential_token', {
        gateId: 'hosted-mcp-ca',
      });
      expect(minted).toMatchObject({
        gateId: 'hosted-mcp-ca',
        url: '/gate-host/i/hosted-mcp-ca/gate/connected-accounts',
        onBehalfOf: ownerPrincipalId,
        credentialMode: 'connected_account',
      });
      const claims = await verifyGateHostToken(minted.token, publicKey, {
        expectedGateId: 'hosted-mcp-ca',
      });
      expect(claims.obo).toBe(ownerPrincipalId);
    });

    it('h. delete_gate_instance: in_use while linked, not_hosted for a packaged gate, deleted when unlinked', async () => {
      await expectPlatformError(
        () => callAsAdmin('delete_gate_instance', { gateId: 'hosted-mcp' }),
        'gate_in_use',
      );
      await expectPlatformError(
        () => callAsAdmin('delete_gate_instance', { gateId: PACKAGED_GATE_ID }),
        'gate_not_hosted',
      );

      await callAsAdmin('create_gate_instance', {
        gateId: 'hosted-mcp-unlinked',
        transportKind: 'mcp',
        target: 'http://mcp.internal.test/',
        credentialMode: 'shared',
      });
      const deleted = await callAsAdmin<{ gateId: string; deleted: boolean }>(
        'delete_gate_instance',
        { gateId: 'hosted-mcp-unlinked' },
      );
      expect(deleted).toEqual({ gateId: 'hosted-mcp-unlinked', deleted: true });
      await expectPlatformError(
        () => callAsAdmin('get_gate_instance', { gateId: 'hosted-mcp-unlinked' }),
        'gate_not_found',
      );
    });
  },
);
