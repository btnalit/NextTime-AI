import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  GateTarget,
  GatekeeperClient,
  GatekeeperStoreConnectedAccountInput,
} from '../../adapters/gatekeeper-client/index.js';
import { createGateConnectionSecrets } from '../../adapters/gatekeeper-client/index.js';
import {
  OutboundTargetRefusedError,
  createOutboundTargetGuard,
} from '../../adapters/outbound-target/index.js';
import { getGatekeeper } from '../../governance/gatekeepers/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import {
  ConnectionCredentialRequiredError,
  ConnectionSecretConflictError,
  ConnectionSecretInvalidError,
  ConnectorNotSelfServeError,
  createConnectionHandler,
  requestConnectionHandler,
  setConnectionHandlerDeps,
} from './connection-handlers.js';
import { dispatchCapability } from './dispatch.js';
import { resolveGateTarget } from './gate-target.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/connection-handlers.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) unit-level tests for `create_connection`'s handler logic against a **fake**
 * `GatekeeperClient` (no real HTTP gate server, unlike connection-flow.integration.test.ts's own
 * end-to-end suite) — the `describe_operations` manifest-resolution fallback (no `manifestSource`
 * given), the `credentialKind` default/validation rules, and the redaction contract (docs/
 * development-tasks.md S2.13: "credential ... never persisted in the kernel ... redact before
 * writeAudit"). The real-gate, real-OpenAPI-import, real-ConnectedAccountStore end-to-end path,
 * and the "credential string appears in no kernel table" full-schema proof, live in
 * connection-flow.integration.test.ts — this file only needs a fake client's recorded call
 * arguments to prove the same redaction contract at the handler-orchestration level.
 *
 * R-01 / R-27 (2026-10-02 review): the first `describe` below needs no database (a stub
 * `PoolClient` that answers the connector-mode read with the given mode and every other query with
 * no rows) and always runs — the outbound-target predicate refusing owner-supplied URLs before any
 * fetch, the connection-secret checks, and R-40's connector three-state refusal. The
 * DB-gated suite proves the same through `dispatchCapability`: what credential the fake gate is
 * addressed with, the salt on the Gatekeeper, rotation, and the audit redaction.
 */

const GATE_TOKEN = 'connection-handlers-test-gate-token-0123456789';
const PUBLIC_ADDRESS = '93.184.216.34';

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

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

const FAKE_DESCRIBED_OPERATIONS: Operation[] = [
  {
    name: 'stock.get',
    binding: { kind: 'http', method: 'GET', path: '/stocks' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  },
];

/** Records every call made to it — never performs real network I/O. */
function createFakeGatekeeperClient() {
  const storeConnectedAccountCalls: {
    endpoint: string;
    input: GatekeeperStoreConnectedAccountInput;
  }[] = [];
  const targets: GateTarget[] = [];
  const client: GatekeeperClient = {
    describeOperations: async (target) => {
      targets.push(target);
      return { operations: FAKE_DESCRIBED_OPERATIONS };
    },
    observe: async () => {
      throw new Error('not implemented');
    },
    simulate: async () => {
      throw new Error('not implemented');
    },
    apply: async () => {
      throw new Error('not implemented');
    },
    revert: async () => {
      throw new Error('not implemented');
    },
    health: async () => ({ status: 'ok' }),
    storeConnectedAccount: async (target, input) => {
      targets.push(target);
      storeConnectedAccountCalls.push({ endpoint: target.endpoint, input });
    },
    deleteConnectedAccount: async () => {},
  };
  return { client, storeConnectedAccountCalls, targets };
}

/** A `PoolClient` stand-in for handler-level tests that never reach a write: the connector-mode
 *  read (R-40) answers `connectorMode`, every other query (the catalog read, the salt-reuse lookup)
 *  answers with no rows. Records every query's SQL. */
function stubClient(connectorMode: string | null): PoolClient & { readonly sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    query: async (text: string) => {
      sql.push(text);
      if (/from connectors where name/.test(text) && connectorMode !== null) {
        return { rows: [{ mode: connectorMode }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient & { readonly sql: string[] };
}

const EMPTY_CLIENT = stubClient('self_serve');

describe('create_connection before any fetch (R-27 predicate, R-01 secret) — no database', () => {
  const WORKSPACE = randomUUID();
  const OWNER = randomUUID();
  const secrets = createGateConnectionSecrets(GATE_TOKEN);

  function wire() {
    const fake = createFakeGatekeeperClient();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    setConnectionHandlerDeps({
      gatekeeperClient: fake.client,
      connectionSecrets: secrets,
      fetchImpl,
      // The production guard over a public resolver: the review's targets are refused by the rules
      // themselves, not by a stub.
      outboundTargetGuard: createOutboundTargetGuard({
        policy: { platformSubnets: [] },
        resolve: async () => [PUBLIC_ADDRESS],
      }),
    });
    return { fake, fetchImpl };
  }

  function call(params: Record<string, unknown>) {
    return createConnectionHandler(EMPTY_CLIENT, WORKSPACE, params, {
      channel: 'human',
      principalId: OWNER,
    });
  }

  it("refuses the review's scenario — an mcp manifestSource aimed at worker-supervisor — before any fetch", async () => {
    const { fake, fetchImpl } = wire();
    const thrown = await call({
      kind: 'mcp',
      target: 'x',
      endpoint: 'https://gate.owner.example',
      credentialKind: 'shared',
      connectionSecret: secrets.mint(WORKSPACE).secret,
      manifestSource: `http://worker-supervisor:8081/task/${randomUUID()}/terminate`,
    }).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(OutboundTargetRefusedError);
    expect(thrown).toMatchObject({ code: 'connection_target_refused', reason: 'bare-hostname' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.targets).toEqual([]);
  });

  it.each([
    ['http://worker-supervisor:8081', 'bare-hostname'],
    ['http://localhost:8090', 'bare-hostname'],
    ['http://127.0.0.1:8090', 'loopback'],
    ['http://169.254.169.254/', 'link-local'],
  ])('refuses endpoint %s (%s) before calling it', async (endpoint, reason) => {
    const { fake, fetchImpl } = wire();
    await expect(
      call({
        kind: 'cli',
        target: 'x',
        endpoint,
        credentialKind: 'shared',
        connectionSecret: secrets.mint(WORKSPACE).secret,
      }),
    ).rejects.toMatchObject({ code: 'connection_target_refused', reason });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.targets).toEqual([]);
  });

  it('requires a connectionSecret minted for this workspace, before contacting anything', async () => {
    const { fake } = wire();
    const base = {
      kind: 'cli',
      target: 'x',
      endpoint: 'https://gate.owner.example',
      credentialKind: 'shared',
    };
    await expect(call(base)).rejects.toBeInstanceOf(ConnectionSecretInvalidError);
    await expect(
      call({ ...base, connectionSecret: secrets.mint(randomUUID()).secret }),
    ).rejects.toBeInstanceOf(ConnectionSecretInvalidError);
    await expect(call({ ...base, connectionSecret: GATE_TOKEN })).rejects.toBeInstanceOf(
      ConnectionSecretInvalidError,
    );
    expect(fake.targets).toEqual([]);
  });

  it.each([['disabled'], ['platform_preset'], [null]])(
    'R-40: refuses create_connection and request_connection when the connector is %s, before anything else',
    async (mode) => {
      const { fake, fetchImpl } = wire();
      const client = stubClient(mode);
      const thrown = await createConnectionHandler(
        client,
        WORKSPACE,
        {
          kind: 'ssh',
          target: 'x',
          endpoint: 'https://gate.owner.example',
          credentialKind: 'shared',
          connectionSecret: secrets.mint(WORKSPACE).secret,
        },
        { channel: 'human', principalId: OWNER },
      ).catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(ConnectorNotSelfServeError);
      expect(thrown).toMatchObject({ code: 'connector_not_self_serve', connector: 'ssh', mode });
      // Nothing but the connector read ran: no catalog read, no salt lookup, no fetch, no gate call.
      expect(client.sql).toHaveLength(1);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(fake.targets).toEqual([]);

      await expect(
        requestConnectionHandler(
          stubClient(mode),
          WORKSPACE,
          { kind: 'ssh', target: 'x' },
          { channel: 'handle', principalId: OWNER },
        ),
      ).rejects.toMatchObject({ code: 'connector_not_self_serve' });
    },
  );
});

describe.runIf(DATABASE_URL !== undefined)(
  'create_connection handler (integration, real Postgres + fake GatekeeperClient)',
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
      workspaceId = await adminInsertWorkspace('connection-handlers-test-workspace');
      ownerId = await adminInsertPrincipal('owner', 'owner');
    });

    afterAll(async () => {
      await pool.end();
    });

    let fake: ReturnType<typeof createFakeGatekeeperClient>;
    const secrets = createGateConnectionSecrets(GATE_TOKEN);
    const newSecret = () => secrets.mint(workspaceId).secret;

    beforeEach(() => {
      fake = createFakeGatekeeperClient();
      setConnectionHandlerDeps({
        gatekeeperClient: fake.client,
        connectionSecrets: secrets,
        // These cases are about the handler, not the predicate: the loopback test endpoint is
        // allowed explicitly (the predicate's own cases run in the suite above).
        outboundTargetGuard: createOutboundTargetGuard({
          policy: { platformSubnets: [], allowHosts: ['127.0.0.1'] },
        }),
      });
    });

    it('R-40: a connector the platform set to disabled refuses create_connection with 409 connector_not_self_serve', async () => {
      const setSshMode = (mode: string) =>
        withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query('update connectors set mode = $1 where name = $2', [mode, 'ssh']),
          { skipRoleSwitch: true },
        );
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      await setSshMode('disabled');
      try {
        await expect(
          dispatchCapability({ pool }, owner, 'create_connection', {
            kind: 'ssh',
            target: 'example-ssh-system',
            endpoint: 'http://127.0.0.1:1/unused',
            connectionSecret: newSecret(),
            credentialKind: 'shared',
          }),
        ).rejects.toBeInstanceOf(ConnectorNotSelfServeError);
        expect(fake.targets).toEqual([]);
      } finally {
        await setSshMode('self_serve');
      }
    });

    it('falls back to describe_operations when manifestSource is omitted (cli/ssh, or an already-manifest-loaded http/mcp gate)', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const result = (await dispatchCapability({ pool }, owner, 'create_connection', {
        kind: 'cli',
        target: 'example-cli-system',
        endpoint: 'http://127.0.0.1:1/unused',
        connectionSecret: newSecret(),
        credentialKind: 'shared',
      })) as { gatekeeperId: string; importedOperationNames: readonly string[] };

      expect(result.importedOperationNames).toEqual(['stock.get']);
      expect(fake.storeConnectedAccountCalls).toEqual([]);
    });

    it("credentialKind: 'shared' never calls storeConnectedAccount, even when credentials happen to be omitted", async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      await dispatchCapability({ pool }, owner, 'create_connection', {
        kind: 'http',
        target: 'example-system',
        endpoint: 'http://127.0.0.1:1/unused',
        connectionSecret: newSecret(),
        credentialKind: 'shared',
      });
      expect(fake.storeConnectedAccountCalls).toEqual([]);
    });

    it('credentials given with no explicit credentialKind defaults to connected_account and posts to the gate, keyed by onBehalfOf', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const memberId = await adminInsertPrincipal('member', `member-${randomUUID()}`);

      await dispatchCapability({ pool }, owner, 'create_connection', {
        kind: 'http',
        target: 'example-system',
        endpoint: 'http://127.0.0.1:1/unused',
        connectionSecret: newSecret(),
        credentials: { token: 'the-credential-value' },
        onBehalfOf: memberId,
      });

      expect(fake.storeConnectedAccountCalls).toHaveLength(1);
      expect(fake.storeConnectedAccountCalls[0]?.input).toEqual({
        onBehalfOf: memberId,
        credential: { token: 'the-credential-value' },
      });
    });

    it('connected_account with no credentials → ConnectionCredentialRequiredError, before any DB write', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      await expect(
        dispatchCapability({ pool }, owner, 'create_connection', {
          kind: 'http',
          target: 'example-system',
          endpoint: 'http://127.0.0.1:1/unused',
          connectionSecret: newSecret(),
          credentialKind: 'connected_account',
        }),
      ).rejects.toBeInstanceOf(ConnectionCredentialRequiredError);
      expect(fake.storeConnectedAccountCalls).toEqual([]);
    });

    it('redacts `credentials` out of the audit payload (never the raw value, never omitted either)', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const result = (await dispatchCapability({ pool }, owner, 'create_connection', {
        kind: 'http',
        target: 'example-system',
        endpoint: 'http://127.0.0.1:1/unused',
        connectionSecret: newSecret(),
        credentials: { token: 'must-never-appear-in-audit' },
      })) as { gatekeeperId: string };

      const auditRows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, {
          action: 'create_connection',
          resourceId: result.gatekeeperId,
        }),
      );
      expect(auditRows).toHaveLength(1);
      const params = (auditRows[0]?.payload as { params?: { credentials?: unknown } }).params;
      expect(params?.credentials).toBe('[redacted]');
      expect(JSON.stringify(auditRows[0]?.payload)).not.toContain('must-never-appear-in-audit');
    });

    // R-01 / D-01 through the real dispatch path.
    it('addresses a self-connected gate with its own connection secret, never the platform credential', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const minted = (await dispatchCapability({ pool }, owner, 'mint_connection_secret', {})) as {
        connectionSecret: string;
      };
      const salt = secrets.saltOf(workspaceId, minted.connectionSecret);
      expect(salt).not.toBeNull();

      const result = (await dispatchCapability({ pool }, owner, 'create_connection', {
        kind: 'http',
        target: 'byo-system',
        endpoint: 'http://127.0.0.1:1/unused',
        connectionSecret: minted.connectionSecret,
        credentials: { token: 'byo-credential' },
      })) as { gatekeeperId: string };

      expect(fake.targets).toHaveLength(2); // describe_operations, then the credential POST
      for (const target of fake.targets) {
        expect(target.credential).toEqual({ kind: 'connection', workspaceId, salt });
      }

      // The salt — not the secret — is on the Gatekeeper, and later calls resolve to the same
      // connection credential (no catalog instance has this endpoint).
      const target = await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (c) => {
        const record = await getGatekeeper(c, workspaceId, result.gatekeeperId);
        expect(record?.connectionSecretSalt).toBe(salt);
        return record ? resolveGateTarget(c, workspaceId, record) : null;
      });
      expect(target?.credential).toEqual({ kind: 'connection', workspaceId, salt });

      // The secret never reaches the audit row.
      const auditRows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (c) =>
        queryAudit(c, workspaceId, {
          action: 'create_connection',
          resourceId: result.gatekeeperId,
        }),
      );
      expect(
        (auditRows[0]?.payload as { params?: { connectionSecret?: unknown } }).params
          ?.connectionSecret,
      ).toBe('[redacted]');
      expect(JSON.stringify(auditRows[0]?.payload)).not.toContain(minted.connectionSecret);
    });

    it('refuses a connection secret another Gatekeeper already holds (409)', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const secret = newSecret();
      const params = {
        kind: 'cli',
        target: 'reuse-system',
        endpoint: 'http://127.0.0.1:1/unused',
        credentialKind: 'shared',
        connectionSecret: secret,
      };
      await dispatchCapability({ pool }, owner, 'create_connection', params);
      await expect(
        dispatchCapability({ pool }, owner, 'create_connection', params),
      ).rejects.toBeInstanceOf(ConnectionSecretConflictError);
    });

    it('rotate_connection_secret replaces the salt; the old secret no longer matches', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const first = newSecret();
      const created = (await dispatchCapability({ pool }, owner, 'create_connection', {
        kind: 'cli',
        target: 'rotate-system',
        endpoint: 'http://127.0.0.1:1/unused',
        credentialKind: 'shared',
        connectionSecret: first,
      })) as { gatekeeperId: string };

      const rotated = (await dispatchCapability({ pool }, owner, 'rotate_connection_secret', {
        gatekeeperId: created.gatekeeperId,
      })) as { gatekeeperId: string; connectionSecret: string };
      expect(rotated.gatekeeperId).toBe(created.gatekeeperId);
      expect(rotated.connectionSecret).not.toBe(first);

      const record = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (c) =>
        getGatekeeper(c, workspaceId, created.gatekeeperId),
      );
      expect(record?.connectionSecretSalt).toBe(
        secrets.saltOf(workspaceId, rotated.connectionSecret),
      );
      expect(record?.connectionSecretSalt).not.toBe(secrets.saltOf(workspaceId, first));
    });
  },
);
