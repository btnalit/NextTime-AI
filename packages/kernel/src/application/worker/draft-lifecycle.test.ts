import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { dispatchCapability } from '../gateway/dispatch.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from './definitions.js';
import {
  DEFAULT_DRAFT_EXPIRY_DAYS,
  DraftNotDiscardableError,
  discardDraft,
  expireDraftsOnce,
} from './draft-lifecycle.js';
import { proposeProcedure, publishProcedure } from './procedures.js';
import { proposeSkill, publishSkill } from './skills.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL — same pattern as
 * definitions.test.ts / skills.test.ts / procedures.test.ts) for the S8 W3 K2 (leftover 82) draft
 * terminal states: `discardDraft` (proposer-only manual discard) and `expireDraftsOnce` (periodic
 * cross-workspace sweep) across all three kinds (WorkerDefinition/Skill/Procedure).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const VALID_WORKER_DEFINITION = { systemPrompt: 'You are ops-runner.' };
const VALID_SKILL = {
  name: 'diagnose-network',
  description: 'Find the top talker on the network and the process behind it.',
  markdown: 'Run `ss -tnp` and look for the highest byte count.',
};
const VALID_PROCEDURE = {
  name: 'restart-and-verify',
  description: 'Restart then check',
  steps: [],
};

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role = 'builder',
): ResolvedCaller {
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

describe.runIf(DATABASE_URL !== undefined)(
  'application/worker/draft-lifecycle (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let proposerId: string;
    let otherId: string;

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

    async function adminInsertPrincipal(role: string, displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [workspaceId, id, role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function inTx<T>(
      principalId: string,
      fn: (client: import('pg').PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('draft-lifecycle-test-workspace');
      proposerId = await adminInsertPrincipal('builder', 'proposer');
      otherId = await adminInsertPrincipal('builder', 'other');
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('discardDraft', () => {
      it('the proposer can discard their own draft WorkerDefinition — the row is gone', async () => {
        const draft = await inTx(proposerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, proposerId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );

        const discarded = await inTx(proposerId, (client) =>
          discardDraft(client, workspaceId, proposerId, {
            kind: 'worker_definition',
            id: draft.id,
            version: draft.version,
          }),
        );
        expect(discarded).toEqual({
          kind: 'worker_definition',
          id: draft.id,
          version: draft.version,
          name: null,
        });

        const remaining = await inTx(proposerId, (client) =>
          client.query('select 1 from worker_definitions where workspace_id = $1 and id = $2', [
            workspaceId,
            draft.id,
          ]),
        );
        expect(remaining.rowCount).toBe(0);
      });

      it('the proposer can discard their own draft Skill and Procedure too', async () => {
        const skillDraft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, VALID_SKILL),
        );
        await inTx(proposerId, (client) =>
          discardDraft(client, workspaceId, proposerId, {
            kind: 'skill',
            id: skillDraft.id,
            version: skillDraft.version,
          }),
        );
        const skillRemaining = await inTx(proposerId, (client) =>
          client.query('select 1 from skills where workspace_id = $1 and id = $2', [
            workspaceId,
            skillDraft.id,
          ]),
        );
        expect(skillRemaining.rowCount).toBe(0);

        const procedureDraft = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, VALID_PROCEDURE),
        );
        await inTx(proposerId, (client) =>
          discardDraft(client, workspaceId, proposerId, {
            kind: 'procedure',
            id: procedureDraft.id,
            version: procedureDraft.version,
          }),
        );
        const procedureRemaining = await inTx(proposerId, (client) =>
          client.query('select 1 from procedures where workspace_id = $1 and id = $2', [
            workspaceId,
            procedureDraft.id,
          ]),
        );
        expect(procedureRemaining.rowCount).toBe(0);
      });

      it('another principal cannot discard someone else’s draft — not-found (I16), never forbidden', async () => {
        const draft = await inTx(proposerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, proposerId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );

        await expect(
          inTx(otherId, (client) =>
            discardDraft(client, workspaceId, otherId, {
              kind: 'worker_definition',
              id: draft.id,
              version: draft.version,
            }),
          ),
        ).rejects.toThrow(/not found/i);

        // Still there — the rejected attempt did not touch the row.
        const remaining = await inTx(proposerId, (client) =>
          client.query('select 1 from worker_definitions where workspace_id = $1 and id = $2', [
            workspaceId,
            draft.id,
          ]),
        );
        expect(remaining.rowCount).toBe(1);
      });

      it('a published version can never be discarded (typed error), even by its own proposer', async () => {
        const draft = await inTx(proposerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, proposerId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        await inTx(proposerId, (client) =>
          publishWorkerDefinition(client, workspaceId, proposerId, {
            definitionId: draft.id,
            version: draft.version,
          }),
        );

        await expect(
          inTx(proposerId, (client) =>
            discardDraft(client, workspaceId, proposerId, {
              kind: 'worker_definition',
              id: draft.id,
              version: draft.version,
            }),
          ),
        ).rejects.toThrow(DraftNotDiscardableError);

        const remaining = await inTx(proposerId, (client) =>
          client.query(
            'select status from worker_definitions where workspace_id = $1 and id = $2',
            [workspaceId, draft.id],
          ),
        );
        expect(remaining.rows[0]?.status).toBe('published');
      });

      it('unknown id/version — not found, same as any other unknown draft', async () => {
        await expect(
          inTx(proposerId, (client) =>
            discardDraft(client, workspaceId, proposerId, {
              kind: 'skill',
              id: randomUUID(),
              version: 1,
            }),
          ),
        ).rejects.toThrow(/not found/i);
      });

      it('through dispatchCapability (discard_draft, human channel): proposer discards and an AuditRecord is written', async () => {
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, VALID_SKILL),
        );

        const caller = humanCaller(workspaceId, proposerId);
        const result = (await dispatchCapability({ pool }, caller, 'discard_draft', {
          kind: 'skill',
          id: draft.id,
          version: draft.version,
        })) as { kind: string; id: string; version: number };
        expect(result).toEqual({ kind: 'skill', id: draft.id, version: draft.version });

        const audit = await inTx(proposerId, (client) =>
          queryAudit(client, workspaceId, { action: 'discard_draft', resourceId: draft.id }),
        );
        expect(audit).toHaveLength(1);
        expect(audit[0]?.actorPrincipalId).toBe(proposerId);
        expect((audit[0]?.payload as { params?: { kind?: string } }).params?.kind).toBe('skill');

        const remaining = await inTx(proposerId, (client) =>
          client.query('select 1 from skills where workspace_id = $1 and id = $2', [
            workspaceId,
            draft.id,
          ]),
        );
        expect(remaining.rowCount).toBe(0);
      });

      it('through dispatchCapability: another principal discarding someone else’s draft is rejected', async () => {
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, VALID_SKILL),
        );
        const otherCaller = humanCaller(workspaceId, otherId);
        await expect(
          dispatchCapability({ pool }, otherCaller, 'discard_draft', {
            kind: 'skill',
            id: draft.id,
            version: draft.version,
          }),
        ).rejects.toThrow(/not found/i);
      });
    });

    describe('expireDraftsOnce', () => {
      it('deletes only drafts older than the threshold, never a published row, across all three kinds', async () => {
        const oldWorker = await inTx(proposerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, proposerId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        const oldSkill = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, VALID_SKILL),
        );
        const oldProcedure = await inTx(proposerId, (client) =>
          proposeProcedure(client, workspaceId, proposerId, VALID_PROCEDURE),
        );

        const recentWorker = await inTx(proposerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, proposerId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );

        const publishedWorker = await inTx(proposerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, proposerId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        await inTx(proposerId, (client) =>
          publishWorkerDefinition(client, workspaceId, proposerId, {
            definitionId: publishedWorker.id,
            version: publishedWorker.version,
          }),
        );

        // Back-date the "old" three rows' created_at past the threshold — admin mode, direct SQL
        // (there is no capability that ever moves created_at; this is the test's own fixture
        // setup, not something discardDraft/expireDraftsOnce themselves do).
        const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        await withWorkspace(
          pool,
          { workspaceId, principalId: proposerId },
          async (client) => {
            await client.query(
              'update worker_definitions set created_at = $3 where workspace_id = $1 and id = $2',
              [workspaceId, oldWorker.id, past],
            );
            await client.query(
              'update skills set created_at = $3 where workspace_id = $1 and id = $2',
              [workspaceId, oldSkill.id, past],
            );
            await client.query(
              'update procedures set created_at = $3 where workspace_id = $1 and id = $2',
              [workspaceId, oldProcedure.id, past],
            );
          },
          { skipRoleSwitch: true },
        );

        const result = await expireDraftsOnce(pool, { thresholdDays: 30 });
        expect(result.expired).toBeGreaterThanOrEqual(3);

        async function exists(table: string, id: string): Promise<boolean> {
          const rows = await inTx(proposerId, (client) =>
            client.query(`select 1 from ${table} where workspace_id = $1 and id = $2`, [
              workspaceId,
              id,
            ]),
          );
          return (rows.rowCount ?? 0) > 0;
        }

        expect(await exists('worker_definitions', oldWorker.id)).toBe(false);
        expect(await exists('skills', oldSkill.id)).toBe(false);
        expect(await exists('procedures', oldProcedure.id)).toBe(false);
        // Recent draft and the published row must survive.
        expect(await exists('worker_definitions', recentWorker.id)).toBe(true);
        expect(await exists('worker_definitions', publishedWorker.id)).toBe(true);

        const audit = await inTx(proposerId, (client) =>
          queryAudit(client, workspaceId, { action: 'draft.expired', resourceId: oldWorker.id }),
        );
        expect(audit).toHaveLength(1);
        expect(audit[0]?.actorPrincipalId).not.toBe(proposerId);
        expect(audit[0]?.payload.reason).toBe('expired');
      });

      it('DEFAULT_DRAFT_EXPIRY_DAYS is the documented maintainer default (30)', () => {
        expect(DEFAULT_DRAFT_EXPIRY_DAYS).toBe(30);
      });

      it('an injectable clock lets a "future now" treat a freshly proposed draft as expired', async () => {
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, VALID_SKILL),
        );
        const future = () => new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

        await expireDraftsOnce(pool, { thresholdDays: 30, now: future });

        const rows = await inTx(proposerId, (client) =>
          client.query('select 1 from skills where workspace_id = $1 and id = $2', [
            workspaceId,
            draft.id,
          ]),
        );
        expect(rows.rowCount).toBe(0);
      });
    });
  },
);
