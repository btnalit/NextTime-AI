import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  GatekeeperClient,
  GatekeeperStoreConnectedAccountInput,
} from '../../adapters/gatekeeper-client/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import {
  ConnectionCredentialRequiredError,
  setConnectionHandlerDeps,
} from './connection-handlers.js';
import { dispatchCapability } from './dispatch.js';
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
 */

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
  const client: GatekeeperClient = {
    describeOperations: async () => ({ operations: FAKE_DESCRIBED_OPERATIONS }),
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
    storeConnectedAccount: async (endpoint, input) => {
      storeConnectedAccountCalls.push({ endpoint, input });
    },
    deleteConnectedAccount: async () => {},
  };
  return { client, storeConnectedAccountCalls };
}

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

    beforeEach(() => {
      fake = createFakeGatekeeperClient();
      setConnectionHandlerDeps({ gatekeeperClient: fake.client });
    });

    it('falls back to describe_operations when manifestSource is omitted (cli/ssh, or an already-manifest-loaded http/mcp gate)', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const result = (await dispatchCapability({ pool }, owner, 'create_connection', {
        kind: 'cli',
        target: 'example-cli-system',
        endpoint: 'http://127.0.0.1:1/unused',
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
  },
);
