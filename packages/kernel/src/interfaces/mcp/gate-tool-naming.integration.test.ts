import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandleClaims, Operation, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { dispatchCapability } from '../../application/gateway/index.js';
import {
  importManifest,
  proposeOperation,
  publishOperation,
  registerGatekeeper,
  updateOperationDescription,
} from '../../governance/gatekeepers/index.js';
import { buildToolCatalog } from './tool-projection.js';

/**
 * Legacy 144 (#514 audit): which gate a tool name belongs to. Every consumer of
 * `list_allowed_operations` names gate tools in list order — `<gate>_<op>` for the first Operation
 * that sanitizes to it, `<gatekeeperId>_<op>` for a later one (this MCP projection; the pi
 * extension's `gateToolName` is the same rule). The list was in Operation `updated_at` order, so
 * editing one gate's Operation handed its tool name to another gate of the same name. DB-gated
 * (real Postgres; auto-skip without DATABASE_URL).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function observeOperation(name: string, description: string): Operation {
  return {
    name,
    description,
    binding: { kind: 'http', method: 'GET', path: '/stock' },
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
  'gate tool names follow the order gates were registered in (legacy 144)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;

    async function adminInsert(sql: string, values: unknown[], principalId: string) {
      await withWorkspace(
        pool,
        { workspaceId, principalId },
        (client) => client.query(sql, values),
        { skipRoleSwitch: true },
      );
    }

    async function insertPrincipal(role: Role): Promise<string> {
      const id = randomUUID();
      await adminInsert(
        'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
        [workspaceId, id, 'human', role, role],
        id,
      );
      return id;
    }

    async function asOwner<T>(fn: Parameters<typeof withWorkspace<T>>[2]): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function newActivity(): Promise<string> {
      return asOwner(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by)
           values ($1, 'test.gate-tool-naming', 'running', $2) returning id`,
          [workspaceId, ownerId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('failed to insert test activity');
        return row.id;
      });
    }

    /** A gate named `name`, its `operations` imported and published one after another. */
    async function gateWith(name: string, operations: readonly Operation[]): Promise<string> {
      const activityId = await newActivity();
      const { gatekeeperId } = await asOwner((client) =>
        registerGatekeeper(client, workspaceId, {
          name,
          transportKind: 'http',
          target: 'example-system',
          endpoint: `https://gate-${randomUUID()}.example.invalid`,
          activityId,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );
      await asOwner((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations,
          proposedBy: { id: ownerId, kind: 'human' },
          activityId,
        }),
      );
      for (const operation of operations) {
        await asOwner((client) =>
          publishOperation(client, workspaceId, { gatekeeperId, name: operation.name }),
        );
      }
      return gatekeeperId;
    }

    function memberHandle(capabilities: readonly string[]): HandleClaims {
      const now = Math.floor(Date.now() / 1000);
      return {
        ws: workspaceId,
        sid: randomUUID(),
        obo: memberId,
        scope: { capabilities: [...capabilities], resources: {} },
        jti: randomUUID(),
        iat: now,
        exp: now + 600,
      };
    }

    /** The gate a tool name reaches in a fresh MCP tool list, or `undefined` if none is listed. */
    async function gateBehind(toolName: string): Promise<string | undefined> {
      const catalog = await buildToolCatalog(
        { pool },
        memberHandle(['list_allowed_operations', '<gate>.<op>']),
      );
      const call = catalog.resolve(toolName, {});
      return (call?.params as { gatekeeperId?: string } | undefined)?.gatekeeperId;
    }

    async function listedOrder(): Promise<string[]> {
      const listed = (await dispatchCapability(
        { pool },
        { channel: 'handle', claims: memberHandle(['list_allowed_operations']) },
        'list_allowed_operations',
        {},
      )) as { items: { gatekeeperId: string; name: string }[] };
      return listed.items.map((item) => `${item.gatekeeperId}/${item.name}`);
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      await adminInsert(
        'insert into workspaces (id, name) values ($1, $2)',
        [workspaceId, 'gate-tool-naming-test-workspace'],
        randomUUID(),
      );
      ownerId = await insertPrincipal('owner');
      memberId = await insertPrincipal('member');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('the gate registered first keeps `<gate>_<op>` after its Operation is edited and revised', async () => {
      const gateName = `stock-${randomUUID().slice(0, 8)}`;
      const shortName = `${gateName}_stock_list`;
      const first = await gateWith(gateName, [observeOperation('stock.list', 'Lists stock.')]);
      const second = await gateWith(gateName, [observeOperation('stock.list', 'Lists stock.')]);
      const secondsName = `${second}_stock_list`;

      expect(await gateBehind(shortName)).toBe(first);
      expect(await gateBehind(secondsName)).toBe(second);

      // An edit in place moves the row's `updated_at` past the other gate's.
      await asOwner((client) =>
        updateOperationDescription(client, workspaceId, {
          gatekeeperId: first,
          name: 'stock.list',
          description: 'Lists stock, by warehouse.',
        }),
      );
      expect(await gateBehind(shortName)).toBe(first);
      expect(await gateBehind(secondsName)).toBe(second);

      // A published revision is a new row, with its own `created_at`.
      const activityId = await newActivity();
      await asOwner((client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId: first,
          operation: { ...observeOperation('stock.list', 'Lists stock.'), blast_radius: 'medium' },
          proposedBy: { id: ownerId, kind: 'human' },
          activityId,
        }),
      );
      const revised = await asOwner((client) =>
        publishOperation(client, workspaceId, { gatekeeperId: first, name: 'stock.list' }),
      );
      expect(revised.version).toBe(2);
      expect(await gateBehind(shortName)).toBe(first);
      expect(await gateBehind(secondsName)).toBe(second);
    });

    it('within one gate, Operations are listed by name, whatever order they were published or edited in', async () => {
      const gatekeeperId = await gateWith(`shelf-${randomUUID().slice(0, 8)}`, [
        observeOperation('shelf.scan', 'Scans a shelf.'),
        observeOperation('shelf.count', 'Counts a shelf.'),
      ]);
      await asOwner((client) =>
        updateOperationDescription(client, workspaceId, {
          gatekeeperId,
          name: 'shelf.count',
          description: 'Counts the items on a shelf.',
        }),
      );

      const ofThisGate = (await listedOrder()).filter((key) => key.startsWith(`${gatekeeperId}/`));
      expect(ofThisGate).toEqual([`${gatekeeperId}/shelf.count`, `${gatekeeperId}/shelf.scan`]);
    });
  },
);
