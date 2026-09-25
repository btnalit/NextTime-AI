import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ListEnvelope,
  PlatformAuditRecordWire,
  PlatformWorkspaceWire,
  PurgeUsersResultWire,
  PurgeWorkspaceResultWire,
  UserMembershipWire,
  UserWire,
} from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  ResidentInventoryEntry,
  RuntimeImageInfo,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/index.js';
import { createPlatformAdmin, createUser } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { discoverWorkspaceScopedSchema, updatePlatformSettings } from '../platform/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { withAdminClient } from './auth.js';
import { dispatchCapability } from './dispatch.js';
import { PlatformAdminError } from './platform-handlers.js';
import type { PlatformErrorCode } from './platform-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/** S8 W5 (leftover 77): a minimal fake `TaskSupervisorClientPort` recording every
 *  `reclaimResident` call — `purge_workspace`'s `afterCommit` is the only thing this file's
 *  `purge_workspace reclaims entry containers` block below exercises against it; every other
 *  method throws if the handler ever reached it, the same "unused methods throw" convention
 *  `platform-runtime.integration.test.ts`'s `FakeRuntimeSupervisorClient` already uses. */
class FakeReclaimSupervisorClient implements TaskSupervisorClientPort {
  readonly reclaimedPrincipalIds: string[] = [];
  reclaimShouldThrow = false;

  async spawn(): Promise<TaskSpawnOutcome> {
    throw new Error('FakeReclaimSupervisorClient.spawn is not exercised by this test file');
  }
  async terminate(): Promise<boolean> {
    throw new Error('FakeReclaimSupervisorClient.terminate is not exercised by this test file');
  }
  async status(): Promise<TaskSupervisorStatus | undefined> {
    throw new Error('FakeReclaimSupervisorClient.status is not exercised by this test file');
  }
  async reclaimResident(principalId: string): Promise<boolean> {
    if (this.reclaimShouldThrow) throw new Error('simulated: worker-supervisor unreachable');
    this.reclaimedPrincipalIds.push(principalId);
    return true;
  }
  async listImages(): Promise<{
    defaultImage: string;
    images: RuntimeImageInfo[];
    allowedImages: readonly string[];
  }> {
    throw new Error('FakeReclaimSupervisorClient.listImages is not exercised by this test file');
  }
  async listResidents(): Promise<ResidentInventoryEntry[]> {
    throw new Error('FakeReclaimSupervisorClient.listResidents is not exercised by this test file');
  }
}

