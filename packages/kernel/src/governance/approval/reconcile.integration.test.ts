import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BlastRadius, DECISION_TRANSITIONS, transition } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  endActivity,
  recordSourceObservation,
  registerSource,
  startActivity,
} from '../../substrate/epistemic/index.js';
import { approveActionRequest } from './decide.js';
import {
  markActionRequestExecuted,
  markActionRequestFailed,
  startActionRequestExecution,
} from './execution.js';
import { getActionRequest } from './reads.js';
import {
  type ReconcileCheckRow,
  claimReconcileCheck,
  deferReconcileCheck,
  ensureReconcileCheck,
  lockReconcileCheck,
  readReconcileChecks,
  settleReconcileCheck,
} from './reconcile-checks.js';
import {
  RECONCILIATION_NOTE_MAX,
  reconcileActionRequest,
  recordObservedReconciliation,
} from './reconcile.js';
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

    /** A Decision as any application code could write one (insert-only since core/0035). */
    async function decision(
      decidedBy: string | null,
      rationale: Record<string, unknown>,
      sourceId: string | null = null,
    ): Promise<string> {
      return as(decidedBy ?? ownerId, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'governance.reconcile_decision',
          principalId: decidedBy ?? ownerId,
        });
        await endActivity(client, workspaceId, activity.id, 'completed');
        const result = await client.query<{ id: string }>(
          `insert into decisions (workspace_id, status, activity_id, summary, rationale, decided_by,
             decided_at, source_id)
           values ($1, $2, $3, 'test', $4::jsonb, $5, now(), $6) returning id`,
          [
            workspaceId,
            transition(DECISION_TRANSITIONS, 'proposed', 'approve'),
            activity.id,
            JSON.stringify(rationale),
            decidedBy,
            sourceId,
          ],
        );
        return result.rows[0]?.id as string;
      });
    }

    /** A Source of the gate kind, and an Observation of it with `content` (GO3d). */
    async function gateSource(): Promise<string> {
      return asOwner(
        async (client) =>
          (
            await registerSource(client, workspaceId, {
              kind: 'gatekeeper',
              name: `gate-${randomUUID().slice(0, 8)}`,
              ownerPrincipalId: ownerId,
              visibility: 'workspace',
              metadata: { gatekeeperId },
            })
          ).id,
      );
    }
    async function observation(sourceId: string, content: Record<string, unknown>) {
      return asOwner(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'goal_reconcile_check',
          principalId: requesterId,
        });
        const recorded = await recordSourceObservation(client, workspaceId, {
          sourceId,
          activityId: activity.id,
          content,
        });
        await endActivity(client, workspaceId, activity.id, 'completed');
        return recorded.id;
      });
    }

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
            action_request_id: string | null;
          }>(
            `select d.id, d.decided_by, d.rationale, a.kind, d.action_request_id from decisions d
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
            // Legacy 421: about the request (and its goal run, when it has one).
            action_request_id: lost.id,
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
            action_request_id: lost.id,
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
        // Nobody decided (governance/0024): only the platform's effect_seen, resting on an
        // observation of this request that satisfied its predicate — never effect_absent.
        const source = await gateSource();
        const satisfied = await observation(source, { actionRequestId: id, outcome: 'satisfied' });
        const platform = (extra: Record<string, unknown> = {}) =>
          finding(id, 'effect_seen', { basis: 'observation', observationId: satisfied, ...extra });
        for (const [verdict, rationale, sourceId] of [
          ['effect_absent', finding(id), source],
          ['effect_absent', finding(id, 'effect_absent', { basis: 'observation' }), source],
          ['effect_seen', platform({ basis: 'person' }), source],
          ['effect_seen', platform(), null],
          ['effect_seen', platform(), await gateSource()],
          [
            'effect_seen',
            platform({
              observationId: await observation(source, {
                actionRequestId: id,
                outcome: 'unsatisfied',
              }),
            }),
            source,
          ],
          [
            'effect_seen',
            platform({
              observationId: await observation(source, {
                actionRequestId: randomUUID(),
                outcome: 'satisfied',
              }),
            }),
            source,
          ],
          ['effect_seen', platform({ observationId: randomUUID() }), source],
        ] as const) {
          await expect(
            write(id, set, [verdict, await decision(null, rationale, sourceId)]),
          ).rejects.toThrow(/nobody decided is the platform's effect_seen/);
        }
        // A person's Decision says so.
        await expect(
          write(id, set, [
            'effect_absent',
            await decision(requesterId, finding(id, 'effect_absent', { basis: 'observation' })),
          ]),
        ).rejects.toThrow(/basis person/);
        await write(id, set, ['effect_absent', await decision(requesterId, finding(id))]);

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

    describe('the platform’s finding and its check (S11 GO3d, governance/0024)', () => {
      async function lostRequest(): Promise<string> {
        const created = await request(await step(), { n: randomUUID() });
        await inDoubt(created.id);
        return created.id;
      }

      const observationCheck = (operation = 'inventory.read') => ({
        gatekeeperId,
        operation,
        expect: { path: 'qty', op: 'gte' as const, value: 1 },
      });
      const ensure = (id: string, operation?: string) =>
        asOwner((client) =>
          ensureReconcileCheck(client, workspaceId, {
            actionRequestId: id,
            observationCheck: observationCheck(operation),
          }),
        );
      const checkOf = async (id: string) => {
        const found = (
          await asOwner((client) => readReconcileChecks(client, workspaceId, [id]))
        ).get(id);
        if (!found) throw new Error(`no check for ${id}`);
        return found;
      };
      /** Read when called: the principals are created in `beforeAll`. */
      const auditContext = () => ({ actorPrincipalId: requesterId, stepRunId: null });
      const settle = (id: string, input: Parameters<typeof settleReconcileCheck>[3]) =>
        asOwner(async (client) =>
          settleReconcileCheck(
            client,
            workspaceId,
            (await lockReconcileCheck(client, workspaceId, id)) as ReconcileCheckRow,
            input,
            auditContext(),
          ),
        );
      const observed = (id: string, observationId: string, sourceId: string) =>
        as(requesterId, (client) =>
          recordObservedReconciliation(client, workspaceId, {
            actionRequestId: id,
            observationId,
            sourceId,
            actorPrincipalId: requesterId,
          }),
        );
      const audits = (id: string, action: string, outcome?: string) =>
        count(
          `select count(*) as n from audit_records
            where workspace_id = $1 and resource_id = $2 and action = $3
              and ($4::text is null or payload ->> 'outcome' = $4 or payload ->> 'basis' = $4)`,
          [workspaceId, id, action, outcome ?? null],
        );

      it('records effect_seen nobody decided, resting on the observation, once; never for a request not in doubt', async () => {
        const id = await lostRequest();
        const source = await gateSource();
        const seen = await observation(source, { actionRequestId: id, outcome: 'satisfied' });
        const first = await observed(id, seen, source);
        expect(first.changed).toBe(true);
        expect(first.actionRequest.reconciliation).toBe('effect_seen');
        const [found] = await raw<{
          decided_by: string | null;
          source_id: string;
          rationale: Record<string, unknown>;
          action_request_id: string | null;
        }>(
          `select decided_by, source_id, rationale, action_request_id from decisions
            where workspace_id = $1 and id = $2`,
          [workspaceId, first.actionRequest.reconciliationDecisionId],
        );
        expect(found).toMatchObject({
          decided_by: null,
          source_id: source,
          action_request_id: id,
          rationale: expect.objectContaining({
            actionRequestId: id,
            verdict: 'effect_seen',
            basis: 'observation',
            observationId: seen,
          }),
        });
        expect(await audits(id, 'action_request.reconcile', 'observation')).toBe(1);
        // Once: a repeat changes nothing, a person's other finding is refused.
        expect((await observed(id, seen, source)).changed).toBe(false);
        await expect(
          reconcile(requesterId, { actionRequestId: id, verdict: 'effect_absent' }),
        ).rejects.toBeInstanceOf(ActionReconciliationStateError);

        const pending = await request(await step(), { n: randomUUID() });
        const early = await observation(source, {
          actionRequestId: pending.id,
          outcome: 'satisfied',
        });
        await expect(observed(pending.id, early, source)).rejects.toBeInstanceOf(
          ActionReconciliationStateError,
        );
      });

      it('creates a check pending once, for a goal step’s request in doubt, and claims it one attempt at a time under a lease', async () => {
        const id = await lostRequest();
        expect(await ensure(id)).toMatchObject({
          status: 'pending',
          attempts: 0,
          leaseUntil: null,
        });
        // One check per request, whatever is declared later.
        expect((await ensure(id, 'other.read')).observationCheck.operation).toBe('inventory.read');

        const pending = await request(await step(), { n: randomUUID() });
        await expect(ensure(pending.id)).rejects.toThrow(
          /only a goal step's request whose outcome/,
        );
        const outside = await request(undefined, { n: randomUUID() });
        await inDoubt(outside.id);
        await expect(ensure(outside.id)).rejects.toThrow(
          /only a goal step's request whose outcome/,
        );
        const untried = await lostRequest();
        await expect(
          asOwner((client) =>
            client.query(
              `insert into action_request_reconcile_checks
                 (workspace_id, action_request_id, observation_check, attempts)
               values ($1, $2, '{}'::jsonb, 1)`,
              [workspaceId, untried],
            ),
          ),
        ).rejects.toThrow(/created pending and untried/);

        const claim = () =>
          asOwner((client) => claimReconcileCheck(client, workspaceId, id, 60_000));
        const claimed = await claim();
        expect(claimed?.attempts).toBe(1);
        expect(claimed?.leaseUntil).not.toBeNull();
        expect(claimed?.firstAttemptAt).toBeInstanceOf(Date);
        expect(await claim()).toBeNull();
        // A lease that ran out (its kernel died): the next claim is a new attempt.
        await raw(
          `update action_request_reconcile_checks set lease_until = now() - interval '1 second'
            where workspace_id = $1 and action_request_id = $2`,
          [workspaceId, id],
        );
        const second = await claim();
        expect(second?.attempts).toBe(2);
        // The first claim set when the first attempt was made; later claims keep it.
        expect(second?.firstAttemptAt).toEqual(claimed?.firstAttemptAt);
        const looked = await observation(await gateSource(), {
          actionRequestId: id,
          outcome: 'unsatisfied',
        });
        await asOwner((client) =>
          deferReconcileCheck(
            client,
            workspaceId,
            second as ReconcileCheckRow,
            { delayMs: 60_000, lastError: 'predicate_unsatisfied', observationId: looked },
            auditContext(),
          ),
        );
        expect(await claim()).toBeNull();
        // Not due, but closed (its run or step ended): claimed to be settled without a call.
        const closed = await asOwner((client) =>
          claimReconcileCheck(client, workspaceId, id, 60_000, true),
        );
        expect(closed?.attempts).toBe(3);
        await raw(
          `update action_request_reconcile_checks set lease_until = null
            where workspace_id = $1 and action_request_id = $2`,
          [workspaceId, id],
        );
        expect(await checkOf(id)).toMatchObject({
          status: 'pending',
          attempts: 3,
          leaseUntil: null,
          observationId: looked,
          lastError: 'predicate_unsatisfied',
        });
        expect(await audits(id, 'action_request.reconcile_check', 'retry')).toBe(1);

        const update = (set: string) =>
          asOwner((client) =>
            client.query(
              `update action_request_reconcile_checks set ${set}
                where workspace_id = $1 and action_request_id = $2`,
              [workspaceId, id],
            ),
          );
        await expect(update('attempts = 0')).rejects.toThrow(/attempts only grow/);
        await expect(update(`observation_check = '{}'::jsonb`)).rejects.toThrow(/never changes/);
        await expect(update(`first_attempt_at = now() - interval '1 hour'`)).rejects.toThrow(
          /when the first attempt was made never changes/,
        );
        await expect(update('first_attempt_at = null')).rejects.toThrow(
          /when the first attempt was made never changes/,
        );
        // Untried checks have no first attempt, tried ones always do.
        const fresh = await lostRequest();
        await ensure(fresh);
        await expect(
          asOwner((client) =>
            client.query(
              `update action_request_reconcile_checks set attempts = 1
                where workspace_id = $1 and action_request_id = $2`,
              [workspaceId, fresh],
            ),
          ),
        ).rejects.toThrow(/action_request_reconcile_checks_first_attempt/);
      });

      it('settles once: seen only on the platform’s effect_seen from its own observation, preempted only by a finding, seen and not_seen with evidence', async () => {
        const id = await lostRequest();
        await ensure(id);
        const source = await gateSource();
        const seen = await observation(source, { actionRequestId: id, outcome: 'satisfied' });
        await expect(settle(id, { status: 'seen', observationId: seen })).rejects.toThrow(
          /seen only when the request carries the platform's effect_seen/,
        );
        await expect(settle(id, { status: 'preempted' })).rejects.toThrow(
          /preempted only by a finding/,
        );
        await expect(settle(id, { status: 'not_seen' })).rejects.toThrow(
          /action_request_reconcile_checks_evidence/,
        );
        await observed(id, seen, source);
        const another = await observation(source, { actionRequestId: id, outcome: 'satisfied' });
        await expect(settle(id, { status: 'seen', observationId: another })).rejects.toThrow(
          /seen only when/,
        );
        await settle(id, { status: 'seen', observationId: seen });
        const settled = await checkOf(id);
        expect(settled).toMatchObject({ status: 'seen', observationId: seen, leaseUntil: null });
        expect(settled.settledAt).not.toBeNull();
        expect(await audits(id, 'action_request.reconcile_check', 'seen')).toBe(1);
        await expect(settle(id, { status: 'unavailable', lastError: 'late' })).rejects.toThrow(
          /a settled check is not changed/,
        );

        const unseen = await lostRequest();
        await ensure(unseen);
        const looked = await observation(source, {
          actionRequestId: unseen,
          outcome: 'unsatisfied',
        });
        await settle(unseen, { status: 'not_seen', observationId: looked });
        expect((await checkOf(unseen)).status).toBe('not_seen');
        expect((await row(unseen)).reconciliation).toBeNull();

        // A settle with no observation of its own keeps the check's latest as its evidence.
        const later = await lostRequest();
        const check = await ensure(later);
        const earlier = await observation(source, {
          actionRequestId: later,
          outcome: 'unsatisfied',
        });
        await asOwner((client) =>
          deferReconcileCheck(
            client,
            workspaceId,
            check,
            { delayMs: 0, lastError: 'predicate_unsatisfied', observationId: earlier },
            auditContext(),
          ),
        );
        await settle(later, { status: 'not_seen', lastError: 'gate_unreachable' });
        expect(await checkOf(later)).toMatchObject({
          status: 'not_seen',
          observationId: earlier,
          lastError: 'gate_unreachable',
        });
      });

      it('a person’s finding preempts a pending check in the same transaction; a settled one stays as it was', async () => {
        const id = await lostRequest();
        await ensure(id);
        await reconcile(requesterId, { actionRequestId: id, verdict: 'effect_absent' });
        expect(await checkOf(id)).toMatchObject({ status: 'preempted' });
        expect(await audits(id, 'action_request.reconcile_check', 'preempted')).toBe(1);

        const settledFirst = await lostRequest();
        await ensure(settledFirst);
        await settle(settledFirst, { status: 'unavailable', lastError: 'gate_not_enabled' });
        await reconcile(requesterId, { actionRequestId: settledFirst, verdict: 'effect_seen' });
        expect(await checkOf(settledFirst)).toMatchObject({
          status: 'unavailable',
          lastError: 'gate_not_enabled',
        });
      });
    });

    describe('the platform’s finding on a "not there" answer (S11 「门确认不存在」 reconcile, governance/0029, I-AB1)', () => {
      const ABSENT = () => ({ gatekeeperId, operation: 'inventory.get', params: { sku: 'old' } });
      const REVIEW = () => ({ reviewedBy: ownerId, reviewedAt: new Date().toISOString() });
      const observed = (id: string, observationId: string, sourceId: string) =>
        as(requesterId, (client) =>
          recordObservedReconciliation(client, workspaceId, {
            actionRequestId: id,
            observationId,
            sourceId,
            actorPrincipalId: requesterId,
          }),
        );
      const NOT_BASELINED =
        /the platform's effect_seen on a "not there" answer rests on the request's own reconcile check making that absence call, under a version whose answers a person confirmed, and on an earlier baseline of the call that saw the thing before the action \(I-AB1\)/;

      interface AbsentCase {
        /** The baseline: of the step (default), the goal's (`null`), another step's, or none. */
        readonly baselineStepKey?: string | null | 'none';
        readonly baselineCall?: Record<string, unknown>;
        /** Look after the request was raised instead of before. */
        readonly baselineAfter?: boolean;
        /** What the request's reconcile check declares. */
        readonly declared?: Record<string, unknown>;
        /** What the Observation the finding rests on records, beside the defaults. */
        readonly evidence?: Record<string, unknown>;
      }

      /** A lost request of a goal step whose run has (or lacks) a baseline, its reconcile check
       *  making an absence call, and the platform's finding on a "not there" answer. */
      async function absentFinding(options: AbsentCase = {}) {
        const stepRunId = await step();
        const [stepRow] = await raw<{ goal_run_id: string }>(
          'select goal_run_id from step_runs where workspace_id = $1 and id = $2',
          [workspaceId, stepRunId],
        );
        const goalRunId = stepRow?.goal_run_id as string;
        const source = await gateSource();
        const baseline = async () => {
          if (options.baselineStepKey === 'none') return;
          const looked = await observation(source, {
            purpose: 'absence_baseline',
            goalRunId,
            outcome: 'satisfied',
          });
          await raw(
            `insert into goal_absence_baselines
               (workspace_id, goal_run_id, step_key, check_key, take, observation_check, status,
                attempts, first_attempt_at, observation_id, settled_at)
             values ($1, $2, $3, 'gone', 1, $4::jsonb, 'seen_present', 1, now(), $5, now())`,
            [
              workspaceId,
              goalRunId,
              options.baselineStepKey === undefined ? 's' : options.baselineStepKey,
              JSON.stringify(options.baselineCall ?? ABSENT()),
              looked,
            ],
          );
        };
        if (!options.baselineAfter) await baseline();
        const created = await request(stepRunId, { sku: 'old', n: randomUUID() });
        await inDoubt(created.id);
        if (options.baselineAfter) await baseline();
        await asOwner((client) =>
          ensureReconcileCheck(client, workspaceId, {
            actionRequestId: created.id,
            observationCheck: (options.declared ?? ABSENT()) as ReturnType<typeof ABSENT>,
          }),
        );
        const call = options.declared ?? ABSENT();
        const evidence = await observation(source, {
          actionRequestId: created.id,
          gatekeeperId: call.gatekeeperId,
          operation: call.operation,
          outcome: 'satisfied',
          absent: { status: 404 },
          absentAnswersReview: REVIEW(),
          ...options.evidence,
        });
        return () => observed(created.id, evidence, source);
      }

      it('records effect_seen on the step’s or the goal’s baseline of the same call taken before the action', async () => {
        const onStep = await (await absentFinding())();
        expect(onStep.actionRequest.reconciliation).toBe('effect_seen');
        const onGoal = await (await absentFinding({ baselineStepKey: null }))();
        expect(onGoal.actionRequest.reconciliation).toBe('effect_seen');
      });

      it('refuses it with no baseline, a later one, one of another call or another step, an unconfirmed version (or a blank confirmation), or a check with a predicate', async () => {
        const refused: [string, AbsentCase][] = [
          ['no baseline', { baselineStepKey: 'none' }],
          ['looked after the action', { baselineAfter: true }],
          ['another call', { baselineCall: { ...ABSENT(), params: { sku: 'other' } } }],
          ['another step', { baselineStepKey: 'other' }],
          ['no confirmation', { evidence: { absentAnswersReview: undefined } }],
          [
            'a blank confirmation',
            { evidence: { absentAnswersReview: { reviewedBy: '', reviewedAt: '' } } },
          ],
          ['another operation', { evidence: { operation: 'inventory.list' } }],
          [
            'a predicate',
            {
              declared: { ...ABSENT(), expect: { path: 'sku', op: 'eq', value: 'old' } },
              evidence: { expect: { path: 'sku', op: 'eq', value: 'old' } },
            },
          ],
        ];
        for (const [label, options] of refused) {
          const finding = await absentFinding(options);
          await expect(finding(), label).rejects.toThrow(NOT_BASELINED);
        }
      });

      it('leaves a finding on data alone, and a person’s on whatever they saw', async () => {
        // A person's finding: theirs to make, whatever the run's baselines say.
        const stepRunId = await step();
        const created = await request(stepRunId, { sku: 'old', n: randomUUID() });
        await inDoubt(created.id);
        await reconcile(requesterId, { actionRequestId: created.id, verdict: 'effect_seen' });
        expect((await row(created.id)).reconciliation).toBe('effect_seen');
      });
    });
  },
);
