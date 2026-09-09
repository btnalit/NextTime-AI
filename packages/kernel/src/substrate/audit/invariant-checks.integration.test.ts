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
 * tasks.md S3.8: "人为写入违反 I7 的记录后告警计数为 1" — generalized to I13, this file's own chosen
 * DB-checkable target; see the doc comment on the first `it()` below for why).
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
 * this module's own correctness. Instead: `it('I13 ...')` below captures a *baseline* snapshot
 * before touching anything, asserts the one invariant this test actually drives (I13) starts at
 * `0` (a real assertion — no other test file plausibly constructs a mismatched-attenuation
 * `capability_handles` pair on purpose), inserts one violation, asserts the delta is exactly `+1`
 * on I13 and `+0` on every other invariant (proving the violation is attributed to "exactly that
 * invariant", the task brief's own phrase, regardless of whatever baseline noise the rest of the
 * suite may have left behind), cleans up, and confirms I13 returns to its own baseline. I4/I12 are
 * separately asserted at `0` unconditionally — pure trigger-presence checks against `pg_trigger`,
 * structurally unaffected by any other test's fixture *data*.
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

    async function insertHandle(params: {
      jti: string;
      onBehalfOf: string;
      parentJti: string | null;
      expiresAt: Date;
    }): Promise<void> {
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query(
            `insert into capability_handles
               (workspace_id, jti, session_id, on_behalf_of, parent_jti, scope, expires_at)
             values ($1, $2, $3, $4, $5, '{}'::jsonb, $6)`,
            [
              workspaceId,
              params.jti,
              sessionId,
              params.onBehalfOf,
              params.parentJti,
              params.expiresAt,
            ],
          ),
        { skipRoleSwitch: true },
      );
    }

    async function deleteHandles(jtis: readonly string[]): Promise<void> {
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query(
            'delete from capability_handles where workspace_id = $1 and jti = any($2::uuid[])',
            [workspaceId, jtis],
          ),
        { skipRoleSwitch: true },
      );
    }

    it("I13: a child Handle whose expires_at exceeds its parent's is counted as exactly one violation; a correctly-attenuated child is not", async () => {
      const baseline = await runInvariantChecks(pool);
      const baselineI13 = baseline.find((result) => result.invariant === 'I13');
      expect(baselineI13).toBeDefined();
      expect(baselineI13?.violations).toBe(0);

      const parentJti = randomUUID();
      const goodChildJti = randomUUID();
      const badChildJti = randomUUID();
      const parentExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // +1h
      const goodChildExpiresAt = new Date(Date.now() + 30 * 60 * 1000); // +30m, within parent's
      const badChildExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // +2h, exceeds parent's

      await insertHandle({
        jti: parentJti,
        onBehalfOf: ownerId,
        parentJti: null,
        expiresAt: parentExpiresAt,
      });
      // A correctly-attenuated child — inserted first so its presence alone proves the check does
      // not simply flag "every row with a parent_jti".
      await insertHandle({
        jti: goodChildJti,
        onBehalfOf: ownerId,
        parentJti,
        expiresAt: goodChildExpiresAt,
      });

      try {
        const afterGoodChild = await runInvariantChecks(pool);
        expect(afterGoodChild.find((result) => result.invariant === 'I13')?.violations).toBe(0);

        // Nothing in the DB blocks this INSERT — governance/0001_capability_handles.sql's own
        // trigger only fires `before update` (blocking `on_behalf_of` from changing post-issuance),
        // never `before insert`; this module's own doc comment table explains why that makes I13 a
        // real, independent check rather than defense-in-depth over an already-enforced rule.
        await insertHandle({
          jti: badChildJti,
          onBehalfOf: ownerId,
          parentJti,
          expiresAt: badChildExpiresAt,
        });

        const withViolation = await runInvariantChecks(pool);
        const i13 = withViolation.find((result) => result.invariant === 'I13');
        expect(i13?.violations).toBe(1);
        expect(i13?.sample).toContain(`${workspaceId}:${badChildJti}`);

        // The task brief's own phrase: "violations: 1 for exactly that invariant" — every other
        // check's count is unaffected by this one insert (a capability_handles row is read by no
        // check other than I13's own).
        for (const result of withViolation) {
          if (result.invariant === 'I13') continue;
          const before = baseline.find((b) => b.invariant === result.invariant);
          expect(result.violations).toBe(before?.violations ?? 0);
        }
      } finally {
        await deleteHandles([parentJti, goodChildJti, badChildJti]);
      }

      const clean = await runInvariantChecks(pool);
      expect(clean.find((result) => result.invariant === 'I13')?.violations).toBe(0);
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
