import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, Operation, PolicyWire, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, splitSqlStatements } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { requestAction } from '../../governance/approval/index.js';
import { grantCapability } from '../../governance/capability/index.js';
import {
  GatekeeperNotFoundError,
  OperationNotFoundError,
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import {
  HighBlastRadiusAutoApproveError,
  SetPolicyValidationError,
} from '../../governance/policy/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { ForbiddenError } from './authorize.js';
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
      let labGateId: string;
      let prodGateId: string;

      beforeAll(async () => {
        workspaceId = await adminInsertWorkspace('auto-approval-scope-workspace');
        ownerId = await adminInsertPrincipal(workspaceId, 'owner', 'owner');
        operatorId = await adminInsertPrincipal(workspaceId, 'operator', 'operator-no-grant');
        grantedOperatorId = await adminInsertPrincipal(workspaceId, 'operator', 'operator-kind');
        labGateId = await registerGateWithOperations(workspaceId, ownerId, 'lab-gate', [
          SHARED_OP,
          HIGH_OP,
          CARRY_OP,
        ]);
        prodGateId = await registerGateWithOperations(workspaceId, ownerId, 'prod-gate', [
          SHARED_OP,
        ]);
        // A historical action-kind grant: still what lets a non-owner write the rule.
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          grantCapability(client, workspaceId, {
            principalId: grantedOperatorId,
            resourceType: SHARED_OP.name,
            grantedBy: ownerId,
          }),
        );
      });

      async function requestStatus(gatekeeperId: string, actionKind: string): Promise<string> {
        const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind,
            blastRadius: 'medium',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: scopeCovering(labGateId, prodGateId),
            idempotencyKey: randomUUID(),
          }),
        );
        return row.status;
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
        expect(await requestStatus(labGateId, SHARED_OP.name)).toBe('pending_approval');

        const rule = (await dispatchCapability(
          { pool },
          humanCaller(workspaceId, ownerId, 'owner'),
          'set_auto_approved_action_kind',
          { gatekeeperId: labGateId, actionKindTag: SHARED_OP.name },
        )) as PolicyWire;
        expect(rule).toMatchObject({
          gatekeeperId: labGateId,
          actionKindTag: SHARED_OP.name,
          blastRadius: 'medium',
          autoApprove: true,
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
            { gatekeeperId: labGateId, actionKindTag: HIGH_OP.name },
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
            { gatekeeperId: prodGateId, actionKindTag: HIGH_OP.name },
          ),
        ).rejects.toThrow(OperationNotFoundError);
      });

      it('who may write the rule is unchanged: an operator needs a grant naming the action kind', async () => {
        await expect(
          dispatchCapability(
            { pool },
            humanCaller(workspaceId, operatorId, 'operator'),
            'set_auto_approved_action_kind',
            { gatekeeperId: prodGateId, actionKindTag: SHARED_OP.name },
          ),
        ).rejects.toThrow(ForbiddenError);

        const rule = (await dispatchCapability(
          { pool },
          humanCaller(workspaceId, grantedOperatorId, 'operator'),
          'set_auto_approved_action_kind',
          { gatekeeperId: prodGateId, actionKindTag: SHARED_OP.name },
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
            policy: { gatekeeperId: labGateId, actionKindTag: HIGH_OP.name, autoApprove: true },
          }),
        ).rejects.toThrow(HighBlastRadiusAutoApproveError);
      });

      it('"Always allow" carries over a requesterCanApprove narrowing already in force', async () => {
        const owner = humanCaller(workspaceId, ownerId, 'owner');
        await dispatchCapability({ pool }, owner, 'set_policy', {
          policy: { actionKindTag: CARRY_OP.name, autoApprove: false, requesterCanApprove: false },
        });
        const rule = (await dispatchCapability({ pool }, owner, 'set_auto_approved_action_kind', {
          gatekeeperId: labGateId,
          actionKindTag: CARRY_OP.name,
        })) as PolicyWire;
        expect(rule).toMatchObject({ autoApprove: true, requesterCanApprove: false });
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
