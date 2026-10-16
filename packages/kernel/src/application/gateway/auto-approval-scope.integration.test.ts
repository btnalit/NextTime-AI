import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, Operation, PolicyWire, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, splitSqlStatements } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  ActionRequestNotFoundError,
  type ActionRequestRow,
  ApprovalScopeError,
  SelfApprovalNotAllowedError,
  requestAction,
} from '../../governance/approval/index.js';
import { ReviewedVersionChangedError, grantCapability } from '../../governance/capability/index.js';
import {
  GatekeeperNotFoundError,
  OperationNotFoundError,
  deprecateOperation,
  getPublishedOperation,
  importManifest,
  operationRecordDigest,
  proposeOperation,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import {
  HighBlastRadiusAutoApproveError,
  SetPolicyValidationError,
} from '../../governance/policy/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for review 2026-10-02 R-20 /
 * decision D-15 — "Always allow" is keyed by (gatekeeper, action kind) — and for migration
 * governance/0016's two data steps (the R-20 re-scope of legacy workspace-wide rules and the R-21 /
 * D-16 AgentPolicy default). Two gates expose the same Operation name, the case D-15 was decided
 * on ("two docker instances are enough"). Policy evaluation is driven through
 * `governance/approval`'s `requestAction` directly, so no gate is ever called.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function operation(overrides: Partial<Operation> & Pick<Operation, 'name'>): Operation {
  return {
    description: 'A test operation.',
    binding: { kind: 'http', method: 'POST', path: '/op' },
    params_schema: {},
    mode: 'execute',
    blast_radius: 'medium',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
    ...overrides,
  };
}

const SHARED_OP = operation({ name: 'shared.restart' });
const HIGH_OP = operation({ name: 'shared.wipe', blast_radius: 'high' });
const CARRY_OP = operation({ name: 'carry.kind' });
const SELF_OP = operation({ name: 'self.kind' });
// Legacy 218: the action kind the old "always allow" check confused with a gate grant.
const NAMED_GATEKEEPER_OP = operation({ name: 'gatekeeper' });

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
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

function scopeCovering(...gatekeeperIds: string[]): CapabilityScope {
  return { capabilities: ['request_action'], resources: { gatekeeper: gatekeeperIds } };
}

async function migrationDoBlocks(): Promise<string[]> {
  const sql = await readFile(
    path.join(MIGRATIONS_DIR, 'governance', '0016_auto_approval_scope.sql'),
    'utf8',
  );
  const blocks = splitSqlStatements(sql).filter((statement) => statement.includes('do $$'));
  if (blocks.length !== 2) throw new Error(`expected two do-blocks in 0016, got ${blocks.length}`);
  return blocks;
}

