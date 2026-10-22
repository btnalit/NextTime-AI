import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { withPlatform } from '../../adapters/db/platform-context.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ReviewedVersionChangedError } from '../../governance/capability/index.js';
import { deriveOntologyPackId, publishOntologyDomainPack } from '../../substrate/ontology/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { type PackFixtureDirs, objectTypeYaml, writePackFixture } from '../packs/fixture.js';
import { createWorkspaceWithOwner } from '../workspace/create.js';
import {
  ModuleConfirmRequiredError,
  type ModuleRegistry,
  checkDefaultModules,
  countModuleInstallations,
  installOrUpgradeModule,
  loadModuleRegistry,
  loadWorkspaceModuleStates,
} from './modules.js';
import { readPlatformSettings, updatePlatformSettings } from './settings.js';

/**
 * application/platform/modules.integration.test: DB-gated (real Postgres, shared CI database, the
 * same `describe.runIf` pattern every other integration suite in this package uses — auto-skip
 * without `DATABASE_URL`, which this machine does not have) coverage of `installOrUpgradeModule`'s
 * D3 branches, `countModuleInstallations`, and `create_workspace`'s default-module install (D4).
 *
 * **The central fact every test here exercises**: a workspace's `ontology_versions.version` (a
 * per-workspace publish counter) and a module's own **pack** version number (`packs/<name>/
 * <version>/`, matched by content digest — D2) are two different counters. `installOrUpgradeModule`
 * always targets a module's own **latest** index version directly (one publish), never
 * `installedVersion + 1` — see `modules.ts`'s own module doc comment for the full correction and
 * why an earlier draft of this function conflated the two.
 *
 * **Fixture.** A synthetic 4-version `test-mod` pack is written to a temp `packs/` + `ontology/` in
 * `beforeAll` (`application/packs/fixture.ts`; v1/v2/v4 distinct, non-breaking content; v3
 * breaking) and every registry below is read from it — precise control over `breaking` placement
 * the real `ops-assets` versions (both non-breaking) cannot give. The D4 create-workspace test uses the real, checked-in
 * `ontology/` directory instead (its `ops-assets` family) — that test needs `platform-meta.yaml`/
 * `entry-agent.yaml` too, which the synthetic fixture does not carry.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** A synthetic 4-version `test-mod` module (one ontology component per version, into the family
 *  named after it): v1/v2/v4 distinct, non-breaking content; v3 breaking. */
async function writeTestModFixture(): Promise<PackFixtureDirs> {
  const version = (n: number, notes: string, breaking = false) => ({
    notes,
    breaking,
    ontology: [
      { family: 'test-mod', domainPack: `test-mod-v${n}.yaml`, yaml: objectTypeYaml(`ThingV${n}`) },
    ],
  });
  return writePackFixture({
    'test-mod': [
      version(1, 'v1'),
      version(2, 'v2'),
      version(3, 'v3, breaking', true),
      version(4, 'v4 (latest)'),
    ],
  });
}

