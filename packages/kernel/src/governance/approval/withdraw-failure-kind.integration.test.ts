import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CapabilityScope, IllegalTransition } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { approveActionRequest } from './decide.js';
import {
  compensateActionRequest,
  markActionRequestExecuted,
  markActionRequestFailed,
  startActionRequestExecution,
  withdrawActionRequest,
} from './execution.js';
import { getActionRequest } from './reads.js';
import { requestAction } from './request-action.js';

/**
 * governance/approval/withdraw-failure-kind.integration (S11 GO1, migrations/governance/0021):
 *
 *   - `withdrawn` (plan I-G9): reached only from `pending_approval` / `approved` /
 *     `auto_approved`, terminal — refused by the transition table in code and by the
 *     `action_requests_status_guard` trigger in the database, so a direct UPDATE cannot do what the
 *     code would not.
 *   - `failure_kind`: set exactly on a `failed` / `compensated` row, by whoever wrote the failure;
 *     a writer that names none (the previous release) gets `outcome_unknown`; existing rows are
 *     backfilled from their last recorded reason.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MIGRATION_0021 = path.join(
  MIGRATIONS_DIR,
  'governance',
  '0021_action_request_withdraw_failure_kind.sql',
);

function scopeCovering(gatekeeperId: string): CapabilityScope {
  return { capabilities: ['request_action'], resources: { gatekeeper: [gatekeeperId] } };
}

describe.runIf(DATABASE_URL !== undefined)(
  'governance/approval — withdrawn and failure_kind (S11 GO1, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;

    const asOwner = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);

    /** A request in `status`: `pending_approval` (medium), `approved` (medium, then approved),
     *  `auto_approved` (low), `executing` (low, then started). */
    async function requestIn(
      status: 'pending_approval' | 'approved' | 'auto_approved' | 'executing',
      actionKind = `test.go1.${status}`,
    ): Promise<string> {
      const row = await asOwner((client) =>
        requestAction(client, workspaceId, {
          gatekeeperId,
          actionKind,
          blastRadius: status === 'pending_approval' || status === 'approved' ? 'medium' : 'low',
          operationAutoApprovable: true,
          awaitDecision: false,
          onBehalfOf: ownerId,
          actorRuntime: 'pi',
          requesterScope: scopeCovering(gatekeeperId),
        }),
      );
      if (status === 'approved') {
        await asOwner((client) =>
          approveActionRequest(client, workspaceId, {
            actionRequestId: row.id,
            approverPrincipalId: ownerId,
            approverRole: 'owner',
          }),
        );
      }
      if (status === 'executing') {
        await asOwner((client) => startActionRequestExecution(client, workspaceId, row.id));
      }
      const current = await asOwner((client) => getActionRequest(client, workspaceId, row.id));
      expect(current?.status).toBe(status);
      return row.id;
    }

    /** A direct UPDATE of the row, as code that skips the transition table would write it. */
    const rawUpdate = (id: string, set: string) =>
      asOwner((client) =>
        client.query(`update action_requests set ${set} where workspace_id = $1 and id = $2`, [
          workspaceId,
          id,
        ]),
      );

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
            'go1-withdraw-failure-kind',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      gatekeeperId = randomUUID();
      await asOwner((client) =>
        client.query(
          "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
          [workspaceId, gatekeeperId],
        ),
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('withdrawn (I-G9)', () => {
      it.each(['pending_approval', 'approved', 'auto_approved'] as const)(
        'withdraws a request that is %s, audits where it was and tells the linkage',
        async (from) => {
          const id = await requestIn(from);
          const withdrawn = await asOwner((client) =>
            withdrawActionRequest(client, workspaceId, id, { reason: 'step cancelled' }),
          );
          expect(withdrawn.status).toBe('withdrawn');
          expect(withdrawn.failureKind).toBeNull();

          const { audit, outbox } = await asOwner(async (client) => ({
            audit: (
              await client.query<{ payload: Record<string, unknown> }>(
                `select payload from audit_records
                where workspace_id = $1 and resource_id = $2 and action = 'action_request.withdraw'`,
                [workspaceId, id],
              )
            ).rows,
            outbox: (
              await client.query<{ payload: Record<string, unknown> }>(
                `select payload from outbox
                where workspace_id = $1 and event_type = 'ActionRequestUpdated'
                  and payload ->> 'actionRequestId' = $2`,
                [workspaceId, id],
              )
            ).rows,
          }));
          expect(audit).toHaveLength(1);
          expect(audit[0]?.payload).toMatchObject({
            resultingStatus: 'withdrawn',
            withdrawnFrom: from,
            reason: 'step cancelled',
          });
          // The update every consumer acts on (drain, chat linkage) is published with it.
          expect(outbox.length).toBeGreaterThanOrEqual(1);
        },
      );

      it('never withdraws a request that started executing or finished — in code or in the database', async () => {
        const executing = await requestIn('executing');
        await expect(
          asOwner((client) => withdrawActionRequest(client, workspaceId, executing)),
        ).rejects.toThrow(IllegalTransition);
        await expect(rawUpdate(executing, "status = 'withdrawn'")).rejects.toThrow(
          /only a request that has not started executing can be withdrawn, not one that is executing \(I-G9\)/,
        );

        await asOwner((client) =>
          markActionRequestExecuted(client, workspaceId, executing, { resultMetadata: {} }),
        );
        await expect(rawUpdate(executing, "status = 'withdrawn'")).rejects.toThrow(/I-G9/);
        const row = await asOwner((client) => getActionRequest(client, workspaceId, executing));
        expect(row?.status).toBe('executed');
      });

      it('a withdrawn request is terminal: it never starts, and the database lets nothing out', async () => {
        const id = await requestIn('auto_approved');
        await asOwner((client) => withdrawActionRequest(client, workspaceId, id));

        await expect(
          asOwner((client) => startActionRequestExecution(client, workspaceId, id)),
        ).rejects.toThrow(IllegalTransition);
        await expect(
          asOwner((client) => withdrawActionRequest(client, workspaceId, id)),
        ).rejects.toThrow(IllegalTransition);
        for (const to of ['approved', 'auto_approved', 'executing', 'failed']) {
          await expect(rawUpdate(id, `status = '${to}'`), to).rejects.toThrow(
            /a withdrawn request is terminal \(I-G9\)/,
          );
        }
        const row = await asOwner((client) => getActionRequest(client, workspaceId, id));
        expect(row?.status).toBe('withdrawn');
      });

      it('the database refuses a request created withdrawn', async () => {
        const id = await requestIn('pending_approval');
        await expect(
          asOwner((client) =>
            client.query(
              `insert into action_requests
               select (jsonb_populate_record(null::action_requests,
                         to_jsonb(r) || jsonb_build_object('id', $3::uuid, 'status', 'withdrawn'))).*
                 from action_requests r
                where r.workspace_id = $1 and r.id = $2`,
              [workspaceId, id, randomUUID()],
            ),
          ),
        ).rejects.toThrow(/a request is never created withdrawn \(I-G9\)/);
      });
    });

    describe('failure_kind', () => {
      it.each(['not_delivered', 'refused', 'outcome_unknown'] as const)(
        'a %s failure is on the row and in its audit record, and stays through compensate',
        async (failureKind) => {
          const id = await requestIn('executing', `test.go1.fail.${failureKind}`);
          const failed = await asOwner((client) =>
            markActionRequestFailed(client, workspaceId, id, {
              failureKind,
              reason: `${failureKind}: synthetic`,
            }),
          );
          expect(failed).toMatchObject({ status: 'failed', failureKind });

          const audit = await asOwner(async (client) => {
            const { rows } = await client.query<{ payload: Record<string, unknown> }>(
              `select payload from audit_records
              where workspace_id = $1 and resource_id = $2 and action = 'action_request.fail'`,
              [workspaceId, id],
            );
            return rows;
          });
          expect(audit[0]?.payload).toMatchObject({ resultingStatus: 'failed', failureKind });

          const compensated = await asOwner((client) =>
            compensateActionRequest(client, workspaceId, id),
          );
          expect(compensated).toMatchObject({ status: 'compensated', failureKind });
        },
      );

      it('a failure written without a kind (the previous release after a rollback) is recorded outcome_unknown', async () => {
        const id = await requestIn('executing', 'test.go1.fail.kindless');
        await rawUpdate(id, "status = 'failed', failed_at = now()");
        const row = await asOwner((client) => getActionRequest(client, workspaceId, id));
        expect(row).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
      });

      it('the database holds a kind exactly on a failed or compensated row, from the three values', async () => {
        const executed = await requestIn('executing', 'test.go1.fail.executed');
        await asOwner((client) =>
          markActionRequestExecuted(client, workspaceId, executed, { resultMetadata: {} }),
        );
        await expect(rawUpdate(executed, "failure_kind = 'refused'")).rejects.toThrow(
          /action_requests_failure_kind_status/,
        );

        const failed = await requestIn('executing', 'test.go1.fail.value');
        await asOwner((client) =>
          markActionRequestFailed(client, workspaceId, failed, { failureKind: 'refused' }),
        );
        await expect(rawUpdate(failed, "failure_kind = 'timed_out'")).rejects.toThrow(
          /action_requests_failure_kind_check/,
        );
      });

      it('the backfill reads each existing row’s kind from its last recorded reason', async () => {
        // The CASE migration 0021 runs over existing rows, evaluated on sample reasons.
        const migration = readFileSync(MIGRATION_0021, 'utf8');
        const caseExpression = /set failure_kind = (case[\s\S]*?\bend)\n/.exec(migration)?.[1];
        expect(caseExpression).toBeDefined();
        const samples: ReadonlyArray<readonly [string | null, string]> = [
          [null, 'outcome_unknown'],
          ['outcome_unknown: apply for "restart" … may have run', 'outcome_unknown'],
          ['gate_unreachable: … not sent', 'not_delivered'],
          ['gate_token_unavailable: …', 'not_delivered'],
          ['connection_secret_missing: …', 'not_delivered'],
          ['gate_not_found: …', 'not_delivered'],
          ['apply_not_received: the gate holds no record', 'not_delivered'],
          ['transport_error: target answered 500', 'refused'],
          ['operation_disabled: the Operation was disabled', 'refused'],
          ['boom', 'refused'],
          // A code later in the text is not the reason's code.
          ['operation_refused: not outcome_unknown:', 'refused'],
        ];
        const { rows } = await asOwner((client) =>
          client.query<{ kind: string }>(
            `select ${(caseExpression as string).replaceAll('f.reason', 'v.reason')} as kind
               from unnest($1::text[]) with ordinality as v(reason, n)
              order by v.n`,
            [samples.map(([reason]) => reason)],
          ),
        );
        expect(rows.map((row) => row.kind)).toEqual(samples.map(([, kind]) => kind));
      });
    });
  },
);