/**
 * application/gateway/platform-purge.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) coverage of the S6 purge plane — `purge_workspace` (preview and execution, every
 * refusal, the §4 cascade counts, the service-Handle warning, the never-activated-user cascade and
 * its "keep" cases), `purge_user`, the `disabled_at` clock `set_workspace_status` runs (migration
 * core 0030) and the `list_workspaces` / `list_users` filters the console's default views use
 * (docs/console-completion-plan.md §4, §5.2, §6, §12 决定 3 / 5).
 *
 * Drives `dispatchCapability` with a `channel: 'platform'` caller, the same seam
 * platform-capabilities.integration.test.ts uses, and — like that file — owns a private database:
 * `purge_user`'s guards and the platform audit stream are database-global, and the shared CI
 * database carries other files' users and administrators.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

const PASSWORD = 'correct horse battery staple';
const DAY_MS = 24 * 60 * 60 * 1000;

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

async function createIsolatedDatabase(): Promise<{
  readonly pool: Pool;
  readonly drop: () => Promise<void>;
}> {
  if (DATABASE_URL === undefined) throw new Error('createIsolatedDatabase needs DATABASE_URL');
  const cluster = createPool();
  const name = `nexttime_platform_purge_${randomUUID().replace(/-/g, '')}`;
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

interface SeededWorkspace {
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
  readonly ownerUserId: string;
  readonly ownerLogin: string;
}

interface SeededRows {
  readonly taskId: string;
  readonly servicePrincipalId: string;
}

describe.runIf(DATABASE_URL !== undefined)('S6 purge plane (integration, real Postgres)', () => {
  let pool: Pool;
  let dropDatabase: (() => Promise<void>) | undefined;
  let admin: UserRow;
  /** The platform default workspace — never purgeable; the "somewhere real" a kept user belongs to. */
  let homeWorkspaceId: string;

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

  function callAsAdmin<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    return dispatchCapability({ pool }, platformCaller(admin), name, params) as Promise<T>;
  }

  async function expectPlatformError(
    call: () => Promise<unknown>,
    code: PlatformErrorCode,
  ): Promise<void> {
    const thrown = await call().then(
      () => {
        throw new Error(`expected PlatformAdminError("${code}"), but the call resolved`);
      },
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(PlatformAdminError);
    expect((thrown as PlatformAdminError).code).toBe(code);
  }

  function adminQuery<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return withAdminClient(pool, async (client) => (await client.query<T>(sql, params)).rows);
  }

  async function countRows(workspaceId: string, table: string): Promise<number> {
    const rows = await adminQuery<{ n: string }>(
      `select count(*)::text as n from "${table}" where workspace_id = $1`,
      [workspaceId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  async function userExists(userId: string): Promise<boolean> {
    const rows = await adminQuery<{ id: string }>('select id from users where id = $1', [userId]);
    return rows.length === 1;
  }

  /** A workspace whose owner is a CLI-shaped, never-activated user (derived login, no password) —
   *  exactly what every acceptance run leaves behind. */
  async function seedWorkspace(input: {
    readonly name: string;
    readonly purpose?: 'standard' | 'ephemeral';
    readonly expiresAt?: Date | null;
  }): Promise<SeededWorkspace> {
    const created = await createWorkspaceWithOwner(pool, {
      name: input.name,
      owner: { displayName: `Owner of ${input.name}` },
      ontologyDir: ONTOLOGY_DIR,
      purpose: input.purpose ?? 'standard',
      expiresAt: input.expiresAt ?? null,
    });
    const [owner] = await adminQuery<{ user_id: string; login: string }>(
      `select p.user_id, u.login from principals p join users u on u.id = p.user_id
        where p.workspace_id = $1 and p.id = $2`,
      [created.workspaceId, created.ownerPrincipalId],
    );
    if (!owner) throw new Error('seedWorkspace: owner has no user');
    return {
      workspaceId: created.workspaceId,
      ownerPrincipalId: created.ownerPrincipalId,
      ownerUserId: owner.user_id,
      ownerLogin: owner.login,
    };
  }

  /** The §4 cascade's row kinds: a session + live Handle for the owner, a chat with two messages,
   *  a task with a worker run, a workspace audit row, and a `service` Principal (a collector)
   *  with its own session and live Handle — edge (a)'s trigger. */
  async function seedRows(ws: SeededWorkspace): Promise<SeededRows> {
    const ctx = { workspaceId: ws.workspaceId, principalId: ws.ownerPrincipalId };
    return withWorkspace(
      pool,
      ctx,
      async (client) => {
        const session = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'web', $2, 'active') returning id`,
          [ws.workspaceId, ws.ownerPrincipalId],
        );
        await client.query(
          `insert into capability_handles (workspace_id, jti, session_id, on_behalf_of, scope, expires_at)
           values ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
          [
            ws.workspaceId,
            randomUUID(),
            session.rows[0]?.id,
            ws.ownerPrincipalId,
            JSON.stringify({ capabilities: [], resources: {} }),
          ],
        );
        const chat = await client.query<{ id: string }>(
          `insert into chats (workspace_id, owner_principal_id, title, visibility)
           values ($1, $2, 'purge test chat', 'private') returning id`,
          [ws.workspaceId, ws.ownerPrincipalId],
        );
        await client.query(
          `insert into chat_messages (workspace_id, chat_id, role, content, sequence)
           values ($1, $2, 'user', $3::jsonb, 1), ($1, $2, 'assistant', $4::jsonb, 2)`,
          [
            ws.workspaceId,
            chat.rows[0]?.id,
            JSON.stringify({ text: 'hello' }),
            JSON.stringify({ text: 'hi there' }),
          ],
        );
        const task = await client.query<{ id: string }>(
          `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version)
           values ($1, 'completed', $2, $3, 1) returning id`,
          [ws.workspaceId, ws.ownerPrincipalId, randomUUID()],
        );
        await client.query(
          `insert into worker_runs (workspace_id, status, task_id, session_id, depth, attempt)
           values ($1, 'terminated', $2, $3, 0, 1)`,
          [ws.workspaceId, task.rows[0]?.id, session.rows[0]?.id],
        );
        await client.query(
          `insert into audit_records (workspace_id, actor_principal_id, action)
           values ($1, $2, 'purge.test')`,
          [ws.workspaceId, ws.ownerPrincipalId],
        );
        const service = await client.query<{ id: string }>(
          `insert into principals (workspace_id, kind, role, display_name)
           values ($1, 'service', 'member', 'host-inventory') returning id`,
          [ws.workspaceId],
        );
        const serviceSession = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'service', $2, 'active') returning id`,
          [ws.workspaceId, service.rows[0]?.id],
        );
        await client.query(
          `insert into capability_handles (workspace_id, jti, session_id, on_behalf_of, scope, expires_at)
           values ($1, $2, $3, $4, $5, now() + interval '30 days')`,
          [
            ws.workspaceId,
            randomUUID(),
            serviceSession.rows[0]?.id,
            service.rows[0]?.id,
            JSON.stringify({ capabilities: ['register_source'], resources: {} }),
          ],
        );
        return {
          taskId: task.rows[0]?.id as string,
          servicePrincipalId: service.rows[0]?.id as string,
        };
      },
      { skipRoleSwitch: true },
    );
  }

  beforeAll(async () => {
    const isolated = await createIsolatedDatabase();
    pool = isolated.pool;
    dropDatabase = isolated.drop;
    await runMigrations(pool, MIGRATIONS_DIR);

    admin = await createPlatformAdmin(pool, {
      login: `purge-admin-${randomUUID().slice(0, 8)}`,
      displayName: 'Purge Admin',
      password: PASSWORD,
    });
    const home = await createWorkspaceWithOwner(pool, {
      name: 'purge-home-workspace',
      owner: { userId: admin.id, displayName: 'Purge Admin' },
      ontologyDir: ONTOLOGY_DIR,
    });
    homeWorkspaceId = home.workspaceId;
    await withAdminClient(pool, (client) =>
      updatePlatformSettings(client, { defaultWorkspaceId: homeWorkspaceId }, null),
    );
  }, 180_000);

  afterAll(async () => {
    await dropDatabase?.();
  }, 60_000);

  // ---- refusals ----------------------------------------------------------------------------------

  describe('purge_workspace refusals', () => {
    it('the platform default workspace → default_workspace, even as a preview', async () => {
      await expectPlatformError(
        () => callAsAdmin('purge_workspace', { workspaceId: homeWorkspaceId }),
        'default_workspace',
      );
    });

    it('an active standard workspace → workspace_active; disabled just now → retention_not_elapsed', async () => {
      const ws = await seedWorkspace({ name: 'purge-active' });
      await expectPlatformError(
        () => callAsAdmin('purge_workspace', { workspaceId: ws.workspaceId, confirm: true }),
        'workspace_active',
      );
      await callAsAdmin('set_workspace_status', {
        workspaceId: ws.workspaceId,
        status: 'disabled',
      });
      await expectPlatformError(
        () => callAsAdmin('purge_workspace', { workspaceId: ws.workspaceId, confirm: true }),
        'retention_not_elapsed',
      );
      // Nothing was touched by the refusals.
      expect(await countRows(ws.workspaceId, 'principals')).toBe(1);
      expect(await userExists(ws.ownerUserId)).toBe(true);
    });

    it('an unexpired ephemeral workspace → workspace_active; an unknown id → workspace_not_found', async () => {
      const ws = await seedWorkspace({
        name: 'purge-ephemeral-fresh',
        purpose: 'ephemeral',
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
      });
      await expectPlatformError(
        () => callAsAdmin('purge_workspace', { workspaceId: ws.workspaceId }),
        'workspace_active',
      );
      await expectPlatformError(
        () => callAsAdmin('purge_workspace', { workspaceId: randomUUID(), confirm: true }),
        'workspace_not_found',
      );
    });
  });

  // ---- the disabled_at clock (migration core 0030) -------------------------------------------------

  describe('set_workspace_status and disabled_at', () => {
    it('disabling stamps disabledAt (not purgeable for 7 days); re-enabling clears it; a pre-0030 null is purgeable at once', async () => {
      const ws = await seedWorkspace({ name: 'purge-clock' });
      const disabled = await callAsAdmin<PlatformWorkspaceWire>('set_workspace_status', {
        workspaceId: ws.workspaceId,
        status: 'disabled',
      });
      expect(disabled.status).toBe('disabled');
      expect(disabled.disabledAt).not.toBeNull();
      expect(disabled.purgeable).toBe(false);

      const enabled = await callAsAdmin<PlatformWorkspaceWire>('set_workspace_status', {
        workspaceId: ws.workspaceId,
        status: 'active',
      });
      expect(enabled.disabledAt).toBeNull();
      expect(enabled.purgeable).toBe(false);

      await callAsAdmin('set_workspace_status', {
        workspaceId: ws.workspaceId,
        status: 'disabled',
      });
      // Disabling an already-disabled workspace keeps the original clock.
      const again = await callAsAdmin<PlatformWorkspaceWire>('set_workspace_status', {
        workspaceId: ws.workspaceId,
        status: 'disabled',
      });
      expect(again.disabledAt).not.toBeNull();

      // §12 决定 3: a row disabled before migration 0030 carries no timestamp — purgeable now.
      await adminQuery('update workspaces set disabled_at = null where id = $1', [ws.workspaceId]);
      const listed = await callAsAdmin<ListEnvelope<PlatformWorkspaceWire>>('list_workspaces', {
        status: 'disabled',
      });
      const row = listed.items.find((item) => item.id === ws.workspaceId);
      expect(row?.disabledAt).toBeNull();
      expect(row?.purgeable).toBe(true);
    });

    it('a workspace disabled 8 days ago is purgeable with reason disabled_retention_elapsed', async () => {
      const ws = await seedWorkspace({ name: 'purge-retention' });
      await callAsAdmin('set_workspace_status', {
        workspaceId: ws.workspaceId,
        status: 'disabled',
      });
      await adminQuery(
        `update workspaces set disabled_at = now() - interval '8 days' where id = $1`,
        [ws.workspaceId],
      );
      const result = await callAsAdmin<PurgeWorkspaceResultWire>('purge_workspace', {
        workspaceId: ws.workspaceId,
        confirm: true,
      });
      expect(result.executed).toBe(true);
      expect(result.reason).toBe('disabled_retention_elapsed');
      expect(await userExists(ws.ownerUserId)).toBe(false);
    });
  });

  // ---- preview vs execute, cascade, edges ----------------------------------------------------------

  describe('purge_workspace on an expired ephemeral workspace', () => {
    let ws: SeededWorkspace;
    let rows: SeededRows;
    /** A never-activated member whose *other* membership is in the home workspace — kept. */
    let memberElsewhere: UserRow;
    /** A never-activated member referenced by a platform audit row — kept. */
    let memberAudited: UserRow;
    /** A never-activated member who somehow logged in once (a console session row) — kept. */
    let memberWithSession: UserRow;
    let schemaTables: readonly string[];

    beforeAll(async () => {
      ws = await seedWorkspace({
        name: 'purge-ephemeral-expired',
        purpose: 'ephemeral',
        expiresAt: new Date(Date.now() - 60_000),
      });
      rows = await seedRows(ws);
      // Three more never-activated users with a membership here, each with one reason to survive.
      memberElsewhere = await createUser(pool, {
        login: `kept-elsewhere-${randomUUID().slice(0, 8)}`,
        displayName: 'Kept Elsewhere',
      });
      memberAudited = await createUser(pool, {
        login: `kept-audited-${randomUUID().slice(0, 8)}`,
        displayName: 'Kept Audited',
      });
      memberWithSession = await createUser(pool, {
        login: `kept-session-${randomUUID().slice(0, 8)}`,
        displayName: 'Kept Session',
      });
      for (const user of [memberElsewhere, memberAudited, memberWithSession]) {
        await callAsAdmin('add_membership', {
          userId: user.id,
          workspaceId: ws.workspaceId,
          role: 'member',
        });
      }
      await callAsAdmin('add_membership', {
        userId: memberElsewhere.id,
        workspaceId: homeWorkspaceId,
        role: 'member',
      });
      await adminQuery(
        `insert into audit_records (workspace_id, actor_principal_id, actor_user_id, action)
         values (null, null, $1, 'purge.test.platform_row')`,
        [memberAudited.id],
      );
      await adminQuery(
        `insert into user_sessions (user_id, expires_at) values ($1, now() + interval '1 hour')`,
        [memberWithSession.id],
      );
      schemaTables = (
        await withAdminClient(pool, (client) => discoverWorkspaceScopedSchema(client))
      ).tables;
    }, 120_000);

    it('preview (no confirm): counts, the service-Handle warning and the users that would go — and nothing deleted', async () => {
      const preview = await callAsAdmin<PurgeWorkspaceResultWire>('purge_workspace', {
        workspaceId: ws.workspaceId,
      });
      expect(preview.executed).toBe(false);
      expect(preview.reason).toBe('ephemeral_expired');
      expect(preview.purpose).toBe('ephemeral');
      expect(preview.status).toBe('active');
      expect(preview.counts.chatMessages).toBe(2);
      expect(preview.counts.chats).toBe(1);
      expect(preview.counts.tasks).toBe(1);
      expect(preview.counts.workerRuns).toBe(1);
      expect(preview.counts.capabilityHandles).toBe(2);
      expect(preview.counts.sessions).toBe(2);
      // owner + service + the three added members
      expect(preview.counts.principals).toBe(5);
      expect(preview.counts.auditRecords).toBeGreaterThanOrEqual(1);
      expect(preview.totalRows).toBe(Object.values(preview.counts).reduce((sum, n) => sum + n, 0));
      expect(preview.activeHandles).toBe(2);
      expect(preview.warnings).toEqual([
        {
          kind: 'service_handle_in_use',
          principalId: rows.servicePrincipalId,
          name: 'host-inventory',
          activeHandles: 1,
        },
      ]);
      // Edge (b): only the CLI-shaped owner goes; the three kept users are not listed.
      expect(preview.purgedUsers).toEqual([{ id: ws.ownerUserId, login: ws.ownerLogin }]);
      expect(preview.taskIds).toEqual([rows.taskId]);
      expect(preview.principalIds).toContain(ws.ownerPrincipalId);
      expect(preview.principalIds).toContain(rows.servicePrincipalId);
      expect(preview.principalIds).toHaveLength(5);

      // A preview deletes nothing.
      expect(await countRows(ws.workspaceId, 'chat_messages')).toBe(2);
      expect(await countRows(ws.workspaceId, 'capability_handles')).toBe(2);
      expect(await countRows(ws.workspaceId, 'principals')).toBe(5);
      expect(await userExists(ws.ownerUserId)).toBe(true);
      const stillThere = await adminQuery<{ id: string }>(
        'select id from workspaces where id = $1',
        [ws.workspaceId],
      );
      expect(stillThere).toHaveLength(1);
      // No handle was revoked by the preview either.
      const live = await adminQuery<{ n: string }>(
        'select count(*)::text as n from capability_handles where workspace_id = $1 and revoked_at is null',
        [ws.workspaceId],
      );
      expect(live[0]?.n).toBe('2');
    });

    it('execute (confirm: true): the whole cascade, the owner cascaded, the three referenced users kept, the platform audit row written', async () => {
      const result = await callAsAdmin<PurgeWorkspaceResultWire>('purge_workspace', {
        workspaceId: ws.workspaceId,
        confirm: true,
      });
      expect(result.executed).toBe(true);
      expect(result.reason).toBe('ephemeral_expired');
      expect(result.counts.chatMessages).toBe(2);
      expect(result.counts.capabilityHandles).toBe(2);
      expect(result.counts.principals).toBe(5);
      expect(result.counts.users).toBe(1);
      expect(result.activeHandles).toBe(2);
      expect(result.warnings).toHaveLength(1);
      expect(result.purgedUsers).toEqual([{ id: ws.ownerUserId, login: ws.ownerLogin }]);
      expect(result.taskIds).toEqual([rows.taskId]);

      // Every workspace-scoped table is empty for the purged workspace — discovered the same way
      // the cascade discovers them, so a table a future migration adds cannot be missed.
      for (const table of schemaTables) {
        expect(await countRows(ws.workspaceId, table)).toBe(0);
      }
      expect(
        await adminQuery<{ id: string }>('select id from workspaces where id = $1', [
          ws.workspaceId,
        ]),
      ).toHaveLength(0);

      // Edge (b): the owner is gone; each kept user is still there with its reason intact.
      expect(await userExists(ws.ownerUserId)).toBe(false);
      expect(await userExists(memberElsewhere.id)).toBe(true);
      expect(await userExists(memberAudited.id)).toBe(true);
      expect(await userExists(memberWithSession.id)).toBe(true);
      const elsewhere = await callAsAdmin<ListEnvelope<UserMembershipWire>>(
        'list_user_memberships',
        { userId: memberElsewhere.id },
      );
      expect(elsewhere.items.map((m) => m.workspaceId)).toEqual([homeWorkspaceId]);

      // The home workspace is untouched.
      expect(await countRows(homeWorkspaceId, 'principals')).toBeGreaterThan(0);

      // The append-only triggers are back on: a delete on audit_records raises again.
      await expect(
        adminQuery(`delete from audit_records where action = 'purge.test.platform_row'`),
      ).rejects.toThrow(/append-only/);

      // Platform audit: the call's own row (params carry confirm) plus the cascade's row with
      // the counts, both found by the target-workspace filter.
      const byWorkspace = await callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>(
        'platform_audit_query',
        { targetWorkspaceId: ws.workspaceId },
      );
      const actions = byWorkspace.items.map((item) => item.action);
      expect(actions).toContain('purge_workspace');
      expect(actions).toContain('platform.workspace_purged');
      const purgedRow = byWorkspace.items.find(
        (item) => item.action === 'platform.workspace_purged',
      );
      expect(purgedRow?.resourceType).toBe('workspace');
      expect(purgedRow?.resourceId).toBe(ws.workspaceId);
      expect(purgedRow?.actorUserId).toBe(admin.id);
      expect(purgedRow?.payload).toMatchObject({
        params: { workspaceId: ws.workspaceId },
        workspaceName: 'purge-ephemeral-expired',
        reason: 'ephemeral_expired',
        forced: false,
        counts: { chatMessages: 2, principals: 5, users: 1 },
        purgedUsers: [{ id: ws.ownerUserId, login: ws.ownerLogin }],
        taskIds: [rows.taskId],
      });
      expect((purgedRow?.payload.warnings as unknown[]).length).toBe(1);

      // The workspace is gone from the platform list.
      const listed = await callAsAdmin<ListEnvelope<PlatformWorkspaceWire>>('list_workspaces');
      expect(listed.items.find((item) => item.id === ws.workspaceId)).toBeUndefined();
    });

    it('a second purge of the same id → workspace_not_found', async () => {
      await expectPlatformError(
        () => callAsAdmin('purge_workspace', { workspaceId: ws.workspaceId, confirm: true }),
        'workspace_not_found',
      );
    });
  });

  // ---- purge_workspace reclaims entry containers (S8 W5 leftover 77) ----------------------------

  describe('purge_workspace reclaims entry containers (S8 W5 leftover 77)', () => {
    let supervisor: FakeReclaimSupervisorClient;

    beforeEach(async () => {
      supervisor = new FakeReclaimSupervisorClient();
      const { privateKey } = await generateEphemeralHandleKeyPair();
      configureTaskRuntime({ pool, privateKey, supervisorClient: supervisor });
    });

    afterEach(() => {
      resetTaskRuntimeForTests();
    });

    it('execute (confirm: true): calls reclaimResident once per purged principal id, after commit', async () => {
      const ws = await seedWorkspace({
        name: `purge-reclaim-${randomUUID().slice(0, 8)}`,
        purpose: 'ephemeral',
        expiresAt: new Date(Date.now() - 60_000),
      });
      const rows = await seedRows(ws);

      const result = await callAsAdmin<PurgeWorkspaceResultWire>('purge_workspace', {
        workspaceId: ws.workspaceId,
        confirm: true,
      });
      expect(result.executed).toBe(true);
      expect(result.principalIds).toHaveLength(2); // owner + the service Principal seedRows adds
      expect(result.principalIds).toContain(ws.ownerPrincipalId);
      expect(result.principalIds).toContain(rows.servicePrincipalId);

      // dispatchCapability awaits `afterCommit` before resolving (dispatch.ts) and
      // reclaimEntryContainers itself awaits every reclaimResident call — no poll/wait needed.
      expect(supervisor.reclaimedPrincipalIds.sort()).toEqual([...result.principalIds].sort());
    });

    it('preview (no confirm): never calls reclaimResident — nothing was actually purged', async () => {
      const ws = await seedWorkspace({
        name: `purge-reclaim-preview-${randomUUID().slice(0, 8)}`,
        purpose: 'ephemeral',
        expiresAt: new Date(Date.now() - 60_000),
      });
      await seedRows(ws);

      const preview = await callAsAdmin<PurgeWorkspaceResultWire>('purge_workspace', {
        workspaceId: ws.workspaceId,
      });
      expect(preview.executed).toBe(false);
      expect(supervisor.reclaimedPrincipalIds).toEqual([]);

      // Clean up so this workspace doesn't linger for later assertions in this describe block.
      await callAsAdmin('purge_workspace', { workspaceId: ws.workspaceId, confirm: true });
    });

    it('a reclaim failure (worker-supervisor unreachable) never fails the purge itself', async () => {
      supervisor.reclaimShouldThrow = true;
      const ws = await seedWorkspace({
        name: `purge-reclaim-fails-${randomUUID().slice(0, 8)}`,
        purpose: 'ephemeral',
        expiresAt: new Date(Date.now() - 60_000),
      });
      await seedRows(ws);

      const result = await callAsAdmin<PurgeWorkspaceResultWire>('purge_workspace', {
        workspaceId: ws.workspaceId,
        confirm: true,
      });
      expect(result.executed).toBe(true);
      expect(supervisor.reclaimedPrincipalIds).toEqual([]);
    });
  });

  // ---- purge_user --------------------------------------------------------------------------------

  describe('purge_user', () => {
    it('purges never-activated users without an active membership; skips every other kind with its reason', async () => {
      const suffix = randomUUID().slice(0, 8);
      const orphan = await createUser(pool, { login: `orphan-${suffix}`, displayName: 'Orphan' });
      const removed = await createUser(pool, {
        login: `removed-${suffix}`,
        displayName: 'Removed',
      });
      const activated = await createUser(pool, {
        login: `activated-${suffix}`,
        displayName: 'Activated',
        password: PASSWORD,
      });
      const active = await createUser(pool, { login: `active-${suffix}`, displayName: 'Active' });
      const referenced = await createUser(pool, {
        login: `referenced-${suffix}`,
        displayName: 'Referenced',
      });
      const withSession = await createUser(pool, {
        login: `session-${suffix}`,
        displayName: 'Session',
      });
      const pendingAdmin = await createUser(pool, {
        login: `pending-admin-${suffix}`,
        displayName: 'Pending Admin',
        platformRole: 'admin',
      });

      // `removed`: a membership that was removed (disabled Principal) — detached, then purged.
      await callAsAdmin('add_membership', {
        userId: removed.id,
        workspaceId: homeWorkspaceId,
        role: 'member',
      });
      await callAsAdmin('remove_membership', { userId: removed.id, workspaceId: homeWorkspaceId });
      // `active`: a live membership — must be removed first.
      await callAsAdmin('add_membership', {
        userId: active.id,
        workspaceId: homeWorkspaceId,
        role: 'member',
      });
      await adminQuery(
        `insert into audit_records (workspace_id, actor_principal_id, actor_user_id, action)
         values (null, null, $1, 'purge.test.user_reference')`,
        [referenced.id],
      );
      await adminQuery(
        `insert into user_sessions (user_id, expires_at) values ($1, now() + interval '1 hour')`,
        [withSession.id],
      );

      const unknownId = randomUUID();
      const result = await callAsAdmin<PurgeUsersResultWire>('purge_user', {
        userIds: [
          orphan.id,
          removed.id,
          activated.id,
          active.id,
          referenced.id,
          withSession.id,
          pendingAdmin.id,
          unknownId,
        ],
      });
      expect(result.purgedCount).toBe(2);
      expect(result.outcomes).toEqual([
        { userId: orphan.id, login: orphan.login, status: 'purged' },
        { userId: removed.id, login: removed.login, status: 'purged' },
        { userId: activated.id, login: activated.login, status: 'skipped', reason: 'activated' },
        { userId: active.id, login: active.login, status: 'skipped', reason: 'active_membership' },
        {
          userId: referenced.id,
          login: referenced.login,
          status: 'skipped',
          reason: 'referenced',
          detail: 'audit_records.actor_user_id (1)',
        },
        {
          userId: withSession.id,
          login: withSession.login,
          status: 'skipped',
          reason: 'has_sessions',
        },
        {
          userId: pendingAdmin.id,
          login: pendingAdmin.login,
          status: 'skipped',
          reason: 'platform_admin',
        },
        { userId: unknownId, login: null, status: 'skipped', reason: 'user_not_found' },
      ]);

      expect(await userExists(orphan.id)).toBe(false);
      expect(await userExists(removed.id)).toBe(false);
      for (const kept of [activated, active, referenced, withSession, pendingAdmin]) {
        expect(await userExists(kept.id)).toBe(true);
      }
      // The removed membership's Principal row stays, detached, for audit lineage.
      const detached = await adminQuery<{ user_id: string | null; disabled_at: Date | null }>(
        `select user_id, disabled_at from principals where workspace_id = $1 and display_name = 'Removed'`,
        [homeWorkspaceId],
      );
      expect(detached).toHaveLength(1);
      expect(detached[0]?.user_id).toBeNull();
      expect(detached[0]?.disabled_at).not.toBeNull();

      // One platform.user_purged row per purged user, found by the target-user filter.
      const audit = await callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>(
        'platform_audit_query',
        { targetUserId: removed.id },
      );
      const purgedRow = audit.items.find((item) => item.action === 'platform.user_purged');
      expect(purgedRow?.resourceType).toBe('user');
      expect(purgedRow?.resourceId).toBe(removed.id);
      expect(purgedRow?.payload).toMatchObject({
        login: removed.login,
        params: { userId: removed.id },
      });
      expect((purgedRow?.payload.detachedPrincipals as unknown[]).length).toBe(1);
    });
  });

  // ---- list filters ------------------------------------------------------------------------------

  describe('list filters', () => {
    let expired: SeededWorkspace;
    let live: SeededWorkspace;
    let disabledWs: SeededWorkspace;

    beforeAll(async () => {
      expired = await seedWorkspace({
        name: 'filter-expired',
        purpose: 'ephemeral',
        expiresAt: new Date(Date.now() - 60_000),
      });
      live = await seedWorkspace({
        name: 'filter-live',
        purpose: 'ephemeral',
        expiresAt: new Date(Date.now() + DAY_MS),
      });
      disabledWs = await seedWorkspace({ name: 'filter-disabled' });
      await callAsAdmin('set_workspace_status', {
        workspaceId: disabledWs.workspaceId,
        status: 'disabled',
      });
    }, 120_000);

    it('list_workspaces: no filter lists everything; status / purpose narrow; includeExpired: false hides the expired ephemeral', async () => {
      const all = await callAsAdmin<ListEnvelope<PlatformWorkspaceWire>>('list_workspaces');
      const ids = (items: readonly PlatformWorkspaceWire[]) => items.map((item) => item.id);
      expect(ids(all.items)).toEqual(
        expect.arrayContaining([expired.workspaceId, live.workspaceId, disabledWs.workspaceId]),
      );
      expect(all.items.find((item) => item.id === expired.workspaceId)?.purgeable).toBe(true);
      expect(all.items.find((item) => item.id === live.workspaceId)?.purgeable).toBe(false);

      const defaultView = await callAsAdmin<ListEnvelope<PlatformWorkspaceWire>>(
        'list_workspaces',
        { status: 'active', includeExpired: false },
      );
      expect(ids(defaultView.items)).not.toContain(expired.workspaceId);
      expect(ids(defaultView.items)).not.toContain(disabledWs.workspaceId);
      expect(ids(defaultView.items)).toContain(live.workspaceId);

      const ephemeral = await callAsAdmin<ListEnvelope<PlatformWorkspaceWire>>('list_workspaces', {
        purpose: 'ephemeral',
      });
      expect(ephemeral.items.every((item) => item.purpose === 'ephemeral')).toBe(true);
      expect(ids(ephemeral.items)).toEqual(
        expect.arrayContaining([expired.workspaceId, live.workspaceId]),
      );

      const explicitInclude = await callAsAdmin<ListEnvelope<PlatformWorkspaceWire>>(
        'list_workspaces',
        { includeExpired: true },
      );
      expect(ids(explicitInclude.items)).toContain(expired.workspaceId);
    });

    it('list_users: hideResidual drops never-activated users whose memberships are all in disabled / ephemeral workspaces; pendingOnly keeps only hasPassword: false', async () => {
      const logins = (items: readonly UserWire[]) => items.map((item) => item.login);
      const all = await callAsAdmin<ListEnvelope<UserWire>>('list_users', { limit: 200 });
      expect(logins(all.items)).toEqual(
        expect.arrayContaining([
          expired.ownerLogin,
          live.ownerLogin,
          disabledWs.ownerLogin,
          admin.login,
        ]),
      );

      const hidden = await callAsAdmin<ListEnvelope<UserWire>>('list_users', {
        hideResidual: true,
        limit: 200,
      });
      // Owners of the two ephemeral and the disabled workspace are residual — hidden.
      expect(logins(hidden.items)).not.toContain(expired.ownerLogin);
      expect(logins(hidden.items)).not.toContain(live.ownerLogin);
      expect(logins(hidden.items)).not.toContain(disabledWs.ownerLogin);
      // A real account, and a never-activated user with a membership in the home workspace, stay.
      expect(logins(hidden.items)).toContain(admin.login);

      const pending = await callAsAdmin<ListEnvelope<UserWire>>('list_users', {
        pendingOnly: true,
        limit: 200,
      });
      expect(pending.items.every((item) => item.hasPassword === false)).toBe(true);
      expect(logins(pending.items)).toContain(expired.ownerLogin);
      expect(logins(pending.items)).not.toContain(admin.login);
    });
  });
});
