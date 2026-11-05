import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExtraPacksWire,
  ModuleWire,
  PackInstallPreviewWire,
  PackInstallResultWire,
  PackWire,
  Role,
} from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { type UserRow, createPlatformAdmin } from '../identity/index.js';
import {
  type PackFixtureDirs,
  objectTypeYaml,
  skillFile,
  writePackFixture,
} from '../packs/fixture.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/extra-packs.integration.test (S11 AA5d-1): a deployment's extra packs
 * (`EXTRA_PACKS_DIR`) end to end through `dispatchCapability` — one read beside the image's,
 * offered by `list_packs` as `source: 'extra'`, installed and verified like any pack, never a
 * module; one that breaks a rule left out and shown to a platform administrator by
 * `extra_packs_status`, every other read untouched. The directory is read on every call, so the test
 * sets `EXTRA_PACKS_DIR` around its calls. Every result is checked against its own
 * `resultSchema` (`KERNEL_VALIDATE_RESULTS=1`, vitest.config.ts).
 *
 * Gated on `DATABASE_URL`.
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

function platformCaller(user: UserRow): ResolvedCaller {
  return {
    channel: 'platform',
    user: {
      id: user.id,
      login: user.login,
      displayName: user.displayName,
      platformRole: 'admin',
      mustChangePassword: false,
      consoleSessionId: randomUUID(),
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/gateway — extra packs (S11 AA5d-1, integration, real Postgres)',
  () => {
    let pool: Pool;
    let admin: UserRow;
    let fixture: PackFixtureDirs | undefined;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      admin = await createPlatformAdmin(pool, {
        login: `extra-packs-${randomUUID().slice(0, 8)}`,
        displayName: 'Extra packs admin',
        password: 'correct horse battery staple',
      });
    });

    afterEach(async () => {
      Reflect.deleteProperty(process.env, 'EXTRA_PACKS_DIR');
      if (fixture) await rm(fixture.root, { recursive: true, force: true });
      fixture = undefined;
    });

    afterAll(async () => {
      await pool.end();
    });

    it('one read and installed like any pack, never a module; one broken left out and shown on the platform plane', async () => {
      fixture = await writePackFixture(
        {
          'org-notes': [
            {
              summary: 'Notes the organization keeps',
              ontology: [
                { family: 'org-notes', domainPack: 'org-notes.yaml', yaml: objectTypeYaml('Note') },
              ],
              skills: [skillFile('org-note-taking', 'Take an org note.', 'Write it down.')],
            },
          ],
          'org-broken': [
            {
              ontology: [
                { family: 'org-broken', domainPack: 'b.yaml', yaml: objectTypeYaml('Broken') },
              ],
            },
          ],
        },
        { extra: true },
      );
      await writeFile(
        path.join(fixture.packsDir, 'org-broken', '1', 'pack.yaml'),
        'schema: 1\nname: org-broken\n',
      );

      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      const memberId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'aa5d1-extra-packs',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'member')`,
            [workspaceId, ownerId, memberId],
          );
        },
        { skipRoleSwitch: true },
      );
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const member = humanCaller(workspaceId, memberId, 'member');
      const call = <T>(caller: ResolvedCaller, name: string, params: unknown = {}) =>
        dispatchCapability({ pool }, caller, name, params) as Promise<T>;
      const listPacks = async () => (await call<{ items: PackWire[] }>(member, 'list_packs')).items;

      // Without the directory configured: the image's packs only, and nothing to show.
      const before = await listPacks();
      expect(before.every((pack) => pack.source === 'builtin')).toBe(true);
      expect(await call<ExtraPacksWire>(platformCaller(admin), 'extra_packs_status')).toMatchObject(
        {
          configured: false,
          packs: [],
          skipped: [],
          unreadable: null,
        },
      );

      process.env.EXTRA_PACKS_DIR = fixture.packsDir;
      const listed = await listPacks();
      expect(listed.map((pack) => pack.name)).toEqual([
        ...before.map((pack) => pack.name),
        'org-notes',
      ]);
      expect(listed.find((pack) => pack.name === 'org-notes')).toMatchObject({
        source: 'extra',
        summary: 'Notes the organization keeps',
        status: 'not_installed',
        latestVersion: 1,
      });

      const shown = await call<ExtraPacksWire>(platformCaller(admin), 'extra_packs_status');
      expect(shown).toMatchObject({
        configured: true,
        packs: [{ name: 'org-notes', summary: 'Notes the organization keeps', latestVersion: 1 }],
        skipped: [
          { name: 'org-broken', reason: expect.stringContaining('org-broken/1/pack.yaml') },
        ],
        unreadable: null,
      });
      expect(shown.skipped[0]?.reason).not.toContain(fixture.packsDir);

      // Never a module: not on the platform's module list.
      const modules = (await call<{ items: ModuleWire[] }>(platformCaller(admin), 'list_modules'))
        .items;
      expect(modules.map((module) => module.name)).not.toContain('org-notes');

      const preview = await call<PackInstallPreviewWire>(owner, 'preview_pack_install', {
        name: 'org-notes',
      });
      expect(preview.items.map((item) => item.kind)).toEqual(['ontology_version', 'skill_version']);
      const installed = await call<PackInstallResultWire>(owner, 'install_pack', {
        name: 'org-notes',
        version: 1,
        reviewedDigest: preview.digest,
        confirmedOrdinals: preview.items
          .filter((item) => item.classification === 'authority_widening')
          .map((item) => item.ordinal),
      });
      expect(installed.pack).toMatchObject({
        source: 'extra',
        status: 'up_to_date',
        installedVersion: 1,
      });
      expect(installed.segmentId).not.toBeNull();
      // Verified on install, like any pack: its source version is found in this deployment.
      expect(installed.verification).toMatchObject({ passed: true, sourceFound: true });

      // The directory taken away: the pack is no longer offered; what it installed stays.
      await rm(path.join(fixture.packsDir, 'org-notes'), { recursive: true });
      await mkdir(path.join(fixture.packsDir, '.staging'));
      expect((await listPacks()).map((pack) => pack.name)).not.toContain('org-notes');
      expect(
        (await call<ExtraPacksWire>(platformCaller(admin), 'extra_packs_status')).packs,
      ).toEqual([]);
    });
  },
);
