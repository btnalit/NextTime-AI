import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, splitSqlStatements } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ENTRY_CEILING_CAPABILITIES, entryScope } from '../../governance/capability/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for review 2026-10-02 R-35 /
 * decision D-07: `auditor` is strictly read-only, on the human channel and through its entry
 * agent's Handle, and migration governance/0017 revokes the Handles minted under the old ceiling.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

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

function handleCaller(workspaceId: string, obo: string, scope: CapabilityScope): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope,
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'auditor is read-only — R-35 / D-07 (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let auditorId: string;
    let memberId: string;

    async function adminInsertPrincipal(role: Role, name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [workspaceId, id, role, name],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
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
            'auditor-read-only-workspace',
          ]);
        },
        { skipRoleSwitch: true },
      );
      auditorId = await adminInsertPrincipal('auditor', 'auditor');
      memberId = await adminInsertPrincipal('member', 'member');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('human channel: writes that cleared minRole:"member" (or had none) are refused before any handler runs', async () => {
      const auditor = humanCaller(workspaceId, auditorId, 'auditor');
      for (const name of [
        'invoke_worker',
        'invalidate_fact',
        'assert_fact',
        'record_decision',
        'deprecate_operation',
        'publish_worker_definition',
        'set_agent_profile',
        'observe_operation',
        'request_action',
      ]) {
        await expect(dispatchCapability({ pool }, auditor, name, {}), name).rejects.toThrow(
          ForbiddenError,
        );
      }
    });

    it('human channel: its reads still work', async () => {
      const auditor = humanCaller(workspaceId, auditorId, 'auditor');
      await expect(
        dispatchCapability({ pool }, auditor, 'list_gatekeepers', {}),
      ).resolves.toMatchObject({ items: [] });
      await expect(dispatchCapability({ pool }, auditor, 'audit_query', {})).resolves.toBeDefined();
    });

    it('handle channel: even a Handle minted under the old ceiling cannot reach a gate for an auditor', async () => {
      // The pre-R-35 entry ceiling an auditor's Handle used to carry.
      const stale = handleCaller(workspaceId, auditorId, {
        capabilities: [...ENTRY_CEILING_CAPABILITIES, 'request_action'],
        resources: { gatekeeper: [randomUUID()] },
      });
      for (const name of ['observe_operation', 'request_action']) {
        await expect(
          dispatchCapability({ pool }, stale, name, {
            gatekeeperId: randomUUID(),
            operation: 'any.op',
            params: {},
          }),
          name,
        ).rejects.toThrow(/read-only role/);
      }
    });

    it('a Handle minted now for an auditor carries only the read-only ceiling', async () => {
      const scope = entryScope({}, { role: 'auditor' });
      const fresh = handleCaller(workspaceId, auditorId, scope);
      await expect(dispatchCapability({ pool }, fresh, 'invoke_worker', {})).rejects.toThrow(
        ForbiddenError,
      );
      await expect(
        dispatchCapability({ pool }, fresh, 'observe_operation', {
          gatekeeperId: randomUUID(),
          operation: 'any.op',
          params: {},
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("migration 0017 revokes an auditor's unexpired Handles (audited) and leaves everyone else's", async () => {
      const sql = await readFile(
        path.join(MIGRATIONS_DIR, 'governance', '0017_auditor_handles_revoked.sql'),
        'utf8',
      );
      const insertHandle = async (obo: string): Promise<string> =>
        withWorkspace(pool, { workspaceId, principalId: obo }, async (client) => {
          const session = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'entry', $2, 'active') returning id`,
            [workspaceId, obo],
          );
          const jti = randomUUID();
          await client.query(
            `insert into capability_handles (workspace_id, jti, session_id, on_behalf_of, scope, expires_at)
             values ($1, $2, $3, $4, $5::jsonb, now() + interval '1 hour')`,
            [
              workspaceId,
              jti,
              session.rows[0]?.id,
              obo,
              JSON.stringify({ capabilities: ['invoke_worker'], resources: {} }),
            ],
          );
          return jti;
        });
      const auditorJti = await insertHandle(auditorId);
      const memberJti = await insertHandle(memberId);

      const runMigrationStatements = () =>
        withWorkspace(pool, { workspaceId, principalId: auditorId }, async (client) => {
          for (const statement of splitSqlStatements(sql)) await client.query(statement);
        });
      await runMigrationStatements();

      const state = () =>
        withWorkspace(pool, { workspaceId, principalId: auditorId }, async (client) => {
          const handles = await client.query<{ jti: string; revoked_at: Date | null }>(
            'select jti, revoked_at from capability_handles where workspace_id = $1 and jti = any($2::uuid[])',
            [workspaceId, [auditorJti, memberJti]],
          );
          const audits = await client.query<{ actor_principal_id: string }>(
            "select actor_principal_id from audit_records where workspace_id = $1 and action = 'principal.auditor_handles_revoked'",
            [workspaceId],
          );
          return {
            revoked: Object.fromEntries(handles.rows.map((r) => [r.jti, r.revoked_at !== null])),
            auditActors: audits.rows.map((r) => r.actor_principal_id),
          };
        });

      expect(await state()).toEqual({
        revoked: { [auditorJti]: true, [memberJti]: false },
        auditActors: [auditorId],
      });

      // Idempotent: nothing left to revoke, no second audit record.
      await runMigrationStatements();
      expect((await state()).auditActors).toEqual([auditorId]);
    });
  },
);
