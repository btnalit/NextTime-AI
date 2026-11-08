import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, Operation } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { setAgentPolicy } from '../../governance/agent-profile/index.js';
import { ApprovalDrainer } from '../../governance/approval/index.js';
import {
  HANDLE_SIGNING_ALG,
  grantCapability,
  revokeCapabilityGrant,
} from '../../governance/capability/index.js';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { configureTaskRuntime } from '../task/index.js';
import { createAdminWithTransaction, createGatekeeperActionExecutor } from './action-executor.js';
import { dispatchCapability } from './dispatch.js';
import { authenticateHandle } from './handle-auth.js';
import { ActionRequestDeniedError, setRequestActionDeps } from './request-action-handler.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/service-handle-gates.integration.test: legacy 690 (DB-gated, real Postgres).
 * A service Handle (`issue_service_handle`) is minted with the service Principal's own gates —
 * `issue_handle`'s rule (application/gates/execute-access.ts `serviceHandleResources`) — so the
 * external runtime it is given can ask for an action on a gate the owner granted it, through the
 * same approval as anyone. Until then it was minted with `resources: {}` and every such
 * `request_action` was denied (`requester_scope_does_not_cover_gatekeeper`). What the Handle
 * carries is a snapshot: each call still keeps only the gates the Principal may act on then (R-37).
 *
 * Once through the scope check a request is decided as anyone's is. `host.restart` waits for a
 * person (`auto_approvable: false`, `await_decision: false`), so it stops at `pending_approval`;
 * `host.check` is low and auto-approvable, so under the default AgentPolicy it runs with no person
 * (`allowMemberAutoApproveLow`, the owner's switch) — #493 on #1091. The gate is a stand-in that
 * records each `apply` and answers each `simulate`; nothing leaves the process.
 */

class UnusedSupervisorClient implements TaskSupervisorClientPort {
  spawn(_input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    throw new Error('legacy 690 tests never spawn a Task');
  }
  terminate(_workerRunId: string): Promise<boolean> {
    throw new Error('legacy 690 tests never terminate a Task');
  }
  status(_workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    throw new Error('legacy 690 tests never poll Task status');
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const RESTART_OP: Operation = {
  name: 'host.restart',
  binding: { kind: 'http', method: 'POST', path: '/restart' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'medium',
  reversibility: false,
  auto_approvable: false,
  await_decision: false,
  reads: [],
  writes: [],
};

const CHECK_OP: Operation = {
  ...RESTART_OP,
  name: 'host.check',
  binding: { kind: 'http', method: 'POST', path: '/check' },
  blast_radius: 'low',
  reversibility: true,
  auto_approvable: true,
};

/** The gates' far side: answers a `simulate`, records an `apply` (by ActionRequest id). */
const applied: string[] = [];
const unused = async (): Promise<never> => {
  throw new Error('legacy 690 tests only simulate and apply');
};
const recordingGate: GatekeeperClient = {
  describeOperations: unused,
  observe: unused,
  simulate: async (_target, input) => ({ description: `would run ${input.operation}` }),
  apply: async (_target, input) => {
    applied.push(input.actionRequestId);
    return { replayed: false };
  },
  lookupApply: unused,
  revert: unused,
  health: unused,
  storeConnectedAccount: unused,
  deleteConnectedAccount: unused,
};

describe.runIf(DATABASE_URL !== undefined)(
  'service Handle gates (legacy 690, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;
    let otherGatekeeperId: string;
    let handlePublicKey: CryptoKey;

    function ownerCaller(): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: ownerId, kind: 'human', role: 'owner', displayName: null },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId: ownerId,
          kind: 'web',
          onBehalfOf: ownerId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    async function admin<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function insertPrincipal(kind: 'human' | 'service', role: string): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, $3, $4, $5)`,
          [workspaceId, id, kind, role, `legacy-690 ${kind} ${role} ${id.slice(0, 8)}`],
        ),
      );
      return id;
    }

    async function registerGate(name: string): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        const { gatekeeperId: id } = await registerGatekeeper(client, workspaceId, {
          name,
          transportKind: 'http',
          target: `${name}-system`,
          endpoint: `http://${name}.invalid:8080`,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        await importManifest(client, workspaceId, {
          gatekeeperId: id,
          operations: [RESTART_OP, CHECK_OP],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
        await publishOperation(client, workspaceId, { gatekeeperId: id, name: RESTART_OP.name });
        await publishOperation(client, workspaceId, { gatekeeperId: id, name: CHECK_OP.name });
        return id;
      });
    }

    async function grantGate(principalId: string, gate: string): Promise<string> {
      const grant = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        grantCapability(client, workspaceId, {
          principalId,
          resourceType: 'gatekeeper',
          resourceId: gate,
          grantedBy: ownerId,
        }),
      );
      return grant.id;
    }

    interface Issued {
      handle: string;
      sessionId: string;
      scope: CapabilityScope;
    }

    function issue(principalId: string, scope: string[]): Promise<Issued> {
      return dispatchCapability({ pool }, ownerCaller(), 'issue_service_handle', {
        principalId,
        scope,
      }) as Promise<Issued>;
    }

    /** The issued token as the gateway resolves it — a real verification, revocation included. */
    async function asHandle(issued: Issued): Promise<ResolvedCaller> {
      const claims = await authenticateHandle(pool, issued.handle, { publicKey: handlePublicKey });
      return { channel: 'handle', claims };
    }

    function act(operation: Operation, caller: ResolvedCaller, gate: string, host: string) {
      return dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId: gate,
        operation: operation.name,
        params: { host },
      }) as Promise<{ id: string; status: string }>;
    }
    const restart = (caller: ResolvedCaller, gate: string, host: string) =>
      act(RESTART_OP, caller, gate, host);

    async function requestsOf(principalId: string): Promise<string[]> {
      const result = await admin((client) =>
        client.query<{ status: string }>(
          `select status from action_requests
           where workspace_id = $1 and on_behalf_of = $2 order by requested_at, id`,
          [workspaceId, principalId],
        ),
      );
      return result.rows.map((row) => row.status);
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      handlePublicKey = publicKey;
      configureTaskRuntime({ pool, privateKey, supervisorClient: new UnusedSupervisorClient() });
      const adminWithTransaction = createAdminWithTransaction(pool);
      setRequestActionDeps({
        gatekeeperClient: recordingGate,
        drainer: new ApprovalDrainer({
          executor: createGatekeeperActionExecutor({
            gatekeeperClient: recordingGate,
            withTransaction: adminWithTransaction,
          }),
          withTransaction: adminWithTransaction,
        }),
      });

      workspaceId = randomUUID();
      ownerId = randomUUID();
      await admin(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'legacy-690-workspace',
        ]);
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'owner', 'legacy-690 owner')`,
          [workspaceId, ownerId],
        );
      });
      gatekeeperId = await registerGate('legacy-690-gate');
      otherGatekeeperId = await registerGate('legacy-690-other-gate');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a service Handle carries the gates its Principal was granted, and asks for an action on one through approval', async () => {
      const serviceId = await insertPrincipal('service', 'member');
      await grantGate(serviceId, gatekeeperId);

      const issued = await issue(serviceId, ['request_action', 'search']);
      expect(issued.scope.resources).toEqual({ gatekeeper: [gatekeeperId] });
      const caller = await asHandle(issued);
      expect(caller.channel === 'handle' && caller.claims.scope.resources.gatekeeper).toEqual([
        gatekeeperId,
      ]);

      await expect(restart(caller, gatekeeperId, 'web-1')).resolves.toMatchObject({
        status: 'pending_approval',
      });
      // The gate it was not granted stays out of reach: denied, and the denial is recorded.
      await expect(restart(caller, otherGatekeeperId, 'web-1')).rejects.toBeInstanceOf(
        ActionRequestDeniedError,
      );
      expect(await requestsOf(serviceId)).toEqual(['pending_approval', 'denied']);
    });

    it('a service Principal with no gate Grant still gets a Handle with no gate, and its request is denied', async () => {
      const serviceId = await insertPrincipal('service', 'member');

      const issued = await issue(serviceId, ['request_action']);
      expect(issued.scope.resources).toEqual({});
      await expect(restart(await asHandle(issued), gatekeeperId, 'web-2')).rejects.toBeInstanceOf(
        ActionRequestDeniedError,
      );
      expect(await requestsOf(serviceId)).toEqual(['denied']);
    });

    it('a Grant revoked after issue takes the gate away from the Handle already issued (R-37 at each call)', async () => {
      const serviceId = await insertPrincipal('service', 'member');
      const grantId = await grantGate(serviceId, gatekeeperId);
      const issued = await issue(serviceId, ['request_action']);
      expect(issued.scope.resources).toEqual({ gatekeeper: [gatekeeperId] });
      const caller = await asHandle(issued);

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        revokeCapabilityGrant(client, workspaceId, grantId),
      );
      await expect(restart(caller, gatekeeperId, 'web-3')).rejects.toBeInstanceOf(
        ActionRequestDeniedError,
      );
      expect(await requestsOf(serviceId)).toEqual(['denied']);
    });

    it('the gate set follows the issue_handle rule: the AgentPolicy cap leaves a granted gate out', async () => {
      const serviceId = await insertPrincipal('service', 'member');
      await grantGate(serviceId, gatekeeperId);
      await grantGate(serviceId, otherGatekeeperId);
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        setAgentPolicy(client, workspaceId, ownerId, { allowedGatekeepers: [gatekeeperId] }),
      );
      try {
        const issued = await issue(serviceId, ['request_action']);
        expect(issued.scope.resources).toEqual({ gatekeeper: [gatekeeperId] });
      } finally {
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          setAgentPolicy(client, workspaceId, ownerId, { allowedGatekeepers: [] }),
        );
      }
    });

    it('on a gate it was granted, a low auto-approvable Operation runs with no person under the default AgentPolicy, and waits for one once the owner turns that off', async () => {
      // A gate of its own: the requests the earlier cases left waiting on the shared gate would
      // hold an approved one back (the drainer's per-gate order), which is not what this shows.
      const gate = await registerGate('legacy-690-check-gate');
      const serviceId = await insertPrincipal('service', 'member');
      await grantGate(serviceId, gate);
      const caller = await asHandle(await issue(serviceId, ['request_action']));

      const ran = await act(CHECK_OP, caller, gate, 'web-4');
      expect(ran.status).toBe('executed');
      expect(applied).toContain(ran.id);

      const setAutoApproveLow = (allowMemberAutoApproveLow: boolean) =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          setAgentPolicy(client, workspaceId, ownerId, { allowMemberAutoApproveLow }),
        );
      await setAutoApproveLow(false);
      try {
        const held = await act(CHECK_OP, caller, gate, 'web-5');
        expect(held.status).toBe('pending_approval');
        expect(applied).not.toContain(held.id);
      } finally {
        await setAutoApproveLow(true);
      }
      expect(await requestsOf(serviceId)).toEqual(['executed', 'pending_approval']);
      // The medium one never ran: it waits for a person under either setting.
      const restarted = await restart(caller, gate, 'web-6');
      expect(restarted.status).toBe('pending_approval');
      expect(applied).not.toContain(restarted.id);
    });

    it('a Handle with no capability that acts on a gate carries none, granted or not', async () => {
      const serviceId = await insertPrincipal('service', 'member');
      await grantGate(serviceId, gatekeeperId);

      const issued = await issue(serviceId, ['search', 'submit_observations']);
      expect(issued.scope.resources).toEqual({});
    });
  },
);
