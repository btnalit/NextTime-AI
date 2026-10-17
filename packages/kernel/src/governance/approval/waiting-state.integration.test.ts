import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ACTION_REQUEST_IN_DOUBT_AUDIT_ACTION } from './execution.js';
import { readActionRequestFailureReasons, readActionRequestsInDoubt } from './waiting-state.js';

/**
 * Legacy 340 (review #493 on #609): two audit records for one ActionRequest written in the same
 * transaction share `created_at` (`now()`), and `distinct on` alone then picks either of them —
 * a reason that could change from one read to the next. `id` breaks the tie, so the newest-record
 * read (failure reason) and the earliest-record read (in doubt since) each name one record, on
 * every read. The records are inserted so that physical order disagrees with that pick.
 * Integration (real Postgres; auto-skip without DATABASE_URL).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** Ids that sort first / last among the tied records — fresh on every run (`audit_records`
 *  outlives a test run, and nothing may delete from it). */
const lowId = () => `00000000${randomUUID().slice(8)}`;
const highId = () => `ffffffff${randomUUID().slice(8)}`;

describe.runIf(DATABASE_URL !== undefined)(
  'waiting-state reads — a created_at tie (legacy 340)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let failedId: string;
    let inDoubtId: string;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      failedId = randomUUID();
      inDoubtId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'waiting-state-tie-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, ownerId, 'human', 'owner', 'owner'],
          );
          // One transaction: every row below has the same `created_at`.
          const insert = (id: string, action: string, resourceId: string, reason: string) =>
            client.query(
              `insert into audit_records (workspace_id, id, actor_principal_id, action, resource_type, resource_id, payload)
             values ($1, $2, $3, $4, 'action_request', $5, jsonb_build_object('reason', $6::text))`,
              [workspaceId, id, ownerId, action, resourceId, reason],
            );
          await insert(lowId(), 'action_request.fail', failedId, 'low id');
          await insert(highId(), 'action_request.fail', failedId, 'high id');
          await insert(highId(), ACTION_REQUEST_IN_DOUBT_AUDIT_ACTION, inDoubtId, 'high id');
          await insert(lowId(), ACTION_REQUEST_IN_DOUBT_AUDIT_ACTION, inDoubtId, 'low id');
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool?.end();
    });

    it('the failure reason is the tied record with the highest id, on every read', async () => {
      for (let read = 0; read < 3; read++) {
        const reasons = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          readActionRequestFailureReasons(client, workspaceId, [
            { id: failedId, status: 'failed' },
          ]),
        );
        expect(reasons.get(failedId)?.text).toBe('high id');
      }
    });

    it('the in-doubt record is the tied record with the lowest id, on every read', async () => {
      for (let read = 0; read < 3; read++) {
        const inDoubt = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          readActionRequestsInDoubt(client, workspaceId, [inDoubtId]),
        );
        expect(inDoubt.get(inDoubtId)?.reason).toBe('low id');
      }
    });
  },
);
