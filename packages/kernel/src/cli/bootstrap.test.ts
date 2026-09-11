import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import { exportPKCS8, exportSPKI } from 'jose';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../adapters/db/pool.js';
import type { GatekeeperClient } from '../adapters/gatekeeper-client/index.js';
import { hashApiKey } from '../application/gateway/index.js';
import {
  createPlatformAdmin,
  derivedLogin,
  findUserById,
  findUserByLogin,
  setUserPassword,
} from '../application/identity/index.js';
import {
  generateEphemeralHandleKeyPair,
  loadHandleKeyPair,
  verifyHandle,
} from '../governance/capability/index.js';
import { getOperation, getPublishedOperation } from '../governance/gatekeepers/index.js';
import {
  WorkspaceDeletionOrderCycleError,
  addPrincipal,
  checkDeleteWorkspaceGuards,
  computeWorkspaceTableDeletionOrder,
  createWorkspace,
  issueServiceHandleFromCli,
  parseDeleteWorkspaceArgs,
  registerGatekeeperFromCli,
  seedDomainPackFromCli,
} from './bootstrap.js';
import type { WorkspaceScopedSchema } from './bootstrap.js';

/**
 * cli/bootstrap.test: two kinds of coverage for `bootstrap.ts`.
 *
 * `delete-workspace — pure functions (no DB)` below runs unconditionally (no Postgres needed):
 * `computeWorkspaceTableDeletionOrder`'s topological sort against fabricated `pg_constraint`-
 * shaped input (task brief: "unit with fakes ... incl. a self-reference and a two-level chain"),
 * and `parseDeleteWorkspaceArgs`/`checkDeleteWorkspaceGuards`'s argument/guard logic.
 *
 * The `describe.runIf(...)` block after it is the original integration coverage (real Postgres;
 * auto-skip without DATABASE_URL) for `create-workspace` (docs/development-tasks.md S1.3, item
 * 6) and `add-principal` (docs/development-tasks.md S1.10) — the workspace/principal rows exist
 * afterward, the printed API key resolves back to that Principal via the human channel's own
 * hashing (`application/gateway/auth.ts`'s `hashApiKey`, which `bootstrap.ts` itself calls — see
 * its module doc), and only the hash, never the raw key, is stored. `delete-workspace`'s own
 * integration coverage lives in the sibling `delete-workspace.integration.test.ts` (this
 * package's `*.integration.test.ts` convention).
 */

describe('computeWorkspaceTableDeletionOrder (pure, no DB)', () => {
  it('orders a simple two-level chain: the referencing (child) table before the referenced (parent) table', () => {
    const schema: WorkspaceScopedSchema = {
      tables: ['principals', 'sessions'],
      foreignKeys: [{ childTable: 'sessions', parentTable: 'principals' }],
    };

    expect(computeWorkspaceTableDeletionOrder(schema)).toEqual(['sessions', 'principals']);
  });

  it('orders a three-level chain end to end (grandchild, then child, then root)', () => {
    const schema: WorkspaceScopedSchema = {
      tables: ['workspaces_scoped_a', 'workspaces_scoped_b', 'workspaces_scoped_c'],
      foreignKeys: [
        { childTable: 'workspaces_scoped_b', parentTable: 'workspaces_scoped_a' },
        { childTable: 'workspaces_scoped_c', parentTable: 'workspaces_scoped_b' },
      ],
    };

    expect(computeWorkspaceTableDeletionOrder(schema)).toEqual([
      'workspaces_scoped_c',
      'workspaces_scoped_b',
      'workspaces_scoped_a',
    ]);
  });

  it('drops a self-referencing foreign key entirely — no ordering constraint, no cycle error', () => {
    // Mirrors links.supersedes_id / capability_handles.parent_jti / worker_runs.
    // parent_worker_run_id: a table whose only foreign key (besides ones to other tables) points
    // at itself.
    const schema: WorkspaceScopedSchema = {
      tables: ['links', 'principals'],
      foreignKeys: [
        { childTable: 'links', parentTable: 'links' },
        { childTable: 'links', parentTable: 'principals' },
      ],
    };

    const order = computeWorkspaceTableDeletionOrder(schema);
    expect(order).toEqual(['links', 'principals']);
  });

  it('handles a table with multiple foreign keys to the same parent (e.g. proposed_by + published_by)', () => {
    const schema: WorkspaceScopedSchema = {
      tables: ['principals', 'worker_definitions'],
      foreignKeys: [
        { childTable: 'worker_definitions', parentTable: 'principals' },
        { childTable: 'worker_definitions', parentTable: 'principals' },
      ],
    };

    expect(computeWorkspaceTableDeletionOrder(schema)).toEqual([
      'worker_definitions',
      'principals',
    ]);
  });

  it('ignores a foreign key to a table outside the workspace-scoped set (e.g. -> workspaces)', () => {
    const schema: WorkspaceScopedSchema = {
      tables: ['principals'],
      foreignKeys: [{ childTable: 'principals', parentTable: 'workspaces' }],
    };

    expect(computeWorkspaceTableDeletionOrder(schema)).toEqual(['principals']);
  });

  it('produces a valid order for a diamond (two children of one parent, one grandchild of both)', () => {
    const schema: WorkspaceScopedSchema = {
      tables: ['root', 'left', 'right', 'leaf'],
      foreignKeys: [
        { childTable: 'left', parentTable: 'root' },
        { childTable: 'right', parentTable: 'root' },
        { childTable: 'leaf', parentTable: 'left' },
        { childTable: 'leaf', parentTable: 'right' },
      ],
    };

    const order = computeWorkspaceTableDeletionOrder(schema);
    expect(order.indexOf('leaf')).toBeLessThan(order.indexOf('left'));
    expect(order.indexOf('leaf')).toBeLessThan(order.indexOf('right'));
    expect(order.indexOf('left')).toBeLessThan(order.indexOf('root'));
    expect(order.indexOf('right')).toBeLessThan(order.indexOf('root'));
    expect(order).toHaveLength(4);
  });

  it('throws WorkspaceDeletionOrderCycleError for a genuine (non-self) cycle', () => {
    const schema: WorkspaceScopedSchema = {
      tables: ['a', 'b'],
      foreignKeys: [
        { childTable: 'a', parentTable: 'b' },
        { childTable: 'b', parentTable: 'a' },
      ],
    };

    expect(() => computeWorkspaceTableDeletionOrder(schema)).toThrow(
      WorkspaceDeletionOrderCycleError,
    );
  });
});

