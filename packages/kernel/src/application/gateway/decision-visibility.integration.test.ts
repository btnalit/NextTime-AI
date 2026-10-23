import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { createGoalRun } from '../goal/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import {
  getDecisionChainForExplorer,
  getProvenanceForExplorer,
  getProvenanceReportForExplorer,
  listDecisionsForExplorer,
} from './explorer-read-service.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for STATUS legacy 421: a
 * Decision is read only by whoever may see what it is about (migrations/governance/0028,
 * substrate/epistemic/decision-visibility.ts), on every read that returns Decisions —
 * `query_decisions`, `find_precedents`, `causal_chain`, `decision_impact`, `explain`, the Explorer
 * (decision list, decision chain, provenance and its report) and `export_prov`.
 *
 * The fixture: a requester's goal run with one step, a request of that step and a request of no
 * goal, both at one gate; Decisions about each (approval, reconcile, outcome), one naming a request
 * that does not exist, one about nothing, and an agent's Decisions in the requester's private and
 * shared conversations. Every governed Decision's rationale carries `actionKind`, so
 * `find_precedents{actionKindTag}` would list all of them to a reader allowed to see them.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MIGRATION_0028 = path.join(MIGRATIONS_DIR, 'governance', '0028_decision_subjects.sql');

const BUDGET = { maxTokens: 100_000, maxSteps: 10, maxRevisions: 2, maxWallClockSeconds: 3600 };
const ACTION_KIND = 'fixture.restart';
const READS = ['query_decisions', 'find_precedents', 'causal_chain', 'decision_impact', 'explain'];

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

