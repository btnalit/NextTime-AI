import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, PrincipalKind, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { getOperation, registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/operation-proposer-kind.integration.test (legacy 616): who wrote an
 * Operation draft. `propose_operation` records the caller's own kind beside the Principal the
 * draft is for, and the draft's `origin` follows from it, as every other gateway draft's does
 * (`draftOriginOf`): a person over the human channel wrote it themselves (`human`); a service
 * Principal's API key, which authenticates on the human channel too, is an automation credential,
 * not a person (`service`, origin `agent`); an agent through a Handle is `agent`. The catalog list
 * (what the console's 「起草方」 row and 「智能体」 mark read) carries that origin. The `exposes` Fact's
 * epistemic status is read from the Principal row, not from this kind, and so is unchanged.
 *
 * DB-gated (real Postgres; auto-skip without DATABASE_URL).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function lookup(name: string): Operation {
  return {
    name,
    description: 'Looks up one record by its id.',
    binding: { kind: 'http', method: 'GET', path: '/records/{id}' },
    params_schema: {
      type: 'object',
      properties: { id: { type: 'string', 'x-in': 'path' } },
      required: ['id'],
    },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: ['Record'],
    writes: [],
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'legacy 616 — propose_operation records who wrote the draft (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let serviceId: string;
    let gatekeeperId: string;

    /** A human-channel caller: a person's console session, or a service Principal's API key. */
    function humanChannel(id: string, kind: PrincipalKind, displayName: string | null) {
      return {
        channel: 'human',
        principal: { workspaceId, id, kind, role: 'owner' satisfies Role, displayName },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId: id,
          kind: 'web',
          onBehalfOf: id,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      } satisfies ResolvedCaller;
    }

    /** An agent's Handle acting for the owner. */
    function handle(): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: ownerId,
          scope: { capabilities: ['propose_operation'], resources: {} },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    async function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    /** Proposes a fresh Operation as `caller`, then reads back how it was recorded. */
    async function propose(caller: ResolvedCaller) {
      const name = `op616.${randomUUID().slice(0, 8)}`;
      await dispatchCapability({ pool }, caller, 'propose_operation', {
        gatekeeperId,
        operation: lookup(name),
      });
      const record = await admin((client) => getOperation(client, workspaceId, gatekeeperId, name));
      const listed = (await dispatchCapability(
        { pool },
        humanChannel(ownerId, 'human', 'owner'),
        'list_operations',
        { gatekeeperId },
      )) as { items: { name: string; status: string; origin?: string }[] };
      const row = listed.items.find((item) => item.name === name && item.status === 'draft');
      const exposes = await admin((client) =>
        client.query<{ epistemic_status: string }>(
          `select epistemic_status from links
            where workspace_id = $1 and link_type = 'exposes' and target_object_id = $2`,
          [workspaceId, record?.id],
        ),
      );
      return {
        origin: record?.origin,
        proposedBy: record?.proposedBy,
        listedOrigin: row?.origin,
        exposes: exposes.rows.map((fact) => fact.epistemic_status),
      };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      serviceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'operation-proposer-kind-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'service', 'owner', 'op616-bot')`,
            [workspaceId, ownerId, serviceId],
          );
        },
        { skipRoleSwitch: true },
      );
      gatekeeperId = await admin(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.register_gatekeeper',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name: 'operation-proposer-kind-gate',
          transportKind: 'http',
          target: 'operation-proposer-kind-system',
          endpoint: 'https://gate.operation-proposer-kind-test.invalid/',
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        return registered.gatekeeperId;
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a person over the human channel wrote it: origin human', async () => {
      const recorded = await propose(humanChannel(ownerId, 'human', 'owner'));
      expect(recorded).toEqual({
        origin: 'human',
        proposedBy: { id: ownerId, kind: 'human' },
        listedOrigin: 'human',
        exposes: ['asserted'],
      });
    });

    it('a service Principal’s API key, on the human channel too, is not a person: kind service, origin agent', async () => {
      const recorded = await propose(humanChannel(serviceId, 'service', 'op616-bot'));
      expect(recorded).toEqual({
        origin: 'agent',
        proposedBy: { id: serviceId, kind: 'service' },
        // What the console's list mark and 「起草方」 row read: 「智能体或服务账号」.
        listedOrigin: 'agent',
        // Read from the Principal row, as before.
        exposes: ['observed'],
      });
    });

    it('an agent through a Handle wrote it for its person: kind agent, origin agent', async () => {
      const recorded = await propose(handle());
      expect(recorded).toMatchObject({
        origin: 'agent',
        proposedBy: { id: ownerId, kind: 'agent' },
        listedOrigin: 'agent',
      });
    });
  },
);