describe('parseDeleteWorkspaceArgs (pure, no DB)', () => {
  it('parses a bare workspaceId with --yes', () => {
    const args = parseDeleteWorkspaceArgs(['ws-1', '--yes']);
    expect(args).toEqual({
      workspaceId: 'ws-1',
      yes: true,
      expectedName: undefined,
      allowNamePattern: undefined,
    });
  });

  it('defaults yes to false when --yes is not present', () => {
    const args = parseDeleteWorkspaceArgs(['ws-1']);
    expect(args.yes).toBe(false);
  });

  it('parses --name', () => {
    const args = parseDeleteWorkspaceArgs(['ws-1', '--yes', '--name', 'accept-s2-123']);
    expect(args.expectedName).toBe('accept-s2-123');
  });

  it('parses --allow-name-pattern into a RegExp', () => {
    const args = parseDeleteWorkspaceArgs(['ws-1', '--yes', '--allow-name-pattern', '^accept-']);
    expect(args.allowNamePattern).toBeInstanceOf(RegExp);
    expect(args.allowNamePattern?.source).toBe('^accept-');
  });

  it('throws when no positional workspaceId is given', () => {
    expect(() => parseDeleteWorkspaceArgs([])).toThrow(/usage: bootstrap delete-workspace/);
  });

  it('throws when the first token looks like a flag instead of a workspaceId', () => {
    expect(() => parseDeleteWorkspaceArgs(['--yes'])).toThrow(/usage: bootstrap delete-workspace/);
  });

  it('throws when --allow-name-pattern is not a valid regular expression', () => {
    expect(() =>
      parseDeleteWorkspaceArgs(['ws-1', '--yes', '--allow-name-pattern', '[unterminated']),
    ).toThrow(/not a valid regular expression/);
  });
});