describe.runIf(DATABASE_URL !== undefined)(
  'auto-approval scope — R-20 / D-15 and migration governance/0016 (integration, real Postgres)',
  () => {
    let pool: Pool;

    async function adminInsertWorkspace(name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function adminInsertPrincipal(ws: string, role: Role, name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: ws, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [ws, id, role, name],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function registerGateWithOperations(
      ws: string,
      ownerId: string,
      name: string,
      operations: readonly Operation[],
    ): Promise<string> {
      return withWorkspace(pool, { workspaceId: ws, principalId: ownerId }, async (client) => {
        const activity = await startActivity(client, ws, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        const { gatekeeperId } = await registerGatekeeper(client, ws, {
          name,
          transportKind: 'http',
          target: name,
          endpoint: `http://${name}.invalid:8080`,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        await importManifest(client, ws, {
          gatekeeperId,
          operations,
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
        for (const op of operations) {
          await publishOperation(client, ws, { gatekeeperId, name: op.name });
        }
        return gatekeeperId;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('set_auto_approved_action_kind / set_policy keyed by (gatekeeper, action kind)', () => {
      let workspaceId: string;
      let ownerId: string;
      let operatorId: string;
      let grantedOperatorId: string;
      let labOperatorId: string;
      let labGateId: string;
      let prodGateId: string;

      beforeAll(async () => {
        workspaceId = await adminInsertWorkspace('auto-approval-scope-workspace');
        ownerId = await adminInsertPrincipal(workspaceId, 'owner', 'owner');
        operatorId = await adminInsertPrincipal(workspaceId, 'operator', 'operator-no-grant');
        grantedOperatorId = await adminInsertPrincipal(workspaceId, 'operator', 'operator-kind');
        labOperatorId = await adminInsertPrincipal(workspaceId, 'operator', 'operator-lab-gate');
        labGateId = await registerGateWithOperations(workspaceId, ownerId, 'lab-gate', [
          SHARED_OP,
          HIGH_OP,
          CARRY_OP,
          SELF_OP,
        ]);
        prodGateId = await registerGateWithOperations(workspaceId, ownerId, 'prod-gate', [
          SHARED_OP,
          NAMED_GATEKEEPER_OP,
        ]);
        // A historical action-kind grant: still what lets a non-owner write the rule.
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          await grantCapability(client, workspaceId, {
            principalId: grantedOperatorId,
            resourceType: SHARED_OP.name,
            grantedBy: ownerId,
          });
          // The only kind of grant written since R-26 / D-14: one gate.
          await grantCapability(client, workspaceId, {
            principalId: labOperatorId,
            resourceType: 'gatekeeper',
            resourceId: labGateId,
            grantedBy: ownerId,
          });
        });
      });

      // As `request_action` makes it: against the definition published now (legacy 218).
      async function request(
        gatekeeperId: string,
        actionKind: string,
        onBehalfOf = ownerId,
      ): Promise<ActionRequestRow> {
        return withWorkspace(pool, { workspaceId, principalId: onBehalfOf }, async (client) => {
          const published = await getPublishedOperation(
            client,
            workspaceId,
            gatekeeperId,
            actionKind,
          );
          return requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind,
            resourceScope: gatekeeperId, // as request_action sets it
            blastRadius: 'medium',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf,
            actorRuntime: 'pi',
            requesterScope: scopeCovering(labGateId, prodGateId),
            idempotencyKey: randomUUID(),
            ...(published ? { operationDigest: operationRecordDigest(published) } : {}),
          });
        });
      }

      async function requestStatus(gatekeeperId: string, actionKind: string): Promise<string> {
        return (await request(gatekeeperId, actionKind)).status;
      }

      // "Always allow" is ticked on a request for that gate and action kind.
      async function alwaysAllowParams(
        gatekeeperId: string,
        actionKindTag: string,
        onBehalfOf = ownerId,
      ) {
        const ticked = await request(gatekeeperId, actionKindTag, onBehalfOf);
        return { gatekeeperId, actionKindTag, actionRequestId: ticked.id };
      }

      async function listPolicies(): Promise<readonly PolicyWire[]> {
        const result = (await dispatchCapability(
          { pool },
          humanCaller(workspaceId, ownerId, 'owner'),
          'list_policies',
          {},
        )) as { items: readonly PolicyWire[] };
        return result.items;
      }

      it('"Always allow" on one gate auto-approves that gate only — the same name on another gate still asks', async () => {
        const ticked = await request(labGateId, SHARED_OP.name);
        expect(ticked.status).toBe('pending_approval');

        const rule = (await dispatchCapability(
          { pool },
          humanCaller(workspaceId, ownerId, 'owner'),
          'set_auto_approved_action_kind',
          { gatekeeperId: labGateId, actionKindTag: SHARED_OP.name, actionRequestId: ticked.id },
        )) as PolicyWire;
        expect(rule).toMatchObject({
          gatekeeperId: labGateId,
          actionKindTag: SHARED_OP.name,
          blastRadius: 'medium',
          autoApprove: true,
          operationVersion: 1,
          publishedOperationVersion: 1,
          autoApproveConsent: 'current',
        });

        expect(await requestStatus(labGateId, SHARED_OP.name)).toBe('auto_approved');
        expect(await requestStatus(prodGateId, SHARED_OP.name)).toBe('pending_approval');
        expect(await listPolicies()).toContainEqual(
          expect.objectContaining({ id: rule.id, gatekeeperId: labGateId }),
        );
      });

      it('refuses a high-blast-radius Operation in the kernel and writes nothing', async () => {
        await expect(
          dispatchCapability(
            { pool },
            humanCaller(workspaceId, ownerId, 'owner'),
            'set_auto_approved_action_kind',
            await alwaysAllowParams(labGateId, HIGH_OP.name),
          ),
        ).rejects.toThrow(HighBlastRadiusAutoApproveError);
        expect((await listPolicies()).filter((row) => row.actionKindTag === HIGH_OP.name)).toEqual(
          [],
        );
      });

      it('404s an Operation that is not published on that gate', async () => {
        await expect(
          dispatchCapability(
            { pool },
            humanCaller(workspaceId, ownerId, 'owner'),
            'set_auto_approved_action_kind',
            await alwaysAllowParams(prodGateId, HIGH_OP.name),
          ),
        ).rejects.toThrow(OperationNotFoundError);
      });

      it('who may tick it: whoever may approve that call (I14 on the target gate)', async () => {
        const operator = humanCaller(workspaceId, operatorId, 'operator');
        // Someone else's request it cannot see: not found, as get_action answers.
        await expect(
          dispatchCapability(
            { pool },
            operator,
            'set_auto_approved_action_kind',
            await alwaysAllowParams(prodGateId, SHARED_OP.name),
          ),
        ).rejects.toThrow(ActionRequestNotFoundError);
        // Its own request, but no grant: it may not approve it, so it may not allow it either.
        await expect(
          dispatchCapability(
            { pool },
            operator,
            'set_auto_approved_action_kind',
            await alwaysAllowParams(prodGateId, SHARED_OP.name, operatorId),
          ),
        ).rejects.toThrow(ApprovalScopeError);

        // A grant on the lab gate covers the lab gate only.
        const labOperator = humanCaller(workspaceId, labOperatorId, 'operator');
        await expect(
          dispatchCapability(
            { pool },
            labOperator,
            'set_auto_approved_action_kind',
            await alwaysAllowParams(prodGateId, SHARED_OP.name, labOperatorId),
          ),
        ).rejects.toThrow(ApprovalScopeError);
        // The old check matched any grant whose resource type equals the action kind: an
        // Operation named "gatekeeper" passed on every gate for anyone holding one gate grant.
        await expect(
          dispatchCapability(
            { pool },
            labOperator,
            'set_auto_approved_action_kind',
            await alwaysAllowParams(prodGateId, NAMED_GATEKEEPER_OP.name, labOperatorId),
          ),
        ).rejects.toThrow(ApprovalScopeError);
        expect(
          (await listPolicies()).filter((row) => row.actionKindTag === NAMED_GATEKEEPER_OP.name),
        ).toEqual([]);
        const labRule = (await dispatchCapability(
          { pool },
          labOperator,
          'set_auto_approved_action_kind',
          await alwaysAllowParams(labGateId, SHARED_OP.name),
        )) as PolicyWire;
        expect(labRule).toMatchObject({ gatekeeperId: labGateId, autoApprove: true });

        const rule = (await dispatchCapability(
          { pool },
          humanCaller(workspaceId, grantedOperatorId, 'operator'),
          'set_auto_approved_action_kind',
          await alwaysAllowParams(prodGateId, SHARED_OP.name),
        )) as PolicyWire;
        expect(rule.gatekeeperId).toBe(prodGateId);
        expect(await requestStatus(prodGateId, SHARED_OP.name)).toBe('auto_approved');

        // Back to asking on the prod gate (owner, gate-scoped set_policy).
        const reset = (await dispatchCapability(
          { pool },
          humanCaller(workspaceId, ownerId, 'owner'),
          'set_policy',
          {
            policy: { gatekeeperId: prodGateId, actionKindTag: SHARED_OP.name, autoApprove: false },
          },
        )) as PolicyWire;
        expect(reset).toMatchObject({ id: rule.id, autoApprove: false });
        expect(await requestStatus(prodGateId, SHARED_OP.name)).toBe('pending_approval');
      });

      it('who may tick it: the self-approval rule applies as it does to approve (review #493 M2)', async () => {
        const owner = humanCaller(workspaceId, ownerId, 'owner');
        const labOperator = humanCaller(workspaceId, labOperatorId, 'operator');
        // Requesters may not approve their own SELF_OP requests on the lab gate.
        await dispatchCapability({ pool }, owner, 'set_policy', {
          policy: {
            gatekeeperId: labGateId,
            actionKindTag: SELF_OP.name,
            autoApprove: false,
            requesterCanApprove: false,
          },
        });
        const own = await request(labGateId, SELF_OP.name, labOperatorId);
        await expect(
          dispatchCapability({ pool }, labOperator, 'approve', { actionRequestId: own.id }),
        ).rejects.toThrow(SelfApprovalNotAllowedError);
        await expect(
          dispatchCapability({ pool }, labOperator, 'set_auto_approved_action_kind', {
            gatekeeperId: labGateId,
            actionKindTag: SELF_OP.name,
            actionRequestId: own.id,
          }),
        ).rejects.toThrow(SelfApprovalNotAllowedError);
        expect((await request(labGateId, SELF_OP.name, labOperatorId)).status).toBe(
          'pending_approval',
        );

        // A request made before the narrowing carries no snapshot of it, but "always allow"
        // outlives the request: the narrowing in force now applies too.
        await dispatchCapability({ pool }, owner, 'set_policy', {
          policy: { gatekeeperId: labGateId, actionKindTag: SELF_OP.name, autoApprove: false },
        });
        const before = await request(labGateId, SELF_OP.name, labOperatorId);
        await dispatchCapability({ pool }, owner, 'set_policy', {
          policy: {
            gatekeeperId: labGateId,
            actionKindTag: SELF_OP.name,
            autoApprove: false,
            requesterCanApprove: false,
          },
        });
        await expect(
          dispatchCapability({ pool }, labOperator, 'set_auto_approved_action_kind', {
            gatekeeperId: labGateId,
            actionKindTag: SELF_OP.name,
            actionRequestId: before.id,
          }),
        ).rejects.toThrow(SelfApprovalNotAllowedError);

        // Someone else's request it may approve: allowed, as approving it would be.
        const rule = (await dispatchCapability(
          { pool },
          labOperator,
          'set_auto_approved_action_kind',
          await alwaysAllowParams(labGateId, SELF_OP.name),
        )) as PolicyWire;
        expect(rule).toMatchObject({ autoApprove: true, requesterCanApprove: false });
      });

      it('set_policy: a workspace-wide rule can only require approval; a gate rule wins over it', async () => {
        const owner = humanCaller(workspaceId, ownerId, 'owner');
        await expect(
          dispatchCapability({ pool }, owner, 'set_policy', {
            policy: { actionKindTag: 'other.kind', autoApprove: true },
          }),
        ).rejects.toThrow(SetPolicyValidationError);

        const workspaceRule = (await dispatchCapability({ pool }, owner, 'set_policy', {
          policy: {
            actionKindTag: SHARED_OP.name,
            autoApprove: false,
            requesterCanApprove: false,
          },
        })) as PolicyWire;
        expect(workspaceRule.gatekeeperId).toBeNull();

        // lab's gate rule (first test) still wins there; prod's gate rule says ask.
        expect(await requestStatus(labGateId, SHARED_OP.name)).toBe('auto_approved');
        expect(await requestStatus(prodGateId, SHARED_OP.name)).toBe('pending_approval');

        const rows = await listPolicies();
        expect(rows).toContainEqual(expect.objectContaining({ id: workspaceRule.id }));
        expect(
          rows.filter((row) => row.actionKindTag === SHARED_OP.name).map((r) => r.gatekeeperId),
        ).toEqual(expect.arrayContaining([null, labGateId, prodGateId]));
      });

      it('set_policy with a gate: refuses an unknown gate and auto-approval of a high Operation there', async () => {
        const owner = humanCaller(workspaceId, ownerId, 'owner');
        await expect(
          dispatchCapability({ pool }, owner, 'set_policy', {
            policy: {
              gatekeeperId: randomUUID(),
              actionKindTag: SHARED_OP.name,
              autoApprove: false,
            },
          }),
        ).rejects.toThrow(GatekeeperNotFoundError);
        await expect(
          dispatchCapability({ pool }, owner, 'set_policy', {
            policy: {
              gatekeeperId: labGateId,
              actionKindTag: HIGH_OP.name,
              autoApprove: true,
              operationVersion: 1,
            },
          }),
        ).rejects.toThrow(HighBlastRadiusAutoApproveError);
      });

      it('"Always allow" carries over a requesterCanApprove narrowing already in force', async () => {
        const owner = humanCaller(workspaceId, ownerId, 'owner');
        await dispatchCapability({ pool }, owner, 'set_policy', {
          policy: { actionKindTag: CARRY_OP.name, autoApprove: false, requesterCanApprove: false },
        });
        const rule = (await dispatchCapability(
          { pool },
          owner,
          'set_auto_approved_action_kind',
          // Someone else's request: the owner may not allow its own (review #493 M2).
          await alwaysAllowParams(labGateId, CARRY_OP.name, operatorId),
        )) as PolicyWire;
        expect(rule).toMatchObject({ autoApprove: true, requesterCanApprove: false });
      });
    });

    describe('legacy 218 — "always allow" allows the definition it was given for', () => {
      const REV_OP = operation({ name: 'rev.restart' });
      let workspaceId: string;
      let ownerId: string;
      let gateId: string;

      beforeAll(async () => {
        workspaceId = await adminInsertWorkspace('auto-approval-definition-workspace');
        ownerId = await adminInsertPrincipal(workspaceId, 'owner', 'owner');
        gateId = await registerGateWithOperations(workspaceId, ownerId, 'rev-gate', [
          REV_OP,
          operation({ name: 'rev.sibling' }),
        ]);
      });

      const owner = () => humanCaller(workspaceId, ownerId, 'owner');

      async function request(actionKind = REV_OP.name): Promise<ActionRequestRow> {
        return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const published = await getPublishedOperation(client, workspaceId, gateId, actionKind);
          return requestAction(client, workspaceId, {
            gatekeeperId: gateId,
            actionKind,
            blastRadius: published?.operation.blast_radius ?? 'medium',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: scopeCovering(gateId),
            idempotencyKey: randomUUID(),
            ...(published ? { operationDigest: operationRecordDigest(published) } : {}),
          });
        });
      }

      async function publishRevision(overrides: Partial<Operation>): Promise<void> {
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.revision',
            principalId: ownerId,
          });
          await proposeOperation(client, workspaceId, {
            gatekeeperId: gateId,
            operation: operation({ name: REV_OP.name, ...overrides }),
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: activity.id,
          });
          await publishOperation(client, workspaceId, { gatekeeperId: gateId, name: REV_OP.name });
        });
      }

      async function ruleFor(actionKind = REV_OP.name): Promise<PolicyWire | undefined> {
        const { items } = (await dispatchCapability({ pool }, owner(), 'list_policies', {})) as {
          items: readonly PolicyWire[];
        };
        return items.find((row) => row.gatekeeperId === gateId && row.actionKindTag === actionKind);
      }

      it('a revision published after "always allow" goes back through approval until it is allowed again', async () => {
        const ticked = await request();
        expect(ticked.status).toBe('pending_approval');
        await dispatchCapability({ pool }, owner(), 'set_auto_approved_action_kind', {
          gatekeeperId: gateId,
          actionKindTag: REV_OP.name,
          actionRequestId: ticked.id,
        });
        expect((await request()).status).toBe('auto_approved');

        // v2 calls another path: a definition nobody allowed.
        await publishRevision({ binding: { kind: 'http', method: 'POST', path: '/op-v2' } });
        expect((await request()).status).toBe('pending_approval');
        expect(await ruleFor()).toMatchObject({
          autoApprove: true,
          operationVersion: 1,
          publishedOperationVersion: 2,
          autoApproveConsent: 'definition_changed',
        });

        // The approval page is told before anyone ticks (UX acceptance of #592 P2-1).
        const onV2 = await request();
        const read = (id: string) =>
          dispatchCapability({ pool }, owner(), 'get_action', { actionRequestId: id }) as Promise<{
            publishedDefinition?: { version: number; requestIsCurrent: boolean };
          }>;
        expect((await read(onV2.id)).publishedDefinition).toEqual({
          version: 2,
          requestIsCurrent: true,
        });
        // `ticked` is still pending, and was made against v1.
        expect((await read(ticked.id)).publishedDefinition).toEqual({
          version: 2,
          requestIsCurrent: false,
        });
        const listed = (await dispatchCapability({ pool }, owner(), 'list_pending', {})) as {
          items: readonly { id: string; publishedDefinition?: unknown }[];
        };
        expect(listed.items.find((row) => row.id === ticked.id)?.publishedDefinition).toEqual({
          version: 2,
          requestIsCurrent: false,
        });

        // The request it was ticked on was made against v1: allowing "the latest" from it is refused.
        await expect(
          dispatchCapability({ pool }, owner(), 'set_auto_approved_action_kind', {
            gatekeeperId: gateId,
            actionKindTag: REV_OP.name,
            actionRequestId: ticked.id,
          }),
        ).rejects.toThrow(ReviewedVersionChangedError);

        // Reconfirming from the policy list names the version looked at.
        const policy = { gatekeeperId: gateId, actionKindTag: REV_OP.name, autoApprove: true };
        await expect(
          dispatchCapability({ pool }, owner(), 'set_policy', { policy }),
        ).rejects.toThrow(SetPolicyValidationError);
        await expect(
          dispatchCapability({ pool }, owner(), 'set_policy', {
            policy: { ...policy, operationVersion: 1 },
          }),
        ).rejects.toThrow(ReviewedVersionChangedError);
        expect((await ruleFor())?.operationVersion).toBe(1);

        const reconfirmed = (await dispatchCapability({ pool }, owner(), 'set_policy', {
          policy: { ...policy, operationVersion: 2 },
        })) as PolicyWire;
        expect(reconfirmed).toMatchObject({ operationVersion: 2, autoApproveConsent: 'current' });
        expect((await request()).status).toBe('auto_approved');

        // Same through "always allow" on a request made against v2, after v3 is published.
        await publishRevision({ binding: { kind: 'http', method: 'POST', path: '/op-v3' } });
        const onV3 = await request();
        expect(onV3.status).toBe('pending_approval');
        const allowed = (await dispatchCapability(
          { pool },
          owner(),
          'set_auto_approved_action_kind',
          { gatekeeperId: gateId, actionKindTag: REV_OP.name, actionRequestId: onV3.id },
        )) as PolicyWire;
        expect(allowed).toMatchObject({ operationVersion: 3, autoApproveConsent: 'current' });
        expect((await request()).status).toBe('auto_approved');
      });

      it('an opt-out needs no definition; a rule naming no real Operation is refused', async () => {
        const optOut = (await dispatchCapability({ pool }, owner(), 'set_policy', {
          policy: { gatekeeperId: gateId, actionKindTag: 'rev.sibling', autoApprove: false },
        })) as PolicyWire;
        expect(optOut).toMatchObject({ operationVersion: null, autoApproveConsent: 'current' });

        for (const autoApprove of [false, true]) {
          await expect(
            dispatchCapability({ pool }, owner(), 'set_policy', {
              policy: {
                gatekeeperId: gateId,
                actionKindTag: 'rev.never.published',
                autoApprove,
                operationVersion: 1,
              },
            }),
          ).rejects.toThrow(OperationNotFoundError);
        }
        // Workspace-wide: any string used to become a row every member sees.
        await expect(
          dispatchCapability({ pool }, owner(), 'set_policy', {
            policy: { actionKindTag: 'no.such.kind', autoApprove: false },
          }),
        ).rejects.toThrow(SetPolicyValidationError);
        const { items } = (await dispatchCapability({ pool }, owner(), 'list_policies', {})) as {
          items: readonly PolicyWire[];
        };
        expect(
          items.filter((row) =>
            ['rev.never.published', 'no.such.kind'].includes(row.actionKindTag),
          ),
        ).toEqual([]);
      });

      it('a rule whose Operation the gate no longer publishes can be turned off, never loosened (review #501 P2-2)', async () => {
        const GONE = operation({ name: `rev.gone.${randomUUID().slice(0, 8)}` });
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.gone',
            principalId: ownerId,
          });
          await importManifest(client, workspaceId, {
            gatekeeperId: gateId,
            operations: [GONE],
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: activity.id,
          });
          await publishOperation(client, workspaceId, { gatekeeperId: gateId, name: GONE.name });
        });
        const pendingOnGone = await request(GONE.name);
        expect(pendingOnGone.status).toBe('pending_approval');
        const key = { gatekeeperId: gateId, actionKindTag: GONE.name };
        await dispatchCapability({ pool }, owner(), 'set_policy', {
          policy: { ...key, autoApprove: true, operationVersion: 1, requesterCanApprove: false },
        });
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          deprecateOperation(client, workspaceId, { gatekeeperId: gateId, name: GONE.name }),
        );
        // The approval page is told nothing is published to allow (coordinator on #592).
        const pendingRead = (await dispatchCapability({ pool }, owner(), 'get_action', {
          actionRequestId: pendingOnGone.id,
        })) as { publishedDefinition?: unknown };
        expect(pendingRead.publishedDefinition).toEqual({ version: null, requestIsCurrent: false });
        expect(await ruleFor(GONE.name)).toMatchObject({
          autoApprove: true,
          publishedOperationVersion: null,
          autoApproveConsent: 'definition_changed',
        });

        // Loosening still names a published definition: 404 — clearing a `false` included, since
        // the default lets the requester approve below `high` (#493 review of #592).
        for (const policy of [
          { ...key, autoApprove: true, operationVersion: 1 },
          { ...key, autoApprove: false, requesterCanApprove: true },
          { ...key, autoApprove: false, requesterCanApprove: null },
        ]) {
          await expect(
            dispatchCapability({ pool }, owner(), 'set_policy', { policy }),
          ).rejects.toThrow(OperationNotFoundError);
        }
        // Turning it off is allowed, and leaves an ordinary rule; omitting the self-approval rule
        // keeps its `false` rather than writing the looser default.
        const off = (await dispatchCapability({ pool }, owner(), 'set_policy', {
          policy: { ...key, autoApprove: false },
        })) as PolicyWire;
        expect(off).toMatchObject({
          autoApprove: false,
          requesterCanApprove: false,
          operationVersion: null,
          autoApproveConsent: 'current',
        });
        // No rule to tighten: still 404, nothing written.
        await expect(
          dispatchCapability({ pool }, owner(), 'set_policy', {
            policy: { gatekeeperId: gateId, actionKindTag: 'rev.never.ruled', autoApprove: false },
          }),
        ).rejects.toThrow(OperationNotFoundError);
      });

      it('set_policy keeps requesterCanApprove when omitted, and clears it only on null (#493 review of #592)', async () => {
        const KEEP = operation({ name: `rev.keep.${randomUUID().slice(0, 8)}` });
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.keep',
            principalId: ownerId,
          });
          await importManifest(client, workspaceId, {
            gatekeeperId: gateId,
            operations: [KEEP],
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: activity.id,
          });
          await publishOperation(client, workspaceId, { gatekeeperId: gateId, name: KEEP.name });
        });
        const key = { gatekeeperId: gateId, actionKindTag: KEEP.name };
        const write = async (policy: Record<string, unknown>) =>
          (await dispatchCapability({ pool }, owner(), 'set_policy', {
            policy: { ...key, ...policy },
          })) as PolicyWire;
        expect(await write({ autoApprove: false, requesterCanApprove: false })).toMatchObject({
          requesterCanApprove: false,
        });
        // Omitted: kept — on the gate rule and on a workspace-wide one alike.
        expect(await write({ autoApprove: true, operationVersion: 1 })).toMatchObject({
          autoApprove: true,
          requesterCanApprove: false,
        });
        expect(await write({ autoApprove: false })).toMatchObject({ requesterCanApprove: false });
        const wide = { actionKindTag: KEEP.name };
        await dispatchCapability({ pool }, owner(), 'set_policy', {
          policy: { ...wide, autoApprove: false, requesterCanApprove: false },
        });
        expect(
          await dispatchCapability({ pool }, owner(), 'set_policy', {
            policy: { ...wide, autoApprove: false },
          }),
        ).toMatchObject({ requesterCanApprove: false });
        // `null` clears it, on a published Operation, where loosening is the owner's call.
        expect(await write({ autoApprove: false, requesterCanApprove: null })).toMatchObject({
          requesterCanApprove: null,
        });
      });

      it('"always allow" must be ticked on a request for that gate and action kind', async () => {
        const other = await request('rev.sibling');
        await expect(
          dispatchCapability({ pool }, owner(), 'set_auto_approved_action_kind', {
            gatekeeperId: gateId,
            actionKindTag: REV_OP.name,
            actionRequestId: other.id,
          }),
        ).rejects.toThrow(SetPolicyValidationError);
        await expect(
          dispatchCapability({ pool }, owner(), 'set_auto_approved_action_kind', {
            gatekeeperId: gateId,
            actionKindTag: REV_OP.name,
            actionRequestId: randomUUID(),
          }),
        ).rejects.toThrow(ActionRequestNotFoundError);
      });

      it('migration 0020: an existing rule takes the definition its writer last approved, or is suspended', async () => {
        const sql = await readFile(
          path.join(MIGRATIONS_DIR, 'governance', '0020_auto_approval_definition.sql'),
          'utf8',
        );
        const [block] = splitSqlStatements(sql).filter((statement) => statement.includes('do $$'));
        if (block === undefined) throw new Error('no do-block in 0020');

        const ws = await adminInsertWorkspace('auto-approval-definition-migration');
        const wsOwner = await adminInsertPrincipal(ws, 'owner', 'owner');
        const proven = operation({ name: 'mig.proven' });
        const unproven = operation({ name: 'mig.unproven' });
        // Review #493 M1: its writer turned this definition down — no evidence of allowing it.
        const rejected = operation({ name: 'mig.rejected' });
        const gate = await registerGateWithOperations(ws, wsOwner, 'mig-gate', [
          proven,
          unproven,
          rejected,
        ]);
        const asOwner = humanCaller(ws, wsOwner, 'owner');

        const requestOn = (actionKind: string) =>
          withWorkspace(pool, { workspaceId: ws, principalId: wsOwner }, async (client) => {
            const published = await getPublishedOperation(client, ws, gate, actionKind);
            if (!published) throw new Error('not published');
            return requestAction(client, ws, {
              gatekeeperId: gate,
              actionKind,
              blastRadius: 'medium',
              operationAutoApprovable: true,
              awaitDecision: false,
              onBehalfOf: wsOwner,
              actorRuntime: 'pi',
              requesterScope: scopeCovering(gate),
              operationDigest: operationRecordDigest(published),
            });
          });
        await dispatchCapability({ pool }, asOwner, 'approve', {
          actionRequestId: (await requestOn(proven.name)).id,
          reason: 'looked at it',
        });
        await dispatchCapability({ pool }, asOwner, 'reject', {
          actionRequestId: (await requestOn(rejected.name)).id,
          reason: 'not this one',
        });
        // Rules as the previous release wrote them: no definition on file.
        await withWorkspace(pool, { workspaceId: ws, principalId: wsOwner }, async (client) => {
          for (const actionKind of [proven.name, unproven.name, rejected.name]) {
            await client.query(
              `insert into gatekeeper_policies (workspace_id, gatekeeper_id, action_kind, blast_radius, auto_approve, set_by)
               values ($1, $2, $3, 'medium', true, $4)`,
              [ws, gate, actionKind, wsOwner],
            );
          }
        });

        await withWorkspace(pool, { workspaceId: ws, principalId: wsOwner }, async (client) => {
          await client.query(block);
          await client.query(block); // idempotent
        });

        const { items } = (await dispatchCapability({ pool }, asOwner, 'list_policies', {})) as {
          items: readonly PolicyWire[];
        };
        expect(items.find((row) => row.actionKindTag === proven.name)).toMatchObject({
          autoApproveConsent: 'current',
        });
        for (const name of [unproven.name, rejected.name]) {
          expect(items.find((row) => row.actionKindTag === name)).toMatchObject({
            operationVersion: null,
            autoApproveConsent: 'not_recorded',
          });
        }
        const audits = await withWorkspace(
          pool,
          { workspaceId: ws, principalId: wsOwner },
          (client) =>
            client.query<{ action: string; count: string }>(
              `select action, count(*)::text as count from audit_records
              where workspace_id = $1 and action like 'policy.auto_approve_definition_%'
              group by action order by action`,
              [ws],
            ),
        );
        expect(audits.rows).toEqual([
          { action: 'policy.auto_approve_definition_bound', count: '1' },
          { action: 'policy.auto_approve_definition_unproven', count: '2' },
        ]);

        expect((await requestOn(proven.name)).status).toBe('auto_approved');
        expect((await requestOn(unproven.name)).status).toBe('pending_approval');
        expect((await requestOn(rejected.name)).status).toBe('pending_approval');
      });
    });

    describe('migration governance/0016 — data steps', () => {
      async function runBlock(ws: string, principalId: string, block: string): Promise<void> {
        await withWorkspace(pool, { workspaceId: ws, principalId }, async (client) => {
          await client.query(block);
        });
      }

      async function insertGateObject(client: PoolClient, ws: string): Promise<string> {
        const id = randomUUID();
        await client.query(
          "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
          [ws, id],
        );
        return id;
      }

      it('R-20: a legacy workspace-wide "always allow" moves to its only gate, or is dropped when ambiguous — never wider', async () => {
        const [rescope] = await migrationDoBlocks();
        if (rescope === undefined) throw new Error('no re-scope block');
        const ws = await adminInsertWorkspace('auto-approval-scope-migration-r20');
        const ownerId = await adminInsertPrincipal(ws, 'owner', 'owner');

        const { gateA, gateB } = await withWorkspace(
          pool,
          { workspaceId: ws, principalId: ownerId },
          async (client) => {
            const a = await insertGateObject(client, ws);
            const b = await insertGateObject(client, ws);
            // One request on gate A only for 'single.kind' / 'narrow.kind'; on both gates for
            // 'ambiguous.kind'; none at all for 'orphan.kind'.
            const seed: Array<[string, string]> = [
              [a, 'single.kind'],
              [a, 'narrow.kind'],
              [a, 'ambiguous.kind'],
              [b, 'ambiguous.kind'],
            ];
            for (const [gatekeeperId, actionKind] of seed) {
              await requestAction(client, ws, {
                gatekeeperId,
                actionKind,
                blastRadius: 'medium',
                operationAutoApprovable: false,
                awaitDecision: false,
                onBehalfOf: ownerId,
                actorRuntime: 'pi',
                requesterScope: scopeCovering(a, b),
              });
            }
            const legacy: Array<[string, boolean, boolean | null]> = [
              ['single.kind', true, null],
              ['narrow.kind', true, false],
              ['ambiguous.kind', true, null],
              ['orphan.kind', true, null],
              ['optout.kind', false, null],
            ];
            for (const [actionKind, autoApprove, requesterCanApprove] of legacy) {
              await client.query(
                `insert into policies (workspace_id, action_kind, blast_radius, auto_approve, requester_can_approve, set_by)
                 values ($1, $2, 'medium', $3, $4, $5)`,
                [ws, actionKind, autoApprove, requesterCanApprove, ownerId],
              );
            }
            return { gateA: a, gateB: b };
          },
        );

        await runBlock(ws, ownerId, rescope);

        const state = await withWorkspace(
          pool,
          { workspaceId: ws, principalId: ownerId },
          async (client) => {
            const workspaceRows = await client.query<{
              action_kind: string;
              auto_approve: boolean;
              requester_can_approve: boolean | null;
            }>(
              'select action_kind, auto_approve, requester_can_approve from policies where workspace_id = $1 order by action_kind',
              [ws],
            );
            const gateRows = await client.query<{
              gatekeeper_id: string;
              action_kind: string;
              auto_approve: boolean;
              requester_can_approve: boolean | null;
            }>(
              'select gatekeeper_id, action_kind, auto_approve, requester_can_approve from gatekeeper_policies where workspace_id = $1 order by action_kind',
              [ws],
            );
            const audits = await client.query<{ payload: Record<string, unknown> }>(
              "select payload from audit_records where workspace_id = $1 and action = 'policy.auto_approve_rescoped'",
              [ws],
            );
            return {
              workspaceRows: workspaceRows.rows,
              gateRows: gateRows.rows,
              audits: audits.rows.map((row) => row.payload),
            };
          },
        );

        expect(state.gateRows).toEqual([
          {
            gatekeeper_id: gateA,
            action_kind: 'narrow.kind',
            auto_approve: true,
            requester_can_approve: false,
          },
          {
            gatekeeper_id: gateA,
            action_kind: 'single.kind',
            auto_approve: true,
            requester_can_approve: null,
          },
        ]);
        // Auto-approval-only rows are gone; the one carrying requesterCanApprove stays, opted out;
        // the opt-out row is untouched.
        expect(state.workspaceRows).toEqual([
          { action_kind: 'narrow.kind', auto_approve: false, requester_can_approve: false },
          { action_kind: 'optout.kind', auto_approve: false, requester_can_approve: null },
        ]);
        expect(state.audits).toHaveLength(4);
        const ambiguous = state.audits.find((p) => p.actionKindTag === 'ambiguous.kind');
        expect(ambiguous).toMatchObject({ gatekeeperId: null, workspaceRule: 'deleted' });
        expect(ambiguous?.candidateGatekeeperIds).toEqual(expect.arrayContaining([gateA, gateB]));
        expect(state.audits.find((p) => p.actionKindTag === 'single.kind')).toMatchObject({
          gatekeeperId: gateA,
          candidateGatekeeperIds: [gateA],
        });
        expect(state.audits.find((p) => p.actionKindTag === 'orphan.kind')).toMatchObject({
          gatekeeperId: null,
          candidateGatekeeperIds: [],
        });

        // Idempotent: nothing left to re-scope.
        await runBlock(ws, ownerId, rescope);
        const auditCount = await withWorkspace(
          pool,
          { workspaceId: ws, principalId: ownerId },
          async (client) =>
            (
              await client.query(
                "select 1 from audit_records where workspace_id = $1 and action = 'policy.auto_approve_rescoped'",
                [ws],
              )
            ).rowCount,
        );
        expect(auditCount).toBe(4);
      });

      it('R-21: an AgentPolicy false no owner ever submitted takes the new default true; an owner-submitted false stays', async () => {
        const [, flip] = await migrationDoBlocks();
        if (flip === undefined) throw new Error('no AgentPolicy block');

        const untouchedWs = await adminInsertWorkspace('auto-approval-scope-migration-r21-seeded');
        const untouchedOwner = await adminInsertPrincipal(untouchedWs, 'owner', 'owner');
        const chosenWs = await adminInsertWorkspace('auto-approval-scope-migration-r21-chosen');
        const chosenOwner = await adminInsertPrincipal(chosenWs, 'owner', 'owner');

        for (const ws of [untouchedWs, chosenWs]) {
          await withWorkspace(
            pool,
            { workspaceId: ws, principalId: randomUUID() },
            async (client) => {
              await client.query(
                'insert into agent_policies (workspace_id, allow_member_auto_approve_low) values ($1, false)',
                [ws],
              );
            },
            { skipRoleSwitch: true },
          );
        }
        // The owner of `chosenWs` once saved the AgentPolicy form, which submits the field.
        await withWorkspace(pool, { workspaceId: chosenWs, principalId: chosenOwner }, (client) =>
          client.query(
            `insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
             values ($1, $2, 'set_agent_policy', 'agent_policy', $1, $3::jsonb)`,
            [
              chosenWs,
              chosenOwner,
              JSON.stringify({ channel: 'human', params: { allowMemberAutoApproveLow: false } }),
            ],
          ),
        );

        await runBlock(untouchedWs, untouchedOwner, flip);
        await runBlock(chosenWs, chosenOwner, flip);

        async function stateOf(ws: string, principalId: string) {
          return withWorkspace(pool, { workspaceId: ws, principalId }, async (client) => {
            const policy = await client.query<{ allow_member_auto_approve_low: boolean }>(
              'select allow_member_auto_approve_low from agent_policies where workspace_id = $1',
              [ws],
            );
            const audits = await client.query<{ actor_principal_id: string }>(
              "select actor_principal_id from audit_records where workspace_id = $1 and action = 'agent_policy.auto_approve_low_default_applied'",
              [ws],
            );
            return {
              allow: policy.rows[0]?.allow_member_auto_approve_low,
              auditActors: audits.rows.map((row) => row.actor_principal_id),
            };
          });
        }

        expect(await stateOf(untouchedWs, untouchedOwner)).toEqual({
          allow: true,
          auditActors: [untouchedOwner],
        });
        expect(await stateOf(chosenWs, chosenOwner)).toEqual({ allow: false, auditActors: [] });

        // The column default flipped too: a row written without the field now allows.
        const fresh = await adminInsertWorkspace('auto-approval-scope-migration-r21-fresh');
        const allow = await withWorkspace(
          pool,
          { workspaceId: fresh, principalId: randomUUID() },
          async (client) =>
            (
              await client.query<{ allow_member_auto_approve_low: boolean }>(
                'insert into agent_policies (workspace_id) values ($1) returning allow_member_auto_approve_low',
                [fresh],
              )
            ).rows[0]?.allow_member_auto_approve_low,
          { skipRoleSwitch: true },
        );
        expect(allow).toBe(true);
      });
    });
  },
);
