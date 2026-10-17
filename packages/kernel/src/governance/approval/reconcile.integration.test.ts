import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BlastRadius, DECISION_TRANSITIONS, transition } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { approveActionRequest } from './decide.js';
import {
  markActionRequestExecuted,
  markActionRequestFailed,
  startActionRequestExecution,
} from './execution.js';
import { getActionRequest } from './reads.js';
import { RECONCILIATION_NOTE_MAX, reconcileActionRequest } from './reconcile.js';
import { STEP_IDEMPOTENCY_KEY_PREFIX, requestAction } from './request-action.js';
import { listStepActionOutcomes } from './step-actions.js';
import {
  ActionInDoubtError,
  ActionReconciliationForbiddenError,
  ActionReconciliationStateError,
} from './types.js';

/**
 * governance/approval/reconcile.integration (S11 GO3c, plan §3.3 I-G4, §4.7 "结果未知",
 * migrations/governance/0023):
 *
 *   - a goal step's business-action identity (step, Gatekeeper, Operation, params): the step makes
 *     each request once, whatever key the caller names; one whose outcome is unknown is replayed,
 *     never run again, and holds back other calls of its Operation in the step;
 *   - a person records what they found (`effect_seen` / `effect_absent`) and the requester alone
 *     decides to run it again — after which the step's next request with that identity is a new
 *     ActionRequest, evaluated by the policy and approved like any other;
 *   - the database guard: both are write-once, and who decided is checked from the Decision and
 *     `principals`, not from the writer.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'governance/approval — step identity and reconciliation (S11 GO3c, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let requesterId: string;
    let memberId: string;
    let agentId: string;
    let disabledOwnerId: string;
    let gatekeeperId: string;

    const as = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);
    const asOwner = <T>(fn: (client: PoolClient) => Promise<T>) => as(ownerId, fn);

    /** A write with the guards off — fixtures the write paths of this module do not own. */
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('set local session_replication_role = replica');
          return (await client.query(sql, [...params])).rows as T[];
        },
        { skipRoleSwitch: true },
      );

    async function principal(kind: string, role: string, disabled = false): Promise<string> {
      const id = randomUUID();
      await raw(
        `insert into principals (workspace_id, id, kind, role, display_name, disabled_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [workspaceId, id, kind, role, `${kind}-${id.slice(0, 8)}`, disabled ? new Date() : null],
      );
      return id;
    }

    /** A running GoalRun of the requester with one running StepRun. */
    async function step(): Promise<string> {
      const [goal] = await raw<{ id: string }>(
        `insert into goal_runs (workspace_id, status, on_behalf_of, statement, current_revision,
           confirmed_at, budget_max_tokens, budget_max_steps, budget_max_revisions,
           budget_max_wall_clock_seconds)
         values ($1, 'running', $2, 'a goal', 1, now(), 100000, 10, 5, 3600) returning id`,
        [workspaceId, requesterId],
      );
      await raw(
        `insert into plan_revisions (workspace_id, goal_run_id, revision, status, plan, proposed_by,
           decided_by, decided_at)
         values ($1, $2, 1, 'accepted', '{"steps":[{"key":"s"}]}', $3, $3, now())`,
        [workspaceId, goal?.id, requesterId],
      );
      const [row] = await raw<{ id: string }>(
        `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision, status,
           attempt_count)
         values ($1, $2, 's', 1, 'running', 1) returning id`,
        [workspaceId, goal?.id],
      );
      return row?.id as string;
    }

    interface RequestOptions {
      readonly actionKind?: string;
      readonly idempotencyKey?: string;
      readonly blastRadius?: BlastRadius;
    }

    /** A request of `stepRunId` (none: outside a goal) on behalf of the requester. Medium blast
     *  radius by default: the policy asks for an approval. */
    const request = (
      stepRunId: string | undefined,
      params: Record<string, unknown>,
      options: RequestOptions = {},
    ) =>
      as(requesterId, (client) =>
        requestAction(client, workspaceId, {
          gatekeeperId,
          actionKind: options.actionKind ?? 'test.go3c.write',
          blastRadius: options.blastRadius ?? 'medium',
          operationAutoApprovable: true,
          awaitDecision: false,
          onBehalfOf: requesterId,
          actorRuntime: 'pi',
          params,
          ...(stepRunId ? { stepRunId } : {}),
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          requesterScope: {
            capabilities: ['request_action'],
            resources: { gatekeeper: [gatekeeperId] },
          },
        }),
      );

    const approve = (id: string) =>
      asOwner((client) =>
        approveActionRequest(client, workspaceId, {
          actionRequestId: id,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );

    /** Approved, started, and lost: `failed` + `outcome_unknown`. */
    async function inDoubt(id: string): Promise<void> {
      await approve(id);
      await asOwner((client) => startActionRequestExecution(client, workspaceId, id));
      await asOwner((client) =>
        markActionRequestFailed(client, workspaceId, id, { failureKind: 'outcome_unknown' }),
      );
    }

    const reconcile = (
      deciderPrincipalId: string,
      input: Omit<Parameters<typeof reconcileActionRequest>[2], 'deciderPrincipalId'>,
    ) =>
      as(deciderPrincipalId, (client) =>
        reconcileActionRequest(client, workspaceId, { ...input, deciderPrincipalId }),
      );

    const row = async (id: string) => {
      const found = await asOwner((client) => getActionRequest(client, workspaceId, id));
      if (!found) throw new Error(`no action request ${id}`);
      return found;
    };

    const count = async (sql: string, params: readonly unknown[]) =>
      Number((await asOwner((client) => client.query<{ n: string }>(sql, [...params]))).rows[0]?.n);

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
            'go3c-reconcile',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      requesterId = await principal('human', 'member');
      memberId = await principal('human', 'member');
      agentId = await principal('agent', 'member');
      disabledOwnerId = await principal('human', 'owner', true);
      gatekeeperId = randomUUID();
      await raw(
        "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
        [workspaceId, gatekeeperId],
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('one request per identity in a goal step (I-G4)', () => {
      it('replays the same intent whatever key the caller names, while it is in flight and after it ran; other params, another step and outside a goal are other requests', async () => {
        const stepRunId = await step();
        const first = await request(stepRunId, { n: 1 }, { idempotencyKey: 'model-key-a' });
        expect(first.status).toBe('pending_approval');
        expect(
          first.idempotencyKey?.startsWith(`${STEP_IDEMPOTENCY_KEY_PREFIX}${stepRunId}:`),
        ).toBe(true);

        await expect(
          request(stepRunId, { n: 1 }, { idempotencyKey: 'model-key-b' }),
        ).resolves.toMatchObject({ id: first.id });
        await expect(request(stepRunId, { n: 1 })).resolves.toMatchObject({ id: first.id });
        const other = await request(stepRunId, { n: 2 });
        expect(other.id).not.toBe(first.id);
        const elsewhere = await request(await step(), { n: 1 });
        expect(elsewhere.id).not.toBe(first.id);
        // Outside a goal the caller's key is the identity, as before.
        const outside = await request(undefined, { n: 1 }, { idempotencyKey: 'model-key-a' });
        expect(outside).toMatchObject({ idempotencyKey: 'model-key-a', stepRunId: null });
        expect(outside.id).not.toBe(first.id);

        await approve(first.id);
        await asOwner((client) => startActionRequestExecution(client, workspaceId, first.id));
        await expect(request(stepRunId, { n: 1 })).resolves.toMatchObject({
          id: first.id,
          status: 'executing',
        });
        await asOwner((client) => markActionRequestExecuted(client, workspaceId, first.id));
        await expect(request(stepRunId, { n: 1 })).resolves.toMatchObject({
          id: first.id,
          status: 'executed',
        });
        expect(
          await count(
            'select count(*) as n from action_requests where workspace_id = $1 and step_run_id = $2',
            [workspaceId, stepRunId],
          ),
        ).toBe(2);
      });

      it('an outcome-unknown request is replayed and holds back its Operation in the step; a finding frees the Operation; only a re-execute makes the same intent a new request, evaluated and approved anew', async () => {
        const stepRunId = await step();
        const lost = await request(stepRunId, { n: 1 });
        await inDoubt(lost.id);

        await expect(request(stepRunId, { n: 1 })).resolves.toMatchObject({
          id: lost.id,
          status: 'failed',
          failureKind: 'outcome_unknown',
        });
        const refused = request(stepRunId, { n: 2 });
        await expect(refused).rejects.toBeInstanceOf(ActionInDoubtError);
        await expect(refused).rejects.toMatchObject({ stepRunId, inDoubtActionRequestId: lost.id });
        // Another Operation is not held back.
        await expect(
          request(stepRunId, { n: 2 }, { actionKind: 'test.go3c.other' }),
        ).resolves.toMatchObject({ status: 'pending_approval' });

        await reconcile(requesterId, { actionRequestId: lost.id, verdict: 'effect_absent' });
        await expect(request(stepRunId, { n: 2 })).resolves.toMatchObject({
          status: 'pending_approval',
        });
        // Found absent, but nobody decided to run it again: still the same request.
        await expect(request(stepRunId, { n: 1 })).resolves.toMatchObject({ id: lost.id });

        await reconcile(requesterId, { actionRequestId: lost.id, reexecute: true });
        const rerun = await request(stepRunId, { n: 1 });
        expect(rerun.id).not.toBe(lost.id);
        expect(rerun.idempotencyKey).toBe((await row(lost.id)).idempotencyKey);
        // The policy evaluated it, and its approval is its own: the first one's does not carry over.
        expect(rerun).toMatchObject({
          status: 'pending_approval',
          policyDecision: 'require_approval',
          reconciliation: null,
          reexecuteDecisionId: null,
        });
        expect(
          await count(
            `select count(*) as n from audit_records
              where workspace_id = $1 and resource_id = $2 and action = 'action_request.request'`,
            [workspaceId, rerun.id],
          ),
        ).toBe(1);
        await expect(request(stepRunId, { n: 1 })).resolves.toMatchObject({ id: rerun.id });

        // The step's outcome list: the re-executed request gave way to the new one.
        const outcomes = await asOwner((client) =>
          listStepActionOutcomes(client, workspaceId, stepRunId),
        );
        expect(outcomes.map((outcome) => outcome.id)).not.toContain(lost.id);
        expect(outcomes.map((outcome) => outcome.id)).toContain(rerun.id);
      });
    });

    describe('recording a finding and a re-execute decision', () => {
      it('the requester or an owner records a finding, as a person; only the requester re-executes', async () => {
        const stepRunId = await step();
        const lost = await request(stepRunId, { n: 1 });
        await inDoubt(lost.id);

        for (const decider of [memberId, agentId, disabledOwnerId]) {
          await expect(
            reconcile(decider, { actionRequestId: lost.id, verdict: 'effect_absent' }),
          ).rejects.toBeInstanceOf(ActionReconciliationForbiddenError);
        }
        const found = await reconcile(ownerId, {
          actionRequestId: lost.id,
          verdict: 'effect_absent',
          note: '  checked the target: no record  ',
        });
        expect(found.changed).toBe(true);
        expect(found.actionRequest).toMatchObject({
          reconciliation: 'effect_absent',
          reexecuteDecisionId: null,
        });
        await expect(
          reconcile(ownerId, { actionRequestId: lost.id, reexecute: true }),
        ).rejects.toBeInstanceOf(ActionReconciliationForbiddenError);

        const reexecuted = await reconcile(requesterId, {
          actionRequestId: lost.id,
          reexecute: true,
        });
        expect(reexecuted.changed).toBe(true);
        expect(reexecuted.actionRequest.reexecuteDecisionId).not.toBeNull();

        // The Decisions, and the audit trail of who decided what.
        const decisions = await asOwner((client) =>
          client.query<{
            id: string;
            decided_by: string;
            rationale: Record<string, unknown>;
            kind: string;
          }>(
            `select d.id, d.decided_by, d.rationale, a.kind from decisions d
               join activities a on a.workspace_id = d.workspace_id and a.id = d.activity_id
              where d.workspace_id = $1 and d.id = any($2::uuid[])
              order by d.decided_at, d.id`,
            [
              workspaceId,
              [
                reexecuted.actionRequest.reconciliationDecisionId,
                reexecuted.actionRequest.reexecuteDecisionId,
              ],
            ],
          ),
        );
        expect(decisions.rows).toEqual([
          expect.objectContaining({
            id: reexecuted.actionRequest.reconciliationDecisionId,
            decided_by: ownerId,
            kind: 'governance.reconcile_decision',
            rationale: expect.objectContaining({
              actionRequestId: lost.id,
              decision: 'reconcile',
              verdict: 'effect_absent',
              basis: 'person',
              note: 'checked the target: no record',
              stepRunId,
            }),
          }),
          expect.objectContaining({
            id: reexecuted.actionRequest.reexecuteDecisionId,
            decided_by: requesterId,
            kind: 'governance.reconcile_decision',
            rationale: expect.objectContaining({
              actionRequestId: lost.id,
              decision: 'reexecute',
            }),
          }),
        ]);
        const audit = await asOwner((client) =>
          client.query<{
            action: string;
            actor_principal_id: string;
            payload: Record<string, unknown>;
          }>(
            `select action, actor_principal_id, payload from audit_records
              where workspace_id = $1 and resource_id = $2
                and action in ('action_request.reconcile', 'action_request.reexecute')
              order by created_at, id`,
            [workspaceId, lost.id],
          ),
        );
        expect(audit.rows).toEqual([
          {
            action: 'action_request.reconcile',
            actor_principal_id: ownerId,
            payload: expect.objectContaining({
              verdict: 'effect_absent',
              basis: 'person',
              decisionId: reexecuted.actionRequest.reconciliationDecisionId,
              stepRunId,
              note: 'checked the target: no record',
            }),
          },
          {
            action: 'action_request.reexecute',
            actor_principal_id: requesterId,
            payload: expect.objectContaining({
              decisionId: reexecuted.actionRequest.reexecuteDecisionId,
              stepRunId,
            }),
          },
        ]);
        expect(
          await count(
            `select count(*) as n from outbox
              where workspace_id = $1 and event_type = 'ActionRequestUpdated'
                and payload ->> 'actionRequestId' = $2`,
            [workspaceId, lost.id],
          ),
        ).toBeGreaterThanOrEqual(2);
      });

      it('each is recorded once: a repeat changes nothing, a different finding is refused; only a failed request whose outcome is unknown is reconciled, and re-executed only after effect_absent', async () => {
        const stepRunId = await step();
        const seen = await request(stepRunId, { n: 1 });
        await inDoubt(seen.id);

        await expect(
          reconcile(requesterId, { actionRequestId: seen.id, reexecute: true }),
        ).rejects.toThrow(/has no finding yet/);
        await expect(reconcile(requesterId, { actionRequestId: seen.id })).rejects.toBeInstanceOf(
          ActionReconciliationStateError,
        );
        await expect(
          reconcile(requesterId, {
            actionRequestId: seen.id,
            verdict: 'effect_seen',
            note: 'x'.repeat(RECONCILIATION_NOTE_MAX + 1),
          }),
        ).rejects.toThrow(/at most/);

        await reconcile(requesterId, { actionRequestId: seen.id, verdict: 'effect_seen' });
        await expect(
          reconcile(memberId, { actionRequestId: seen.id, verdict: 'effect_seen' }),
        ).resolves.toMatchObject({ changed: false });
        await expect(
          reconcile(requesterId, { actionRequestId: seen.id, verdict: 'effect_absent' }),
        ).rejects.toThrow(/recorded once/);
        await expect(
          reconcile(requesterId, { actionRequestId: seen.id, reexecute: true }),
        ).rejects.toThrow(/run again only when no effect was found/);
        // Found effect_seen: replayed as executed, and it holds back nothing.
        await expect(request(stepRunId, { n: 1 })).resolves.toMatchObject({ id: seen.id });
        await expect(request(stepRunId, { n: 2 })).resolves.toMatchObject({
          status: 'pending_approval',
        });

        const absent = await request(stepRunId, { n: 3 }, { actionKind: 'test.go3c.again' });
        await inDoubt(absent.id);
        await reconcile(requesterId, {
          actionRequestId: absent.id,
          verdict: 'effect_absent',
          reexecute: true,
        });
        await expect(
          reconcile(requesterId, {
            actionRequestId: absent.id,
            verdict: 'effect_absent',
            reexecute: true,
          }),
        ).resolves.toMatchObject({ changed: false });

        const pending = await request(stepRunId, { n: 4 });
        await expect(
          reconcile(requesterId, { actionRequestId: pending.id, verdict: 'effect_absent' }),
        ).rejects.toThrow(/only a request whose outcome is unknown/);
        const notDelivered = await request(stepRunId, { n: 5 }, { actionKind: 'test.go3c.nd' });
        await approve(notDelivered.id);
        await asOwner((client) =>
          startActionRequestExecution(client, workspaceId, notDelivered.id),
        );
        await asOwner((client) =>
          markActionRequestFailed(client, workspaceId, notDelivered.id, {
            failureKind: 'not_delivered',
          }),
        );
        await expect(
          reconcile(requesterId, { actionRequestId: notDelivered.id, verdict: 'effect_absent' }),
        ).rejects.toThrow(/only a request whose outcome is unknown/);
      });
    });

    describe('the database guard (governance/0023)', () => {
      /** A Decision as any application code could write one (insert-only since core/0035). */
      async function decision(
        decidedBy: string | null,
        rationale: Record<string, unknown>,
      ): Promise<string> {
        return as(decidedBy ?? ownerId, async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'governance.reconcile_decision',
            principalId: decidedBy ?? ownerId,
          });
          await endActivity(client, workspaceId, activity.id, 'completed');
          const result = await client.query<{ id: string }>(
            `insert into decisions (workspace_id, status, activity_id, summary, rationale, decided_by,
               decided_at)
             values ($1, $2, $3, 'test', $4::jsonb, $5, now()) returning id`,
            [
              workspaceId,
              transition(DECISION_TRANSITIONS, 'proposed', 'approve'),
              activity.id,
              JSON.stringify(rationale),
              decidedBy,
            ],
          );
          return result.rows[0]?.id as string;
        });
      }

      /** A direct UPDATE as the application role — what code that skipped `reconcile.ts` could do. */
      const write = (id: string, set: string, params: readonly unknown[] = []) =>
        asOwner((client) =>
          client.query(`update action_requests set ${set} where workspace_id = $1 and id = $2`, [
            workspaceId,
            id,
            ...params,
          ]),
        );

      const finding = (
        id: string,
        verdict = 'effect_absent',
        extra: Record<string, unknown> = {},
      ) => ({
        actionRequestId: id,
        decision: 'reconcile',
        verdict,
        basis: 'person',
        ...extra,
      });

      async function lostRequest(): Promise<string> {
        const created = await request(await step(), { n: randomUUID() });
        await inDoubt(created.id);
        return created.id;
      }

      it('checks who decided from the Decision and principals, and that the Decision is this request’s and this kind', async () => {
        const id = await lostRequest();
        const set = 'reconciliation = $3, reconciliation_decision_id = $4';

        await expect(
          write(id, set, ['effect_absent', await decision(requesterId, finding(randomUUID()))]),
        ).rejects.toThrow(/must name this request and its finding/);
        await expect(
          write(id, set, ['effect_seen', await decision(requesterId, finding(id))]),
        ).rejects.toThrow(/must name this request and its finding/);
        await expect(
          write(id, set, [
            'effect_absent',
            await decision(requesterId, { actionRequestId: id, decision: 'reexecute' }),
          ]),
        ).rejects.toThrow(/must name this request and its finding/);
        for (const decider of [memberId, agentId, disabledOwnerId]) {
          await expect(
            write(id, set, ['effect_absent', await decision(decider, finding(id))]),
          ).rejects.toThrow(/only the requester or a workspace owner/);
        }
        await expect(
          write(id, set, ['effect_absent', await decision(null, finding(id))]),
        ).rejects.toThrow(/must come from an observation/);
        // The platform's reconcile observation (GO3d): nobody decided, the basis says so.
        await write(id, set, [
          'effect_absent',
          await decision(null, finding(id, 'effect_absent', { basis: 'observation' })),
        ]);

        await expect(
          write(id, 'reexecute_decision_id = $3', [
            await decision(ownerId, { actionRequestId: id, decision: 'reexecute' }),
          ]),
        ).rejects.toThrow(/only the requester, as a person/);
        await expect(
          write(id, 'reexecute_decision_id = $3', [
            await decision(requesterId, { actionRequestId: randomUUID(), decision: 'reexecute' }),
          ]),
        ).rejects.toThrow(/only the requester, as a person/);
        await expect(
          write(id, 'reexecute_decision_id = $3', [await decision(requesterId, finding(id))]),
        ).rejects.toThrow(/only the requester, as a person/);
        await write(id, 'reexecute_decision_id = $3', [
          await decision(requesterId, { actionRequestId: id, decision: 'reexecute' }),
        ]);
      });

      it('refuses a request inserted with a finding or a re-execute already on it — even one every CHECK accepts', async () => {
        const lost = await lostRequest();
        /** A copy of the lost request under a new id and key, with `extra` over its columns. */
        const copy = (id: string, extra: Record<string, unknown>) =>
          asOwner((client) =>
            client.query(
              `insert into action_requests
               select (jsonb_populate_record(null::action_requests, to_jsonb(a) || $3::jsonb)).*
                 from action_requests a where a.workspace_id = $1 and a.id = $2`,
              [
                workspaceId,
                lost,
                JSON.stringify({ id, idempotency_key: `explicit:copy:${id}`, ...extra }),
              ],
            ),
          );

        const seenId = randomUUID();
        await expect(
          copy(seenId, {
            reconciliation: 'effect_absent',
            reconciliation_decision_id: await decision(requesterId, finding(seenId)),
          }),
        ).rejects.toThrow(/created unreconciled/);
        const reexecuteId = randomUUID();
        await expect(
          copy(reexecuteId, {
            reexecute_decision_id: await decision(requesterId, {
              actionRequestId: reexecuteId,
              decision: 'reexecute',
            }),
          }),
        ).rejects.toThrow(/created unreconciled/);
        // The same copy without them goes in: the guard lets an ordinary insert through.
        const plainId = randomUUID();
        await copy(plainId, {});
        expect((await row(plainId)).reconciliation).toBeNull();
      });

      it('makes both write-once, and allows them only on a failed request whose outcome is unknown and a re-execute only after effect_absent', async () => {
        const id = await lostRequest();
        await reconcile(requesterId, {
          actionRequestId: id,
          verdict: 'effect_absent',
          reexecute: true,
        });
        await expect(write(id, "reconciliation = 'effect_seen'")).rejects.toThrow(/recorded once/);
        await expect(
          write(id, 'reconciliation = $3, reconciliation_decision_id = $4', [
            'effect_seen',
            await decision(requesterId, finding(id, 'effect_seen')),
          ]),
        ).rejects.toThrow(/recorded once/);
        await expect(
          write(id, 'reconciliation = null, reconciliation_decision_id = null'),
        ).rejects.toThrow(/recorded once/);
        await expect(write(id, 'reexecute_decision_id = null')).rejects.toThrow(/recorded once/);
        await expect(
          write(id, 'reexecute_decision_id = $3', [
            await decision(requesterId, { actionRequestId: id, decision: 'reexecute' }),
          ]),
        ).rejects.toThrow(/recorded once/);
        // Decisions themselves cannot be edited (core/0035).
        const current = await row(id);
        await expect(
          asOwner((client) =>
            client.query(
              `update decisions set rationale = '{}'::jsonb where workspace_id = $1 and id = $2`,
              [workspaceId, current.reconciliationDecisionId],
            ),
          ),
        ).rejects.toThrow(/permission denied/);

        const pending = await request(await step(), { n: 1 });
        await expect(
          write(pending.id, 'reconciliation = $3, reconciliation_decision_id = $4', [
            'effect_absent',
            await decision(requesterId, finding(pending.id)),
          ]),
        ).rejects.toThrow(/only a failed request whose outcome is unknown/);

        const seen = await lostRequest();
        await reconcile(requesterId, { actionRequestId: seen, verdict: 'effect_seen' });
        await expect(
          write(seen, 'reexecute_decision_id = $3', [
            await decision(requesterId, { actionRequestId: seen, decision: 'reexecute' }),
          ]),
        ).rejects.toThrow(/action_requests_reexecute_after_effect_absent/);
        await expect(write(seen, "reconciliation = 'effect_lost'")).rejects.toThrow(
          /recorded once|action_requests_reconciliation_check/,
        );
      });
    });
  },
);
