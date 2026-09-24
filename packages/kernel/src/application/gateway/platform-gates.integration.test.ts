import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AvailableGateInstanceWire,
  ConnectorWire,
  EnableGateInstanceResultWire,
  ExternalRuntimeWire,
  GateInstanceWire,
  ListEnvelope,
  Operation,
  PreviewGateInstanceEnableResultWire,
  Role,
} from '@nexttime/shared';
import { internalAuthorizationHeader } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import { HANDLE_SIGNING_ALG, grantCapability } from '../../governance/capability/index.js';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { evaluate } from '../../governance/policy/index.js';
import { createServer } from '../../index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { createPlatformAdmin } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { withAdminClient } from './auth.js';
import { ForbiddenError } from './authorize.js';
import {
  ConnectionEndpointIsPlatformGateError,
  setConnectionHandlerDeps,
} from './connection-handlers.js';
import { dispatchCapability } from './dispatch.js';
import { GateInstanceNotAvailableError } from './gate-instance-handlers.js';
import { PlatformAdminError } from './platform-handlers.js';
import type { PlatformErrorCode } from './platform-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/platform-gates.integration.test: DB-gated coverage of P-B1 (docs/platform-
 * admin-design.md §6.3; development-tasks.md P-B 决定 ①–⑤) — the announce route, connectors and
 * their three-state / deny list, gate instances, the workspace-side enable, the per-call
 * disabled-Operation refusal, the MCP trust rule and the external-runtime inventory. Private
 * database per file, same reasons and same scaffolding as platform-workspaces.integration.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');
const INTERNAL_TOKEN = 'p-b1-internal-token-0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';

