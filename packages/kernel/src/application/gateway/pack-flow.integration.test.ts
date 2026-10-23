import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PackInstallPreviewWire,
  PackInstallResultWire,
  PackWire,
  Role,
  WorkspaceModuleWire,
} from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ReviewedVersionChangedError } from '../../governance/capability/index.js';
import { ChangePlanChangedError } from '../change-plan/index.js';
import { PackNotFoundError } from '../packs/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/pack-flow.integration.test (S11 P1-C): the 能力目录 能力包 path end to end
 * through `dispatchCapability` — `list_packs` for members and auditors; `preview_pack_install` /
 * `install_pack` for the owner only; the install refused on a stale version or digest, then
 * applied with the reviewed one; the pack and its module agree afterwards (a module is a pack
 * with one component). Every result is checked against its own `resultSchema`
 * (`KERNEL_VALIDATE_RESULTS=1`, vitest.config.ts).
 *
 * Gated on `DATABASE_URL`; uses the repo's own `packs/` (`ops-assets`, no ActionType).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: role },
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
  'application/gateway — packs flow (S11 P1-C, integration, real Postgres)',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('list → owner-only preview → stale version / digest refused → install → pack and module agree', async () => {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      const memberId = randomUUID();
      const auditorId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1c-packs-flow',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'member'),
                    ($1, $4, 'human', 'auditor', 'auditor')`,
            [workspaceId, ownerId, memberId, auditorId],
          );
        },
        { skipRoleSwitch: true },
      );
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const member = humanCaller(workspaceId, memberId, 'member');
      const auditor = humanCaller(workspaceId, auditorId, 'auditor');
      const call = <T>(caller: ResolvedCaller, name: string, params: unknown) =>
        dispatchCapability({ pool }, caller, name, params) as Promise<T>;
      const opsAssets = async (caller: ResolvedCaller) =>
        (await call<{ items: PackWire[] }>(caller, 'list_packs', {})).items.find(
          (p) => p.name === 'ops-assets',
        );

      const listed = await opsAssets(member);
      expect(listed).toMatchObject({
        latestVersion: 2,
        status: 'not_installed',
        installedVersion: null,
        components: [
          {
            kind: 'ontology',
            family: 'ops-assets',
            domainPack: 'ops-assets-v2.yaml',
            status: 'not_installed',
            provenance: { status: 'not_installed' },
          },
        ],
      });
      expect(listed?.versions.map((v) => v.version)).toEqual([1, 2]);
      expect(await opsAssets(auditor)).toEqual(listed);

      await expect(
        call(member, 'preview_pack_install', { name: 'ops-assets' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        call(owner, 'preview_pack_install', { name: 'no-such-pack' }),
      ).rejects.toBeInstanceOf(PackNotFoundError);

      const preview = await call<PackInstallPreviewWire>(owner, 'preview_pack_install', {
        name: 'ops-assets',
      });
      expect(preview).toMatchObject({
        targetVersion: 2,
        unchanged: false,
        crossedVersions: [2],
        breaking: false,
        inUse: { objects: 0, links: 0, capped: false },
      });
      expect(preview.items).toEqual([
        expect.objectContaining({
          ordinal: 1,
          kind: 'ontology_version',
          domainPack: 'ops-assets-v2.yaml',
          before: null,
          classification: 'not_widening',
          unchanged: false,
        }),
      ]);
      const [first] = preview.items;
      expect(first?.kind === 'ontology_version' ? first.types.added.objectTypes : []).toContain(
        'Container',
      );

      await expect(
        call(member, 'install_pack', {
          name: 'ops-assets',
          version: 2,
          reviewedDigest: preview.digest,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        call(owner, 'install_pack', {
          name: 'ops-assets',
          version: 1,
          reviewedDigest: preview.digest,
        }),
      ).rejects.toBeInstanceOf(ReviewedVersionChangedError);
      await expect(
        call(owner, 'install_pack', {
          name: 'ops-assets',
          version: 2,
          reviewedDigest: 'sha256:not-the-reviewed-one',
        }),
      ).rejects.toBeInstanceOf(ChangePlanChangedError);

      const installed = await call<PackInstallResultWire>(owner, 'install_pack', {
        name: 'ops-assets',
        version: 2,
        reviewedDigest: preview.digest,
      });
      expect(installed.segmentId).not.toBeNull();
      expect(installed.pack).toMatchObject({ status: 'up_to_date', installedVersion: 2 });
      expect(installed.pack.components[0]?.provenance).toMatchObject({
        status: 'recorded',
        segmentId: installed.segmentId,
        channel: 'human',
      });

      // A module is a pack with one component: the module page reads the same state.
      const module = (
        await call<{ items: WorkspaceModuleWire[] }>(member, 'list_workspace_modules', {})
      ).items.find((m) => m.name === 'ops-assets');
      expect(module).toMatchObject({ status: 'up_to_date', installedVersion: 2 });
      expect(module?.provenance).toEqual(installed.pack.components[0]?.provenance);

      const again = await call<PackInstallPreviewWire>(owner, 'preview_pack_install', {
        name: 'ops-assets',
      });
      expect(again).toMatchObject({ unchanged: true, crossedVersions: [] });
    });

    it("ops-base: a Worker component carries its published head version (the 「Worker」 tab's row is one version)", async () => {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1d-packs-flow',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const call = <T>(name: string, params: unknown) =>
        dispatchCapability({ pool }, owner, name, params) as Promise<T>;
      const opsRunner = (pack: PackWire | undefined) =>
        pack?.components.find((c) => c.kind === 'worker' && c.name === 'ops-runner');

      const listed = (await call<{ items: PackWire[] }>('list_packs', {})).items.find(
        (p) => p.name === 'ops-base',
      );
      expect(opsRunner(listed)).toMatchObject({ status: 'not_installed', headVersion: null });

      const preview = await call<PackInstallPreviewWire>('preview_pack_install', {
        name: 'ops-base',
      });
      const installed = await call<PackInstallResultWire>('install_pack', {
        name: 'ops-base',
        version: preview.targetVersion,
        reviewedDigest: preview.digest,
        confirmedOrdinals: preview.items
          .filter((item) => item.classification === 'authority_widening')
          .map((item) => item.ordinal),
      });
      expect(installed.pack).toMatchObject({ status: 'up_to_date', installedVersion: 2 });
      expect(opsRunner(installed.pack)).toMatchObject({ status: 'up_to_date', headVersion: 1 });
    });
  },
);
