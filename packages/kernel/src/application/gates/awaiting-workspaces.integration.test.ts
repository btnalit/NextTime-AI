import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { withPlatform } from '../../adapters/db/platform-context.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { readAwaitingWorkspaces } from './awaiting-workspaces.js';
import { ENABLING_WORKSPACES_LIMIT, insertGateLink, upsertAnnouncement } from './store.js';

/**
 * application/gates/awaiting-workspaces.integration.test (legacy 895, #493's T1 on #1536): what
 * `readAwaitingWorkspaces` hands the platform when many workspaces await one gate — at most
 * `ENABLING_WORKSPACES_LIMIT` of them, the uncut count beside them, workspaces by name (not by id,
 * nor by when they enabled the gate, which is how `enablingWorkspaces` is ordered) and each one's
 * Operation names sorted. The read crosses from the platform plane into each workspace, so it runs
 * here as the platform does, in `withPlatform`.
 *
 * The fixture: one platform gate instance whose manifest in effect runs `/v2` for two Operations,
 * and 21 workspaces linked to it that each published `/v1` — so every one of them awaits the gate
 * (`workspace_revision`). Workspace names run in neither the id order nor the order the workspaces
 * linked the gate, and the first workspace by name published its two Operations in the opposite
 * order to their names.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const ADMIN_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
const WORKSPACE_COUNT = ENABLING_WORKSPACES_LIMIT + 1;

function operation(name: string, version: 'v1' | 'v2'): Operation {
  return {
    name,
    description: 'An awaiting-workspaces fixture operation.',
    binding: { kind: 'http', method: 'GET', path: `/${version}/stock` },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/gates — the workspaces a platform gate awaits (integration, real Postgres)',
  () => {
    let pool: Pool;
    const tag = randomUUID().slice(0, 8);
    const gateId = `awaiting-895-${tag}`;
    const zeta = `awaiting.zeta.${tag}`;
    const alpha = `awaiting.alpha.${tag}`;
    /** By workspace name, which is neither by id nor by link order. */
    const byName: { id: string; name: string }[] = [];

    const asAdmin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ADMIN_PLACEHOLDER, principalId: ADMIN_PLACEHOLDER }, fn, {
        skipRoleSwitch: true,
      });

    /** A workspace with an owner, a Gatekeeper that published `names` (in that order) at `/v1`,
     *  linked to the gate instance. */
    async function linkWorkspace(id: string, name: string, names: readonly string[]) {
      const ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'awaiting owner')`,
            [id, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      const inWorkspace = <T>(fn: (client: PoolClient) => Promise<T>) =>
        withWorkspace(pool, { workspaceId: id, principalId: ownerId }, fn);
      const activityId = await inWorkspace(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by)
           values ($1, 'test.awaiting-workspaces', 'running', $2) returning id`,
          [id, ownerId],
        );
        return result.rows[0]?.id as string;
      });
      const { gatekeeperId } = await inWorkspace((client) =>
        registerGatekeeper(client, id, {
          name: `awaiting-gate-${tag}`,
          transportKind: 'http',
          target: 'example-system',
          endpoint: `https://awaiting-${randomUUID()}.example.invalid`,
          activityId,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );
      await inWorkspace((client) =>
        importManifest(client, id, {
          gatekeeperId,
          operations: names.map((n) => operation(n, 'v1')),
          proposedBy: { id: ownerId, kind: 'human' },
          activityId,
        }),
      );
      // One transaction each: the workspace's published list comes back in this order.
      for (const n of names) {
        await inWorkspace((client) => publishOperation(client, id, { gatekeeperId, name: n }));
      }
      await inWorkspace((client) =>
        insertGateLink(client, {
          workspaceId: id,
          gateId,
          gatekeeperObjectId: gatekeeperId,
          enabledBy: ownerId,
        }),
      );
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      await asAdmin(async (client) => {
        await upsertAnnouncement(
          client,
          {
            gateId,
            connector: `awaiting-${tag}`,
            transportKind: 'http',
            endpoint: `https://awaiting-gate-${tag}.example.invalid`,
            operations: [operation(alpha, 'v2'), operation(zeta, 'v2')],
          },
          'gate',
        );
        await client.query(`update gate_instances set status = 'enabled' where gate_id = $1`, [
          gateId,
        ]);
      });
      // Names are a scrambled permutation of the id order (8 is coprime with 21), and the
      // workspaces are linked in id order: neither the id order, ascending or descending, nor the
      // link order is the name order.
      const ids = Array.from({ length: WORKSPACE_COUNT }, () => randomUUID()).sort();
      for (const [i, id] of ids.entries()) {
        const rank = (i * 8) % WORKSPACE_COUNT;
        const name = `awaiting-${tag}-${String(rank).padStart(2, '0')}`;
        byName.push({ id, name });
        // The first by name published zeta, then alpha.
        await linkWorkspace(id, name, rank === 0 ? [zeta, alpha] : [zeta]);
      }
      byName.sort((a, b) => (a.name < b.name ? -1 : 1));
    });

    afterAll(async () => {
      await pool.end();
    });

    it('lists at most the limit, by workspace name, with the uncut count and each one’s Operations by name', async () => {
      const read = await withPlatform(pool, { userId: randomUUID() }, (client) =>
        readAwaitingWorkspaces(client, [gateId]),
      );
      const awaiting = read.get(gateId);
      expect(new Set(byName.map((w) => w.name)).size).toBe(WORKSPACE_COUNT); // the fixture itself
      expect(awaiting?.count).toBe(WORKSPACE_COUNT);
      expect(awaiting?.items).toHaveLength(ENABLING_WORKSPACES_LIMIT);

      // By name: the first twenty names, so the one cut is the last by name — neither the last
      // linked nor the last by id.
      const expected = byName.slice(0, ENABLING_WORKSPACES_LIMIT);
      expect(awaiting?.items.map((item) => item.name)).toEqual(expected.map((w) => w.name));
      expect(awaiting?.items.map((item) => item.id)).toEqual(expected.map((w) => w.id));

      // The first by name published zeta, then alpha; the platform reads them sorted.
      expect(awaiting?.items[0]?.operations).toEqual([alpha, zeta]);
      for (const item of awaiting?.items.slice(1) ?? []) expect(item.operations).toEqual([zeta]);
    });
  },
);
