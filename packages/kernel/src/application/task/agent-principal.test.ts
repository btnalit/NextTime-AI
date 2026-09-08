import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { ensureWorkerAgentPrincipal } from './agent-principal.js';

/**
 * application/task/agent-principal.test: DB-gated (real Postgres; auto-skip without DATABASE_URL)
 * tests for `ensureWorkerAgentPrincipal` — one agent-kind Principal per (workspace,
 * WorkerDefinition), created lazily and idempotently (design decision replacing PR #84's
 * `CallerPrincipal.viaAgent`; see this module's own doc comment and
 * migrations/core/0014_worker_agent_principals.sql's header comment for the full rationale).
 *
 * Covers: two sequential calls for the same WorkerDefinition return the same principal id;
 * concurrent calls (two separate transactions racing the same INSERT) also converge on one row;
 * `display_name` self-heals on a later call with a different `definitionName`; the
 * `kind='agent' whenever worker_definition_id is not null` CHECK constraint rejects a
 * `kind='human'` row naming a WorkerDefinition.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'ensureWorkerAgentPrincipal (integration, real Postgres)',
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

    async function adminInsertPrincipal(displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', $3)",
            [workspaceId, id, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function makeWorkerDefinition(name: string): Promise<string> {
      const proposed = await inTx((client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You are a plain worker.', name },
        }),
      );
      await inTx((client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      return proposed.id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('agent-principal-test');
      ownerId = await adminInsertPrincipal('owner');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('two sequential calls for the same WorkerDefinition return the same principal id', async () => {
      const definitionId = await makeWorkerDefinition(`ops-runner-${randomUUID()}`);

      const first = await inTx((client) =>
        ensureWorkerAgentPrincipal(client, workspaceId, definitionId, 'ops-runner'),
      );
      const second = await inTx((client) =>
        ensureWorkerAgentPrincipal(client, workspaceId, definitionId, 'ops-runner'),
      );

      expect(second).toBe(first);

      const rows = await inTx((client) =>
        client.query<{ count: string }>(
          'select count(*)::bigint as count from principals where workspace_id = $1 and worker_definition_id = $2',
          [workspaceId, definitionId],
        ),
      );
      expect(rows.rows[0]?.count).toBe('1');
    });

    it('the row is kind=agent, role=member, api_key_hash null, display_name worker:<name>', async () => {
      const definitionId = await makeWorkerDefinition(`db-runner-${randomUUID()}`);
      const principalId = await inTx((client) =>
        ensureWorkerAgentPrincipal(client, workspaceId, definitionId, 'db-runner'),
      );

      const row = await inTx((client) =>
        client.query<{
          kind: string;
          role: string;
          display_name: string | null;
          api_key_hash: string | null;
        }>(
          'select kind, role, display_name, api_key_hash from principals where workspace_id = $1 and id = $2',
          [workspaceId, principalId],
        ),
      );
      const principal = row.rows[0];
      expect(principal?.kind).toBe('agent');
      expect(principal?.role).toBe('member');
      expect(principal?.display_name).toBe('worker:db-runner');
      expect(principal?.api_key_hash).toBeNull();
    });

    it('concurrent first-spawns of the same WorkerDefinition converge on one principal id', async () => {
      const definitionId = await makeWorkerDefinition(`concurrent-runner-${randomUUID()}`);

      const [a, b] = await Promise.all([
        inTx((client) =>
          ensureWorkerAgentPrincipal(client, workspaceId, definitionId, 'concurrent-runner'),
        ),
        inTx((client) =>
          ensureWorkerAgentPrincipal(client, workspaceId, definitionId, 'concurrent-runner'),
        ),
      ]);

      expect(a).toBe(b);

      const rows = await inTx((client) =>
        client.query<{ count: string }>(
          'select count(*)::bigint as count from principals where workspace_id = $1 and worker_definition_id = $2',
          [workspaceId, definitionId],
        ),
      );
      expect(rows.rows[0]?.count).toBe('1');
    });

    it('a later call self-heals display_name when the definitionName argument changes', async () => {
      const definitionId = await makeWorkerDefinition(`renamed-runner-${randomUUID()}`);

      const principalId = await inTx((client) =>
        ensureWorkerAgentPrincipal(client, workspaceId, definitionId, 'old-name'),
      );
      const again = await inTx((client) =>
        ensureWorkerAgentPrincipal(client, workspaceId, definitionId, 'new-name'),
      );
      expect(again).toBe(principalId);

      const row = await inTx((client) =>
        client.query<{ display_name: string | null }>(
          'select display_name from principals where workspace_id = $1 and id = $2',
          [workspaceId, principalId],
        ),
      );
      expect(row.rows[0]?.display_name).toBe('worker:new-name');
    });

    it('different WorkerDefinitions in the same workspace get different agent principals', async () => {
      const definitionIdA = await makeWorkerDefinition(`runner-a-${randomUUID()}`);
      const definitionIdB = await makeWorkerDefinition(`runner-b-${randomUUID()}`);

      const a = await inTx((client) =>
        ensureWorkerAgentPrincipal(client, workspaceId, definitionIdA, 'runner-a'),
      );
      const b = await inTx((client) =>
        ensureWorkerAgentPrincipal(client, workspaceId, definitionIdB, 'runner-b'),
      );

      expect(a).not.toBe(b);
    });

    it('the kind=agent-whenever-worker_definition_id-is-set CHECK constraint rejects a kind=human row naming a WorkerDefinition', async () => {
      const definitionId = await makeWorkerDefinition(`checked-runner-${randomUUID()}`);

      await expect(
        inTx((client) =>
          client.query(
            "insert into principals (workspace_id, kind, role, worker_definition_id, display_name) values ($1, 'human', 'member', $2, 'not-an-agent')",
            [workspaceId, definitionId],
          ),
        ),
      ).rejects.toThrow(/principals_worker_definition_id_requires_agent/);
    });
  },
);
