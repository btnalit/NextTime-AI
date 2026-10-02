import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, PrincipalKind, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ApprovalScopeError, requestAction } from '../../governance/approval/index.js';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/approval-human-decider.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) end-to-end coverage, through `dispatchCapability`, of R-17 (maintainer decision
 * D-06, docs/code-review-2026-10-02.md): `approve` / `reject` on an ActionRequest whose
 * `blast_radius` is `high`, or whose Operation is not `auto_approvable` (unpublished counts as
 * not, I17), must be decided by a person — a `kind = 'human'` Principal. A service Principal's
 * API key authenticates on the human channel too; it is refused there (403 family,
 * `HumanDecisionRequiredError extends ApprovalScopeError`) and the row stays pending. Below that
 * line a service Principal may still decide, recorded as `decidedBy`. The rule lives in
 * `governance/approval/decide.ts` (`assertPersonDecidesWhenRequired`).
 *
 * Requests are created with `requestAction` against Operations actually published on a
 * registered Gatekeeper, because the decide path resolves `auto_approvable` from the published
 * Operation, the same lookup `request_action` uses.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanChannelCaller(
  workspaceId: string,
  principalId: string,
  role: Role,
  kind: PrincipalKind,
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

function executeOperation(
  name: string,
  blastRadius: Operation['blast_radius'],
  autoApprovable: boolean,
): Operation {
  return {
    name,
    binding: { kind: 'http', method: 'POST', path: `/${name}` },
    params_schema: {},
    mode: 'execute',
    blast_radius: blastRadius,
    reversibility: false,
    auto_approvable: autoApprovable,
    await_decision: false,
    reads: [],
    writes: [],
  };
}

const HIGH_OP = executeOperation('hd.high', 'high', false);
const MEDIUM_AUTO_OP = executeOperation('hd.medium_auto', 'medium', true);
const LOW_MANUAL_OP = executeOperation('hd.low_manual', 'low', false);
/** Never published — an unclassified Operation (I17). */
const UNPUBLISHED_OP_NAME = 'hd.unpublished';

interface ActionRequestWire {
  id: string;
  status: string;
  blastRadius: string;
  decidedBy?: string | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'R-17: a person decides high-impact and non-auto-approvable ActionRequests (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;
    let serviceId: string;
    let gatekeeperId: string;

    async function insertPrincipal(
      displayName: string,
      role: Role,
      kind: PrincipalKind,
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, id, kind, role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** A pending ActionRequest for `operation`, requested on behalf of the (human) member — so
     *  neither approver below is the requester and `requester_can_approve` never applies. */
    async function pendingRequest(operation: {
      readonly name: string;
      readonly blastRadius: Operation['blast_radius'];
      readonly autoApprovable: boolean;
    }): Promise<string> {
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        requestAction(client, workspaceId, {
          gatekeeperId,
          actionKind: operation.name,
          resourceScope: gatekeeperId,
          blastRadius: operation.blastRadius,
          operationAutoApprovable: operation.autoApprovable,
          awaitDecision: false,
          onBehalfOf: memberId,
          actorRuntime: 'pi',
          requesterScope: {
            capabilities: ['request_action'],
            resources: { gatekeeper: [gatekeeperId] },
          },
        }),
      );
      expect(row.status).toBe('pending_approval');
      return row.id;
    }

    function fromOperation(op: Operation) {
      return { name: op.name, blastRadius: op.blast_radius, autoApprovable: op.auto_approvable };
    }

    async function readStatus(actionRequestId: string): Promise<ActionRequestWire> {
      return (await dispatchCapability(
        { pool },
        humanChannelCaller(workspaceId, ownerId, 'owner', 'human'),
        'get_action',
        { actionRequestId },
      )) as ActionRequestWire;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'approval-human-decider-test-workspace',
          ]);
        },
        { skipRoleSwitch: true },
      );
      ownerId = await insertPrincipal('owner', 'owner', 'human');
      memberId = await insertPrincipal('member', 'member', 'human');
      // The failure the register describes: an owner scripts `approve` with an owner-role service
      // key. Owner role passes I14 outright, so every refusal below is the person check alone.
      serviceId = await insertPrincipal('approval-bot', 'owner', 'service');

      gatekeeperId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.register_gatekeeper',
            principalId: ownerId,
          });
          const registered = await registerGatekeeper(client, workspaceId, {
            name: 'human-decider-gate',
            transportKind: 'http',
            target: 'human-decider-system',
            endpoint: 'https://gate.human-decider-test.invalid/',
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          });
          await importManifest(client, workspaceId, {
            gatekeeperId: registered.gatekeeperId,
            operations: [HIGH_OP, MEDIUM_AUTO_OP, LOW_MANUAL_OP],
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: activity.id,
          });
          for (const op of [HIGH_OP, MEDIUM_AUTO_OP, LOW_MANUAL_OP]) {
            await publishOperation(client, workspaceId, {
              gatekeeperId: registered.gatekeeperId,
              name: op.name,
            });
          }
          return registered.gatekeeperId;
        },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a service Principal approving a high request is refused (403 family), and the request stays pending', async () => {
      const id = await pendingRequest(fromOperation(HIGH_OP));
      const bot = humanChannelCaller(workspaceId, serviceId, 'owner', 'service');

      const refusal = dispatchCapability({ pool }, bot, 'approve', {
        actionRequestId: id,
        reason: 'scripted approval',
      });
      await expect(refusal).rejects.toBeInstanceOf(ApprovalScopeError);
      await expect(refusal).rejects.toMatchObject({
        name: 'HumanDecisionRequiredError',
        actionRequestId: id,
        message: expect.stringContaining('a person must approve or reject'),
      });

      const still = await readStatus(id);
      expect(still.status).toBe('pending_approval');
      expect(still.decidedBy).toBeNull();
    });

    it('a service Principal rejecting a high request is refused too', async () => {
      const id = await pendingRequest(fromOperation(HIGH_OP));
      const bot = humanChannelCaller(workspaceId, serviceId, 'owner', 'service');

      const refusal = dispatchCapability({ pool }, bot, 'reject', {
        actionRequestId: id,
        reason: 'scripted rejection',
      });
      await expect(refusal).rejects.toBeInstanceOf(ApprovalScopeError);
      await expect(refusal).rejects.toMatchObject({ name: 'HumanDecisionRequiredError' });

      expect((await readStatus(id)).status).toBe('pending_approval');
    });

    it('a service Principal may approve a medium request whose Operation is auto_approvable, recorded as decidedBy', async () => {
      const id = await pendingRequest(fromOperation(MEDIUM_AUTO_OP));
      const bot = humanChannelCaller(workspaceId, serviceId, 'owner', 'service');

      const approved = (await dispatchCapability({ pool }, bot, 'approve', {
        actionRequestId: id,
      })) as ActionRequestWire;
      expect(approved.status).toBe('approved');
      expect(approved.decidedBy).toBe(serviceId);
    });

    it('a service Principal approving a low request whose Operation is auto_approvable:false is refused', async () => {
      const id = await pendingRequest(fromOperation(LOW_MANUAL_OP));
      const bot = humanChannelCaller(workspaceId, serviceId, 'owner', 'service');

      const refusal = dispatchCapability({ pool }, bot, 'approve', { actionRequestId: id });
      await expect(refusal).rejects.toBeInstanceOf(ApprovalScopeError);
      await expect(refusal).rejects.toMatchObject({
        name: 'HumanDecisionRequiredError',
        message: expect.stringContaining('not auto_approvable'),
      });

      expect((await readStatus(id)).status).toBe('pending_approval');
    });

    it('a service Principal deciding a request for an unpublished (unclassified) Operation is refused', async () => {
      const id = await pendingRequest({
        name: UNPUBLISHED_OP_NAME,
        blastRadius: 'medium',
        autoApprovable: false,
      });
      const bot = humanChannelCaller(workspaceId, serviceId, 'owner', 'service');

      await expect(
        dispatchCapability({ pool }, bot, 'reject', { actionRequestId: id }),
      ).rejects.toMatchObject({
        name: 'HumanDecisionRequiredError',
        message: expect.stringContaining('not published'),
      });
      expect((await readStatus(id)).status).toBe('pending_approval');
    });

    it('a human approving a high request succeeds, as before', async () => {
      const id = await pendingRequest(fromOperation(HIGH_OP));
      const owner = humanChannelCaller(workspaceId, ownerId, 'owner', 'human');

      const approved = (await dispatchCapability({ pool }, owner, 'approve', {
        actionRequestId: id,
        reason: 'change window confirmed',
      })) as ActionRequestWire;
      expect(approved.status).toBe('approved');
      expect(approved.decidedBy).toBe(ownerId);
    });

    it('a human may still approve a low request whose Operation is auto_approvable:false', async () => {
      const id = await pendingRequest(fromOperation(LOW_MANUAL_OP));
      const owner = humanChannelCaller(workspaceId, ownerId, 'owner', 'human');

      const approved = (await dispatchCapability({ pool }, owner, 'approve', {
        actionRequestId: id,
      })) as ActionRequestWire;
      expect(approved.status).toBe('approved');
      expect(approved.decidedBy).toBe(ownerId);
    });
  },
);
