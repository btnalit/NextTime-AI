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
  Role,
} from '@nexttime/shared';
import { internalAuthorizationHeader } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { evaluate } from '../../governance/policy/index.js';
import { createServer } from '../../index.js';
import { createPlatformAdmin } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { withAdminClient } from './auth.js';
import { ForbiddenError } from './authorize.js';
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

      it('refuses platform_preset for a generic connector', async () => {
        await expectPlatformError(
          () => callAsAdmin('set_connector_mode', { name: 'http', mode: 'platform_preset' }),
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
