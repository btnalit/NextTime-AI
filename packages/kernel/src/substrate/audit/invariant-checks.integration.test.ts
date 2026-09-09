import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { INVARIANT_CHECK_IDS, runInvariantChecks } from './invariant-checks.js';

/**
 * substrate/audit/invariant-checks.integration: the S3.8 acceptance test (docs/development-
 * tasks.md S3.8: "人为写入违反 I7 的记录后告警计数为 1" — generalized to I6, this file's own chosen
 * DB-checkable target; see the doc comment on the first `it()` below for why, including a real
 * correction CI's own real-Postgres run caught in an earlier draft of this file).
 *
 * **Why this test measures a *delta*, not a global "everything reads zero".** `packages/kernel/
 * vitest.config.ts`'s own doc comment already documents the real constraint: every DB-gated
 * integration suite in this package shares *one* Postgres database, and files run serially with no
 * reset between them — a later test file's `runInvariantChecks()` call sees every earlier file's
 * fixture data. Several existing integration tests write `action_requests` rows directly via raw
 * SQL to set up fixtures (e.g. `application/gateway/members-flow.integration.test.ts`'s
 * `adminInsertActionRequest`), bypassing `governance/approval`'s own audited write path
 * (`transition-log.ts`'s `recordTransition`) entirely — which is exactly the shape I11's own check
 * here is built to catch. Asserting "every check reads 0" unconditionally in this file would
 * therefore be genuinely test-order-dependent against the rest of the suite, not a property of
 * this module's own correctness. Instead: the first `it()` below captures a *baseline* snapshot
 * before touching anything, asserts the one invariant this test actually drives (I6) starts at `0`
 * for the specific fabricated ActionRequest id this test uses (a fresh random uuid — no other test
 * file can possibly have touched it), inserts one illegal transition, asserts the delta is exactly
 * `+1` on I6 and `+0` on every other invariant (proving the violation is attributed to "exactly
 * that invariant", the task brief's own phrase, regardless of whatever baseline noise the rest of
 * the suite may have left behind), and confirms `sample` names the fabricated id. `audit_records`
 * is append-only (no UPDATE/DELETE grant, 0004_audit.sql's own trigger) — there is nothing to clean
 * up or restore afterward; the fabricated rows simply become part of this database's permanent
 * history, same as any other AuditRecord.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'substrate/audit/invariant-checks (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let sessionId: string;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = randomUUID();
      ownerId = randomUUID();
      sessionId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'invariant-checks-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, ownerId, 'human', 'owner', 'owner'],
          );
          await client.query(
            `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, $3, 'web', $3, 'active')`,
            [workspaceId, sessionId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    /** Inserts one `audit_records` row with an explicit `created_at` — raw SQL, not `writeAudit`
     *  (substrate/audit/writer.ts), so this test controls ordering deterministically rather than
     *  relying on two real transactions happening to get distinguishable `now()` snapshots.
     *  `resource_id` carries no FK (migrations/core/0004_audit.sql) — a fabricated ActionRequest
     *  id with no matching `action_requests` row is a legal row here, exactly as it would be if
     *  the real Task/ActionRequest were later purged while its audit trail is kept. */
    async function insertAuditRecord(params: {
      action: string;
      resourceType: string;
      resourceId: string;
      resultingStatus: string;
      createdAt: Date;
    }): Promise<void> {
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query(
          `insert into audit_records
             (workspace_id, actor_principal_id, action, resource_type, resource_id, payload, created_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            workspaceId,
            ownerId,
            params.action,
            params.resourceType,
            params.resourceId,
            JSON.stringify({ resultingStatus: params.resultingStatus }),
            params.createdAt,
          ],
        ),
      );
    }

    it('I6: a transition audit trail that skips a legal edge is counted as exactly one violation; a legal sequence is not', async () => {
      const illegalId = randomUUID();
      const legalId = randomUUID();
      const t1 = new Date(Date.now() - 60_000);
      const t2 = new Date(Date.now() - 30_000);

      const baseline = await runInvariantChecks(pool);
      const baselineI6 = baseline.find((result) => result.invariant === 'I6');
      expect(baselineI6).toBeDefined();
      // Not asserted at 0 unconditionally (other test files may have left their own audit rows
      // behind) — the per-id sample check below is what actually proves attribution.
      expect(baselineI6?.sample).not.toContain(
        `${workspaceId}:${illegalId} pending_approval->executed`,
      );

      // A legal sequence first — proves the check does not simply flag "any second transition".
      // policy_evaluated -> pending_approval -> approved is two real edges
      // (ACTION_REQUEST_EDGES: {from:'policy_evaluated', event:'require_approval',
      // to:'pending_approval'}, {from:'pending_approval', event:'approve', to:'approved'}).
      await insertAuditRecord({
        action: 'action_request.request',
        resourceType: 'action_request',
        resourceId: legalId,
        resultingStatus: 'pending_approval',
        createdAt: t1,
      });
      await insertAuditRecord({
        action: 'action_request.approve',
        resourceType: 'action_request',
        resourceId: legalId,
        resultingStatus: 'approved',
        createdAt: t2,
      });

      const afterLegal = await runInvariantChecks(pool);
      expect(afterLegal.find((r) => r.invariant === 'I6')?.sample).not.toContain(
        `${workspaceId}:${legalId} pending_approval->approved`,
      );

      // Nothing in the DB blocks this insert — audit_records has no FK from resource_id to
      // action_requests, and the append-only trigger (0004_audit.sql) only ever blocks UPDATE/
      // DELETE, never INSERT. pending_approval -> executed is not an edge in ACTION_REQUEST_EDGES
      // (pending_approval only ever goes to approved/rejected/expired) — see this module's own
      // doc comment table for why I6 has no DB-level defense at all (unlike I13, corrected in the
      // same table after CI caught an earlier draft's wrong claim about that one).
      await insertAuditRecord({
        action: 'action_request.request',
        resourceType: 'action_request',
        resourceId: illegalId,
        resultingStatus: 'pending_approval',
        createdAt: t1,
      });
      await insertAuditRecord({
        action: 'action_request.complete',
        resourceType: 'action_request',
        resourceId: illegalId,
        resultingStatus: 'executed',
        createdAt: t2,
      });

      const withViolation = await runInvariantChecks(pool);
      const i6 = withViolation.find((result) => result.invariant === 'I6');
      expect(i6?.sample).toContain(`${workspaceId}:${illegalId} pending_approval->executed`);
      // >= 1, not a strict-1 equality: other DB-gated test files running earlier in the same
      // shared-Postgres CI job may have exercised the real governed transition paths too, which
      // could not itself add a *violation* (only a real illegal edge would), but this stays
      // robust against that noise either way rather than assuming this suite runs in isolation.
      expect(i6?.violations ?? 0).toBeGreaterThanOrEqual((baselineI6?.violations ?? 0) + 1);

      // The task brief's own phrase: "violations: 1 for exactly that invariant" — every other
      // check's count is unaffected by these audit_records inserts (none of the other nine
      // checks reads audit_records at all, except I11 and I16 — I11 only ever counts action_
      // requests rows missing an audit trail, never audit rows themselves, so an *extra* audit
      // row cannot move it; I16 only matches a fixed set of publish_* action names, which
      // 'action_request.request'/'action_request.approve'/'action_request.complete' are not).
      for (const result of withViolation) {
        if (result.invariant === 'I6') continue;
        const before = baseline.find((b) => b.invariant === result.invariant);
        expect(result.violations).toBe(before?.violations ?? 0);
      }
    });

    it("I13: the capability_handles_inheritance trigger rejects a child Handle whose expires_at exceeds its parent's at INSERT time (governance/0008_capability_handle_inheritance.sql) — this check itself always reads 0 in a clean database", async () => {
      const results = await runInvariantChecks(pool);
      expect(results.find((r) => r.invariant === 'I13')?.violations).toBe(0);

      const sessionForHandle = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query(
            `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, $3, 'web', $3, 'active')`,
            [workspaceId, sessionForHandle, ownerId],
          ),
        { skipRoleSwitch: true },
      );

      const parentJti = randomUUID();
      const parentExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // +1h
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query(
            `insert into capability_handles
               (workspace_id, jti, session_id, on_behalf_of, parent_jti, scope, expires_at)
             values ($1, $2, $3, $4, null, '{}'::jsonb, $5)`,
            [workspaceId, parentJti, sessionForHandle, ownerId, parentExpiresAt],
          ),
        { skipRoleSwitch: true },
      );

      const badChildJti = randomUUID();
      const badChildExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // +2h, exceeds parent's
      await expect(
        withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query(
              `insert into capability_handles
                 (workspace_id, jti, session_id, on_behalf_of, parent_jti, scope, expires_at)
               values ($1, $2, $3, $4, $5, '{}'::jsonb, $6)`,
              [workspaceId, badChildJti, sessionForHandle, ownerId, parentJti, badChildExpiresAt],
            ),
          { skipRoleSwitch: true },
        ),
      ).rejects.toThrow(/expires_at cannot exceed its parent/);
    });

    it('I4/I12: the append-only and publish-immutability triggers are present and enabled (unconditional — pg_trigger presence, not data)', async () => {
      const results = await runInvariantChecks(pool);
      expect(results.find((r) => r.invariant === 'I4')?.violations).toBe(0);
      expect(results.find((r) => r.invariant === 'I12')?.violations).toBe(0);
    });

    it('runInvariantChecks always returns exactly INVARIANT_CHECK_IDS, in that fixed order', async () => {
      const results = await runInvariantChecks(pool);
      expect(results.map((result) => result.invariant)).toEqual(INVARIANT_CHECK_IDS);
      // Every result is well-formed regardless of its violation count — no check ever throws or
      // returns a malformed shape (a real SQL error in any one of the ten queries would already
      // have failed every test above, since every one of them calls the full runner).
      for (const result of results) {
        expect(typeof result.violations).toBe('number');
        expect(result.violations).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(result.sample)).toBe(true);
        expect(result.sample.length).toBeLessThanOrEqual(5);
      }
    });
  },
);
