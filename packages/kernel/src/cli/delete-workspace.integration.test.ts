import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../adapters/db/pool.js';
import {
  DeleteWorkspaceRefusedError,
  computeWorkspaceTableDeletionOrder,
  createWorkspace,
  deleteWorkspace,
  discoverWorkspaceScopedSchema,
  inspectWorkspace,
} from './bootstrap.js';

/**
 * cli/delete-workspace.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) end-to-end coverage for `deleteWorkspace` — creates a Workspace with a
 * Principal, a Chat with messages, a Task with a WorkerRun, a Capability Handle, and an Audit
 * Record, then deletes it and asserts zero rows remain in every workspace-scoped table
 * (discovered the same way `deleteWorkspace` itself does, via `discoverWorkspaceScopedSchema` —
 * not a hand-maintained table list that could drift from it) while a second, untouched Workspace
 * keeps all of its own rows. Also confirms the `links`/`audit_records` append-only triggers this
 * function deliberately disables mid-transaction (I4/I11 — see `deleteWorkspace`'s own doc
 * comment in bootstrap.ts) are back to enabled once the transaction commits, and that
 * `computeWorkspaceTableDeletionOrder` accepts the *real* live schema without throwing (the pure
 * unit tests in bootstrap.test.ts only exercise it against fabricated schemas).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)('deleteWorkspace (integration, real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('computeWorkspaceTableDeletionOrder accepts the real live schema without throwing', async () => {
    const schema = await withWorkspace(
      pool,
      { workspaceId: randomUUID(), principalId: randomUUID() },
      (client) => discoverWorkspaceScopedSchema(client),
      { skipRoleSwitch: true },
    );

    const order = computeWorkspaceTableDeletionOrder(schema);

    expect(order.length).toBeGreaterThan(0);
    expect(order.length).toBe(schema.tables.length);

    // A handful of known parent/child relationships (migrations/**/*.sql) — every one of these
    // must have the child strictly before the parent in the computed order.
    const before = (child: string, parent: string) => {
      expect(order.indexOf(child)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(parent)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(child)).toBeLessThan(order.indexOf(parent));
    };
    before('capability_handles', 'sessions');
    before('sessions', 'principals');
    before('chat_messages', 'chats');
    before('worker_runs', 'tasks');
    before('evidence', 'links');
    before('conflicts', 'links');
    before('links', 'objects');
  });

  it('deletes a Workspace and every row of its own across all workspace-scoped tables, leaving another Workspace untouched', async () => {
    const ts = Date.now();
    const target = await createWorkspace(pool, `delete-workspace-target-${ts}`, 'Target Owner');
    const control = await createWorkspace(pool, `delete-workspace-control-${ts}`, 'Control Owner');

    const targetCtx = { workspaceId: target.workspaceId, principalId: target.ownerPrincipalId };

    const sessionId = await withWorkspace(pool, targetCtx, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, 'web', $2, 'active') returning id`,
        [target.workspaceId, target.ownerPrincipalId],
      );
      return result.rows[0]?.id as string;
    });

    await withWorkspace(pool, targetCtx, (client) =>
      client.query(
        `insert into capability_handles (workspace_id, jti, session_id, on_behalf_of, scope, expires_at)
         values ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
        [
          target.workspaceId,
          randomUUID(),
          sessionId,
          target.ownerPrincipalId,
          JSON.stringify({ capabilities: [], resources: {} }),
        ],
      ),
    );

    const chatId = await withWorkspace(pool, targetCtx, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into chats (workspace_id, owner_principal_id, title, visibility)
         values ($1, $2, 'delete-workspace test chat', 'private') returning id`,
        [target.workspaceId, target.ownerPrincipalId],
      );
      return result.rows[0]?.id as string;
    });

    await withWorkspace(pool, targetCtx, (client) =>
      client.query(
        `insert into chat_messages (workspace_id, chat_id, role, content, sequence)
         values ($1, $2, 'user', $3::jsonb, 1), ($1, $2, 'assistant', $4::jsonb, 2)`,
        [
          target.workspaceId,
          chatId,
          JSON.stringify({ text: 'hello' }),
          JSON.stringify({ text: 'hi there' }),
        ],
      ),
    );

    const taskId = await withWorkspace(pool, targetCtx, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version)
         values ($1, 'completed', $2, $3, 1) returning id`,
        [target.workspaceId, target.ownerPrincipalId, randomUUID()],
      );
      return result.rows[0]?.id as string;
    });

    await withWorkspace(pool, targetCtx, (client) =>
      client.query(
        `insert into worker_runs (workspace_id, status, task_id, session_id, depth, attempt)
         values ($1, 'terminated', $2, $3, 0, 1)`,
        [target.workspaceId, taskId, sessionId],
      ),
    );

    const auditId = await withWorkspace(pool, targetCtx, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into audit_records (workspace_id, actor_principal_id, action)
         values ($1, $2, 'delete-workspace.test') returning id`,
        [target.workspaceId, target.ownerPrincipalId],
      );
      return result.rows[0]?.id as string;
    });
    expect(auditId).toBeTruthy();

    // Sanity: the target workspace really does hold rows in more than the handful just inserted
    // above (createWorkspace's own S2.6 seeding also wrote ontology_versions/worker_definitions).
    const schema = await withWorkspace(
      pool,
      { workspaceId: randomUUID(), principalId: randomUUID() },
      (client) => discoverWorkspaceScopedSchema(client),
      { skipRoleSwitch: true },
    );
    const countFor = async (workspaceId: string, table: string): Promise<number> =>
      withWorkspace(
        pool,
        { workspaceId: randomUUID(), principalId: randomUUID() },
        async (client) => {
          const result = await client.query<{ count: string }>(
            `select count(*)::bigint as count from "${table}" where workspace_id = $1`,
            [workspaceId],
          );
          return Number(result.rows[0]?.count ?? 0);
        },
        { skipRoleSwitch: true },
      );

    expect(await countFor(target.workspaceId, 'ontology_versions')).toBeGreaterThan(0);
    expect(await countFor(target.workspaceId, 'worker_definitions')).toBeGreaterThan(0);

    const result = await deleteWorkspace(pool, target.workspaceId);

    expect(result.workspaceId).toBe(target.workspaceId);
    expect(result.name).toBe(`delete-workspace-target-${ts}`);
    expect(result.principalIds).toEqual([target.ownerPrincipalId]);
    expect(result.taskIds).toEqual([taskId]);
    expect(result.deletedCounts.get('chat_messages')).toBe(2);
    expect(result.deletedCounts.get('capability_handles')).toBe(1);
    expect(result.deletedCounts.get('audit_records')).toBe(1);
    expect(result.deletedCounts.get('tasks')).toBe(1);
    expect(result.deletedCounts.get('worker_runs')).toBe(1);
    expect(result.deletedCounts.get('chats')).toBe(1);
    expect(result.deletedCounts.get('sessions')).toBe(1);
    expect(result.deletedCounts.get('principals')).toBe(1);

    // Every workspace-scoped table — not just the ones seeded above — has zero rows left for the
    // deleted workspace. Uses the exact same table discovery `deleteWorkspace` itself relied on,
    // so this assertion can never silently miss a table a future migration adds.
    for (const table of schema.tables) {
      expect(await countFor(target.workspaceId, table)).toBe(0);
    }

    // The workspace row itself is gone.
    expect(await inspectWorkspace(pool, target.workspaceId)).toBeNull();

    // The control workspace is completely untouched.
    const controlInfo = await inspectWorkspace(pool, control.workspaceId);
    expect(controlInfo?.principalCount).toBe(1);
    expect(await countFor(control.workspaceId, 'ontology_versions')).toBeGreaterThan(0);
    expect(await countFor(control.workspaceId, 'worker_definitions')).toBeGreaterThan(0);

    // The append-only triggers `deleteWorkspace` disabled mid-transaction to delete `links`/
    // `audit_records` rows are back to enabled now that the transaction has committed — the one
    // deliberate override of I4/I11 never outlives this single call.
    const triggerStates = await withWorkspace(
      pool,
      { workspaceId: randomUUID(), principalId: randomUUID() },
      async (client) => {
        const rows = await client.query<{ tgname: string; tgenabled: string }>(
          `select tgname, tgenabled from pg_trigger
           where tgname in ('links_immutable_delete', 'audit_records_no_delete')`,
        );
        return new Map(rows.rows.map((row) => [row.tgname, row.tgenabled]));
      },
      { skipRoleSwitch: true },
    );
    expect(triggerStates.get('links_immutable_delete')).toBe('O');
    expect(triggerStates.get('audit_records_no_delete')).toBe('O');

    // The re-enabled trigger actually still blocks a direct delete attempt against a real row
    // (not merely "enabled" in the catalog but somehow inert) — seed one in the untouched control
    // workspace and confirm deleting it is refused exactly as it would be for any ordinary write
    // path (I11).
    await withWorkspace(
      pool,
      { workspaceId: control.workspaceId, principalId: control.ownerPrincipalId },
      (client) =>
        client.query(
          `insert into audit_records (workspace_id, actor_principal_id, action)
           values ($1, $2, 'delete-workspace.trigger-check')`,
          [control.workspaceId, control.ownerPrincipalId],
        ),
    );
    await expect(
      withWorkspace(
        pool,
        { workspaceId: control.workspaceId, principalId: randomUUID() },
        (client) =>
          client.query('delete from audit_records where workspace_id = $1', [control.workspaceId]),
        { skipRoleSwitch: true },
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects deleting a workspace that does not exist', async () => {
    await expect(deleteWorkspace(pool, randomUUID())).rejects.toThrow(DeleteWorkspaceRefusedError);
  });
});
