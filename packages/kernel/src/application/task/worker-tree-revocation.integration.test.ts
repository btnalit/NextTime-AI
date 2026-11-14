import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { type IssuedHandle, issueHandle } from '../../governance/capability/handles.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/keys.js';
import { WORKER_TREE_REVOKE_ATTEMPTS, revokeWorkerRunAndDescendants } from './lifecycle.js';

/**
 * application/task/worker-tree-revocation.integration.test (legacy 713): revoking a Worker tree
 * reaches a child its root spawned while the revocation ran. The spawn holds the root's Handle
 * `for share` while it creates the child (`invoke_worker` from a Worker, application/task/spawn.ts),
 * so revoking the root's Handle waits for it; the child's run and session are not in the tree the
 * revocation gathered before it waited. Runs as the kernel does, through `withWorkspace`.
 *
 * The revocation takes the grown tree again in one statement, after rolling back to a savepoint, so
 * a second revoker of the same tree never waits on it in a cycle (#1172 review); a tree that keeps
 * growing past its attempts is revoked in rounds.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const SCOPE: CapabilityScope = { capabilities: ['search'], resources: {} };

describe.runIf(DATABASE_URL !== undefined)(
  'application/task — revoking a Worker tree (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let workspaceId: string;
    let personId: string;
    let taskId: string;

    const asApp = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: personId }, fn);
    const asOwner = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: personId }, fn, { skipRoleSwitch: true });

    /** `requestedId` places the session in the lock order (sessions are taken ordered by id). */
    async function openWorkerSession(client: PoolClient, requestedId?: string): Promise<string> {
      const result = await client.query<{ id: string }>(
        `insert into sessions (id, workspace_id, principal_id, kind, on_behalf_of, status)
         values (coalesce($3::uuid, gen_random_uuid()), $1, $2, 'worker_run', $2, 'active')
         returning id`,
        [workspaceId, personId, requestedId ?? null],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('openWorkerSession: no row');
      return id;
    }

    async function insertRun(
      client: PoolClient,
      sessionId: string,
      parentRunId: string | null,
      depth: number,
    ): Promise<string> {
      const result = await client.query<{ id: string }>(
        `insert into worker_runs
           (workspace_id, status, task_id, parent_worker_run_id, session_id, depth, attempt)
         values ($1, 'running', $2, $3, $4, $5, 1) returning id`,
        [workspaceId, taskId, parentRunId, sessionId, depth],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('insertRun: no row');
      return id;
    }

    /** The root run: its session and a Handle on the person's role. */
    async function rootRun(): Promise<{ runId: string; handle: IssuedHandle }> {
      return asApp(async (client) => {
        const sessionId = await openWorkerSession(client);
        const runId = await insertRun(client, sessionId, null, 0);
        const handle = await issueHandle(client, {
          sessionId,
          scope: SCOPE,
          ttlSeconds: 3600,
          privateKey,
          basis: { kind: 'role', role: 'owner' },
        });
        return { runId, handle };
      });
    }

    /** What `spawn.ts` writes for a Worker's `invoke_worker`: the child run under `parentRunId`,
     *  a new session, and a Handle on the parent Handle's authority (read `for share`). */
    async function spawnChild(
      client: PoolClient,
      parentRunId: string,
      parent: IssuedHandle,
      depth: number,
      sessionIdToUse?: string,
    ): Promise<IssuedHandle> {
      const sessionId = await openWorkerSession(client, sessionIdToUse);
      await insertRun(client, sessionId, parentRunId, depth);
      return issueHandle(client, {
        sessionId,
        scope: SCOPE,
        ttlSeconds: 1800 / depth,
        privateKey,
        parentJti: parent.jti,
        basis: { kind: 'parent', parentJti: parent.jti },
      });
    }

    async function runOf(sessionId: string): Promise<string> {
      const result = await asApp((client) =>
        client.query<{ id: string }>(
          'select id from worker_runs where workspace_id = $1 and session_id = $2',
          [workspaceId, sessionId],
        ),
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error(`no run for session ${sessionId}`);
      return id;
    }

    /** Session ids that sort first or last among random ones. */
    const firstId = () => `0${randomUUID().slice(1)}`;
    const lastId = () => `f${randomUUID().slice(1)}`;

    async function handleState(jti: string): Promise<'valid' | 'revoked'> {
      const result = await asOwner((client) =>
        client.query<{ revoked: boolean }>(
          'select revoked_at is not null as revoked from capability_handles where jti = $1',
          [jti],
        ),
      );
      const row = result.rows[0];
      if (!row) throw new Error(`no Handle ${jti}`);
      return row.revoked ? 'revoked' : 'valid';
    }

    function latch(): { readonly wait: Promise<void>; readonly open: () => void } {
      let open!: () => void;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { wait, open };
    }

    async function waitUntilBlocked(fragment: string): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await pool.query<{ waiting: number }>(
          `select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and position($1 in query) > 0`,
          [fragment],
        );
        if ((rows[0]?.waiting ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no statement containing "${fragment}" ever waited on a lock`);
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;
      workspaceId = randomUUID();
      personId = randomUUID();
      await asOwner(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'worker-tree-revocation-test-workspace',
        ]);
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'owner', 'Worker Tree Fixture')`,
          [workspaceId, personId],
        );
      });
      taskId = await asApp(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version)
           values ($1, 'running', $2, $3, 1) returning id`,
          [workspaceId, personId, randomUUID()],
        );
        return result.rows[0]?.id as string;
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('revokes the whole tree, children and grandchildren', async () => {
      const root = await rootRun();
      const { child, grandchild } = await asApp(async (client) => {
        const child = await spawnChild(client, root.runId, root.handle, 1);
        const childRun = await client.query<{ id: string }>(
          'select id from worker_runs where workspace_id = $1 and session_id = $2',
          [workspaceId, child.sessionId],
        );
        const grandchild = await spawnChild(client, childRun.rows[0]?.id as string, child, 2);
        return { child, grandchild };
      });

      await asApp((client) => revokeWorkerRunAndDescendants(client, workspaceId, root.runId));

      expect(await handleState(root.handle.jti)).toBe('revoked');
      expect(await handleState(child.jti)).toBe('revoked');
      expect(await handleState(grandchild.jti)).toBe('revoked');
    });

    it('a child spawned while the revocation waits on the root’s Handle is revoked with it', async () => {
      const root = await rootRun();
      const spawned = latch();
      const commit = latch();
      let child: IssuedHandle | undefined;
      // The spawn: holds the root's Handle `for share` until it commits.
      const spawner = asApp(async (client) => {
        child = await spawnChild(client, root.runId, root.handle, 1);
        spawned.open();
        await commit.wait;
      });
      await spawned.wait;

      // The revocation gathers the tree (the child's run is not committed yet), then waits on the
      // root's Handle; the spawn commits; the revocation goes on.
      const revoker = asApp((client) =>
        revokeWorkerRunAndDescendants(client, workspaceId, root.runId),
      );
      await waitUntilBlocked('update capability_handles set revoked_at');
      commit.open();
      await spawner;
      await revoker;

      if (!child) throw new Error('no child Handle issued');
      expect(await handleState(root.handle.jti)).toBe('revoked');
      expect(await handleState(child.jti)).toBe('revoked');
    });

    it('a revoker of a subtree and one of the whole tree, with a grandchild spawned between them, both finish', async () => {
      const root = await rootRun();
      // The child's session sorts after the grandchild's, so the whole-tree revoker takes the
      // grandchild's row first.
      const child = await asApp((client) =>
        spawnChild(client, root.runId, root.handle, 1, lastId()),
      );
      const childRunId = await runOf(child.sessionId);

      // The grandchild's spawn holds the child's Handle `for share` until it commits.
      const spawned = latch();
      const commitSpawn = latch();
      let grandchild: IssuedHandle | undefined;
      const spawner = asApp(async (client) => {
        grandchild = await spawnChild(client, childRunId, child, 2, firstId());
        spawned.open();
        await commitSpawn.wait;
      });
      await spawned.wait;
      // So does another transaction, which keeps the subtree revoker waiting after the spawn commits.
      const held = latch();
      const release = latch();
      const holder = asApp(async (client) => {
        await client.query('select 1 from capability_handles where jti = $1 for share', [
          child.jti,
        ]);
        held.open();
        await release.wait;
      });
      await held.wait;

      // The subtree revoker takes the child's session and waits on its Handle.
      const subtree = asApp((client) =>
        revokeWorkerRunAndDescendants(client, workspaceId, childRunId),
      );
      await waitUntilBlocked('update capability_handles set revoked_at');
      commitSpawn.open();
      await spawner;
      // The whole-tree revoker sees the grandchild, takes its session and waits on the child's.
      const whole = asApp((client) =>
        revokeWorkerRunAndDescendants(client, workspaceId, root.runId),
      );
      await waitUntilBlocked('order by id for no key update');
      // The subtree revoker goes on and finds the grandchild. Taking its session now would close a
      // cycle with the whole-tree revoker (40P01).
      release.open();
      await holder;

      const outcomes = await Promise.allSettled([subtree, whole]);
      expect(outcomes.map((o) => (o.status === 'rejected' ? String(o.reason) : 'ok'))).toEqual([
        'ok',
        'ok',
      ]);
      if (!grandchild) throw new Error('no grandchild Handle issued');
      expect(await handleState(root.handle.jti)).toBe('revoked');
      expect(await handleState(child.jti)).toBe('revoked');
      expect(await handleState(grandchild.jti)).toBe('revoked');
    });

    it(`a tree that grows during each of its ${WORKER_TREE_REVOKE_ATTEMPTS} attempts is revoked in rounds`, async () => {
      const root = await rootRun();
      const children: IssuedHandle[] = [];
      const spawners: Promise<void>[] = [];
      /** A spawn under the root, holding the root's Handle `for share` until a revocation waits on
       *  it. Returns once the spawn holds it. */
      async function spawnUntilARevokerWaits(): Promise<void> {
        const spawned = latch();
        const spawner = asApp(async (client) => {
          children.push(await spawnChild(client, root.runId, root.handle, 1));
          spawned.open();
          await waitUntilBlocked('update capability_handles set revoked_at');
        });
        spawners.push(spawner);
        await Promise.race([spawned.wait, spawner]);
      }

      await spawnUntilARevokerWaits();
      let rollbacks = 0;
      let spawnFirst = false;
      await asApp((client) => {
        // After each rollback to the savepoint, another spawn starts before the next attempt, so
        // every attempt waits on one.
        const watched = new Proxy(client, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop !== 'query') return typeof value === 'function' ? value.bind(target) : value;
            return async (...args: unknown[]) => {
              if (spawnFirst) {
                spawnFirst = false;
                await spawnUntilARevokerWaits();
              }
              const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(
                target,
                args,
              );
              if (typeof args[0] === 'string' && args[0].startsWith('rollback to savepoint')) {
                rollbacks += 1;
                spawnFirst = rollbacks <= WORKER_TREE_REVOKE_ATTEMPTS + 1;
              }
              return result;
            };
          },
        });
        return revokeWorkerRunAndDescendants(watched, workspaceId, root.runId);
      });
      await Promise.all(spawners);

      expect(rollbacks).toBe(WORKER_TREE_REVOKE_ATTEMPTS);
      expect(children).toHaveLength(WORKER_TREE_REVOKE_ATTEMPTS + 1);
      for (const handle of [root.handle, ...children]) {
        expect(await handleState(handle.jti)).toBe('revoked');
      }
    });
  },
);