describe('checkDeleteWorkspaceGuards (pure, no DB)', () => {
  it('refuses without --yes', () => {
    const result = checkDeleteWorkspaceGuards({ workspaceId: 'ws-1', yes: false }, 'accept-s2-123');
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/--yes/) });
  });

  it('passes when --yes is given and no --name/--allow-name-pattern were supplied', () => {
    const result = checkDeleteWorkspaceGuards({ workspaceId: 'ws-1', yes: true }, 'anything');
    expect(result).toEqual({ ok: true });
  });

  it("refuses when --name does not match the workspace's actual stored name", () => {
    const result = checkDeleteWorkspaceGuards(
      { workspaceId: 'ws-1', yes: true, expectedName: 'accept-s2-999' },
      'accept-s2-123',
    );
    expect(result.ok).toBe(false);
  });

  it("passes when --name matches the workspace's actual stored name", () => {
    const result = checkDeleteWorkspaceGuards(
      { workspaceId: 'ws-1', yes: true, expectedName: 'accept-s2-123' },
      'accept-s2-123',
    );
    expect(result).toEqual({ ok: true });
  });

  it('refuses when the workspace name does not match --allow-name-pattern', () => {
    const result = checkDeleteWorkspaceGuards(
      { workspaceId: 'ws-1', yes: true, allowNamePattern: /^accept-/ },
      'web-smoke-prod',
    );
    expect(result.ok).toBe(false);
  });

  it('passes when the workspace name matches --allow-name-pattern', () => {
    const result = checkDeleteWorkspaceGuards(
      { workspaceId: 'ws-1', yes: true, allowNamePattern: /^accept-/ },
      'accept-s2-123',
    );
    expect(result).toEqual({ ok: true });
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

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
    storeConnectedAccount: notImplemented('storeConnectedAccount'),
    deleteConnectedAccount: notImplemented('deleteConnectedAccount'),
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
          user_id: string | null;
        }>(
          'select kind, role, display_name, api_key_hash, user_id from principals where workspace_id = $1 and id = $2',
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

    // S4.1: the owner principal is linked to a passwordless user with the derived login
    // (application/identity's `ensureUserForHumanPrincipal`).
    expect(row.principal?.user_id).toBeTruthy();
    expect(result.ownerLogin).toBe(derivedLogin('Test Owner', result.ownerPrincipalId));
    const ownerUser = await findUserById(pool, row.principal?.user_id as string);
    expect(ownerUser?.login).toBe(result.ownerLogin);
    expect(ownerUser?.hasPassword).toBe(false);
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
          user_id: string | null;
        }>(
          'select kind, role, display_name, api_key_hash, user_id from principals where workspace_id = $1 and id = $2',
          [owner.workspaceId, bob.principalId],
        );
        return result.rows[0];
      },
    );

    expect(row?.kind).toBe('human');
    expect(row?.role).toBe('member');
    expect(row?.display_name).toBe('Bob');
    expect(row?.api_key_hash).toBe(hashApiKey(bob.apiKey));

    // S4.1: same passwordless-user linkage as the owner principal (see the createWorkspace test
    // above).
    expect(row?.user_id).toBeTruthy();
    expect(bob.login).toBe(derivedLogin('Bob', bob.principalId));
    const bobUser = await findUserById(pool, row?.user_id as string);
    expect(bobUser?.login).toBe(bob.login);
    expect(bobUser?.hasPassword).toBe(false);
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

  describe('seedDomainPackFromCli / issueServiceHandleFromCli (S3.3 collector bootstrap seam)', () => {
    it('seedDomainPackFromCli publishes ops-assets-v1.yaml; a second call publishes v2 of the same family', async () => {
      const owner = await createWorkspace(
        pool,
        'bootstrap-test-workspace-seed-domain-pack',
        'Alice',
      );

      const v1 = await seedDomainPackFromCli(pool, {
        workspaceId: owner.workspaceId,
        principalId: owner.ownerPrincipalId,
        packName: 'ops-assets',
        fileName: 'ops-assets-v1.yaml',
        dir: ONTOLOGY_DIR,
      });
      expect(v1.version).toBe(1);

      const v2 = await seedDomainPackFromCli(pool, {
        workspaceId: owner.workspaceId,
        principalId: owner.ownerPrincipalId,
        packName: 'ops-assets',
        fileName: 'ops-assets-v1.yaml',
        dir: ONTOLOGY_DIR,
      });
      expect(v2.id).toBe(v1.id); // same family
      expect(v2.version).toBe(2);
    });

    describe('with a Handle signing keypair on disk', () => {
      let keyDir: string;
      let savedPrivateKeyFile: string | undefined;
      let savedPublicKeyFile: string | undefined;

      beforeEach(async () => {
        keyDir = await mkdtemp(path.join(tmpdir(), 'nexttime-issue-service-handle-test-'));
        const keyPair = await generateEphemeralHandleKeyPair();
        const [privatePem, publicPem] = await Promise.all([
          exportPKCS8(keyPair.privateKey),
          exportSPKI(keyPair.publicKey),
        ]);
        const privateKeyFile = path.join(keyDir, 'handle.key');
        const publicKeyFile = path.join(keyDir, 'handle.pub');
        await writeFile(privateKeyFile, privatePem, 'utf8');
        await writeFile(publicKeyFile, publicPem, 'utf8');

        savedPrivateKeyFile = process.env.HANDLE_PRIVATE_KEY_FILE;
        savedPublicKeyFile = process.env.HANDLE_PUBLIC_KEY_FILE;
        process.env.HANDLE_PRIVATE_KEY_FILE = privateKeyFile;
        process.env.HANDLE_PUBLIC_KEY_FILE = publicKeyFile;
      });

      afterEach(async () => {
        process.env.HANDLE_PRIVATE_KEY_FILE = savedPrivateKeyFile;
        process.env.HANDLE_PUBLIC_KEY_FILE = savedPublicKeyFile;
        await rm(keyDir, { recursive: true, force: true });
      });

      it('mints a service Principal + a Handle whose claims verify and carry exactly the given scope', async () => {
        const owner = await createWorkspace(
          pool,
          'bootstrap-test-workspace-issue-service-handle',
          'Alice',
        );

        const result = await issueServiceHandleFromCli(pool, {
          workspaceId: owner.workspaceId,
          name: 'host-inventory-test',
          scope: ['register_source', 'submit_observations'],
        });

        expect(result.principalId).toBeTruthy();
        expect(result.token).toBeTruthy();

        const claims = await verifyHandle(result.token, {
          publicKey: (await loadHandleKeyPair()).publicKey,
          isRevoked: () => false,
        });
        expect(claims.ws).toBe(owner.workspaceId);
        expect(claims.obo).toBe(result.principalId);
        expect(claims.scope.capabilities.slice().sort()).toEqual([
          'register_source',
          'submit_observations',
        ]);

        const principalRow = await withWorkspace(
          pool,
          { workspaceId: owner.workspaceId, principalId: owner.ownerPrincipalId },
          (client) =>
            client.query<{ kind: string; display_name: string | null }>(
              'select kind, display_name from principals where workspace_id = $1 and id = $2',
              [owner.workspaceId, result.principalId],
            ),
        );
        expect(principalRow.rows[0]?.kind).toBe('service');
        expect(principalRow.rows[0]?.display_name).toBe('host-inventory-test');
      });

      it('re-running with the same --name reuses the same service Principal (a fresh Session/Handle each time)', async () => {
        const owner = await createWorkspace(
          pool,
          'bootstrap-test-workspace-issue-service-handle-reuse',
          'Alice',
        );

        const first = await issueServiceHandleFromCli(pool, {
          workspaceId: owner.workspaceId,
          name: 'host-inventory-reuse-test',
          scope: ['register_source'],
        });
        const second = await issueServiceHandleFromCli(pool, {
          workspaceId: owner.workspaceId,
          name: 'host-inventory-reuse-test',
          scope: ['register_source'],
        });

        expect(second.principalId).toBe(first.principalId);
        expect(second.sessionId).not.toBe(first.sessionId);
        expect(second.jti).not.toBe(first.jti);
      });

      it('rejects an unknown capability name in --scope before minting anything', async () => {
        const owner = await createWorkspace(
          pool,
          'bootstrap-test-workspace-issue-service-handle-bad-scope',
          'Alice',
        );

        await expect(
          issueServiceHandleFromCli(pool, {
            workspaceId: owner.workspaceId,
            name: 'host-inventory-bad-scope-test',
            scope: ['this_capability_does_not_exist'],
          }),
        ).rejects.toMatchObject({ name: 'ScopeValidationError' });
      });
    });
  });

  describe('createPlatformAdmin (S4.1 CLI fallback — bootstrap.js create-platform-admin)', () => {
    it('--temporary (mustChangePassword: true) yields must_change_password = true', async () => {
      const user = await createPlatformAdmin(pool, {
        login: `bootstrap-test-admin-${randomUUID()}`,
        displayName: 'Test Admin',
        password: 'a-strong-enough-password',
        mustChangePassword: true,
      });

      expect(user.platformRole).toBe('admin');
      expect(user.hasPassword).toBe(true);
      expect(user.mustChangePassword).toBe(true);
    });

    it('omitting mustChangePassword defaults to false', async () => {
      const user = await createPlatformAdmin(pool, {
        login: `bootstrap-test-admin-${randomUUID()}`,
        displayName: 'Test Admin',
        password: 'a-strong-enough-password',
      });

      expect(user.mustChangePassword).toBe(false);
    });
  });

  describe('set-password effect (S4.1 CLI fallback — bootstrap.js set-password)', () => {
    it('gives an existing passwordless user a password, honoring --temporary', async () => {
      const owner = await createWorkspace(pool, 'bootstrap-test-workspace-set-password', 'Carol');

      const before = await findUserByLogin(pool, owner.ownerLogin);
      expect(before?.hasPassword).toBe(false);

      // Same two steps `runSetPassword` takes internally: look the user up by login, then set
      // its password with --temporary's mustChangePassword shape.
      await setUserPassword(pool, before?.id as string, 'a-strong-enough-password', {
        mustChangePassword: true,
      });

      const after = await findUserByLogin(pool, owner.ownerLogin);
      expect(after?.hasPassword).toBe(true);
      expect(after?.mustChangePassword).toBe(true);
    });
  });
});
