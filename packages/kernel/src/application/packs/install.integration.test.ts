import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ReviewedVersionChangedError } from '../../governance/capability/index.js';
import { deriveOntologyPackId, publishOntologyVersion } from '../../substrate/ontology/index.js';
import {
  ChangeConfirmationRequiredError,
  ChangePlanChangedError,
  type PlannedChangeItem,
  applyWorkspaceSegment,
  planWorkspaceSegment,
} from '../change-plan/index.js';
import { proposeSkill, publishSkill } from '../worker/index.js';
import { type PackFixtureDirs, skillFile, workerFile, writePackFixture } from './fixture.js';
import {
  type PackComponentState,
  PackDependencyUnmetError,
  type PackRegistry,
  installPack,
  latestPackVersion,
  loadPackRegistry,
  loadPackState,
  packSegment,
  previewPackInstall,
  readPackDependencies,
  requirePack,
} from './index.js';

/**
 * application/packs — install.integration (S11 P1-C): a pack installs as one ChangePlan workspace
 * segment. The preview: what the workspace has now (derived from each family's head, per
 * component), the versions the install moves through and whether one is breaking, each item's
 * type names added / removed / changed, the graph rows using a removed type. The install: the
 * reviewed version and digest re-checked (409 `version_changed` / `change_plan_changed`, nothing
 * written), widening items confirmed one by one, one segment sourced from the pack version.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;

/** An ontology item's type changes (`undefined` for another kind). */
const typesOf = (item: PlannedChangeItem | undefined) =>
  item?.detail.kind === 'ontology_version' ? item.detail.types : undefined;
/** A component state's family (an ontology component) or name. */
const keyOf = (state: PackComponentState) =>
  state.component.kind === 'ontology' ? state.component.family : state.component.name;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** A domain pack declaring `objectTypes` and one LinkType `link` from the first of them. */
function ontologyYaml(objectTypes: readonly string[], link: string, extra = ''): string {
  const types = objectTypes.map((name) => `  - name: ${name}\n    description: d\n`).join('');
  return `objectTypes:\n${types}linkTypes:\n  - name: ${link}\n    domain: ${objectTypes[0]}\n    range: "*"\n    description: d\n${extra}`;
}

const RESTART_YAML =
  'actionTypes:\n  - name: restart\n    description: d\n    mode: execute\n    blastRadius: medium\n';

type Ws = { readonly workspaceId: string; readonly ownerId: string };

