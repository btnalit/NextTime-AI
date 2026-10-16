import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADDRESS_CREDENTIAL_SQL, IllegalTransition, type Operation } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { requestConnection } from '../../governance/connections/index.js';
import {
  OperationNameInvalidError,
  getGatekeeper,
  getOperation,
  normalizeGateEndpoint,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { GatekeeperLandingRefusedError, landGatekeeper } from './landing.js';
import { findSelfConnection } from './self-connections.js';

/**
 * application/gates/landing.integration.test (real Postgres; auto-skip without DATABASE_URL): the
 * one landing path's self origin, end to end below the capability layer — what `create_connection`
 * and the removed `register-gatekeeper` CLI used to write between them. The catalog origin (enable,
 * linking an existing Gatekeeper, converting a self connection, the suspension refusal) runs
 * through the real capabilities in application/gateway/platform-gates.integration.test.ts; the
 * one-writer rule is pinned statically by `landing-path.guard.test.ts`.
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MIGRATION_0045 = path.join(MIGRATIONS_DIR, 'core', '0045_workspace_self_connections.sql');
const DATABASE_URL = process.env.DATABASE_URL;

const SALT = 'e'.repeat(32);
/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

describe('core 0045 backfill (no DB): judges addresses by the scrub preflight patterns', () => {
  it('carries @nexttime/shared ADDRESS_CREDENTIAL_SQL verbatim, so the two cannot drift', async () => {
    const migration = await readFile(MIGRATION_0045, 'utf8');
    expect(migration).toContain(`'${ADDRESS_CREDENTIAL_SQL.password}'`);
    expect(migration).toContain(`'${ADDRESS_CREDENTIAL_SQL.query}'`);
  });
});

const OBSERVE_OP: Operation = {
  name: 'example.observe_thing',
  description: 'Reads one example thing.',
  binding: { kind: 'http', method: 'GET', path: '/thing' },
  params_schema: {},
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};
const EXECUTE_OP: Operation = {
  name: 'example.execute_thing',
  description: 'Changes one example thing.',
  binding: { kind: 'http', method: 'POST', path: '/thing' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'medium',
  reversibility: false,
  auto_approvable: false,
  await_decision: true,
  reads: [],
  writes: [],
};

describe.runIf(DATABASE_URL !== undefined)('application/gates/landing (integration)', () => {
  let pool: Pool;
  let workspaceId: string;
  let ownerId: string;

  async function asSuperuser<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
      skipRoleSwitch: true,
    });
  }

  async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
  }

  const endpoint = () => `https://gate-${randomUUID()}.example.invalid`;

  function landSelf(
    at: string,
    operations: readonly Operation[] = [OBSERVE_OP, EXECUTE_OP],
    connectionRequestId?: string,
  ) {
    return inTx((client) =>
      landGatekeeper(
        client,
        workspaceId,
        { id: ownerId, kind: 'human' },
        {
          kind: 'self',
          connector: 'http',
          target: 'example-system',
          endpoint: at,
          connectionSecretSalt: SALT,
          operations: [...operations],
          ...(connectionRequestId ? { connectionRequestId } : {}),
        },
      ),
    );
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    workspaceId = randomUUID();
    ownerId = randomUUID();
    await asSuperuser(async (client) => {
      await client.query('insert into workspaces (id, name) values ($1, $2)', [
        workspaceId,
        'landing-test-workspace',
      ]);
      await client.query(
        `insert into principals (workspace_id, id, kind, role, display_name)
         values ($1, $2, 'human', 'owner', 'owner')`,
        [workspaceId, ownerId],
      );
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('self: one Gatekeeper with its salt, the manifest as drafts (never published), and its origin row', async () => {
    const at = endpoint();
    const result = await landSelf(at);
    expect(result.importedOperationNames.slice().sort()).toEqual(
      [EXECUTE_OP.name, OBSERVE_OP.name].sort(),
    );
    expect(result.publishedOperationNames).toEqual([]);
    expect(result.linkedExisting).toBe(false);
    expect(result.connectionRequest).toBeNull();

    const { gatekeeper, observe, origin } = await inTx(async (client) => ({
      gatekeeper: await getGatekeeper(client, workspaceId, result.gatekeeperId),
      observe: await getOperation(client, workspaceId, result.gatekeeperId, OBSERVE_OP.name),
      origin: await findSelfConnection(client, workspaceId, result.gatekeeperId),
    }));
    expect(gatekeeper).toMatchObject({ endpoint: at, connectionSecretSalt: SALT });
    // I17: imported Operations are drafts whatever the gate suggested.
    expect(observe?.status).toBe('draft');
    expect(origin).toMatchObject({
      connector: 'http',
      target: 'example-system',
      endpoint: at,
      connectedBy: ownerId,
      suspendedAt: null,
    });
  });

  it('self: a second landing at the same address, however it is spelled, is refused, naming the Gatekeeper there (#620 review P2-1)', async () => {
    const at = endpoint();
    const first = await landSelf(at);
    for (const spelling of [`${at}/`, `${at}//`, at.toUpperCase(), `${at}.:443/`]) {
      const thrown = await landSelf(spelling).catch((err: unknown) => err);
      expect(thrown, spelling).toBeInstanceOf(GatekeeperLandingRefusedError);
      expect(thrown, spelling).toMatchObject({
        code: 'endpoint_already_connected',
        gatekeeperId: first.gatekeeperId,
      });
    }
  });

  it('self: a suspended connection cannot be connected again under another spelling — case, default port, user info (#620 review P2-1)', async () => {
    const at = endpoint();
    const first = await landSelf(at);
    await asSuperuser((client) =>
      client.query(
        `update workspace_self_connections set suspended_at = now(), suspended_by_user_id = $3
          where workspace_id = $1 and gatekeeper_object_id = $2`,
        [workspaceId, first.gatekeeperId, randomUUID()],
      ),
    );
    const host = new URL(at).host;
    for (const spelling of [
      `HTTPS://${host.toUpperCase()}`,
      `https://${host}:443/`,
      `https://ops@${host}`,
    ]) {
      const thrown = await landSelf(spelling).catch((err: unknown) => err);
      expect(thrown, spelling).toBeInstanceOf(GatekeeperLandingRefusedError);
      expect(thrown, spelling).toMatchObject({
        code: 'endpoint_already_connected',
        gatekeeperId: first.gatekeeperId,
      });
    }
  });

  it('self: the refusal names the Gatekeeper there as its card shows it — a name written before legacy 186 keeps no credential (UX acceptance of #620, P2-3)', async () => {
    const at = endpoint();
    const secret = 'abcdefghijklmnopqrstuvwxyz0123';
    // A self connection is named after its target; one written before legacy 186 can carry a
    // credential (written directly — registration refuses such a target now).
    const legacyName = `https://ops:${secret}@legacy.invalid/inventory?token=${secret}`;
    const existing = await inTx(async (client) => {
      const activity = await startActivity(client, workspaceId, {
        kind: 'test.legacy_name',
        principalId: ownerId,
      });
      const registered = await registerGatekeeper(client, workspaceId, {
        name: 'legacy-name-system',
        transportKind: 'http',
        target: 'legacy-name-system',
        endpoint: at,
        activityId: activity.id,
        registeredBy: { id: ownerId, kind: 'human' },
      });
      await endActivity(client, workspaceId, activity.id, 'completed');
      return registered.gatekeeperId;
    });
    await asSuperuser((client) =>
      client.query(
        `update objects set properties = properties || jsonb_build_object('name', $2::text, 'target', $2::text)
          where id = $1`,
        [existing, legacyName],
      ),
    );
    const thrown = await landSelf(at).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(GatekeeperLandingRefusedError);
    expect(thrown).toMatchObject({
      code: 'endpoint_already_connected',
      gatekeeperId: existing,
      gatekeeperName: 'https://legacy.invalid/inventory',
    });
    expect((thrown as Error).message).not.toContain(secret);
  });

  it('self: the database holds one address per workspace too — a second row with the same endpoint_key, or one without a key, is refused', async () => {
    const at = endpoint();
    const first = await landSelf(at);
    const other = await inTx(async (client) => {
      const activity = await startActivity(client, workspaceId, {
        kind: 'test.endpoint_key',
        principalId: ownerId,
      });
      const registered = await registerGatekeeper(client, workspaceId, {
        name: 'endpoint-key-system',
        transportKind: 'http',
        target: 'endpoint-key-system',
        endpoint: endpoint(),
        activityId: activity.id,
        registeredBy: { id: ownerId, kind: 'human' },
      });
      await endActivity(client, workspaceId, activity.id, 'completed');
      return registered.gatekeeperId;
    });
    const insert = (key: string | null) =>
      inTx((client) =>
        client.query(
          `insert into workspace_self_connections
             (workspace_id, gatekeeper_object_id, connector, target, endpoint, endpoint_key, connected_by)
           values ($1, $2, 'http', 'endpoint-key-system', $3, $4, $5)`,
          [workspaceId, other, `${at.toUpperCase()}/`, key, ownerId],
        ),
      );
    expect(first.gatekeeperId).not.toBe(other);
    await expect(insert(normalizeGateEndpoint(`${at}/`))).rejects.toThrow(
      /workspace_self_connections_endpoint_key_uniq/,
    );
    await expect(insert(null)).rejects.toThrow(/row-level security/);
  });

  it('self: one bad manifest entry rejects the whole landing — no Gatekeeper, no Operation, no origin row', async () => {
    const at = endpoint();
    // Legacy 232: a new name carrying a control character is refused before any Operation write;
    // the Gatekeeper registered just before it goes with the transaction.
    await expect(
      landSelf(at, [OBSERVE_OP, { ...EXECUTE_OP, name: 'example.\u0007hidden' }]),
    ).rejects.toThrow(OperationNameInvalidError);
    const left = await inTx((client) =>
      client.query<{ count: number }>(
        `select count(*)::int as count from objects
          where workspace_id = $1 and object_type = 'Gatekeeper' and properties->>'endpoint' = $2`,
        [workspaceId, at],
      ),
    );
    expect(left.rows[0]?.count).toBe(0);
    // Nothing was committed, so the address is still free.
    await expect(landSelf(at)).resolves.toMatchObject({ linkedExisting: false });
  });

  it('self: a member’s request card is resolved to the landed Gatekeeper (I6); a second landing for it is IllegalTransition', async () => {
    const card = await inTx((client) =>
      requestConnection(client, workspaceId, {
        kind: 'http',
        target: 'example-system',
        requestedBy: { id: ownerId, kind: 'human' },
      }),
    );
    const result = await landSelf(endpoint(), [OBSERVE_OP], card.id);
    expect(result.connectionRequest).toMatchObject({
      id: card.id,
      status: 'completed',
      gatekeeperId: result.gatekeeperId,
      completedBy: ownerId,
    });
    await expect(landSelf(endpoint(), [OBSERVE_OP], card.id)).rejects.toBeInstanceOf(
      IllegalTransition,
    );
  });

  it('core 0045 backfill: a Gatekeeper with no origin gets a self row, attributed to nobody and dated by the Gatekeeper; re-running adds nothing', async () => {
    // What `register-gatekeeper` (removed) and `create_connection` (before 0045) left behind.
    const at = endpoint();
    const orphanId = await inTx(async (client) => {
      const activity = await startActivity(client, workspaceId, {
        kind: 'test.orphan_gatekeeper',
        principalId: ownerId,
      });
      const { gatekeeperId } = await registerGatekeeper(client, workspaceId, {
        name: 'orphan-system',
        transportKind: 'ssh',
        target: 'orphan-system',
        endpoint: at,
        activityId: activity.id,
        registeredBy: { id: ownerId, kind: 'human' },
      });
      await endActivity(client, workspaceId, activity.id, 'completed');
      return gatekeeperId;
    });
    expect(await inTx((client) => findSelfConnection(client, workspaceId, orphanId))).toBeNull();

    const migration = await readFile(MIGRATION_0045, 'utf8');
    await asSuperuser((client) => client.query(migration));
    await asSuperuser((client) => client.query(migration));

    const { origin, createdAt, rows } = await asSuperuser(async (client) => ({
      origin: await findSelfConnection(client, workspaceId, orphanId),
      createdAt: (
        await client.query<{ created_at: Date }>(
          'select created_at from objects where workspace_id = $1 and id = $2',
          [workspaceId, orphanId],
        )
      ).rows[0]?.created_at,
      rows: (
        await client.query<{ count: number }>(
          `select count(*)::int as count from workspace_self_connections
            where workspace_id = $1 and gatekeeper_object_id = $2`,
          [workspaceId, orphanId],
        )
      ).rows[0]?.count,
    }));
    expect(origin).toMatchObject({
      connector: 'ssh',
      target: 'orphan-system',
      endpoint: at,
      connectedBy: null,
      connectedAt: createdAt,
      suspendedAt: null,
    });
    expect(rows).toBe(1);
  });

  it('core 0045 backfill: an address written before legacy 186 is copied with the credential cut out; the Gatekeeper keeps its own (#620 review M2)', async () => {
    const orphanId = await inTx(async (client) => {
      const activity = await startActivity(client, workspaceId, {
        kind: 'test.orphan_gatekeeper',
        principalId: ownerId,
      });
      const { gatekeeperId } = await registerGatekeeper(client, workspaceId, {
        name: 'orphan-with-credential',
        transportKind: 'http',
        target: 'orphan-with-credential',
        endpoint: endpoint(),
        activityId: activity.id,
        registeredBy: { id: ownerId, kind: 'human' },
      });
      await endActivity(client, workspaceId, activity.id, 'completed');
      return gatekeeperId;
    });
    const host = `old-${randomUUID()}.example.invalid`;
    const written = {
      target: `https://ops:${FAKE}@${host}/d?token=${FAKE}`,
      endpoint: `https://ops:${FAKE}@${host}/?api_key=${FAKE}#x`,
    };
    // What a Gatekeeper written before legacy 186 can hold (registerGatekeeper refuses it now).
    await asSuperuser((client) =>
      client.query(
        `update objects set properties = properties || $3::jsonb
          where workspace_id = $1 and id = $2`,
        [workspaceId, orphanId, JSON.stringify(written)],
      ),
    );

    const notices: string[] = [];
    await asSuperuser(async (client) => {
      const onNotice = (notice: { message?: string }) => notices.push(notice.message ?? '');
      client.on('notice', onNotice);
      try {
        await client.query(await readFile(MIGRATION_0045, 'utf8'));
      } finally {
        client.off('notice', onNotice);
      }
    });

    const { origin, properties } = await asSuperuser(async (client) => ({
      origin: await findSelfConnection(client, workspaceId, orphanId),
      properties: (
        await client.query<{ properties: Record<string, unknown> }>(
          'select properties from objects where workspace_id = $1 and id = $2',
          [workspaceId, orphanId],
        )
      ).rows[0]?.properties,
    }));
    expect(origin).toMatchObject({
      target: `https://ops@${host}/d`,
      endpoint: `https://${host}/`,
    });
    expect(JSON.stringify(origin)).not.toContain(FAKE);
    expect(properties).toMatchObject(written);
    expect(notices.join('\n')).toMatch(
      /core 0045: recorded \d+ self-connected Gatekeeper\(s\), [1-9]\d* of them with a credential cut out/,
    );
  });

  it('RLS: a workspace transaction can insert only an unsuspended row and never suspend one', async () => {
    const at = endpoint();
    const { gatekeeperId } = await landSelf(at);
    const updated = await inTx((client) =>
      client.query(
        `update workspace_self_connections set suspended_at = now(), suspended_by_user_id = $3
          where workspace_id = $1 and gatekeeper_object_id = $2`,
        [workspaceId, gatekeeperId, randomUUID()],
      ),
    );
    expect(updated.rowCount).toBe(0);

    const other = await inTx(async (client) => {
      const activity = await startActivity(client, workspaceId, {
        kind: 'test.rls_insert',
        principalId: ownerId,
      });
      const registered = await registerGatekeeper(client, workspaceId, {
        name: 'rls-system',
        transportKind: 'http',
        target: 'rls-system',
        endpoint: endpoint(),
        activityId: activity.id,
        registeredBy: { id: ownerId, kind: 'human' },
      });
      await endActivity(client, workspaceId, activity.id, 'completed');
      return registered.gatekeeperId;
    });
    await expect(
      inTx((client) =>
        client.query(
          `insert into workspace_self_connections
             (workspace_id, gatekeeper_object_id, connector, target, endpoint,
              suspended_at, suspended_by_user_id)
           values ($1, $2, 'http', 'rls-system', 'https://rls.example.invalid', now(), $3)`,
          [workspaceId, other, randomUUID()],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('RLS: a workspace transaction cannot delete a self row whose Gatekeeper has no catalog link — it would drop out of the platform’s sight (#620 review P3-1)', async () => {
    const { gatekeeperId } = await landSelf(endpoint());
    const deleted = await inTx((client) =>
      client.query(
        'delete from workspace_self_connections where workspace_id = $1 and gatekeeper_object_id = $2',
        [workspaceId, gatekeeperId],
      ),
    );
    expect(deleted.rowCount).toBe(0);
    expect(
      await inTx((client) => findSelfConnection(client, workspaceId, gatekeeperId)),
    ).not.toBeNull();
  });
});
