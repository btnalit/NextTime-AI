import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ChangeRollbackPreviewWire,
  ChangeSegmentDetailWire,
  ChangeSegmentWire,
  Role,
  WorkspaceModuleWire,
} from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ChangeSegmentRolledBackError } from '../change-plan/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/change-segments-flow.integration.test (S11 P1-B): the 能力目录 安装历史 path
 * end to end through `dispatchCapability` — `install_module` applies a segment and the module's
 * `provenance` names it; `list_change_segments` / `get_change_segment` read it back (members
 * and auditors too — an install record is provenance); `preview_roll_back_change_segment` / `roll_back_change_segment` are the owner's; after the
 * rollback the module is not installed and the segment says who rolled it back. Every result is
 * checked against its own `resultSchema` (`KERNEL_VALIDATE_RESULTS=1`, vitest.config.ts).
 *
 * Gated on `DATABASE_URL`; uses the repo's own `packs/` (`ops-assets`, no
 * ActionType — installing and rolling it back is not authority-widening).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role,
  kind: 'human' | 'service' = 'human',
): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind, role, displayName: role },
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
  'application/gateway — change segments flow (S11 P1-B, integration, real Postgres)',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('install → provenance names the segment → read back → owner-only rollback → not installed', async () => {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      const memberId = randomUUID();
      const auditorId = randomUUID();
      const serviceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1b-change-segments-flow',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'member'),
                    ($1, $4, 'human', 'auditor', 'auditor'), ($1, $5, 'service', 'owner', 'ci-bot')`,
            [workspaceId, ownerId, memberId, auditorId, serviceId],
          );
        },
        { skipRoleSwitch: true },
      );
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const member = humanCaller(workspaceId, memberId, 'member');
      const auditor = humanCaller(workspaceId, auditorId, 'auditor');
      // An owner-role service Principal: its API key authenticates on the human channel too.
      const service = humanCaller(workspaceId, serviceId, 'owner', 'service');
      const call = <T>(caller: ResolvedCaller, name: string, params: unknown) =>
        dispatchCapability({ pool }, caller, name, params) as Promise<T>;
      const opsAssets = async () =>
        (
          await call<{ items: WorkspaceModuleWire[] }>(member, 'list_workspace_modules', {})
        ).items.find((m) => m.name === 'ops-assets');

      expect((await opsAssets())?.provenance).toEqual({ status: 'not_installed' });
      const installed = await call<WorkspaceModuleWire>(owner, 'install_module', {
        name: 'ops-assets',
        version: 2,
      });
      expect(installed.provenance).toMatchObject({
        status: 'recorded',
        segmentStatus: 'applied',
        channel: 'human',
        appliedBy: { id: ownerId, kind: 'human', displayName: 'owner' },
      });
      const segmentId =
        installed.provenance.status === 'recorded' ? installed.provenance.segmentId : '';
      expect((await opsAssets())?.provenance).toEqual(installed.provenance);

      const listed = await call<{ items: ChangeSegmentWire[]; nextCursor?: string }>(
        member,
        'list_change_segments',
        {},
      );
      expect(listed.items.map((s) => [s.id, s.source.name, s.status])).toEqual([
        [segmentId, 'ops-assets', 'applied'],
      ]);
      const detail = await call<ChangeSegmentDetailWire>(member, 'get_change_segment', {
        segmentId,
      });
      expect(detail.items).toEqual([
        expect.objectContaining({
          ordinal: 1,
          kind: 'ontology_version',
          before: null,
          after: expect.objectContaining({ version: 1 }),
          state: 'in_effect',
          replacedBy: null,
        }),
      ]);

      expect(
        (await call<ChangeSegmentDetailWire>(auditor, 'get_change_segment', { segmentId })).segment
          .id,
      ).toBe(segmentId);
      expect(
        (await call<{ items: ChangeSegmentWire[] }>(auditor, 'list_change_segments', {})).items,
      ).toHaveLength(1);

      for (const reader of [member, auditor]) {
        await expect(
          call(reader, 'preview_roll_back_change_segment', { segmentId }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
      await expect(call(member, 'roll_back_change_segment', { segmentId })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      // Review of #663: confirming an authority-widening item is a person's, never a service's.
      await expect(
        call(service, 'roll_back_change_segment', { segmentId, confirmedOrdinals: [1] }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      // S11 AA1 (legacy 407): nor may it roll back at all, confirming nothing — the capability is
      // `actsForPerson`, refused at dispatch, as is verifying the segment.
      await expect(call(service, 'roll_back_change_segment', { segmentId })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(call(service, 'verify_change_segment', { segmentId })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(
        (await call<ChangeSegmentDetailWire>(owner, 'get_change_segment', { segmentId })).segment
          .status,
      ).toBe('applied');

      const dryRun = await call<ChangeRollbackPreviewWire>(
        owner,
        'preview_roll_back_change_segment',
        { segmentId },
      );
      expect(dryRun).toMatchObject({
        possible: true,
        inUse: { objects: 0, links: 0, capped: false },
        items: [{ ordinal: 1, to: null, classification: 'not_widening', blocker: null }],
      });
      const [first] = dryRun.items;
      expect(first?.kind === 'ontology_version' ? first.removes.objectTypes : []).toContain('Host');

      const rolledBack = await call<ChangeSegmentWire>(owner, 'roll_back_change_segment', {
        segmentId,
      });
      expect(rolledBack).toMatchObject({
        id: segmentId,
        status: 'rolled_back',
        rolledBackBy: { id: ownerId, kind: 'human', displayName: 'owner' },
      });
      expect(rolledBack.rolledBackAt).toEqual(expect.any(String));
      expect(await opsAssets()).toMatchObject({
        status: 'not_installed',
        installedVersion: null,
        provenance: { status: 'not_installed' },
      });
      await expect(call(owner, 'roll_back_change_segment', { segmentId })).rejects.toBeInstanceOf(
        ChangeSegmentRolledBackError,
      );

      const audit = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ action: string; resource_type: string | null; resource_id: string | null }>(
          `select action, resource_type, resource_id from audit_records
            where workspace_id = $1 and action in ('roll_back_change_segment', 'change_item.roll_back')
            order by action`,
          [workspaceId],
        ),
      );
      expect(audit.rows).toEqual([
        {
          action: 'change_item.roll_back',
          resource_type: 'change_item',
          resource_id: detail.items[0]?.id,
        },
        {
          action: 'roll_back_change_segment',
          resource_type: 'change_segment',
          resource_id: segmentId,
        },
      ]);
    });
  },
);