describe.runIf(DATABASE_URL !== undefined)(
  'application/packs — preview and install (S11 P1-C, integration, real Postgres)',
  () => {
    let pool: Pool;
    let fixture: PackFixtureDirs;
    let registry: PackRegistry;

    async function newWorkspace(): Promise<Ws> {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1-packs',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      return { workspaceId, ownerId };
    }

    const inWorkspace = <T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn);
    const asOwner = <T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn, {
        skipRoleSwitch: true,
      });
    const rows = (ws: Ws, sql: string, params: unknown[] = []) =>
      asOwner(ws, async (client) => (await client.query(sql, [ws.workspaceId, ...params])).rows);

    const preview = (ws: Ws, name: string) =>
      inWorkspace(ws, (client) => previewPackInstall(client, ws.workspaceId, registry, name));
    const install = (
      ws: Ws,
      input: {
        name: string;
        version: number;
        reviewedDigest: string;
        confirmedOrdinals?: number[];
      },
    ) =>
      inWorkspace(ws, (client) =>
        installPack(client, ws.workspaceId, ws.ownerId, registry, {
          confirmedOrdinals: [],
          ...input,
        }),
      );

    /** Installs version `version` of `name` the way an older platform would have: its segment,
     *  applied directly (`install_pack` only ever installs the latest), every widening item
     *  confirmed. */
    async function installOlder(ws: Ws, name: string, version: number): Promise<void> {
      const entry = requirePack(registry, name);
      const target = entry.versions.find((v) => v.version === version);
      if (!target) throw new Error(`fixture: ${name} has no version ${version}`);
      const segment = packSegment(entry, target);
      await inWorkspace(ws, async (client) => {
        const plan = await planWorkspaceSegment(client, ws.workspaceId, segment);
        await applyWorkspaceSegment(client, ws.workspaceId, {
          ...segment,
          reviewedDigest: plan.digest,
          proposedBy: ws.ownerId,
          appliedBy: ws.ownerId,
          channel: 'human',
          confirmedOrdinals: plan.items
            .filter((item) => item.classification === 'authority_widening')
            .map((item) => item.ordinal),
        });
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      fixture = await writePackFixture({
        // v2 drops Beta (breaking), adds Gamma, and a second family.
        kit: [
          {
            notes: 'core only',
            ontology: [
              {
                family: 'kit-core',
                domainPack: 'kit-core-v1.yaml',
                yaml: ontologyYaml(['Alpha', 'Beta'], 'kit_rel'),
              },
            ],
          },
          {
            notes: 'drops Beta; adds the extra family',
            breaking: true,
            ontology: [
              {
                family: 'kit-core',
                domainPack: 'kit-core-v2.yaml',
                yaml: ontologyYaml(['Alpha', 'Gamma'], 'kit_rel'),
              },
              {
                family: 'kit-extra',
                domainPack: 'kit-extra-v1.yaml',
                yaml: ontologyYaml(['Delta'], 'extra_rel'),
              },
            ],
          },
        ],
        // v2 changes the Skill's text and gives the Worker a second Skill.
        crew: [
          {
            skills: [skillFile('crew-fix', 'Fix the thing.', 'Step one.')],
            workers: [workerFile('crew-runner', 'You run the crew.', 'skills:\n  - crew-fix\n')],
          },
          {
            skills: [
              skillFile('crew-fix', 'Fix the thing.', 'Step one, then two.'),
              skillFile('crew-check', 'Check the thing.', 'Look first.'),
            ],
            workers: [
              workerFile(
                'crew-runner',
                'You run the crew.',
                'skills:\n  - crew-fix\n  - crew-check\n',
              ),
            ],
          },
        ],
        // S11 P1-F: builds on kit v2 (its Skill uses the types v2 publishes, say).
        'kit-user': [
          {
            skills: [skillFile('kit-user-fix', 'Use the kit.', 'Look at the Gamma first.')],
            requiresPacks: [{ name: 'kit', minVersion: 2 }],
          },
        ],
        'act-kit': [
          {
            ontology: [
              {
                family: 'act-kit',
                domainPack: 'act-kit-v1.yaml',
                yaml: ontologyYaml(['Widget'], 'widget_rel', RESTART_YAML),
              },
            ],
          },
        ],
      });
      registry = await loadPackRegistry(fixture);
    }, 180_000);

    afterAll(async () => {
      await pool.end();
      await rm(fixture.root, { recursive: true, force: true });
    });

    it('a fresh workspace: preview, install the reviewed digest, then nothing left to do', async () => {
      const ws = await newWorkspace();
      const dryRun = await preview(ws, 'kit');
      expect(dryRun.current).toMatchObject({ status: 'not_installed', installedVersion: null });
      expect(dryRun.target.version).toBe(2);
      expect(dryRun.crossed.map((v) => v.version)).toEqual([2]);
      expect(dryRun.breaking).toBe(false); // nothing installed to leave outside the new shapes
      expect(dryRun.plan.items.map((item) => [item.target.family, item.before])).toEqual([
        ['kit-core', null],
        ['kit-extra', null],
      ]);
      expect(typesOf(dryRun.plan.items[0])?.added.objectTypes).toEqual(['Alpha', 'Gamma']);
      expect(dryRun.inUse).toEqual({ objects: 0, links: 0, capped: false });
      // A dry run writes nothing.
      expect(await rows(ws, 'select id from change_segments where workspace_id = $1')).toEqual([]);

      const installed = await install(ws, {
        name: 'kit',
        version: 2,
        reviewedDigest: dryRun.plan.digest,
      });
      expect(installed.state).toMatchObject({ status: 'up_to_date', installedVersion: 2 });
      expect(installed.segmentId).not.toBeNull();
      const [segment] = await rows(
        ws,
        'select id, channel, source_kind, source_name, source_version, source_digest from change_segments where workspace_id = $1',
      );
      const kit = requirePack(registry, 'kit');
      expect(segment).toMatchObject({
        id: installed.segmentId,
        channel: 'human',
        source_kind: 'pack',
        source_name: 'kit',
        source_version: '2',
        source_digest: latestPackVersion(kit).digest,
      });
      expect(
        await rows(
          ws,
          'select ordinal, target->>$2 as family from change_items where workspace_id = $1 order by ordinal',
          ['family'],
        ),
      ).toEqual([
        { ordinal: 1, family: 'kit-core' },
        { ordinal: 2, family: 'kit-extra' },
      ]);

      const after = await preview(ws, 'kit');
      expect(after.current).toMatchObject({ status: 'up_to_date', installedVersion: 2 });
      expect(after.plan.unchanged).toBe(true);
      expect(after.crossed).toEqual([]);
      // Installing what is already there records nothing.
      const again = await install(ws, {
        name: 'kit',
        version: 2,
        reviewedDigest: after.plan.digest,
      });
      expect(again.segmentId).toBeNull();
      expect(await rows(ws, 'select id from change_segments where workspace_id = $1')).toHaveLength(
        1,
      );
    });

    it('an older install: the versions crossed, breaking, type changes, and rows of a removed type', async () => {
      const ws = await newWorkspace();
      await installOlder(ws, 'kit', 1);
      await asOwner(ws, (client) =>
        client.query(
          `insert into objects (workspace_id, object_type, identity_key, properties)
           values ($1, 'Beta', '{"key":"b1"}'::jsonb, '{}'::jsonb)`,
          [ws.workspaceId],
        ),
      );
      const state = await inWorkspace(ws, (client) =>
        loadPackState(client, ws.workspaceId, requirePack(registry, 'kit')),
      );
      expect(state).toMatchObject({ status: 'outdated', installedVersion: 1 });

      const dryRun = await preview(ws, 'kit');
      expect(dryRun.current.components.map((c) => [keyOf(c), c.status])).toEqual([
        ['kit-core', 'outdated'],
        ['kit-extra', 'not_installed'],
      ]);
      expect(dryRun.crossed.map((v) => v.version)).toEqual([2]);
      expect(dryRun.breaking).toBe(true);
      const [core, extra] = dryRun.plan.items;
      expect(typesOf(core)).toEqual({
        added: { objectTypes: ['Gamma'], linkTypes: [], actionTypes: [] },
        removed: { objectTypes: ['Beta'], linkTypes: [], actionTypes: [] },
        changed: { objectTypes: [], linkTypes: [], actionTypes: [] },
      });
      expect(typesOf(extra)?.added.objectTypes).toEqual(['Delta']);
      expect(dryRun.inUse).toEqual({ objects: 1, links: 0, capped: false });

      const installed = await install(ws, {
        name: 'kit',
        version: 2,
        reviewedDigest: dryRun.plan.digest,
      });
      expect(installed.state.status).toBe('up_to_date');
      // The rows of the removed type stay (S10 I-P4).
      expect(
        await rows(
          ws,
          "select count(*)::int as n from objects where workspace_id = $1 and object_type = 'Beta'",
        ),
      ).toEqual([{ n: 1 }]);
    });

    it('a family edited by hand is customized, and the install says the target is breaking', async () => {
      const ws = await newWorkspace();
      await installOlder(ws, 'kit', 1);
      await inWorkspace(ws, (client) =>
        publishOntologyVersion(client, ws.workspaceId, {
          id: deriveOntologyPackId('kit-core'),
          definition: {
            objectTypes: [{ name: 'Alpha', description: 'edited by hand' }],
            linkTypes: [{ name: 'kit_rel', domain: 'Alpha', range: '*', description: 'd' }],
          },
          principalId: ws.ownerId,
        }),
      );
      const dryRun = await preview(ws, 'kit');
      expect(dryRun.current).toMatchObject({ status: 'customized', installedVersion: null });
      expect(dryRun.current.components[0]).toMatchObject({
        component: { kind: 'ontology', family: 'kit-core' },
        status: 'customized',
      });
      expect(dryRun.crossed.map((v) => v.version)).toEqual([2]);
      expect(dryRun.breaking).toBe(true);
      expect(typesOf(dryRun.plan.items[0])?.changed.objectTypes).toEqual(['Alpha']);
    });

    it('the reviewed version or digest no longer current: refused, nothing written', async () => {
      const ws = await newWorkspace();
      const dryRun = await preview(ws, 'kit');
      await expect(
        install(ws, { name: 'kit', version: 1, reviewedDigest: dryRun.plan.digest }),
      ).rejects.toBeInstanceOf(ReviewedVersionChangedError);

      // Something changed between the review and the click: the family was installed meanwhile.
      await installOlder(ws, 'kit', 1);
      await expect(
        install(ws, { name: 'kit', version: 2, reviewedDigest: dryRun.plan.digest }),
      ).rejects.toBeInstanceOf(ChangePlanChangedError);
      expect(
        await rows(ws, 'select source_version from change_segments where workspace_id = $1'),
      ).toEqual([{ source_version: '1' }]);
    });

    it('an authority-widening item is installed only when confirmed by its ordinal', async () => {
      const ws = await newWorkspace();
      const dryRun = await preview(ws, 'act-kit');
      expect(dryRun.plan.items[0]?.classification).toBe('authority_widening');
      await expect(
        install(ws, { name: 'act-kit', version: 1, reviewedDigest: dryRun.plan.digest }),
      ).rejects.toBeInstanceOf(ChangeConfirmationRequiredError);
      expect(await rows(ws, 'select id from change_segments where workspace_id = $1')).toEqual([]);

      const installed = await install(ws, {
        name: 'act-kit',
        version: 1,
        reviewedDigest: dryRun.plan.digest,
        confirmedOrdinals: [1],
      });
      expect(installed.state.status).toBe('up_to_date');
      expect(
        await rows(
          ws,
          'select classification, confirmed_by from change_items where workspace_id = $1',
        ),
      ).toEqual([{ classification: 'authority_widening', confirmed_by: ws.ownerId }]);
    });

    it('Skills and Workers: Skills before the Worker that mounts them, one item each, upgraded and recognized by content', async () => {
      const ws = await newWorkspace();
      await installOlder(ws, 'crew', 1);
      const entry = requirePack(registry, 'crew');
      expect(
        await inWorkspace(ws, (client) => loadPackState(client, ws.workspaceId, entry)),
      ).toMatchObject({ status: 'outdated', installedVersion: 1 });

      const dryRun = await preview(ws, 'crew');
      expect(dryRun.current.components.map((c) => [c.component.kind, keyOf(c), c.status])).toEqual([
        ['skill', 'crew-fix', 'outdated'],
        ['skill', 'crew-check', 'not_installed'],
        ['worker', 'crew-runner', 'outdated'],
      ]);
      expect(
        dryRun.plan.items.map((item) => [
          item.ordinal,
          item.kind,
          item.widening.map((w) => w.path),
        ]),
      ).toEqual([
        [1, 'skill_version', ['skill.markdown']],
        [2, 'skill_version', ['skill']],
        [3, 'worker_definition_version', ['worker.skills']],
      ]);
      expect(dryRun.inUse).toEqual({ objects: 0, links: 0, capped: false });
      await expect(
        install(ws, { name: 'crew', version: 2, reviewedDigest: dryRun.plan.digest }),
      ).rejects.toBeInstanceOf(ChangeConfirmationRequiredError);

      const installed = await install(ws, {
        name: 'crew',
        version: 2,
        reviewedDigest: dryRun.plan.digest,
        confirmedOrdinals: [1, 2, 3],
      });
      expect(installed.state).toMatchObject({ status: 'up_to_date', installedVersion: 2 });
      expect(
        await inWorkspace(ws, (client) => loadPackState(client, ws.workspaceId, entry)),
      ).toMatchObject({ status: 'up_to_date', installedVersion: 2 });
      expect(
        await rows(
          ws,
          'select s.name, s.version, s.status from skills s where s.workspace_id = $1 order by s.name, s.version',
        ),
      ).toEqual([
        { name: 'crew-check', version: 1, status: 'published' },
        { name: 'crew-fix', version: 1, status: 'published' },
        { name: 'crew-fix', version: 2, status: 'published' },
      ]);
      expect((await preview(ws, 'crew')).plan.unchanged).toBe(true);
    });

    it('a Skill name the workspace already uses: the preview is refused (409 skill_name_conflict)', async () => {
      const ws = await newWorkspace();
      await inWorkspace(ws, async (client) => {
        const own = await proposeSkill(client, ws.workspaceId, ws.ownerId, {
          name: 'crew-check',
          description: 'Mine.',
          markdown: 'my body',
        });
        await publishSkill(client, ws.workspaceId, ws.ownerId, own.id);
      });
      await expect(preview(ws, 'crew')).rejects.toMatchObject({
        code: 'skill_name_conflict',
        skillName: 'crew-check',
      });
    });

    it('S11 P1-F: a pack it builds on not installed at the version it needs refuses the install, nothing written; installing that pack first lets it through', async () => {
      const ws = await newWorkspace();
      const dependencies = () =>
        inWorkspace(ws, (client) =>
          readPackDependencies(
            client,
            ws.workspaceId,
            registry,
            latestPackVersion(requirePack(registry, 'kit-user')).requiredPacks,
          ),
        );
      const tryInstall = async () => {
        const dryRun = await preview(ws, 'kit-user');
        return install(ws, {
          name: 'kit-user',
          version: 1,
          reviewedDigest: dryRun.plan.digest,
          confirmedOrdinals: dryRun.plan.items
            .filter((item) => item.classification === 'authority_widening')
            .map((item) => item.ordinal),
        });
      };

      // Not installed: the preview still answers (the console shows what is missing), the install
      // refuses with what to install first.
      expect(await dependencies()).toEqual([
        { name: 'kit', minVersion: 2, status: 'not_installed', installedVersion: null, met: false },
      ]);
      const refused = await tryInstall().catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(PackDependencyUnmetError);
      expect((refused as PackDependencyUnmetError).details).toEqual({
        unmet: [{ name: 'kit', minVersion: 2, status: 'not_installed', installedVersion: null }],
      });
      expect((refused as Error).message).toMatch(/builds on kit v2 or later/);

      // An older version is not enough.
      await installOlder(ws, 'kit', 1);
      expect(await dependencies()).toMatchObject([
        { status: 'outdated', installedVersion: 1, met: false },
      ]);
      await expect(tryInstall()).rejects.toBeInstanceOf(PackDependencyUnmetError);
      expect(
        await rows(
          ws,
          "select source_name from change_segments where workspace_id = $1 and source_name = 'kit-user'",
        ),
      ).toEqual([]);

      // The required version installed: the install goes through.
      const kit = await preview(ws, 'kit');
      await install(ws, {
        name: 'kit',
        version: 2,
        reviewedDigest: kit.plan.digest,
        confirmedOrdinals: kit.plan.items
          .filter((item) => item.classification === 'authority_widening')
          .map((item) => item.ordinal),
      });
      expect(await dependencies()).toMatchObject([
        { status: 'up_to_date', installedVersion: 2, met: true },
      ]);
      const installed = await tryInstall();
      expect(installed.state.status).toBe('up_to_date');
      expect(installed.segmentId).not.toBeNull();
    });

    it('a pack the deployment does not ship is pack_not_found', async () => {
      const ws = await newWorkspace();
      await expect(preview(ws, 'no-such-pack')).rejects.toMatchObject({ code: 'pack_not_found' });
    });
  },
);