describe.runIf(DATABASE_URL !== undefined)('modules (integration, real Postgres)', () => {
  let pool: Pool;
  let fixture: PackFixtureDirs;
  let registry: ModuleRegistry;

  async function newWorkspace(name: string): Promise<{ workspaceId: string; principalId: string }> {
    const workspaceId = randomUUID();
    const principalId = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId },
      async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          name,
        ]);
        await client.query(
          "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
          [workspaceId, principalId],
        );
      },
      { skipRoleSwitch: true },
    );
    return { workspaceId, principalId };
  }

  async function inWorkspace<T>(
    workspaceId: string,
    principalId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return withWorkspace(pool, { workspaceId, principalId }, fn);
  }

  /** `installOrUpgradeModule` against the synthetic `test-mod` registry (`loadModuleRegistry(
   *  fixture)` in `beforeAll`): the definitions it publishes are the fixture's, read into the
   *  registry, never the real repo `ontology/`. */
  async function install(
    workspaceId: string,
    principalId: string,
    input: { readonly name: string; readonly confirm?: boolean; readonly version?: number },
  ) {
    return inWorkspace(workspaceId, principalId, (client) =>
      installOrUpgradeModule(client, workspaceId, principalId, registry, {
        ...input,
        channel: 'human',
      }),
    );
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    fixture = await writeTestModFixture();
    registry = await loadModuleRegistry(fixture);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('D3 (b): family absent → installs the latest index version directly, no confirm needed', async () => {
    const { workspaceId, principalId } = await newWorkspace('modules-install-latest');
    const state = await install(workspaceId, principalId, { name: 'test-mod' });
    expect(state.installedVersion).toBe(4);
    expect(state.status).toBe('up_to_date');
  });

  it('D3: calling again once already at the latest is a no-op (does not publish a new row)', async () => {
    const { workspaceId, principalId } = await newWorkspace('modules-noop-latest');
    await install(workspaceId, principalId, { name: 'test-mod' });
    const again = await install(workspaceId, principalId, { name: 'test-mod' });
    expect(again.installedVersion).toBe(4);

    const rows = await inWorkspace(workspaceId, principalId, (client) =>
      client.query<{ version: number }>(
        'select version from ontology_versions where workspace_id = $1 and id = $2',
        [workspaceId, deriveOntologyPackId('test-mod')],
      ),
    );
    expect(rows.rows).toHaveLength(1); // only the first install's row — the retry published nothing
  });

  it('D3 (a) + (c): a workspace whose DB version ≠ index version is classified by hash, and upgrading jumps straight to the latest, requiring confirm for the breaking version it crosses', async () => {
    const { workspaceId, principalId } = await newWorkspace('modules-db-index-mismatch');

    // Publish index v1's own file content twice by hand (not via installOrUpgradeModule, which
    // always targets the latest) — this workspace's ontology_versions.version ends up 2, while its
    // *content* still matches the index's own version 1. The DB row number and the index version
    // number are different counters (this file's own module doc comment).
    const v1 = registry.get('test-mod')?.versions.find((v) => v.version === 1);
    if (!v1) throw new Error('fixture bug: test-mod has no index version 1');
    await inWorkspace(workspaceId, principalId, (client) =>
      publishOntologyDomainPack(client, workspaceId, {
        packName: 'test-mod',
        fileName: v1.file,
        dir: fixture.ontologyDir,
        principalId,
      }),
    );
    const secondPublish = await inWorkspace(workspaceId, principalId, (client) =>
      publishOntologyDomainPack(client, workspaceId, {
        packName: 'test-mod',
        fileName: v1.file,
        dir: fixture.ontologyDir,
        principalId,
      }),
    );
    expect(secondPublish.version).toBe(2); // the DB's own publish counter — not the index version

    const states = await inWorkspace(workspaceId, principalId, (client) =>
      loadWorkspaceModuleStates(client, workspaceId, registry),
    );
    const testMod = states.find((s) => s.entry.name === 'test-mod');
    expect(testMod?.status).toBe('outdated');
    expect(testMod?.installedVersion).toBe(1); // the matched *index* version, not the DB row (2)

    // Upgrading jumps straight to the latest (index v4), crossing index v3 (breaking) along the
    // way — confirm is required even though the immediate "current -> latest" jump's own target
    // (v4) is not itself marked breaking.
    await expect(install(workspaceId, principalId, { name: 'test-mod' })).rejects.toMatchObject({
      code: 'module_confirm_required',
      details: {
        name: 'test-mod',
        currentVersion: 1,
        currentStatus: 'outdated',
        targetVersion: 4,
        breaking: true,
      },
    });

    const state = await install(workspaceId, principalId, { name: 'test-mod', confirm: true });
    expect(state.installedVersion).toBe(4);
    expect(state.status).toBe('up_to_date');
  });

  it('D3: customized (hand-published content under the family id) requires confirm even when no indexed version in range is breaking', async () => {
    const { workspaceId, principalId } = await newWorkspace('modules-customized');
    const packId = deriveOntologyPackId('test-mod');
    // Publish arbitrary content directly under test-mod's own id family — the "someone reached
    // this family through propose_ontology_change by hand" scenario this file's own module doc
    // comment (modules.ts) describes. Uses `publishOntologyVersion` directly (not a real index
    // file) so its hash matches no indexed version at all.
    const { publishOntologyVersion } = await import('../../substrate/ontology/index.js');
    await inWorkspace(workspaceId, principalId, (client) =>
      publishOntologyVersion(client, workspaceId, {
        id: packId,
        definition: { objectTypes: [{ name: 'HandEdited', description: 'd' }], linkTypes: [] },
        principalId,
      }),
    );

    const states = await inWorkspace(workspaceId, principalId, (client) =>
      loadWorkspaceModuleStates(client, workspaceId, registry),
    );
    const testMod = states.find((s) => s.entry.name === 'test-mod');
    expect(testMod?.status).toBe('customized');
    expect(testMod?.installedVersion).toBeNull();

    await expect(install(workspaceId, principalId, { name: 'test-mod' })).rejects.toMatchObject({
      code: 'module_confirm_required',
      details: { currentVersion: null, currentStatus: 'customized', targetVersion: 4 },
    });

    const state = await install(workspaceId, principalId, { name: 'test-mod', confirm: true });
    expect(state.installedVersion).toBe(4);
    expect(state.status).toBe('up_to_date');
  });

  it('legacy 300: the version the owner was offered must still be the latest — otherwise nothing is installed (409 version_changed)', async () => {
    const { workspaceId, principalId } = await newWorkspace('modules-reviewed-version');
    await expect(
      install(workspaceId, principalId, { name: 'test-mod', version: 3 }),
    ).rejects.toThrow(ReviewedVersionChangedError);
    const rows = await inWorkspace(workspaceId, principalId, (client) =>
      client.query('select 1 from ontology_versions where workspace_id = $1 and id = $2', [
        workspaceId,
        deriveOntologyPackId('test-mod'),
      ]),
    );
    expect(rows.rows).toHaveLength(0);

    const state = await install(workspaceId, principalId, { name: 'test-mod', version: 4 });
    expect(state).toMatchObject({ installedVersion: 4, status: 'up_to_date' });
  });

  it('D3: a confirm-required error is a ModuleConfirmRequiredError instance', async () => {
    const { workspaceId, principalId } = await newWorkspace('modules-error-instance');
    let caught: unknown;
    try {
      // Fresh install always lands on the latest content directly with no confirm — force a
      // customized state first so the very next call needs confirm.
      const packId = deriveOntologyPackId('test-mod');
      const { publishOntologyVersion } = await import('../../substrate/ontology/index.js');
      await inWorkspace(workspaceId, principalId, (client) =>
        publishOntologyVersion(client, workspaceId, {
          id: packId,
          definition: { objectTypes: [{ name: 'HandEdited2', description: 'd' }], linkTypes: [] },
          principalId,
        }),
      );
      await install(workspaceId, principalId, { name: 'test-mod' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModuleConfirmRequiredError);
  });

  it('countModuleInstallations: installed n / newer m across workspaces, by content hash not DB version', async () => {
    const behind = await newWorkspace('modules-count-behind');
    const current = await newWorkspace('modules-count-current');
    // `behind` ends up on index v1's content, republished twice (DB version 2) — still `outdated`
    // by hash, and must still count toward `newerAvailableCount`.
    const v1 = registry.get('test-mod')?.versions.find((v) => v.version === 1);
    if (!v1) throw new Error('fixture bug: test-mod has no index version 1');
    await inWorkspace(behind.workspaceId, behind.principalId, async (client) => {
      await publishOntologyDomainPack(client, behind.workspaceId, {
        packName: 'test-mod',
        fileName: v1.file,
        dir: fixture.ontologyDir,
        principalId: behind.principalId,
      });
      await publishOntologyDomainPack(client, behind.workspaceId, {
        packName: 'test-mod',
        fileName: v1.file,
        dir: fixture.ontologyDir,
        principalId: behind.principalId,
      });
    });
    await install(current.workspaceId, current.principalId, { name: 'test-mod' }); // lands on the latest directly

    const counts = await withPlatform(pool, { userId: randomUUID() }, (client) =>
      countModuleInstallations(client, [behind.workspaceId, current.workspaceId], registry),
    );
    const testMod = counts.get('test-mod');
    expect(testMod?.installedWorkspaceCount).toBe(2);
    expect(testMod?.newerAvailableCount).toBe(1); // only `behind` (outdated by hash, not by DB version)
  });

  // ---------------------------------------------------------------------------------------
  // D4 (d): create_workspace installs defaultModules at each module's own latest index version,
  // in the same bootstrap transaction, with the new owner Principal as proposed_by/published_by.
  // Uses the real, checked-in ontology/ dir (its own `ops-assets` family, v1 + v2) — createWorkspaceWithOwner
  // also needs platform-meta.yaml / entry-agent.yaml, which the synthetic fixture above does not carry.
  // ---------------------------------------------------------------------------------------

  it('D4: create_workspace installs defaultModules at their latest indexed version for the new owner Principal', async () => {
    const outcome = await createWorkspaceWithOwner(pool, {
      name: `modules-default-${randomUUID().slice(0, 8)}`,
      owner: { displayName: 'Default Modules Owner' },
      defaultModules: ['ops-assets'],
    });

    const row = await withWorkspace(
      pool,
      { workspaceId: outcome.workspaceId, principalId: outcome.ownerPrincipalId },
      (client) =>
        client.query<{
          status: string;
          proposed_by: string;
          published_by: string;
          definition: { objectTypes: { name: string }[] };
        }>(
          `select status, proposed_by, published_by, definition from ontology_versions
            where workspace_id = $1 and id = $2`,
          [outcome.workspaceId, deriveOntologyPackId('ops-assets')],
        ),
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.status).toBe('published');
    expect(row.rows[0]?.proposed_by).toBe(outcome.ownerPrincipalId);
    expect(row.rows[0]?.published_by).toBe(outcome.ownerPrincipalId);
    // ops-assets-v2.yaml (the family's latest indexed version) adds KnowledgeBase/Document over
    // v1 — their presence proves the *latest* version was installed, not v1.
    const objectTypeNames = row.rows[0]?.definition.objectTypes.map((t) => t.name) ?? [];
    expect(objectTypeNames).toContain('KnowledgeBase');
    expect(objectTypeNames).toContain('Document');
  });

  it('D4: create_workspace with no defaultModules installs none', async () => {
    const outcome = await createWorkspaceWithOwner(pool, {
      name: `modules-nodefault-${randomUUID().slice(0, 8)}`,
      owner: { displayName: 'No Default Modules Owner' },
    });
    const row = await withWorkspace(
      pool,
      { workspaceId: outcome.workspaceId, principalId: outcome.ownerPrincipalId },
      (client) =>
        client.query('select 1 from ontology_versions where workspace_id = $1 and id = $2', [
          outcome.workspaceId,
          deriveOntologyPackId('ops-assets'),
        ]),
    );
    expect(row.rowCount).toBe(0);
  });

  // P2 hotfix (post-v0.16.0 review, "default modules drift"): a defaultModules entry naming a
  // module no longer in the deployed index must not hard-fail the whole workspace-creation
  // transaction — it is skipped (reported back via skippedDefaultModules) and every other named
  // module still installs normally.
  it('D4 hotfix: an unknown defaultModules name is skipped, not fatal — the workspace and its other default modules still install', async () => {
    const outcome = await createWorkspaceWithOwner(pool, {
      name: `modules-drift-${randomUUID().slice(0, 8)}`,
      owner: { displayName: 'Drifted Default Modules Owner' },
      defaultModules: ['ops-assets', 'no-such-module-in-the-index'],
    });
    expect(outcome.skippedDefaultModules).toEqual(['no-such-module-in-the-index']);

    const row = await withWorkspace(
      pool,
      { workspaceId: outcome.workspaceId, principalId: outcome.ownerPrincipalId },
      (client) =>
        client.query('select status from ontology_versions where workspace_id = $1 and id = $2', [
          outcome.workspaceId,
          deriveOntologyPackId('ops-assets'),
        ]),
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.status).toBe('published');
  });

  it('D4 hotfix: defaultModules of only unknown names skips every one and still creates the workspace', async () => {
    const outcome = await createWorkspaceWithOwner(pool, {
      name: `modules-all-drifted-${randomUUID().slice(0, 8)}`,
      owner: { displayName: 'All Drifted Owner' },
      defaultModules: ['no-such-module-a', 'no-such-module-b'],
    });
    expect(outcome.skippedDefaultModules).toEqual(['no-such-module-a', 'no-such-module-b']);
    expect(outcome.workspaceId).toBeDefined();
  });

  // S8 W5 (leftover 65): checkDefaultModules is the startup-time guard for platform_settings.
  // defaultModules drifting stale against the deployed module index. platform_settings is a
  // global singleton this DB-gated suite's own module doc comment already flags as shared across
  // every file in a serial run — each test below saves the current value first and restores it in
  // a `finally`, so a failure mid-test never leaves a stale defaultModules for a later file.
  describe('checkDefaultModules (leftover 65)', () => {
    async function withSavedDefaultModules(
      next: readonly string[],
      run: () => Promise<void>,
    ): Promise<void> {
      const before = await withAdminClient(pool, (client) => readPlatformSettings(client));
      await withAdminClient(pool, (client) =>
        updatePlatformSettings(client, { defaultModules: next }, null),
      );
      try {
        await run();
      } finally {
        await withAdminClient(pool, (client) =>
          updatePlatformSettings(client, { defaultModules: before.settings.defaultModules }, null),
        );
      }
    }

    it('warns once, naming every defaultModules entry no longer in the module index — a known name is not listed', async () => {
      await withSavedDefaultModules(['test-mod', 'no-such-module-checkdefault'], async () => {
        const lines: string[] = [];
        const missing = await checkDefaultModules(pool, {
          ...fixture,
          log: (line) => lines.push(line),
        });
        expect(missing).toEqual(['no-such-module-checkdefault']);
        expect(lines).toHaveLength(1);
        const parsed = JSON.parse(lines[0] as string) as { level: string; names: string[] };
        expect(parsed.level).toBe('warn');
        expect(parsed.names).toEqual(['no-such-module-checkdefault']);
      });
    });

    it('every name resolving never warns', async () => {
      await withSavedDefaultModules(['test-mod'], async () => {
        const lines: string[] = [];
        const missing = await checkDefaultModules(pool, {
          ...fixture,
          log: (line) => lines.push(line),
        });
        expect(missing).toEqual([]);
        expect(lines).toEqual([]);
      });
    });

    it('no defaultModules configured never warns and never loads the module registry', async () => {
      await withSavedDefaultModules([], async () => {
        const lines: string[] = [];
        const missing = await checkDefaultModules(pool, {
          // A directory that does not exist: if this were reached, loadModuleRegistry would
          // throw — proving the empty-defaultModules short-circuit never touches the registry.
          packsDir: path.join(fixture.root, 'does-not-exist'),
          log: (line) => lines.push(line),
        });
        expect(missing).toEqual([]);
        expect(lines).toEqual([]);
      });
    });
  });
});
