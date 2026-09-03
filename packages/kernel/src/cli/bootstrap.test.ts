import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../adapters/db/pool.js';
import type { GatekeeperClient } from '../adapters/gatekeeper-client/index.js';
import { hashApiKey } from '../application/gateway/index.js';
import { getOperation, getPublishedOperation } from '../governance/gatekeepers/index.js';
import { addPrincipal, createWorkspace, registerGatekeeperFromCli } from './bootstrap.js';

/**
 * cli/bootstrap.test: integration tests (real Postgres; auto-skip without DATABASE_URL) for
 * `create-workspace` (docs/development-tasks.md S1.3, item 6) and `add-principal`
 * (docs/development-tasks.md S1.10) — the workspace/principal rows exist afterward, the printed
 * API key resolves back to that Principal via the human channel's own hashing
 * (`application/gateway/auth.ts`'s `hashApiKey`, which `bootstrap.ts` itself calls — see its
 * module doc), and only the hash, never the raw key, is stored.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** A `GatekeeperClient` fake for `registerGatekeeperFromCli` tests below — never touches a real
 *  socket/port; only `describeOperations` is ever called by that function. */
function fakeGatekeeperClient(operations: readonly Operation[]): GatekeeperClient {
  const notImplemented = (method: string) => async () => {
    throw new Error(`fakeGatekeeperClient: ${method} is not implemented`);
  };
  return {
    describeOperations: async () => ({ operations: [...operations] }),
    observe: notImplemented('observe'),
    simulate: notImplemented('simulate'),
    apply: notImplemented('apply'),
    revert: notImplemented('revert'),
    health: notImplemented('health'),
  };
}