function handleCaller(workspaceId: string, obo: string): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope: { capabilities: READS, resources: {} },
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'Decision visibility follows its subject — legacy 421 (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let requesterId: string;
    let otherMemberId: string;
    let scopeHolderId: string;
    let auditorId: string;
    let goalRunId: string;
    let goalRequestId: string;
    let plainRequestId: string;
    const gatekeeperId = randomUUID();

    /** The Decisions under test, by what they are about. */
    const d = {} as {
      approval: string;
      reconcile: string;
      outcome: string;
      unresolved: string;
      open: string;
      privateTurn: string;
      sharedTurn: string;
    };

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });

    /** A write with the guards off — fixtures no path of this file writes. */
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      admin(async (client) => {
        await client.query('set local session_replication_role = replica');
        return (await client.query(sql, [...params])).rows as T[];
      });

    const as = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);

    async function newPrincipal(role: Role): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', $3, $4)`,
          [workspaceId, id, role, `${role}-${id.slice(0, 8)}`],
        ),
      );
      return id;
    }

    /** A Decision as the platform's writers record it: an Activity of `kind` started by `by`, then
     *  the row — on the application role, so RLS and the subject trigger both apply. */
    async function recordDecision(
      by: string,
      kind: string,
      metadata: Record<string, unknown>,
      rationale: Record<string, unknown>,
    ): Promise<string> {
      return as(by, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind,
          principalId: by,
          metadata,
        });
        const result = await client.query<{ id: string }>(
          `insert into decisions (workspace_id, status, activity_id, summary, rationale, decided_by,
             decided_at)
           values ($1, 'approved', $2, $3, $4::jsonb, $5, now())
           returning id`,
          [workspaceId, activity.id, `${kind} by ${by.slice(0, 8)}`, JSON.stringify(rationale), by],
        );
        return result.rows[0]?.id as string;
      });
    }

    /** An agent's `record_decision` in a conversation of the requester's. */
    async function turnDecision(visibility: 'private' | 'workspace'): Promise<string> {
      return as(requesterId, async (client) => {
        const chat = await client.query<{ id: string }>(
          `insert into chats (workspace_id, owner_principal_id, visibility)
           values ($1, $2, $3) returning id`,
          [workspaceId, requesterId, visibility],
        );
        const chatId = chat.rows[0]?.id as string;
        const turn = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, chat_id, sequence, status, started_by)
           values ($1, 'agent_turn', $2, 1, 'running', $3) returning id`,
          [workspaceId, chatId, requesterId],
        );
        const result = await client.query<{ id: string }>(
          `insert into decisions (workspace_id, status, activity_id, summary, rationale)
           values ($1, 'proposed', $2, $3, $4::jsonb) returning id`,
          [
            workspaceId,
            turn.rows[0]?.id,
            `the agent decided, in a ${visibility} conversation`,
            JSON.stringify({ relatedFactIds: [], relatedTaskId: null, actionKind: ACTION_KIND }),
          ],
        );
        return result.rows[0]?.id as string;
      });
    }

    const call = (caller: ResolvedCaller, name: string, params: Record<string, unknown>) =>
      dispatchCapability({ pool }, caller, name, params);

    const human = (principalId: string, role: Role) => humanCaller(workspaceId, principalId, role);

    /** Every Decision of this file `caller` gets from `query_decisions`. */
    async function listed(caller: ResolvedCaller): Promise<string[]> {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = (await call(caller, 'query_decisions', {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })) as { items: { id: string }[]; nextCursor?: string };
        ids.push(...result.items.map((item) => item.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      const mine = new Set(Object.values(d));
      return ids.filter((id) => mine.has(id)).sort();
    }

    const names = (ids: readonly string[]) =>
      ids.map((id) => Object.entries(d).find(([, value]) => value === id)?.[0]).sort();

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
            'legacy-421-decision-visibility',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      requesterId = await newPrincipal('member');
      otherMemberId = await newPrincipal('member');
      scopeHolderId = await newPrincipal('operator');
      auditorId = await newPrincipal('auditor');
      // The scope holder may decide (and so read) every request at the gate.
      await raw(
        `insert into capability_grants (workspace_id, principal_id, resource_type, resource_id,
           granted_by)
         values ($1, $2, 'gatekeeper', $3, $4)`,
        [workspaceId, scopeHolderId, gatekeeperId, ownerId],
      );

      const proposed = await as(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You do one step of a goal.' },
        }),
      );
      await as(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      const created = await as(requesterId, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId,
          proposedBy: requesterId,
          statement: 'restart the web service',
          plan: {
            steps: [
              {
                key: 'a',
                worker: { definitionId: proposed.id, version: proposed.version },
                input: {},
              },
            ],
          },
          budget: BUDGET,
        }),
      );
      goalRunId = created.goalRunId;
      const [step] = await raw<{ id: string }>(
        `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision, status)
         values ($1, $2, 'a', 1, 'running') returning id`,
        [workspaceId, goalRunId],
      );
      const [goalRequest] = await raw<{ id: string }>(
        `insert into action_requests (workspace_id, gatekeeper_id, action_kind, blast_radius,
                                      on_behalf_of, actor_runtime, step_run_id, resource_scope)
         values ($1, $2, $3, 'low', $4, 'worker', $5, $6) returning id`,
        [workspaceId, gatekeeperId, ACTION_KIND, requesterId, step?.id, gatekeeperId],
      );
      const [plainRequest] = await raw<{ id: string }>(
        `insert into action_requests (workspace_id, gatekeeper_id, action_kind, blast_radius,
                                      on_behalf_of, actor_runtime, resource_scope)
         values ($1, $2, $3, 'low', $4, 'entry', $5) returning id`,
        [workspaceId, gatekeeperId, ACTION_KIND, requesterId, gatekeeperId],
      );
      goalRequestId = goalRequest?.id as string;
      plainRequestId = plainRequest?.id as string;

      d.approval = await recordDecision(
        scopeHolderId,
        'governance.approval_decision',
        { actionRequestId: plainRequestId, actionKind: ACTION_KIND, event: 'approve' },
        { actionRequestId: plainRequestId, actionKind: ACTION_KIND, reason: 'looks right' },
      );
      d.reconcile = await recordDecision(
        requesterId,
        'governance.reconcile_decision',
        { actionRequestId: goalRequestId, decision: 'reconcile' },
        {
          actionRequestId: goalRequestId,
          decision: 'reconcile',
          verdict: 'effect_seen',
          basis: 'person',
          note: 'the service answered',
          goalRunId,
          actionKind: ACTION_KIND,
        },
      );
      d.outcome = await recordDecision(
        requesterId,
        'goal.outcome_decision',
        { goalRunId, outcome: 'achieved' },
        { decision: 'goal_outcome', goalRunId, outcome: 'achieved', actionKind: ACTION_KIND },
      );
      d.unresolved = await recordDecision(
        scopeHolderId,
        'governance.approval_decision',
        { actionRequestId: randomUUID(), actionKind: ACTION_KIND, event: 'reject' },
        { actionRequestId: randomUUID(), actionKind: ACTION_KIND, reason: 'no such request' },
      );
      d.open = await recordDecision(
        ownerId,
        'test.workspace_decision',
        {},
        { actionKind: ACTION_KIND },
      );
      d.privateTurn = await turnDecision('private');
      d.sharedTurn = await turnDecision('workspace');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('the database records each Decision’s subject from its Activity', async () => {
      const rows = await raw<{
        id: string;
        goal_run_id: string | null;
        action_request_id: string | null;
        chat_id: string | null;
        subject_unresolved: boolean;
      }>(
        `select id, goal_run_id, action_request_id, chat_id, subject_unresolved
           from decisions where workspace_id = $1`,
        [workspaceId],
      );
      const of = (id: string) => rows.find((row) => row.id === id);
      expect(of(d.approval)).toMatchObject({
        goal_run_id: null,
        action_request_id: plainRequestId,
        chat_id: null,
        subject_unresolved: false,
      });
      expect(of(d.reconcile)).toMatchObject({
        goal_run_id: goalRunId,
        action_request_id: goalRequestId,
        subject_unresolved: false,
      });
      expect(of(d.outcome)).toMatchObject({
        goal_run_id: goalRunId,
        action_request_id: null,
        subject_unresolved: false,
      });
      expect(of(d.unresolved)).toMatchObject({
        goal_run_id: null,
        action_request_id: null,
        subject_unresolved: true,
      });
      expect(of(d.open)).toMatchObject({
        goal_run_id: null,
        action_request_id: null,
        chat_id: null,
        subject_unresolved: false,
      });
      expect(of(d.privateTurn)?.chat_id).not.toBeNull();
      expect(of(d.sharedTurn)?.chat_id).not.toBeNull();
    });

    it('what an inserter puts in the subject columns is replaced by what the Activity says', async () => {
      const id = await as(requesterId, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.workspace_decision',
          principalId: requesterId,
        });
        const result = await client.query<{ id: string }>(
          `insert into decisions (workspace_id, status, activity_id, summary, goal_run_id,
             subject_unresolved)
           values ($1, 'proposed', $2, 'claims a subject', $3, false) returning id`,
          [workspaceId, activity.id, goalRunId],
        );
        return result.rows[0]?.id as string;
      });
      const [row] = await raw<{ goal_run_id: string | null }>(
        'select goal_run_id from decisions where workspace_id = $1 and id = $2',
        [workspaceId, id],
      );
      expect(row?.goal_run_id).toBeNull();
    });

    // Review #493: the subject is set on update too. Only the platform updates a Decision (the
    // workspace plane cannot, core/0035); its updates go through the same trigger.
    it('no update moves a Decision off its subject; an update of its summary alone does not recompute it', async () => {
      const subjectOf = async (id: string) =>
        (
          await raw<{
            goal_run_id: string | null;
            action_request_id: string | null;
            subject_unresolved: boolean;
            summary: string;
          }>(
            `select goal_run_id, action_request_id, subject_unresolved, summary
               from decisions where workspace_id = $1 and id = $2`,
            [workspaceId, id],
          )
        )[0];
      const before = await subjectOf(d.reconcile);
      expect(before?.goal_run_id).toBe(goalRunId);
      const widen = `update decisions
                        set goal_run_id = null, action_request_id = null, subject_unresolved = false
                      where workspace_id = $1 and id = $2`;
      await expect(
        as(otherMemberId, (client) => client.query(widen, [workspaceId, d.reconcile])),
      ).rejects.toThrow(/permission denied/);
      await admin((client) => client.query(widen, [workspaceId, d.reconcile]));
      expect(await subjectOf(d.reconcile)).toEqual(before);

      // scrub-raw-secrets' update names `summary` only, so the trigger does not run on it — seen
      // here as a subject cleared with the guards off staying cleared.
      await raw(
        'update decisions set goal_run_id = null, action_request_id = null where workspace_id = $1 and id = $2',
        [workspaceId, d.reconcile],
      );
      await admin((client) =>
        client.query('update decisions set summary = $3 where workspace_id = $1 and id = $2', [
          workspaceId,
          d.reconcile,
          'scrubbed',
        ]),
      );
      expect(await subjectOf(d.reconcile)).toMatchObject({
        goal_run_id: null,
        action_request_id: null,
        summary: 'scrubbed',
      });
      // Put back: later tests read this row with its subject.
      await raw(
        `update decisions set goal_run_id = $3, action_request_id = $4, summary = $5
          where workspace_id = $1 and id = $2`,
        [workspaceId, d.reconcile, before?.goal_run_id, before?.action_request_id, before?.summary],
      );
      expect(await subjectOf(d.reconcile)).toEqual(before);
    });

    it('a Decision cannot be hung on a conversation its recorder cannot see', async () => {
      const turnId = await as(requesterId, async (client) => {
        const chat = await client.query<{ id: string }>(
          `insert into chats (workspace_id, owner_principal_id, visibility)
           values ($1, $2, 'private') returning id`,
          [workspaceId, requesterId],
        );
        const turn = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, chat_id, sequence, status, started_by)
           values ($1, 'agent_turn', $2, 1, 'running', $3) returning id`,
          [workspaceId, chat.rows[0]?.id, requesterId],
        );
        return turn.rows[0]?.id as string;
      });
      await expect(
        as(otherMemberId, (client) =>
          client.query(
            `insert into decisions (workspace_id, status, activity_id, summary)
             values ($1, 'proposed', $2, 'on someone else''s Turn')`,
            [workspaceId, turnId],
          ),
        ),
      ).rejects.toThrow(/not visible/);
    });

    describe('query_decisions lists exactly what each reader may see', () => {
      it('a member with no scope: the workspace Decision and the shared conversation’s only', async () => {
        expect(names(await listed(human(otherMemberId, 'member')))).toEqual(['open', 'sharedTurn']);
        expect(names(await listed(handleCaller(workspaceId, otherMemberId)))).toEqual([
          'open',
          'sharedTurn',
        ]);
      });

      it('an auditor: the same — no request, goal run or private conversation of others', async () => {
        expect(names(await listed(human(auditorId, 'auditor')))).toEqual(['open', 'sharedTurn']);
      });

      it('the requester: their request’s and goal run’s Decisions, and both conversations', async () => {
        const expected = ['approval', 'open', 'outcome', 'privateTurn', 'reconcile', 'sharedTurn'];
        expect(names(await listed(human(requesterId, 'member')))).toEqual(expected);
        expect(names(await listed(handleCaller(workspaceId, requesterId)))).toEqual(expected);
      });

      it('a scope holder at the gate: the request’s approval, not the goal run’s reconcile', async () => {
        expect(names(await listed(human(scopeHolderId, 'operator')))).toEqual([
          'approval',
          'open',
          'sharedTurn',
        ]);
      });

      it('the owner on the human channel: everything but another person’s private conversation (I15)', async () => {
        expect(names(await listed(human(ownerId, 'owner')))).toEqual([
          'approval',
          'open',
          'outcome',
          'reconcile',
          'sharedTurn',
          'unresolved',
        ]);
      });

      it('the owner’s agent: every request’s Decisions (get_action’s rule), only its own goal runs’', async () => {
        expect(names(await listed(handleCaller(workspaceId, ownerId)))).toEqual([
          'approval',
          'open',
          'sharedTurn',
        ]);
      });
    });

    describe('a member with no scope reads no approval, reconcile or goal Decision anywhere', () => {
      const hidden = () => [d.approval, d.reconcile, d.outcome, d.unresolved, d.privateTurn];

      it('find_precedents', async () => {
        for (const caller of [
          human(otherMemberId, 'member'),
          handleCaller(workspaceId, otherMemberId),
        ]) {
          const result = (await call(caller, 'find_precedents', {
            actionKindTag: ACTION_KIND,
            limit: 50,
          })) as { items: { id: string }[] };
          expect(
            names(
              result.items.map((item) => item.id).filter((id) => Object.values(d).includes(id)),
            ),
          ).toEqual(['open', 'sharedTurn']);
        }
        // The owner on the human channel gets every one the kind matches.
        const owner = (await call(human(ownerId, 'owner'), 'find_precedents', {
          actionKindTag: ACTION_KIND,
          limit: 50,
        })) as { items: { id: string }[] };
        expect(owner.items.map((item) => item.id)).toEqual(
          expect.arrayContaining([d.approval, d.reconcile, d.outcome, d.unresolved]),
        );
      });

      it('causal_chain, decision_impact and explain: not found, like an unknown id', async () => {
        for (const caller of [
          human(otherMemberId, 'member'),
          handleCaller(workspaceId, otherMemberId),
        ]) {
          for (const decisionId of hidden()) {
            await expect(call(caller, 'causal_chain', { decisionId })).rejects.toThrow(
              /not found/i,
            );
            await expect(call(caller, 'decision_impact', { decisionId })).rejects.toThrow(
              /not found/i,
            );
            await expect(call(caller, 'explain', { nodeId: decisionId })).rejects.toThrow(
              /not found/i,
            );
          }
        }
        // …while the requester reads their own.
        const chain = (await call(human(requesterId, 'member'), 'causal_chain', {
          decisionId: d.reconcile,
        })) as { rootType: string };
        expect(chain.rootType).toBe('decision');
      });

      it('the Explorer: absent from the list, not found in the chain and provenance', async () => {
        const rows = await listDecisionsForExplorer(pool, workspaceId, otherMemberId, {
          limit: 500,
        });
        const ids = new Set(rows.map((row) => row.id));
        for (const decisionId of hidden()) expect(ids.has(decisionId)).toBe(false);
        expect(ids.has(d.open)).toBe(true);
        for (const decisionId of hidden()) {
          await expect(
            getDecisionChainForExplorer(pool, workspaceId, otherMemberId, { decisionId }),
          ).rejects.toThrow(/not found/i);
          await expect(
            getProvenanceForExplorer(pool, workspaceId, otherMemberId, { nodeId: decisionId }),
          ).rejects.toThrow(/not found/i);
          await expect(
            getProvenanceReportForExplorer(pool, workspaceId, otherMemberId, {
              nodeId: decisionId,
            }),
          ).rejects.toThrow(/not found/i);
        }
        // The owner's Explorer reads them (human channel).
        const ownerRows = await listDecisionsForExplorer(pool, workspaceId, ownerId, {
          limit: 500,
        });
        expect(ownerRows.map((row) => row.id)).toEqual(
          expect.arrayContaining([d.approval, d.reconcile, d.outcome, d.unresolved]),
        );
        const ownerChain = await getDecisionChainForExplorer(pool, workspaceId, ownerId, {
          decisionId: d.outcome,
        });
        expect(ownerChain.chain[0]).toMatchObject({ id: d.outcome, relationship: 'root' });
      });

      it('export_prov (an auditor): not found, by Decision id and by node id', async () => {
        for (const decisionId of hidden()) {
          await expect(
            call(human(auditorId, 'auditor'), 'export_prov', { decisionId }),
          ).rejects.toThrow(/not found/i);
          await expect(
            call(human(auditorId, 'auditor'), 'export_prov', { nodeId: decisionId }),
          ).rejects.toThrow(/not found/i);
        }
        const exported = (await call(human(ownerId, 'owner'), 'export_prov', {
          decisionId: d.approval,
        })) as { format: string; document: unknown };
        expect(exported.format).toBe('prov-json');
        expect(JSON.stringify(exported.document)).toContain(d.approval);
      });
    });

    describe('the backfill of rows written before 0028', () => {
      // 0028's own statements, run on this workspace's rows: the backfill and its NOTICE.
      const migration = readFileSync(MIGRATION_0028, 'utf8');
      const backfill = /^update decisions d\n[\s\S]*?\n {3}\);$/m.exec(migration)?.[0];
      const report = /^do \$\$\n[\s\S]*?\n\$\$;$/m.exec(migration)?.[0];

      it('gives every row the subject the trigger gives a new one, and reads a dangling one as owner-only', async () => {
        expect(backfill).toBeDefined();
        expect(report).toBeDefined();
        // A row as a release before 0028 left it — written with the trigger off: an Activity of no
        // governed kind, a rationale naming a goal run that does not exist.
        const [legacy] = await raw<{ id: string }>(
          `with activity as (
             insert into activities (workspace_id, kind, status, started_by)
             values ($1, 'test.before_0028', 'completed', $2) returning id
           )
           insert into decisions (workspace_id, status, activity_id, summary, rationale)
           select $1, 'approved', activity.id, 'written before 0028', $3::jsonb from activity
           returning id`,
          [workspaceId, ownerId, JSON.stringify({ goalRunId: randomUUID() })],
        );
        const subjects = () =>
          raw<{
            id: string;
            chat_id: string | null;
            goal_run_id: string | null;
            action_request_id: string | null;
            conflict_id: string | null;
            subject_unresolved: boolean;
          }>(
            `select id, chat_id, goal_run_id, action_request_id, conflict_id, subject_unresolved
               from decisions where workspace_id = $1 order by id`,
            [workspaceId],
          );
        const before = (await subjects()).filter((row) => row.id !== legacy?.id);
        await raw(
          `update decisions
              set chat_id = null, goal_run_id = null, action_request_id = null, conflict_id = null,
                  subject_unresolved = false
            where workspace_id = $1`,
          [workspaceId],
        );

        const notices: string[] = [];
        await admin(async (client) => {
          client.on('notice', (notice) => notices.push(notice.message ?? ''));
          await client.query(
            `${(backfill as string).replace(/;$/, '')} where d.workspace_id = $1`,
            [workspaceId],
          );
          await client.query(report as string);
        });

        const after = await subjects();
        expect(after.filter((row) => row.id !== legacy?.id)).toEqual(before);
        expect(after.find((row) => row.id === legacy?.id)).toMatchObject({
          goal_run_id: null,
          subject_unresolved: true,
        });
        expect(notices.join('\n')).toMatch(
          /governance 0028: .*governance\.approval_decision: \d+ with their subject, \d+ without.*; \d+ Decision\(s\) in all read by the workspace owner only/,
        );
      });
    });
  },
);
