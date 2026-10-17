import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConnectorWire,
  GateHostTokenWire,
  GateInstanceWire,
  Operation,
  Role,
} from '@nexttime/shared';
import { internalAuthorizationHeader, verifyGateHostToken } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { ConnectionParamsCarryCredentialsError } from '../../governance/connections/index.js';
import { createServer } from '../../index.js';
import { deriveInternalCredential } from '../../interfaces/internal-auth/index.js';
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
/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

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

/** Polls `pg_stat_activity` until no backend is connected to `name` (bounded to ~1s). `pool.end()`
 *  resolves once pg-pool has *scheduled* each idle client's `end()`, not once the sockets are
 *  closed, so without this wait the `drop database … with (force)` below can terminate a backend
 *  of this file's own mid-shutdown; the resulting FATAL 57P01 then surfaces on the pool's 'error'
 *  event (CI run 35079054627 on main). Falls through to the caller's `with (force)` if a
 *  connection really did outlive the pool. */
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
      await waitForNoConnections(cluster, name);
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

    /** Announces as the gate host by default; `'gate'` for a packaged gate (R-03 review: each
     *  class may announce only its own kind of instance). */
    async function announce(
      body: Record<string, unknown>,
      caller: 'gate' | 'gate-host' = 'gate-host',
    ) {
      const server = app();
      return server.inject({
        method: 'POST',
        url: '/internal/gates/announce',
        headers: {
          'content-type': 'application/json',
          authorization: internalAuthorizationHeader(
            deriveInternalCredential(INTERNAL_TOKEN, caller),
          ),
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
        // P1: no `connector` given — the generic connector of its kind, as before.
        connector: 'mcp',
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
      const packagedResp = await announce(packagedAnnounceBody, 'gate');
      expect(packagedResp.statusCode).toBe(200);

      const server = app();
      const noToken = await server.inject({ method: 'GET', url: '/internal/gate-host/instances' });
      expect(noToken.statusCode).toBe(401);

      const withToken = await server.inject({
        method: 'GET',
        url: '/internal/gate-host/instances',
        headers: {
          authorization: internalAuthorizationHeader(
            deriveInternalCredential(INTERNAL_TOKEN, 'gate-host'),
          ),
        },
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
      // R-18 (D-18): the administrator enabled it before seeing any Operation, so its first
      // manifest is held for confirmation rather than taking effect unseen.
      expect(afterFirst.operationCount).toBe(0);
      expect(afterFirst.pendingManifest?.added.map((op) => op.name).sort()).toEqual([
        'list_widgets',
        'restart_widget',
      ]);

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
      await expectNotAvailable(
        () => callAsOwner('enable_gate_instance', { gateId: 'hosted-mcp' }),
        'gate_not_ready',
      );
      const held = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: 'hosted-mcp',
      });
      const confirmed = await callAsAdmin<GateInstanceWire>('confirm_gate_manifest', {
        gateId: 'hosted-mcp',
        digest: held.pendingManifest?.digest,
      });
      expect(confirmed.operationCount).toBe(2);
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
      await callAsAdmin('update_gate_instance', { gateId: 'hosted-mcp-ca', status: 'enabled' });
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
      // Enabled before its host spoke (f), so the first manifest waits for confirmation (R-18).
      const held = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: 'hosted-mcp-ca',
      });
      await callAsAdmin('confirm_gate_manifest', {
        gateId: 'hosted-mcp-ca',
        digest: held.pendingManifest?.digest,
      });
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

    it('i. R-03 review (D-02): a packaged gate cannot announce a gate-host instance — unseen, seen-undecided or enabled — and nothing is written', async () => {
      await callAsAdmin('create_gate_instance', {
        gateId: 'hosted-mcp-r03',
        transportKind: 'mcp',
        target: 'http://mcp.internal.test/',
        credentialMode: 'shared',
      });

      // Unseen: the first announcement fills the identity in, endpoint included.
      const unseen = await announce(
        hostedAnnounceBody('hosted-mcp-r03', 'http://impostor:9999/i/hosted-mcp-r03'),
        'gate',
      );
      expect(unseen.statusCode).toBe(403);
      expect(unseen.json().error.code).toBe('forbidden');
      const untouched = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: 'hosted-mcp-r03',
      });
      expect(untouched.lastSeenAt).toBeNull();
      expect(untouched.endpoint).toBe('');

      // The host's own announcement still lands.
      const first = await announce(
        hostedAnnounceBody('hosted-mcp-r03', 'http://gate-host:8083/i/hosted-mcp-r03'),
      );
      expect(first.statusCode).toBe(200);
      const seen = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: 'hosted-mcp-r03',
      });
      expect(seen.status).toBe('discovered');
      expect(seen.endpoint).toBe('http://gate-host:8083/i/hosted-mcp-r03');

      // Seen but undecided (not frozen) and enabled (frozen): a packaged gate could otherwise
      // redefine the first outright and rewrite the second's manifest.
      for (const gateId of ['hosted-mcp-r03', 'hosted-mcp']) {
        const before = await callAsAdmin<GateInstanceWire>('get_gate_instance', { gateId });
        const crossed = await announce(
          {
            ...hostedAnnounceBody(gateId, `http://impostor:9999/i/${gateId}`),
            target: 'http://impostor.test/',
            operations: [HOSTED_OBSERVE_OP],
          },
          'gate',
        );
        expect(crossed.statusCode, gateId).toBe(403);
        const after = await callAsAdmin<GateInstanceWire>('get_gate_instance', { gateId });
        expect(after.endpoint, gateId).toBe(before.endpoint);
        expect(after.target, gateId).toBe(before.target);
        expect(after.operations, gateId).toEqual(before.operations);
        expect(after.lastSeenAt, gateId).toBe(before.lastSeenAt);
        expect(after.health, gateId).toBe(before.health);
      }
    });

    it('j. R-03 review (D-02): the gate host cannot announce a packaged instance, nor create one', async () => {
      const before = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: PACKAGED_GATE_ID,
      });
      const crossed = await announce({
        ...packagedAnnounceBody,
        endpoint: 'http://impostor:9999',
        operations: [HOSTED_OBSERVE_OP],
      });
      expect(crossed.statusCode).toBe(403);
      expect(crossed.json().error.code).toBe('forbidden');
      const after = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: PACKAGED_GATE_ID,
      });
      expect(after.endpoint).toBe(before.endpoint);
      expect(after.operations).toEqual(before.operations);
      expect(after.lastSeenAt).toBe(before.lastSeenAt);

      const fresh = await announce({ ...packagedAnnounceBody, gateId: 'fixture-b2a-unknown' });
      expect(fresh.statusCode).toBe(403);
      await expectPlatformError(
        () => callAsAdmin('get_gate_instance', { gateId: 'fixture-b2a-unknown' }),
        'gate_not_found',
      );

      // The packaged gate's own heartbeat still lands.
      const own = await announce(packagedAnnounceBody, 'gate');
      expect(own.statusCode).toBe(200);
    });

    // Review of #549 (legacy 186, gate-instance half): no address of a gate instance is written
    // with a credential in it — create, announce, and the copy enable makes into a workspace.
    it.each([
      [
        'a password in the target',
        { transportKind: 'mcp', target: `https://ops:${FAKE}@mcp.example.invalid/mcp` },
        'target',
      ],
      [
        'a token in the target',
        { transportKind: 'mcp', target: `https://mcp.example.invalid/mcp?token=${FAKE}` },
        'target',
      ],
      [
        'a key in the manifest source',
        {
          transportKind: 'http',
          target: 'https://billing.example.invalid',
          manifestSource: `https://billing.example.invalid/openapi.json?api_key=${FAKE}`,
        },
        'manifestSource',
      ],
      [
        'a password in the manifest source',
        {
          transportKind: 'http',
          target: 'https://billing.example.invalid',
          manifestSource: `https://ops:${FAKE}@billing.example.invalid/openapi.json`,
        },
        'manifestSource',
      ],
    ])(
      'k. create_gate_instance refuses %s, naming the field, and stores nothing',
      async (_name, params, field) => {
        const gateId = `refused-${randomUUID().slice(0, 8)}`;
        const thrown = await callAsAdmin('create_gate_instance', {
          gateId,
          credentialMode: 'shared',
          ...params,
        }).then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(thrown).toBeInstanceOf(ConnectionParamsCarryCredentialsError);
        expect(thrown).toMatchObject({
          code: 'credentials_in_connection_params',
          details: { field },
        });
        expect((thrown as Error).message).not.toContain(FAKE);
        await expectPlatformError(
          () => callAsAdmin('get_gate_instance', { gateId }),
          'gate_not_found',
        );
      },
    );

    it('k2. create_gate_instance keeps a manifest source with a plain query', async () => {
      const created = await callAsAdmin<GateInstanceWire>('create_gate_instance', {
        gateId: 'plain-query-manifest',
        transportKind: 'http',
        target: 'https://billing.example.invalid',
        manifestSource: 'https://billing.example.invalid/openapi.json?version=3',
        credentialMode: 'shared',
      });
      expect(created.definition?.manifestSource).toBe(
        'https://billing.example.invalid/openapi.json?version=3',
      );
    });

    it('l. an announced target or endpoint carrying a credential is refused, unless the instance already holds exactly that value', async () => {
      const refusedNew = await announce(
        {
          ...packagedAnnounceBody,
          gateId: 'fixture-cred-target',
          target: `https://ops:${FAKE}@fixture-b2a:9000`,
        },
        'gate',
      );
      expect(refusedNew.statusCode).toBe(400);
      expect(refusedNew.json().error).toMatchObject({
        code: 'credentials_in_connection_params',
        details: { field: 'target' },
      });
      expect(refusedNew.body).not.toContain(FAKE);
      await expectPlatformError(
        () => callAsAdmin('get_gate_instance', { gateId: 'fixture-cred-target' }),
        'gate_not_found',
      );

      const refusedEndpoint = await announce(
        {
          ...packagedAnnounceBody,
          gateId: 'fixture-cred-endpoint',
          endpoint: `http://fixture-b2a:9000/?token=${FAKE}`,
        },
        'gate',
      );
      expect(refusedEndpoint.statusCode).toBe(400);
      expect(refusedEndpoint.json().error.details).toEqual({ field: 'endpoint' });

      // A running gate whose announced target changes to one carrying a credential: refused, the
      // row (and its heartbeat) untouched.
      const before = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: PACKAGED_GATE_ID,
      });
      const changed = await announce(
        { ...packagedAnnounceBody, target: `http://fixture-b2a:9000/?token=${FAKE}` },
        'gate',
      );
      expect(changed.statusCode).toBe(400);
      const unchanged = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
        gateId: PACKAGED_GATE_ID,
      });
      expect(unchanged.target).toBe(before.target);
      expect(unchanged.lastSeenAt).toBe(before.lastSeenAt);

      // Stored before the rule: the same value keeps announcing (counted by scrub-raw-secrets).
      const legacyTarget = `https://ops:${FAKE}@fixture-b2a:9000`;
      await pool.query('update gate_instances set target = $2 where gate_id = $1', [
        PACKAGED_GATE_ID,
        legacyTarget,
      ]);
      try {
        const heartbeat = await announce({ ...packagedAnnounceBody, target: legacyTarget }, 'gate');
        expect(heartbeat.statusCode).toBe(200);
      } finally {
        await pool.query('update gate_instances set target = $2 where gate_id = $1', [
          PACKAGED_GATE_ID,
          packagedAnnounceBody.target,
        ]);
      }
    });

    it('m. enable_gate_instance refuses an instance stored with a credential in its target, writing nothing into the workspace', async () => {
      const gateId = 'fixture-legacy-cred';
      const endpoint = 'http://127.0.0.1:2';
      await pool.query(
        `insert into gate_instances
           (gate_id, connector, display_name, transport_kind, target, endpoint, operations, status,
            health, last_seen_at, updated_at)
         values ($1, 'mcp', $1, 'mcp', $2, $3, $4::jsonb, 'enabled', 'ok', now(), now())`,
        [
          gateId,
          `https://mcp.example.invalid/mcp?token=${FAKE}`,
          endpoint,
          JSON.stringify([HOSTED_OBSERVE_OP]),
        ],
      );
      const thrown = await callAsOwner('enable_gate_instance', { gateId }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(ConnectionParamsCarryCredentialsError);
      expect(thrown).toMatchObject({ details: { field: 'target' } });
      expect((thrown as Error).message).not.toContain(FAKE);
      const links = await pool.query(
        'select count(*)::int as n from workspace_gate_links where gate_id = $1',
        [gateId],
      );
      expect(links.rows[0].n).toBe(0);
      const gatekeepers = await pool.query(
        `select count(*)::int as n from objects
          where workspace_id = $1 and object_type = 'Gatekeeper' and properties ->> 'endpoint' = $2`,
        [workspaceId, endpoint],
      );
      expect(gatekeepers.rows[0].n).toBe(0);
    });

    it('n. P1: an instance named after its system gets its own connector — in the catalog once enabled, the generic one untouched', async () => {
      // Test c put the generic `mcp` connector in the catalog; back to the default, so this test
      // can show that it stays there.
      await callAsAdmin('set_connector_mode', { name: 'mcp', mode: 'self_serve' });
      const definition = {
        transportKind: 'mcp',
        target: 'http://widgets.internal.test/',
        credentialMode: 'shared',
      };

      const created = await callAsAdmin<GateInstanceWire>('create_gate_instance', {
        gateId: 'p1-widgets-a',
        connector: 'widgets',
        ...definition,
      });
      expect(created).toMatchObject({ gateId: 'p1-widgets-a', connector: 'widgets' });
      const connectors = await callAsAdmin<{ items: ConnectorWire[] }>('list_connectors');
      expect(connectors.items.find((row) => row.name === 'widgets')).toMatchObject({
        kind: 'mcp',
        packaged: false,
        mode: 'platform_preset',
        instanceCount: 1,
        selfConnectionCount: 0,
      });

      // The host announces what it pulls: the connector comes along, and a first announce under
      // another connector (a gate host older than P1 sends the generic kind) is refused.
      const server = app();
      const pulled = await server.inject({
        method: 'GET',
        url: '/internal/gate-host/instances',
        headers: {
          authorization: internalAuthorizationHeader(
            deriveInternalCredential(INTERNAL_TOKEN, 'gate-host'),
          ),
        },
      });
      expect(
        (pulled.json().result.items as Array<{ gateId: string; connector: string }>).find(
          (item) => item.gateId === 'p1-widgets-a',
        ),
      ).toMatchObject({ connector: 'widgets' });
      const endpoint = 'http://gate-host:8083/i/p1-widgets-a';
      const generic = await announce(hostedAnnounceBody('p1-widgets-a', endpoint));
      expect(generic.statusCode).toBe(409);
      expect(generic.json().error.code).toBe('identity_mismatch');
      const announced = await announce({
        ...hostedAnnounceBody('p1-widgets-a', endpoint),
        connector: 'widgets',
      });
      expect(announced.statusCode).toBe(200);

      await callAsAdmin('update_gate_instance', { gateId: 'p1-widgets-a', status: 'enabled' });
      const enabled = await callAsOwner<{ publishedOperationNames: string[] }>(
        'enable_gate_instance',
        { gateId: 'p1-widgets-a' },
      );
      expect(enabled.publishedOperationNames.sort()).toEqual(['list_widgets', 'restart_widget']);
      const mcp = await callAsAdmin<{ items: ConnectorWire[] }>('list_connectors');
      expect(mcp.items.find((row) => row.name === 'mcp')?.mode).toBe('self_serve');

      // A second instance of the same system joins the connector.
      const second = await callAsAdmin<GateInstanceWire>('create_gate_instance', {
        gateId: 'p1-widgets-b',
        connector: 'widgets',
        ...definition,
      });
      expect(second.connector).toBe('widgets');
      const after = await callAsAdmin<{ items: ConnectorWire[] }>('list_connectors');
      expect(after.items.find((row) => row.name === 'widgets')?.instanceCount).toBe(2);

      // The connector's creation has an audit row of its own (it starts preset with no
      // `set_connector_mode` row), written once — by the first create, not the joining one.
      const audits = await pool.query<{
        actor_user_id: string | null;
        resource_type: string;
        payload: Record<string, unknown>;
      }>(
        `select actor_user_id, resource_type, payload from audit_records
          where action = 'connector.created' and payload ->> 'resourceRef' = 'widgets'`,
      );
      expect(audits.rows).toEqual([
        {
          actor_user_id: admin.id,
          resource_type: 'connector',
          payload: {
            resourceRef: 'widgets',
            kind: 'mcp',
            mode: 'platform_preset',
            gateId: 'p1-widgets-a',
          },
        },
      ]);
    });

    it('o. P1: create_gate_instance refuses a connector of another kind or a packaged gate’s, and a refused create leaves no connector behind', async () => {
      const mcpInstance = {
        transportKind: 'mcp',
        target: 'http://widgets.internal.test/',
        credentialMode: 'shared',
      };
      // A generic name other than the instance's own kind.
      await expectPlatformError(
        () =>
          callAsAdmin('create_gate_instance', {
            gateId: 'p1-refused-generic',
            connector: 'http',
            ...mcpInstance,
          }),
        'connector_kind_mismatch',
      );
      // A system connector of the other kind (`widgets` is mcp, from test n).
      await expectPlatformError(
        () =>
          callAsAdmin('create_gate_instance', {
            gateId: 'p1-refused-kind',
            connector: 'widgets',
            transportKind: 'http',
            target: 'http://widgets.internal.test/',
            credentialMode: 'shared',
            manifestSource: 'http://widgets.internal.test/openapi.json',
          }),
        'connector_kind_mismatch',
      );
      // A packaged gate's connector (test b's announce created it).
      await expectPlatformError(
        () =>
          callAsAdmin('create_gate_instance', {
            gateId: 'p1-refused-packaged',
            connector: packagedAnnounceBody.connector,
            ...mcpInstance,
          }),
        'connector_packaged',
      );
      // An id clash under a new connector name rolls the new connector back with it.
      await expectPlatformError(
        () =>
          callAsAdmin('create_gate_instance', {
            gateId: 'p1-widgets-a',
            connector: 'p1-never-created',
            ...mcpInstance,
          }),
        'gate_id_taken',
      );
      const leftovers = await pool.query(
        `select name from connectors where name = 'p1-never-created'
         union all
         select gate_id from gate_instances where gate_id like 'p1-refused-%'
         union all
         select payload ->> 'resourceRef' from audit_records
          where action = 'connector.created' and payload ->> 'resourceRef' = 'p1-never-created'`,
      );
      expect(leftovers.rows).toEqual([]);
    });

    it('p. P1 (review of #644): one connector rule on every announce path — first or later, gate host or packaged gate — and a refused one writes nothing', async () => {
      // Fixtures, all made here: a gate-host connector (`p1-hosted-sys`, mcp) with one never-seen
      // and one seen, still undecided instance on it; a packaged mcp instance still undecided on
      // its own connector (`p1-pkg-own`); a packaged http connector (`p1-pkg-http-conn`).
      const mcpDefinition = {
        transportKind: 'mcp',
        target: 'http://hosted-sys.internal.test/',
        credentialMode: 'shared',
      };
      for (const gateId of ['p1-hosted-first', 'p1-hosted-again']) {
        await callAsAdmin('create_gate_instance', {
          gateId,
          connector: 'p1-hosted-sys',
          ...mcpDefinition,
        });
      }
      const hostedBody = (gateId: string) => ({
        ...hostedAnnounceBody(gateId, `http://gate-host:8083/i/${gateId}`),
        connector: 'p1-hosted-sys',
      });
      expect((await announce(hostedBody('p1-hosted-again'))).statusCode).toBe(200);
      const packagedBody = (gateId: string) => ({
        ...packagedAnnounceBody,
        gateId,
        connector: 'p1-pkg-own',
        endpoint: `http://127.0.0.1:1/${gateId}`,
      });
      expect((await announce(packagedBody('p1-pkg-again'), 'gate')).statusCode).toBe(200);
      expect(
        (
          await announce(
            {
              ...packagedBody('p1-pkg-http'),
              connector: 'p1-pkg-http-conn',
              transportKind: 'http',
            },
            'gate',
          )
        ).statusCode,
      ).toBe(200);

      type Probe = { connector: string; transportKind?: 'http' | 'mcp' };
      const cases: Array<{
        path: string;
        body: (probe: Probe) => Record<string, unknown>;
        caller: 'gate' | 'gate-host';
        probes: Array<[Probe, string]>;
      }> = [
        {
          // #493's probes: a gate-host instance, first announce and a later one while undecided.
          path: 'gate host, first announce',
          body: (probe) => ({ ...hostedBody('p1-hosted-first'), ...probe }),
          caller: 'gate-host',
          probes: [
            [{ connector: 'mcp' }, 'identity_mismatch'],
            [{ connector: 'p1-pkg-own' }, 'identity_mismatch'],
            [{ connector: 'p1-brand-new-x' }, 'identity_mismatch'],
            [{ connector: 'p1-hosted-sys', transportKind: 'http' }, 'identity_mismatch'],
          ],
        },
        {
          path: 'gate host, later announce, undecided',
          body: (probe) => ({ ...hostedBody('p1-hosted-again'), ...probe }),
          caller: 'gate-host',
          probes: [
            [{ connector: 'mcp' }, 'identity_mismatch'],
            [{ connector: 'p1-pkg-own' }, 'identity_mismatch'],
            [{ connector: 'p1-brand-new-x' }, 'identity_mismatch'],
            [{ connector: 'p1-hosted-sys', transportKind: 'http' }, 'identity_mismatch'],
          ],
        },
        {
          path: 'packaged gate, first announce',
          body: (probe) => ({ ...packagedBody('p1-pkg-first'), ...probe }),
          caller: 'gate',
          probes: [
            [{ connector: 'mcp' }, 'connector_not_packaged'],
            [{ connector: 'http', transportKind: 'http' }, 'connector_not_packaged'],
            [{ connector: 'p1-hosted-sys' }, 'connector_not_packaged'],
            [{ connector: 'p1-pkg-http-conn' }, 'connector_kind_mismatch'],
            [{ connector: 'p1-pkg-own', transportKind: 'http' }, 'connector_kind_mismatch'],
          ],
        },
        {
          path: 'packaged gate, later announce, undecided',
          body: (probe) => ({ ...packagedBody('p1-pkg-again'), ...probe }),
          caller: 'gate',
          probes: [
            [{ connector: 'mcp' }, 'connector_not_packaged'],
            [{ connector: 'http', transportKind: 'http' }, 'connector_not_packaged'],
            [{ connector: 'p1-hosted-sys' }, 'connector_not_packaged'],
            [{ connector: 'p1-pkg-http-conn' }, 'connector_kind_mismatch'],
            [{ connector: 'p1-pkg-own', transportKind: 'http' }, 'connector_kind_mismatch'],
          ],
        },
      ];
      for (const { path, body, caller, probes } of cases) {
        for (const [probe, code] of probes) {
          const refused = await announce(body(probe), caller);
          expect({
            path,
            probe,
            status: refused.statusCode,
            code: refused.json().error?.code,
          }).toEqual({ path, probe, status: 409, code });
        }
      }

      // Nothing was written: every instance keeps its connector, kind and status, the refused
      // first announce created no instance, and no probe created a connector.
      const instances = await pool.query<{
        gate_id: string;
        connector: string;
        transport_kind: string;
        status: string;
        seen: boolean;
      }>(
        `select gate_id, connector, transport_kind, status, last_seen_at is not null as seen
           from gate_instances where gate_id like 'p1-hosted-%' or gate_id like 'p1-pkg-%'
          order by gate_id`,
      );
      expect(instances.rows).toEqual([
        {
          gate_id: 'p1-hosted-again',
          connector: 'p1-hosted-sys',
          transport_kind: 'mcp',
          status: 'discovered',
          seen: true,
        },
        {
          gate_id: 'p1-hosted-first',
          connector: 'p1-hosted-sys',
          transport_kind: 'mcp',
          status: 'discovered',
          seen: false,
        },
        {
          gate_id: 'p1-pkg-again',
          connector: 'p1-pkg-own',
          transport_kind: 'mcp',
          status: 'discovered',
          seen: true,
        },
        {
          gate_id: 'p1-pkg-http',
          connector: 'p1-pkg-http-conn',
          transport_kind: 'http',
          status: 'discovered',
          seen: true,
        },
      ]);
      const stray = await pool.query(`select name from connectors where name = 'p1-brand-new-x'`);
      expect(stray.rows).toEqual([]);

      // The rule still lets each class file under its own: the never-seen gate-host instance
      // under its definition's connector, the packaged gate under a new packaged connector.
      expect((await announce(hostedBody('p1-hosted-first'))).statusCode).toBe(200);
      expect(
        (await announce({ ...packagedBody('p1-pkg-again'), connector: 'p1-pkg-renamed' }, 'gate'))
          .statusCode,
      ).toBe(200);
      const connectors = await callAsAdmin<{ items: ConnectorWire[] }>('list_connectors');
      expect(connectors.items.find((row) => row.name === 'p1-pkg-renamed')).toMatchObject({
        kind: 'mcp',
        packaged: true,
      });
    });
  },
);
