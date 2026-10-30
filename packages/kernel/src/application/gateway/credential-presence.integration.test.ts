import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionRequestWireSchema, type PrincipalKind, type Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { newConnectionSecretSalt } from '../../adapters/gatekeeper-client/connection-secret.js';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { PRESENCE_TTL_MS, setCredentialPresenceDeps } from './credential-presence.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/credential-presence.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) coverage of legacy 513 on the approval reads — `get_action` and `list_pending` say,
 * on a pending request read by a person, whether its requester has connected their own account on
 * its gate (`onBehalfOfAccount`), asked of the gate (a fake here) and kept only briefly in memory.
 * The goal reads' side is in goal-propose.integration.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'approval reads — the requester’s own account on the gate (legacy 513, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;
    let gatekeeperId: string;

    /** The gate the fake answers for, and what it was asked. */
    let asked: { endpoint: string; onBehalfOf: string }[];
    let present: boolean;
    let clock: number;

    function caller(
      principalId: string,
      role: Role,
      kind: PrincipalKind = 'human',
    ): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: principalId, kind, role, displayName: null },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId,
          kind: 'web',
          onBehalfOf: principalId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    const owner = () => caller(ownerId, 'owner');

    async function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function newPrincipal(role: Role, kind: PrincipalKind = 'human'): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, $3, $4, $5)`,
          [workspaceId, id, kind, role, `${role}-${id.slice(0, 8)}`],
        ),
      );
      return id;
    }

    async function seedRequest(status: 'pending_approval' | 'denied'): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into action_requests
             (workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
              policy_decision, await_decision, on_behalf_of, actor_runtime, requester_can_approve,
              params)
           values ($1, $2, $3, $4::uuid, 'l513.test.action', $4::text, 'medium',
                   $5, false, $6, 'pi', true, '{}'::jsonb)`,
          [
            workspaceId,
            id,
            status,
            gatekeeperId,
            status === 'denied' ? 'deny' : 'require_approval',
            memberId,
          ],
        ),
      );
      return id;
    }

    async function getAction(by: ResolvedCaller, actionRequestId: string) {
      return ActionRequestWireSchema.parse(
        await dispatchCapability({ pool }, by, 'get_action', { actionRequestId }),
      );
    }

    async function pendingRow(by: ResolvedCaller, actionRequestId: string) {
      const result = (await dispatchCapability({ pool }, by, 'list_pending', {})) as {
        items: unknown[];
      };
      const rows = result.items.map((item) => ActionRequestWireSchema.parse(item));
      return rows.find((row) => row.id === actionRequestId);
    }

    function useFakeGate(answer?: () => Promise<unknown>): void {
      setCredentialPresenceDeps({
        gatekeeperClient: {
          credentialPresence: async (target, onBehalfOf) => {
            asked.push({ endpoint: target.endpoint, onBehalfOf });
            if (answer) return (await answer()) as never;
            return { credentialMode: 'connected_account', present };
          },
        } as Pick<GatekeeperClient, 'credentialPresence'> as GatekeeperClient,
        now: () => clock,
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'l513-credential-presence',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [workspaceId, ownerId],
          );
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.register_gatekeeper',
            principalId: ownerId,
          });
          const registered = await registerGatekeeper(client, workspaceId, {
            name: 'l513-gate',
            transportKind: 'http',
            target: 'l513-system',
            endpoint: 'http://127.0.0.1:9',
            connectionSecretSalt: newConnectionSecretSalt(),
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          });
          gatekeeperId = registered.gatekeeperId;
        },
        { skipRoleSwitch: true },
      );
      memberId = await newPrincipal('member');
    });

    afterEach(() => {
      setCredentialPresenceDeps({});
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a pending request read by a person says the requester has not connected; once they do, it says so after the short-lived answer runs out', async () => {
      asked = [];
      present = false;
      clock = 1_000_000;
      useFakeGate();
      const id = await seedRequest('pending_approval');

      expect((await getAction(owner(), id)).onBehalfOfAccount).toBe('not_connected');
      expect((await pendingRow(owner(), id))?.onBehalfOfAccount).toBe('not_connected');
      // Asked about the requester, once: the queue's read is answered from memory.
      expect(asked).toEqual([{ endpoint: 'http://127.0.0.1:9', onBehalfOf: memberId }]);

      present = true;
      expect((await getAction(owner(), id)).onBehalfOfAccount).toBe('not_connected');
      clock += PRESENCE_TTL_MS + 1;
      expect((await getAction(owner(), id)).onBehalfOfAccount).toBe('connected');
      expect(asked).toHaveLength(2);
    });

    it('the answer is a yes or no and nothing else: no credential field reaches the row', async () => {
      asked = [];
      clock = 2_000_000;
      useFakeGate(async () => ({ credentialMode: 'connected_account', present: false }));
      const id = await seedRequest('pending_approval');
      const row = await getAction(owner(), id);
      expect(row.onBehalfOfAccount).toBe('not_connected');
      expect(Object.keys(row)).not.toContain('credential');
      expect(Object.keys(row)).not.toContain('present');
    });

    it('nothing is said — and the gate is not asked — for a row not pending, or for an agent Principal on the human channel', async () => {
      asked = [];
      present = false;
      clock = 3_000_000;
      useFakeGate();
      const denied = await seedRequest('denied');
      expect(await getAction(owner(), denied)).not.toHaveProperty('onBehalfOfAccount');

      const pending = await seedRequest('pending_approval');
      const agent = await newPrincipal('owner', 'agent');
      expect(await getAction(caller(agent, 'owner', 'agent'), pending)).not.toHaveProperty(
        'onBehalfOfAccount',
      );
      expect(asked).toEqual([]);
    });

    it('a shared-credential gate, or one that does not answer, says nothing — and an unanswered gate is not asked again until the answer would have expired', async () => {
      asked = [];
      clock = 4_000_000;
      useFakeGate(async () => ({ credentialMode: 'shared' }));
      const id = await seedRequest('pending_approval');
      expect(await getAction(owner(), id)).not.toHaveProperty('onBehalfOfAccount');

      useFakeGate(async () => {
        throw new Error('gate down');
      });
      expect(await getAction(owner(), id)).not.toHaveProperty('onBehalfOfAccount');
      // Review #493 on #821: a gate that did not answer costs one timeout per TTL, not per read.
      expect(await getAction(owner(), id)).not.toHaveProperty('onBehalfOfAccount');
      expect(asked).toHaveLength(2);
      clock += PRESENCE_TTL_MS + 1;
      expect(await getAction(owner(), id)).not.toHaveProperty('onBehalfOfAccount');
      expect(asked).toHaveLength(3);
    });

    it('the queue asks every requester’s gate at once: a slow gate costs one wait, not one per requester', async () => {
      asked = [];
      clock = 5_000_000;
      const others = [await newPrincipal('member'), await newPrincipal('member')];
      let inFlight = 0;
      let mostInFlight = 0;
      let release: () => void = () => {};
      const allAsked = new Promise<void>((resolve) => {
        release = resolve;
      });
      useFakeGate(async () => {
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        if (inFlight === 3) release();
        await allAsked;
        inFlight -= 1;
        return { credentialMode: 'connected_account', present: false };
      });
      const ids = [await seedRequest('pending_approval')];
      for (const requester of others) {
        const id = randomUUID();
        await admin((client) =>
          client.query(
            `insert into action_requests
               (workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
                policy_decision, await_decision, on_behalf_of, actor_runtime, requester_can_approve,
                params)
             values ($1, $2, 'pending_approval', $3::uuid, 'l513.test.action', $3::text, 'medium',
                     'require_approval', false, $4, 'pi', true, '{}'::jsonb)`,
            [workspaceId, id, gatekeeperId, requester],
          ),
        );
        ids.push(id);
      }
      // One read of the queue: the fake answers only once all three are asked together, so asking
      // one requester after another would never finish.
      const result = (await dispatchCapability({ pool }, owner(), 'list_pending', {})) as {
        items: unknown[];
      };
      const listed = result.items.map((item) => ActionRequestWireSchema.parse(item));
      const rows = ids.map((id) => listed.find((row) => row.id === id));
      expect(rows.map((row) => row?.onBehalfOfAccount)).toEqual([
        'not_connected',
        'not_connected',
        'not_connected',
      ]);
      // All three requesters were asked about together, each once.
      expect(mostInFlight).toBe(3);
      expect(new Set(asked.map((entry) => entry.onBehalfOf))).toEqual(
        new Set([memberId, ...others]),
      );
      expect(asked).toHaveLength(3);
    });
  },
);