const OBSERVE_OP: Operation = {
  name: 'list_things',
  binding: { kind: 'mcp', tool_name: 'list_things' },
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
const EXECUTE_OP: Operation = {
  name: 'restart_thing',
  binding: { kind: 'mcp', tool_name: 'restart_thing' },
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
  const name = `nexttime_platform_gates_${randomUUID().replace(/-/g, '')}`;
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
  'P-B1 gates & integrations (integration, real Postgres)',
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

    async function announce(body: Record<string, unknown>) {
      const server = app();
      const response = await server.inject({
        method: 'POST',
        url: '/internal/gates/announce',
        headers: {
          'content-type': 'application/json',
          authorization: internalAuthorizationHeader(INTERNAL_TOKEN),
        },
        payload: body,
      });
      return response;
    }

    const GATE_ID = 'fixture-mcp-gate';
    const announceBody = {
      gateId: GATE_ID,
      connector: 'fixture-mcp',
      transportKind: 'mcp',
      target: 'http://fixture-mcp:9000',
      endpoint: 'http://127.0.0.1:1', // nothing listens: health must read unreachable
      displayName: 'Fixture MCP',
      operations: [OBSERVE_OP, EXECUTE_OP],
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
        login: `gates-admin-${randomUUID().slice(0, 8)}`,
        displayName: 'Gates Admin',
        password: PASSWORD,
      });
      const created = await createWorkspaceWithOwner(pool, {
        name: 'platform-gates-test-workspace',
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

    describe('announce', () => {
      it('refuses without the internal token, accepts with it and lands as discovered', async () => {
        const server = app();
        const noToken = await server.inject({
          method: 'POST',
          url: '/internal/gates/announce',
          headers: { 'content-type': 'application/json' },
          payload: announceBody,
        });
        expect(noToken.statusCode).toBe(401);

        const ok = await announce(announceBody);
        expect(ok.statusCode).toBe(200);
        expect(ok.json().result).toMatchObject({
          gateId: GATE_ID,
          status: 'discovered',
          created: true,
        });

        const bad = await announce({ ...announceBody, gateId: 'Bad Id!' });
        expect(bad.statusCode).toBe(400);
      });

      it('creates the packaged connector as platform_preset next to the four generic kinds', async () => {
        const connectors = await callAsAdmin<ListEnvelope<ConnectorWire>>('list_connectors');
        const names = connectors.items.map((c) => c.name).sort();
        expect(names).toEqual(['cli', 'fixture-mcp', 'http', 'mcp', 'ssh']);
        const fixture = connectors.items.find((c) => c.name === 'fixture-mcp');
        expect(fixture).toMatchObject({
          kind: 'mcp',
          packaged: true,
          mode: 'platform_preset',
          instanceCount: 1,
          operationCount: 2,
        });
        const generic = connectors.items.find((c) => c.name === 'http');
        expect(generic).toMatchObject({ packaged: false, mode: 'self_serve' });
      });

      it('an announcement with a different identity for an enabled instance keeps the stored endpoint (review finding)', async () => {
        await callAsAdmin('update_gate_instance', { gateId: GATE_ID, status: 'enabled' });
        const impostor = await announce({
          ...announceBody,
          endpoint: 'http://impostor:9999',
          connector: 'fixture-mcp',
        });
        expect(impostor.statusCode).toBe(200);
        const after = await callAsAdmin<GateInstanceWire>('get_gate_instance', { gateId: GATE_ID });
        expect(after.endpoint).toBe(announceBody.endpoint);
        expect(after.health).toBe('unknown');
        expect(after.status).toBe('enabled');
        // A matching heartbeat restores health.
        await announce(announceBody);
        const restored = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
          gateId: GATE_ID,
        });
        expect(restored.health).toBe('ok');
      });

      it('a heartbeat keeps the administrator’s status and refreshes lastSeenAt', async () => {
        await callAsAdmin('update_gate_instance', { gateId: GATE_ID, status: 'enabled' });
        const before = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
          gateId: GATE_ID,
        });
        const again = await announce(announceBody);
        expect(again.json().result).toMatchObject({ status: 'enabled', created: false });
        const after = await callAsAdmin<GateInstanceWire>('get_gate_instance', { gateId: GATE_ID });
        expect(after.status).toBe('enabled');
        expect(new Date(after.lastSeenAt ?? 0).getTime()).toBeGreaterThanOrEqual(
          new Date(before.lastSeenAt ?? 0).getTime(),
        );
      });
    });

    describe('gate instances (platform)', () => {
      it('lists, tests (unreachable endpoint) and marks trust only for MCP', async () => {
        const listed = await callAsAdmin<ListEnvelope<GateInstanceWire>>('list_gate_instances', {
          connector: 'fixture-mcp',
        });
        expect(listed.items.map((i) => i.gateId)).toEqual([GATE_ID]);
        expect(listed.items[0]).toMatchObject({
          displayName: 'Fixture MCP',
          transportKind: 'mcp',
          operationCount: 2,
          enabledWorkspaceCount: 0,
          trust: 'byo',
        });

        const tested = await callAsAdmin<{
          health: string;
          describedOperationCount: number | null;
        }>('test_gate_instance', { gateId: GATE_ID });
        expect(tested.health).toBe('unreachable');
        expect(tested.describedOperationCount).toBeNull();

        const vetted = await callAsAdmin<GateInstanceWire>('update_gate_instance', {
          gateId: GATE_ID,
          trust: 'vetted',
          displayName: 'Fixture MCP (vetted)',
        });
        expect(vetted).toMatchObject({ trust: 'vetted', displayName: 'Fixture MCP (vetted)' });

        await expectPlatformError(
          () => callAsAdmin('get_gate_instance', { gateId: 'no-such-gate' }),
          'gate_not_found',
        );
      });

      it('refuses platform_preset for a generic connector without a host (cli / ssh)', async () => {
        // P-B2a lifted this for `http` / `mcp` (the gate host runs platform instances of those).
        await expectPlatformError(
          () => callAsAdmin('set_connector_mode', { name: 'cli', mode: 'platform_preset' }),
          'connector_mode_not_allowed',
        );
      });
    });

    describe('workspace-side enable (owner)', () => {
      let gatekeeperId: string;

      it('lists the enabled preset instance and enables it: Gatekeeper + published Operations + link', async () => {
        const available = await callAsOwner<ListEnvelope<AvailableGateInstanceWire>>(
          'list_available_gate_instances',
        );
        expect(available.items).toHaveLength(1);
        expect(available.items[0]).toMatchObject({ gateId: GATE_ID, gatekeeperId: null });

        const enabled = await callAsOwner<EnableGateInstanceResultWire>('enable_gate_instance', {
          gateId: GATE_ID,
        });
        gatekeeperId = enabled.gatekeeperId;
        expect(enabled.publishedOperationNames.sort()).toEqual(['list_things', 'restart_thing']);

        const again = await callAsOwner<EnableGateInstanceResultWire>('enable_gate_instance', {
          gateId: GATE_ID,
        });
        expect(again.gatekeeperId).toBe(gatekeeperId);
        expect(again.publishedOperationNames).toEqual([]);

        const afterList = await callAsOwner<ListEnvelope<AvailableGateInstanceWire>>(
          'list_available_gate_instances',
        );
        expect(afterList.items[0]?.gatekeeperId).toBe(gatekeeperId);

        const instance = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
          gateId: GATE_ID,
        });
        expect(instance.enabledWorkspaceCount).toBe(1);

        const ops = await callAsOwner<ListEnvelope<{ name: string; status: string }>>(
          'list_operations',
          { gatekeeperId },
        );
        expect(ops.items.map((o) => [o.name, o.status]).sort()).toEqual([
          ['list_things', 'published'],
          ['restart_thing', 'published'],
        ]);
      });

      it('refuses an instance the administrator disabled or whose connector is not preset', async () => {
        await callAsAdmin('update_gate_instance', { gateId: GATE_ID, status: 'disabled' });
        // Already linked: the existing link is still returned (idempotent), a *new* workspace
        // could not enable it — exercised through a second bare workspace below.
        const ws2 = await createWorkspaceWithOwner(pool, {
          name: 'platform-gates-second-workspace',
          owner: { userId: admin.id, displayName: 'Admin' },
          ontologyDir: ONTOLOGY_DIR,
        });
        const owner2: ResolvedCaller = {
          channel: 'human',
          principal: {
            workspaceId: ws2.workspaceId,
            id: ws2.ownerPrincipalId,
            kind: 'human',
            role: 'owner',
            displayName: null,
          },
          session: {
            workspaceId: ws2.workspaceId,
            id: randomUUID(),
            principalId: ws2.ownerPrincipalId,
            kind: 'web',
            onBehalfOf: ws2.ownerPrincipalId,
            status: 'active',
            createdAt: new Date(),
            expiresAt: null,
          },
        };
        await expect(
          dispatchCapability({ pool }, owner2, 'enable_gate_instance', { gateId: GATE_ID }),
        ).rejects.toBeInstanceOf(GateInstanceNotAvailableError);
        await callAsAdmin('update_gate_instance', { gateId: GATE_ID, status: 'enabled' });

        await callAsAdmin('set_connector_mode', { name: 'fixture-mcp', mode: 'self_serve' });
        await expect(
          dispatchCapability({ pool }, owner2, 'enable_gate_instance', { gateId: GATE_ID }),
        ).rejects.toMatchObject({ code: 'connector_not_preset' });
        // Mode changes never tear down the first workspace's link (design §8).
        const still = await callAsOwner<ListEnvelope<AvailableGateInstanceWire>>(
          'list_available_gate_instances',
        );
        expect(still.items).toEqual([]); // hidden from the catalog while not preset …
        const instance = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
          gateId: GATE_ID,
        });
        expect(instance.enabledWorkspaceCount).toBe(1); // … but the link is intact
        await callAsAdmin('set_connector_mode', { name: 'fixture-mcp', mode: 'platform_preset' });
      });

      it('a connector-disabled Operation is hidden from the catalog and refused per call', async () => {
        await callAsAdmin('set_connector_mode', {
          name: 'fixture-mcp',
          disabledOperations: ['restart_thing'],
        });
        const ops = await callAsOwner<ListEnvelope<{ name: string }>>('list_operations', {
          gatekeeperId,
        });
        expect(ops.items.map((o) => o.name)).toEqual(['list_things']);

        await expect(
          callAsOwner('request_action', {
            gatekeeperId,
            operation: 'restart_thing',
            params: {},
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);

        await callAsAdmin('set_connector_mode', { name: 'fixture-mcp', disabledOperations: [] });
        const restored = await callAsOwner<ListEnvelope<{ name: string }>>('list_operations', {
          gatekeeperId,
        });
        expect(restored.items.map((o) => o.name).sort()).toEqual(['list_things', 'restart_thing']);
      });
    });

    // S8 W2-K2 (leftover 73, ui-audit J3/J4/B7): enabling a platform gate instance must link an
    // existing (legacy-registered) Gatekeeper by endpoint instead of registering a duplicate.
    describe('gate link endpoint association (S8 W2-K2, leftover 73)', () => {
      const EXTRA_OP: Operation = {
        name: 'list_more_things',
        binding: { kind: 'mcp', tool_name: 'list_more_things' },
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
      // Legacy-published with governance fields that no longer match what the gate now announces
      // for the same name (CO2's "deployed Operation whose fields no longer match the announced
      // manifest" case) — `differs: true` in the preview.
      const STALE_EXECUTE_OP: Operation = {
        ...EXECUTE_OP,
        blast_radius: 'low',
        auto_approvable: false,
      };

      /** Registers a Gatekeeper the same way the legacy `register-gatekeeper` CLI path does
       *  (same three functions, not through `enable_gate_instance`), and publishes the given
       *  Operations under it — the "already registered outside the platform catalog" fixture the
       *  endpoint-association tests below link against. */
      async function seedLegacyGatekeeper(input: {
        name: string;
        transportKind: 'http' | 'mcp' | 'cli' | 'ssh';
        target: string;
        endpoint: string;
        operations: readonly Operation[];
      }): Promise<string> {
        return withWorkspace(
          pool,
          { workspaceId, principalId: ownerPrincipalId },
          async (client) => {
            const activity = await startActivity(client, workspaceId, {
              kind: 'test.legacy_register_gatekeeper',
              principalId: ownerPrincipalId,
            });
            const { gatekeeperId } = await registerGatekeeper(client, workspaceId, {
              name: input.name,
              transportKind: input.transportKind,
              target: input.target,
              endpoint: input.endpoint,
              activityId: activity.id,
              registeredBy: { id: ownerPrincipalId, kind: 'human' },
            });
            const imported = await importManifest(client, workspaceId, {
              gatekeeperId,
              operations: input.operations,
              proposedBy: { id: ownerPrincipalId, kind: 'human' },
              activityId: activity.id,
            });
            for (const record of imported.imported) {
              await publishOperation(client, workspaceId, { gatekeeperId, name: record.name });
            }
            await endActivity(client, workspaceId, activity.id, 'completed');
            return gatekeeperId;
          },
        );
      }

      async function countObjectsByType(objectType: string): Promise<number> {
        return withAdminClient(pool, async (client) => {
          const result = await client.query<{ count: string }>(
            'select count(*)::bigint as count from objects where workspace_id = $1 and object_type = $2',
            [workspaceId, objectType],
          );
          return Number(result.rows[0]?.count ?? 0);
        });
      }

      async function countGateLinkRows(gateId: string): Promise<number> {
        return withAdminClient(pool, async (client) => {
          const result = await client.query<{ count: string }>(
            'select count(*)::bigint as count from workspace_gate_links where workspace_id = $1 and gate_id = $2',
            [workspaceId, gateId],
          );
          return Number(result.rows[0]?.count ?? 0);
        });
      }

      it('links the legacy Gatekeeper by endpoint (not name/target), previews accurately, imports only the new Operation, stays idempotent, and unlocks execution_readiness', async () => {
        const GATE_ID_LINK = 'fixture-mcp-gate-legacy-link';
        const ENDPOINT = 'http://127.0.0.1:1/legacy-link/';

        const legacyGatekeeperId = await seedLegacyGatekeeper({
          name: 'legacy-docker-gate',
          transportKind: 'cli',
          target: 'docker', // short legacy target — differs from the instance's real address below
          endpoint: ENDPOINT,
          operations: [OBSERVE_OP, STALE_EXECUTE_OP],
        });

        const gatekeeperObjectsBefore = await countObjectsByType('Gatekeeper');
        const connectedSystemObjectsBefore = await countObjectsByType('ConnectedSystem');

        const announced = await announce({
          gateId: GATE_ID_LINK,
          connector: 'fixture-mcp',
          transportKind: 'http', // differs from the legacy Object's own 'cli'
          target: 'http://fixture-mcp-real-upstream:9000', // differs from the legacy 'docker' target
          endpoint: ENDPOINT, // same endpoint — the only field the association key reads
          displayName: 'Fixture MCP (real instance)', // differs from the legacy 'legacy-docker-gate' name
          operations: [OBSERVE_OP, EXECUTE_OP, EXTRA_OP],
        });
        expect(announced.statusCode).toBe(200);
        await callAsAdmin('update_gate_instance', { gateId: GATE_ID_LINK, status: 'enabled' });

        // --- preview: writes nothing ---
        const linksBeforePreview = await countGateLinkRows(GATE_ID_LINK);
        const preview = await callAsOwner<PreviewGateInstanceEnableResultWire>(
          'preview_gate_instance_enable',
          { gateId: GATE_ID_LINK },
        );
        expect(preview.wouldLink?.gatekeeperId).toBe(legacyGatekeeperId);
        expect(preview.wouldLink?.drift).toMatchObject({
          name: { existing: 'legacy-docker-gate', instance: 'Fixture MCP (real instance)' },
          target: { existing: 'docker', instance: 'http://fixture-mcp-real-upstream:9000' },
          transportKind: { existing: 'cli', instance: 'http' },
        });
        expect(preview.ambiguousCandidates).toEqual([]);
        expect(preview.operationsToImport.map((o) => o.name)).toEqual(['list_more_things']);
        const stalePreview = preview.operationsAlreadyPresent.find(
          (o) => o.name === 'restart_thing',
        );
        expect(stalePreview).toMatchObject({
          existing: { blastRadius: 'low', autoApprovable: false, status: 'published' },
          announced: { blastRadius: 'medium', autoApprovable: true },
          differs: true,
        });
        const unchangedPreview = preview.operationsAlreadyPresent.find(
          (o) => o.name === 'list_things',
        );
        expect(unchangedPreview).toMatchObject({ differs: false });
        expect(await countGateLinkRows(GATE_ID_LINK)).toBe(linksBeforePreview); // still nothing written
        expect(await countObjectsByType('Gatekeeper')).toBe(gatekeeperObjectsBefore);
        expect(await countObjectsByType('ConnectedSystem')).toBe(connectedSystemObjectsBefore);

        // --- enable: matches the preview exactly ---
        const enabled = await callAsOwner<EnableGateInstanceResultWire>('enable_gate_instance', {
          gateId: GATE_ID_LINK,
        });
        expect(enabled.gatekeeperId).toBe(legacyGatekeeperId);
        expect(enabled.linkedExisting).toBe(true);
        expect(enabled.drift).toEqual(preview.wouldLink?.drift);
        expect(enabled.publishedOperationNames).toEqual(['list_more_things']);
        expect(enabled.skippedOperationNames.sort()).toEqual(['list_things', 'restart_thing']);

        // No second Gatekeeper, no second ConnectedSystem.
        expect(await countObjectsByType('Gatekeeper')).toBe(gatekeeperObjectsBefore);
        expect(await countObjectsByType('ConnectedSystem')).toBe(connectedSystemObjectsBefore);

        // Operations count = legacy (2) + 1 new = 3; the legacy Operations' fields are unchanged
        // (never rewritten by a link — the stale `restart_thing` stays stale).
        const ops = await callAsOwner<ListEnvelope<{ name: string; status: string }>>(
          'list_operations',
          { gatekeeperId: legacyGatekeeperId },
        );
        expect(ops.items.map((o) => o.name).sort()).toEqual([
          'list_more_things',
          'list_things',
          'restart_thing',
        ]);
        const staleAfter = await callAsOwner<
          ListEnvelope<{ name: string; blastRadius: string; autoApprovable: boolean }>
        >('list_operations', { gatekeeperId: legacyGatekeeperId });
        expect(staleAfter.items.find((o) => o.name === 'restart_thing')).toMatchObject({
          blastRadius: 'low',
          autoApprovable: false,
        });

        expect(await countGateLinkRows(GATE_ID_LINK)).toBe(1);

        // --- idempotent: a second enable call returns the same link, nothing new ---
        const again = await callAsOwner<EnableGateInstanceResultWire>('enable_gate_instance', {
          gateId: GATE_ID_LINK,
        });
        expect(again).toMatchObject({
          gatekeeperId: legacyGatekeeperId,
          linkedExisting: false, // short-circuited on the existing link row, no new decision made
          publishedOperationNames: [],
          skippedOperationNames: [],
        });
        expect(await countGateLinkRows(GATE_ID_LINK)).toBe(1);

        // --- execution_readiness (W1-C): a member granted the linked Gatekeeper, with a
        // published worker declaring it, is ready — mirroring the production acceptance the
        // maintainer performs by clicking "在本工作区启用" once.
        const memberId = randomUUID();
        await withAdminClient(pool, (client) =>
          client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'member', 'legacy-link-member')`,
            [workspaceId, memberId],
          ),
        );
        await withWorkspace(pool, { workspaceId, principalId: ownerPrincipalId }, (client) =>
          grantCapability(client, workspaceId, {
            principalId: memberId,
            resourceType: 'gatekeeper',
            resourceId: legacyGatekeeperId,
            grantedBy: ownerPrincipalId,
          }),
        );
        const workerDraft = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerPrincipalId },
          (client) =>
            proposeWorkerDefinition(client, workspaceId, ownerPrincipalId, {
              kind: 'worker',
              definition: {
                systemPrompt: 'Acts on the linked legacy gate.',
                name: 'legacy-link-worker',
                capabilities: ['request_action'],
                gates: [legacyGatekeeperId],
              },
            }),
        );
        await withWorkspace(pool, { workspaceId, principalId: ownerPrincipalId }, (client) =>
          publishWorkerDefinition(client, workspaceId, ownerPrincipalId, {
            definitionId: workerDraft.id,
            version: workerDraft.version,
          }),
        );

        const member: ResolvedCaller = {
          channel: 'human',
          principal: {
            workspaceId,
            id: memberId,
            kind: 'human',
            role: 'member',
            displayName: null,
          },
          session: {
            workspaceId,
            id: randomUUID(),
            principalId: memberId,
            kind: 'web',
            onBehalfOf: memberId,
            status: 'active',
            createdAt: new Date(),
            expiresAt: null,
          },
        };
        const readiness = (await dispatchCapability(
          { pool },
          member,
          'execution_readiness',
          {},
        )) as { ready: boolean; workers: readonly { definitionId: string; delegable: boolean }[] };
        expect(readiness.ready).toBe(true);
        expect(readiness.workers.find((w) => w.definitionId === workerDraft.id)?.delegable).toBe(
          true,
        );
      });

      it('refuses ambiguous_existing_gatekeeper when the endpoint matches more than one Gatekeeper, and writes nothing', async () => {
        const GATE_ID_AMBIGUOUS = 'fixture-mcp-gate-legacy-ambiguous';
        const ENDPOINT = 'http://127.0.0.1:1/legacy-ambiguous/';

        const first = await seedLegacyGatekeeper({
          name: 'legacy-a',
          transportKind: 'cli',
          target: 'a',
          endpoint: ENDPOINT,
          operations: [OBSERVE_OP],
        });
        const second = await seedLegacyGatekeeper({
          name: 'legacy-b',
          transportKind: 'cli',
          target: 'b',
          endpoint: ENDPOINT,
          operations: [OBSERVE_OP],
        });

        const announced = await announce({
          gateId: GATE_ID_AMBIGUOUS,
          connector: 'fixture-mcp',
          transportKind: 'http',
          target: 'http://fixture-mcp-ambiguous:9000',
          endpoint: ENDPOINT,
          displayName: 'Fixture MCP (ambiguous)',
          operations: [OBSERVE_OP, EXECUTE_OP],
        });
        expect(announced.statusCode).toBe(200);
        await callAsAdmin('update_gate_instance', { gateId: GATE_ID_AMBIGUOUS, status: 'enabled' });

        const gatekeeperObjectsBefore = await countObjectsByType('Gatekeeper');

        const preview = await callAsOwner<PreviewGateInstanceEnableResultWire>(
          'preview_gate_instance_enable',
          { gateId: GATE_ID_AMBIGUOUS },
        );
        expect(preview.wouldLink).toBeNull();
        expect(preview.ambiguousCandidates.sort()).toEqual([first, second].sort());

        await expect(
          callAsOwner('enable_gate_instance', { gateId: GATE_ID_AMBIGUOUS }),
        ).rejects.toMatchObject({ code: 'ambiguous_existing_gatekeeper' });

        expect(await countGateLinkRows(GATE_ID_AMBIGUOUS)).toBe(0);
        expect(await countObjectsByType('Gatekeeper')).toBe(gatekeeperObjectsBefore);
      });
    });

    // STATUS leftover 36 (S5.5; connection-handlers.ts "Endpoint guard"): a workspace owner must
    // not be able to reach a platform-catalog instance through a self-connected gate — that would
    // hand them a Gatekeeper the catalog's deny list / trust / enabled-state never govern, driven
    // by the kernel's shared gate token (and, for gate-host, by the administrator's shared
    // credentials). The gate client below throws on first contact, so every "let through" case
    // proves the guard passed and every "refused" case proves nothing was contacted.
    describe('create_connection endpoint guard (owner self-connect to a catalog address)', () => {
      const HOSTED_ID = 'hosted-http-guard';
      const reached = new Error('reached the gate: the guard let this endpoint through');
      const unreachableGate: GatekeeperClient = {
        describeOperations: async () => {
          throw reached;
        },
        observe: async () => {
          throw reached;
        },
        simulate: async () => {
          throw reached;
        },
        apply: async () => {
          throw reached;
        },
        revert: async () => {
          throw reached;
        },
        health: async () => {
          throw reached;
        },
        storeConnectedAccount: async () => {
          throw reached;
        },
        deleteConnectedAccount: async () => {
          throw reached;
        },
      };

      function selfConnect(endpoint: string) {
        return callAsOwner('create_connection', {
          kind: 'http',
          target: 'a-system-of-my-own',
          endpoint,
          credentialKind: 'shared',
        });
      }

      // Before *each* case, not once: `announce()` builds a server through `createServer`, and the
      // composition root wires the real `HttpGatekeeperClient` into the connection handler on
      // every build — the hosted case below would otherwise leave the real client in place for
      // the "let through" case after it (CI run 35246480966).
      beforeEach(() => {
        setConnectionHandlerDeps({ gatekeeperClient: unreachableGate });
      });

      it("refuses the packaged instance's announced address however it is spelled", async () => {
        for (const spelling of [
          announceBody.endpoint,
          'HTTP://127.0.0.1:1/',
          'http://127.0.0.1:1/i/anything/gate/describe_operations',
        ]) {
          const thrown = await selfConnect(spelling).then(
            () => {
              throw new Error(`expected "${spelling}" to be refused, but the call resolved`);
            },
            (err: unknown) => err,
          );
          expect(thrown).toBeInstanceOf(ConnectionEndpointIsPlatformGateError);
          expect(thrown).toMatchObject({ code: 'endpoint_is_platform_gate', gateId: GATE_ID });
        }
      });

      it("refuses gate-host's /i/ prefix once one hosted instance has announced — for ids the host has not announced too", async () => {
        await callAsAdmin('create_gate_instance', {
          gateId: HOSTED_ID,
          transportKind: 'http',
          target: 'http://system.internal.test/',
          credentialMode: 'shared',
          // An http instance must name the OpenAPI document the host imports from
          // (`create_gate_instance`'s own superRefine) — never fetched here: nothing takes the
          // instance over, the announce below stands in for the host.
          manifestSource: 'http://system.internal.test/openapi.json',
        });
        const announced = await announce({
          gateId: HOSTED_ID,
          connector: 'http',
          transportKind: 'http',
          target: 'http://system.internal.test/',
          endpoint: `http://gate-host:8083/i/${HOSTED_ID}`,
          displayName: 'Hosted HTTP',
          operations: [OBSERVE_OP],
        });
        expect(announced.statusCode).toBe(200);

        await expect(
          selfConnect('http://gate-host:8083/i/an-id-the-host-never-announced'),
        ).rejects.toMatchObject({ code: 'endpoint_is_platform_gate', gateId: HOSTED_ID });
      });

      it('lets an address outside the catalog through to the gate', async () => {
        await expect(selfConnect('http://byo-gate.internal.test:9999')).rejects.toBe(reached);
      });
    });

    describe('MCP trust rule (pure engine)', () => {
      it('mcpTrustBlocked produces its own reason before the auto_approvable check', () => {
        const base = {
          gatekeeperId: 'g',
          blastRadius: 'medium' as const,
          operationAutoApprovable: true,
          requesterScope: { capabilities: [], resources: { gatekeeper: ['g'] } },
          workspacePolicy: { autoApprove: true, requesterCanApprove: null },
        };
        expect(evaluate({ ...base, mcpTrustBlocked: true })).toMatchObject({
          decision: 'require_approval',
          reason: 'mcp_gate_not_vetted',
        });
        expect(evaluate({ ...base, mcpTrustBlocked: false }).decision).toBe('allow');
      });
    });

    describe('external runtimes', () => {
      it('lists a service Principal’s live session across workspaces and revokes it', async () => {
        const servicePrincipalId = randomUUID();
        await withAdminClient(pool, async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'service', 'member', 'collector')`,
            [workspaceId, servicePrincipalId],
          );
        });
        const issued = await callAsOwner<{ sessionId: string; handle: string }>(
          'issue_service_handle',
          { principalId: servicePrincipalId, scope: ['get_task'] },
        );
        expect(issued.handle.length).toBeGreaterThan(20);

        const runtimes =
          await callAsAdmin<ListEnvelope<ExternalRuntimeWire>>('list_external_runtimes');
        const mine = runtimes.items.find((r) => r.sessionId === issued.sessionId);
        expect(mine).toMatchObject({
          workspaceId,
          principalId: servicePrincipalId,
          sessionKind: 'service',
          status: 'active',
        });

        await expect(
          callAsOwner('issue_service_handle', {
            principalId: ownerPrincipalId,
            scope: ['get_task'],
          }),
        ).rejects.toMatchObject({ name: 'ServicePrincipalRequiredError' });

        const revoked = await callAsAdmin<{ revoked: boolean }>('revoke_external_runtime', {
          workspaceId,
          sessionId: issued.sessionId,
        });
        expect(revoked.revoked).toBe(true);
        // …and the Handles issued under the session are revoked too (review finding): Handle
        // verification checks `capability_handles.revoked_at`, not `sessions.status`.
        const handles = await withAdminClient(pool, (client) =>
          client.query<{ revoked_at: Date | null }>(
            'select revoked_at from capability_handles where session_id = $1',
            [issued.sessionId],
          ),
        );
        expect(handles.rows.length).toBeGreaterThan(0);
        expect(handles.rows.every((row) => row.revoked_at !== null)).toBe(true);
        const after =
          await callAsAdmin<ListEnvelope<ExternalRuntimeWire>>('list_external_runtimes');
        expect(after.items.find((r) => r.sessionId === issued.sessionId)).toBeUndefined();
        await expectPlatformError(
          () =>
            callAsAdmin('revoke_external_runtime', { workspaceId, sessionId: issued.sessionId }),
          'runtime_not_found',
        );
      });
    });

    describe('liveness', () => {
      it('marks a silent enabled instance lost; a new announce restores it to enabled (has links)', async () => {
        await withWorkspace(
          pool,
          {
            workspaceId: '00000000-0000-0000-0000-000000000000',
            principalId: '00000000-0000-0000-0000-000000000000',
          },
          (client) =>
            client.query(
              `update gate_instances set last_seen_at = now() - interval '1 hour' where gate_id = $1`,
              [GATE_ID],
            ),
          { skipRoleSwitch: true },
        );
        const { markLostGateInstances } = await import('../gates/index.js');
        const lost = await withWorkspace(
          pool,
          {
            workspaceId: '00000000-0000-0000-0000-000000000000',
            principalId: '00000000-0000-0000-0000-000000000000',
          },
          (client) => markLostGateInstances(client, 180),
          { skipRoleSwitch: true },
        );
        expect(lost).toEqual([GATE_ID]);
        const instance = await callAsAdmin<GateInstanceWire>('get_gate_instance', {
          gateId: GATE_ID,
        });
        expect(instance.status).toBe('lost');
        const back = await announce(announceBody);
        expect(back.json().result.status).toBe('enabled');
      });

      it('a lost instance with no links returns to the status it had (enabled), not to discovered (review finding)', async () => {
        const LONER = 'fixture-loner-gate';
        await announce({ ...announceBody, gateId: LONER, endpoint: 'http://127.0.0.1:2' });
        await callAsAdmin('update_gate_instance', { gateId: LONER, status: 'enabled' });
        const admin0 = {
          workspaceId: '00000000-0000-0000-0000-000000000000',
          principalId: '00000000-0000-0000-0000-000000000000',
        };
        await withWorkspace(
          pool,
          admin0,
          (client) =>
            client.query(
              `update gate_instances set last_seen_at = now() - interval '1 hour' where gate_id = $1`,
              [LONER],
            ),
          { skipRoleSwitch: true },
        );
        const { markLostGateInstances } = await import('../gates/index.js');
        await withWorkspace(pool, admin0, (client) => markLostGateInstances(client, 180), {
          skipRoleSwitch: true,
        });
        expect(
          (await callAsAdmin<GateInstanceWire>('get_gate_instance', { gateId: LONER })).status,
        ).toBe('lost');
        const back = await announce({
          ...announceBody,
          gateId: LONER,
          endpoint: 'http://127.0.0.1:2',
        });
        expect(back.json().result.status).toBe('enabled');
      });
    });
  },
);