const SAMPLE_MANIFEST: Operation[] = [
  {
    name: 'example.observe_thing',
    binding: { kind: 'http', method: 'GET', path: '/thing' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  },
  {
    name: 'example.execute_thing',
    binding: { kind: 'http', method: 'POST', path: '/thing' },
    params_schema: {},
    mode: 'execute',
    blast_radius: 'medium',
    reversibility: false,
    auto_approvable: false,
    await_decision: true,
    reads: [],
    writes: [],
  },
];

describe.runIf(DATABASE_URL !== undefined)('createWorkspace (integration, real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates a Workspace and an owner Principal whose api_key_hash matches the returned key', async () => {
    const result = await createWorkspace(pool, 'bootstrap-test-workspace', 'Test Owner');

    const row = await withWorkspace(
      pool,
      { workspaceId: result.workspaceId, principalId: result.ownerPrincipalId },
      async (client) => {
        const workspaceResult = await client.query<{ name: string }>(
          'select name from workspaces where id = $1',
          [result.workspaceId],
        );
        const principalResult = await client.query<{
          kind: string;
          role: string;
          display_name: string;
          api_key_hash: string;
        }>(
          'select kind, role, display_name, api_key_hash from principals where workspace_id = $1 and id = $2',
          [result.workspaceId, result.ownerPrincipalId],
        );
        return {
          workspaceName: workspaceResult.rows[0]?.name,
          principal: principalResult.rows[0],
        };
      },
    );

    expect(row.workspaceName).toBe('bootstrap-test-workspace');
    expect(row.principal?.kind).toBe('human');
    expect(row.principal?.role).toBe('owner');
    expect(row.principal?.display_name).toBe('Test Owner');
    expect(row.principal?.api_key_hash).toBe(hashApiKey(result.apiKey));
    // The raw key is never itself a valid sha256 hex digest of anything predictable — the real
    // assertion that matters is the one above (hash matches); this just confirms the key looks
    // like an opaque token, not e.g. the workspace id or a guessable string.
    expect(result.apiKey).not.toBe(result.workspaceId);
  });

  it('two calls produce different workspaces, principals, and API keys', async () => {
    const a = await createWorkspace(pool, 'bootstrap-test-workspace-a', 'Owner A');
    const b = await createWorkspace(pool, 'bootstrap-test-workspace-b', 'Owner B');

    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.ownerPrincipalId).not.toBe(b.ownerPrincipalId);
    expect(a.apiKey).not.toBe(b.apiKey);
  });

  it('adds a second, member-role Principal to an existing Workspace with its own API key', async () => {
    const owner = await createWorkspace(pool, 'bootstrap-test-workspace-add-principal', 'Alice');

    const bob = await addPrincipal(pool, owner.workspaceId, 'Bob');

    expect(bob.principalId).not.toBe(owner.ownerPrincipalId);
    expect(bob.apiKey).not.toBe(owner.apiKey);

    const row = await withWorkspace(
      pool,
      { workspaceId: owner.workspaceId, principalId: bob.principalId },
      async (client) => {
        const result = await client.query<{
          kind: string;
          role: string;
          display_name: string;
          api_key_hash: string;
        }>(
          'select kind, role, display_name, api_key_hash from principals where workspace_id = $1 and id = $2',
          [owner.workspaceId, bob.principalId],
        );
        return result.rows[0];
      },
    );

    expect(row?.kind).toBe('human');
    expect(row?.role).toBe('member');
    expect(row?.display_name).toBe('Bob');
    expect(row?.api_key_hash).toBe(hashApiKey(bob.apiKey));
  });

  it("rejects a role outside principals.role's CHECK constraint", async () => {
    // addPrincipal() itself does not re-validate `role` (the CLI's --role flag is what
    // RoleSchema.safeParse guards, in runAddPrincipal, before this function is ever called) —
    // this exercises the DB's own CHECK as the backstop for any other caller.
    const owner = await createWorkspace(pool, 'bootstrap-test-workspace-bad-role', 'Alice');
    await expect(
      addPrincipal(pool, owner.workspaceId, 'Eve', 'not-a-role' as never),
    ).rejects.toThrow();
  });

  describe('S2.6: platform meta-ontology + entry WorkerDefinition seeding', () => {
    it('publishes the platform meta-ontology and a published v1 entry WorkerDefinition', async () => {
      const owner = await createWorkspace(pool, 'bootstrap-test-workspace-s2-6', 'Alice');

      const rows = await withWorkspace(
        pool,
        { workspaceId: owner.workspaceId, principalId: owner.ownerPrincipalId },
        async (client) => {
          const ontologyResult = await client.query<{ status: string; definition: unknown }>(
            'select status, definition from ontology_versions where workspace_id = $1',
            [owner.workspaceId],
          );
          const workerDefResult = await client.query<{
            kind: string;
            status: string;
            version: number;
            proposed_by: string;
            published_by: string;
            definition: { systemPrompt?: string; capabilities?: string[]; model?: string };
          }>(
            'select kind, status, version, proposed_by, published_by, definition from worker_definitions where workspace_id = $1',
            [owner.workspaceId],
          );
          return { ontologyRows: ontologyResult.rows, workerDefRows: workerDefResult.rows };
        },
      );

      expect(rows.ontologyRows).toHaveLength(1);
      expect(rows.ontologyRows[0]?.status).toBe('published');
      expect(
        (rows.ontologyRows[0]?.definition as { objectTypes: { name: string }[] }).objectTypes.map(
          (t) => t.name,
        ),
      ).toContain('WorkerDefinition');

      expect(rows.workerDefRows).toHaveLength(1);
      const entryRow = rows.workerDefRows[0];
      expect(entryRow?.kind).toBe('entry');
      expect(entryRow?.status).toBe('published');
      expect(entryRow?.version).toBe(1);
      expect(entryRow?.proposed_by).toBe(owner.ownerPrincipalId);
      expect(entryRow?.published_by).toBe(owner.ownerPrincipalId);
      expect(entryRow?.definition.systemPrompt?.length).toBeGreaterThan(0);
      expect(entryRow?.definition.capabilities?.length).toBeGreaterThan(0);
      expect(entryRow?.definition.model).toBeUndefined();
    });

    it('--entry-model sets the seeded entry WorkerDefinition’s model field', async () => {
      const owner = await createWorkspace(pool, 'bootstrap-test-workspace-s2-6-model', 'Alice', {
        entryModel: 'example-provider/example-model',
      });

      const row = await withWorkspace(
        pool,
        { workspaceId: owner.workspaceId, principalId: owner.ownerPrincipalId },
        async (client) => {
          const result = await client.query<{ definition: { model?: string } }>(
            "select definition from worker_definitions where workspace_id = $1 and kind = 'entry'",
            [owner.workspaceId],
          );
          return result.rows[0];
        },
      );

      expect(row?.definition.model).toBe('example-provider/example-model');
    });
  });

  describe('registerGatekeeperFromCli (S2.5 manual registration path)', () => {
    it('registers a Gatekeeper and imports its manifest as drafts by default (no publish)', async () => {
      const owner = await createWorkspace(pool, 'bootstrap-test-workspace-register-gate', 'Alice');
      const client = fakeGatekeeperClient(SAMPLE_MANIFEST);

      const result = await registerGatekeeperFromCli(
        pool,
        {
          workspaceId: owner.workspaceId,
          principalId: owner.ownerPrincipalId,
          name: 'example-system',
          endpoint: 'https://gate.example.invalid',
          transportKind: 'http',
        },
        { gatekeeperClient: client },
      );

      expect(result.importedOperationNames.slice().sort()).toEqual([
        'example.execute_thing',
        'example.observe_thing',
      ]);
      expect(result.publishedOperationNames).toEqual([]);

      const record = await withWorkspace(
        pool,
        { workspaceId: owner.workspaceId, principalId: owner.ownerPrincipalId },
        (dbClient) =>
          getOperation(dbClient, owner.workspaceId, result.gatekeeperId, 'example.observe_thing'),
      );
      expect(record?.status).toBe('draft');
    });

    it('--publish true publishes every imported operation', async () => {
      const owner = await createWorkspace(
        pool,
        'bootstrap-test-workspace-register-gate-publish',
        'Alice',
      );
      const client = fakeGatekeeperClient(SAMPLE_MANIFEST);

      const result = await registerGatekeeperFromCli(
        pool,
        {
          workspaceId: owner.workspaceId,
          principalId: owner.ownerPrincipalId,
          name: 'example-system-2',
          endpoint: 'https://gate-2.example.invalid',
          transportKind: 'http',
          publish: true,
        },
        { gatekeeperClient: client },
      );

      expect(result.publishedOperationNames.slice().sort()).toEqual([
        'example.execute_thing',
        'example.observe_thing',
      ]);

      const record = await withWorkspace(
        pool,
        { workspaceId: owner.workspaceId, principalId: owner.ownerPrincipalId },
        (dbClient) =>
          getPublishedOperation(
            dbClient,
            owner.workspaceId,
            result.gatekeeperId,
            'example.execute_thing',
          ),
      );
      expect(record?.status).toBe('published');
    });
  });
});
