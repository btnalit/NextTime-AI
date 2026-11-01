import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANGE_VERIFICATION_COOLDOWN_SECONDS } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { proposeSkill, publishSkill } from '../worker/index.js';
import {
  ChangeSegmentNotFoundError,
  ChangeSegmentRolledBackError,
  ChangeSegmentSupersededError,
  ChangeVerificationCooldownError,
  type CheckSourceRequirements,
  type SkillItemContent,
  type SourceRequirements,
  type WorkspaceSegmentInput,
  applyWorkspaceSegment,
  contentDigest,
  loadChangeVerification,
  planWorkspaceSegment,
  rollBackWorkspaceSegment,
  verifyChangeSegment,
} from './index.js';
import { loadChangeSegment } from './segments.js';

/**
 * application/change-plan — verify.integration (S11 P1-E): verifying an applied segment. A run
 * passes when every item is still in effect, every system the source needs is connected with a
 * healthy gate, and the source version is known; the segment's status follows the latest run and
 * one `change_segment.verify` audit row names who ran it and how (`manual` / `system`). Only the
 * latest segment of a source that is not rolled back is verified, and a segment is not verified
 * again within the cooldown — refused before anything is probed. The systems a source needs are
 * the caller's (`CheckSourceRequirements`), injected here.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

type Ws = { readonly workspaceId: string; readonly ownerId: string };

const skill = (markdown: string): SkillItemContent => ({
  name: 'fix-it',
  description: 'Fix the thing.',
  markdown,
  applicable: {},
});

const CONNECTED_OK: SourceRequirements = {
  sourceFound: true,
  requirements: [
    {
      connector: 'docker',
      state: 'connected',
      gates: [
        { id: 'g-1', name: 'docker-a', health: 'unreachable' },
        { id: 'g-2', name: 'docker-b', health: 'ok' },
      ],
    },
  ],
  dependencies: [{ name: 'ops-assets', minVersion: 2, status: 'up_to_date', installedVersion: 2 }],
};

/** A checker answering `answer`, counting its calls. */
function checker(answer: SourceRequirements): CheckSourceRequirements & { calls: number } {
  const check = async () => {
    check.calls += 1;
    return answer;
  };
  check.calls = 0;
  return check;
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/change-plan — verifying a segment (S11 P1-E, integration, real Postgres)',
  () => {
    let pool: Pool;

    async function newWorkspace(): Promise<Ws> {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1-verify',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'the owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      return { workspaceId, ownerId };
    }

    const inWorkspace = <T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn);

    const segment = (skillId: string, content: SkillItemContent): WorkspaceSegmentInput => ({
      source: { kind: 'pack', name: 'kit', version: '1', digest: contentDigest(content) },
      items: [{ kind: 'skill_version', skillId, content }],
    });

    const apply = (ws: Ws, input: WorkspaceSegmentInput) =>
      inWorkspace(ws, async (client) => {
        const planned = await planWorkspaceSegment(client, ws.workspaceId, input);
        const applied = await applyWorkspaceSegment(client, ws.workspaceId, {
          ...input,
          reviewedDigest: planned.digest,
          proposedBy: ws.ownerId,
          appliedBy: ws.ownerId,
          channel: 'human',
          confirmedOrdinals: [1],
        });
        if (!applied.segmentId) throw new Error('apply: nothing applied');
        return applied.segmentId;
      });

    const verify = (
      ws: Ws,
      segmentId: string,
      check: CheckSourceRequirements,
      trigger: 'manual' | 'system' = 'manual',
    ) =>
      inWorkspace(ws, (client) =>
        verifyChangeSegment(client, ws.workspaceId, {
          segmentId,
          verifiedBy: ws.ownerId,
          trigger,
          checkRequirements: check,
        }),
      );

    /** Moves the segment's last run back past the cooldown: `verified_at` only moves with a new
     *  result (migration 0025's trigger), so the trigger is off for this one statement. */
    const ageLastRun = (ws: Ws, segmentId: string) =>
      withWorkspace(
        pool,
        { workspaceId: ws.workspaceId, principalId: ws.ownerId },
        async (client) => {
          await client.query('set local session_replication_role = replica');
          await client.query(
            `update change_segments set verified_at = verified_at - make_interval(secs => $3)
              where workspace_id = $1 and id = $2`,
            [ws.workspaceId, segmentId, CHANGE_VERIFICATION_COOLDOWN_SECONDS + 1],
          );
        },
        { skipRoleSwitch: true },
      );

    const verifyAudits = (ws: Ws, segmentId: string) =>
      inWorkspace(ws, async (client) => {
        const result = await client.query<{ actor: string; payload: Record<string, unknown> }>(
          `select actor_principal_id as actor, payload from audit_records
            where workspace_id = $1 and action = 'change_segment.verify' and resource_id = $2
            order by created_at, id`,
          [ws.workspaceId, segmentId],
        );
        return result.rows;
      });

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('passes when the items are in effect and a gate of each system is up; records the run and who ran it', async () => {
      const ws = await newWorkspace();
      const segmentId = await apply(ws, segment(randomUUID(), skill('# Fix it')));

      const check = checker(CONNECTED_OK);
      const run = await verify(ws, segmentId, check);
      expect(check.calls).toBe(1);
      expect(run.segment.status).toBe('verified');
      expect(run.verification).toMatchObject({
        trigger: 'manual',
        verifiedBy: { id: ws.ownerId, kind: 'human', displayName: 'the owner' },
        passed: true,
        sourceFound: true,
        items: [{ ordinal: 1, kind: 'skill_version', state: 'in_effect' }],
        requirements: [{ connector: 'docker', state: 'connected', met: true }],
        dependencies: [{ name: 'ops-assets', minVersion: 2, installedVersion: 2, met: true }],
      });
      expect(
        await inWorkspace(ws, (client) =>
          loadChangeVerification(client, ws.workspaceId, segmentId),
        ),
      ).toEqual(run.verification);
      // S11 P1-F: a run recorded before dependencies were checked reads back with none.
      await inWorkspace(ws, async (client) => {
        const stored = await client.query<{ verification: unknown }>(
          'select verification from change_segments where workspace_id = $1 and id = $2',
          [ws.workspaceId, segmentId],
        );
        await client.query(
          `update change_segments set verification = verification - 'dependencies'
            where workspace_id = $1 and id = $2`,
          [ws.workspaceId, segmentId],
        );
        expect(
          (await loadChangeVerification(client, ws.workspaceId, segmentId))?.dependencies,
        ).toEqual([]);
        await client.query(
          `update change_segments set verification = $3::jsonb
            where workspace_id = $1 and id = $2`,
          [ws.workspaceId, segmentId, JSON.stringify(stored.rows[0]?.verification)],
        );
      });
      expect(await verifyAudits(ws, segmentId)).toEqual([
        {
          actor: ws.ownerId,
          payload: expect.objectContaining({
            trigger: 'manual',
            statusBefore: 'applied',
            passed: true,
            source: expect.objectContaining({ name: 'kit', version: '1' }),
          }),
        },
      ]);

      // Within the cooldown: refused before anything is probed or written.
      const again = checker(CONNECTED_OK);
      const refused = await verify(ws, segmentId, again).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(ChangeVerificationCooldownError);
      const retryAfter = (refused as ChangeVerificationCooldownError).details.retryAfterSeconds;
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(CHANGE_VERIFICATION_COOLDOWN_SECONDS);
      expect(again.calls).toBe(0);
      expect(await verifyAudits(ws, segmentId)).toHaveLength(1);
    });

    it('fails when a system is not connected, no gate is up, the source is unknown, or an item was replaced', async () => {
      const ws = await newWorkspace();
      const skillId = randomUUID();
      const segmentId = await apply(ws, segment(skillId, skill('# Fix it')));

      const notConnected = await verify(
        ws,
        segmentId,
        checker({
          sourceFound: true,
          requirements: [{ connector: 'docker', state: 'can_enable', gates: [] }],
          dependencies: [],
        }),
      );
      expect(notConnected.segment.status).toBe('verification_failed');
      expect(notConnected.verification).toMatchObject({
        passed: false,
        requirements: [{ connector: 'docker', state: 'can_enable', gates: [], met: false }],
      });

      await ageLastRun(ws, segmentId);
      const down = await verify(
        ws,
        segmentId,
        checker({
          sourceFound: true,
          requirements: [
            {
              connector: 'docker',
              state: 'connected',
              gates: [{ id: 'g-1', name: 'docker-a', health: 'unauthorized' }],
            },
          ],
          dependencies: [],
        }),
      );
      expect(down.verification).toMatchObject({ passed: false, requirements: [{ met: false }] });

      await ageLastRun(ws, segmentId);
      const unknown = await verify(
        ws,
        segmentId,
        checker({ sourceFound: false, requirements: [], dependencies: [] }),
      );
      expect(unknown.verification).toMatchObject({ passed: false, sourceFound: false });

      // S11 P1-F: a pack it builds on rolled back below the version it needs.
      await ageLastRun(ws, segmentId);
      const rolledBack = await verify(
        ws,
        segmentId,
        checker({
          ...CONNECTED_OK,
          dependencies: [
            { name: 'ops-assets', minVersion: 2, status: 'outdated', installedVersion: 1 },
          ],
        }),
      );
      expect(rolledBack.verification).toMatchObject({
        passed: false,
        requirements: [{ met: true }],
        dependencies: [
          {
            name: 'ops-assets',
            minVersion: 2,
            status: 'outdated',
            installedVersion: 1,
            met: false,
          },
        ],
      });

      // A good run sets it back to verified.
      await ageLastRun(ws, segmentId);
      expect((await verify(ws, segmentId, checker(CONNECTED_OK))).segment.status).toBe('verified');

      // Published outside the ChangePlan core: the item no longer is what is in effect.
      await inWorkspace(ws, async (client) => {
        await proposeSkill(client, ws.workspaceId, ws.ownerId, {
          skillId,
          ...skill('# Fix it by hand'),
        });
        await publishSkill(client, ws.workspaceId, ws.ownerId, skillId);
      });
      await ageLastRun(ws, segmentId);
      const replaced = await verify(ws, segmentId, checker(CONNECTED_OK));
      expect(replaced.segment.status).toBe('verification_failed');
      expect(replaced.verification.items).toEqual([
        { ordinal: 1, kind: 'skill_version', state: 'replaced' },
      ]);
      expect((await verifyAudits(ws, segmentId)).map((row) => row.payload.statusBefore)).toEqual([
        'applied',
        'verification_failed',
        'verification_failed',
        'verification_failed',
        'verification_failed',
        'verified',
      ]);
    });

    it('only the latest segment of a source that is not rolled back; `system` runs are recorded as such', async () => {
      const ws = await newWorkspace();
      const skillId = randomUUID();
      const first = await apply(ws, segment(skillId, skill('# Fix it')));
      const second = await apply(ws, segment(skillId, skill('# Fix it, twice')));

      const superseded = await verify(ws, first, checker(CONNECTED_OK)).catch(
        (err: unknown) => err,
      );
      expect(superseded).toBeInstanceOf(ChangeSegmentSupersededError);
      expect((superseded as ChangeSegmentSupersededError).details).toEqual({
        supersededBy: second,
      });

      const system = await verify(ws, second, checker(CONNECTED_OK), 'system');
      expect(system.verification).toMatchObject({
        trigger: 'system',
        verifiedBy: { id: ws.ownerId },
      });
      expect((await verifyAudits(ws, second))[0]?.payload).toMatchObject({ trigger: 'system' });

      await inWorkspace(ws, (client) =>
        rollBackWorkspaceSegment(client, ws.workspaceId, {
          segmentId: second,
          rolledBackBy: ws.ownerId,
          channel: 'human',
          confirmedOrdinals: [1],
        }),
      );
      await expect(verify(ws, second, checker(CONNECTED_OK))).rejects.toBeInstanceOf(
        ChangeSegmentRolledBackError,
      );
      // With the later one rolled back, the first is the one in effect again.
      const back = await verify(ws, first, checker(CONNECTED_OK));
      expect(back.segment.status).toBe('verified');
      expect(
        (await inWorkspace(ws, (client) => loadChangeSegment(client, ws.workspaceId, second)))
          ?.status,
      ).toBe('rolled_back');

      await expect(verify(ws, randomUUID(), checker(CONNECTED_OK))).rejects.toBeInstanceOf(
        ChangeSegmentNotFoundError,
      );
    });
  },
);
