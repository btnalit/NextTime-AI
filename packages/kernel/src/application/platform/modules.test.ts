import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveOntologyPackId,
  loadOntologyDefinitionFile,
  resolveOntologyDir,
} from '../../substrate/ontology/index.js';
import { contentDigest } from '../change-plan/index.js';
import { type PackFixtureDirs, objectTypeYaml, writePackFixture } from '../packs/fixture.js';
import { PackRegistryError, loadPackRegistry } from '../packs/index.js';
import {
  ModuleNotFoundError,
  classifyModuleState,
  installOrUpgradeModule,
  isModulePack,
  loadModuleRegistry,
  moduleRegistryOf,
  requireModule,
} from './modules.js';

/**
 * application/platform/modules.test: pure, no-DB coverage (the module registry read from the
 * deployment's packs, which packs are modules, and `classifyModuleState`'s four-way split, D2) —
 * same split `substrate/ontology/loader.test.ts` already uses between its own pure describe blocks
 * and its DB-gated `describe.runIf` one. The pack rules themselves are `application/packs/
 * registry.test.ts`. DB-dependent coverage (`installOrUpgradeModule`'s D3 branches,
 * `countModuleInstallations`, `create_workspace`'s default-module install) is
 * `modules.integration.test.ts`.
 */

describe('loadModuleRegistry — the packs this deployment ships', () => {
  it('ops-assets is a module: versions 1 and 2, neither breaking, each its domain pack', async () => {
    const entry = requireModule(await loadModuleRegistry(), 'ops-assets');
    expect(entry.versions.map((v) => [v.version, v.file, v.breaking])).toEqual([
      [1, 'ops-assets-v1.yaml', false],
      [2, 'ops-assets-v2.yaml', false],
    ]);
  });

  it('platform-meta / entry-agent / ops-runner are not modules (D1)', async () => {
    const names = [...(await loadModuleRegistry()).keys()];
    expect(names).not.toContain('platform-meta');
    expect(names).not.toContain('entry-agent');
    expect(names).not.toContain('ops-runner');
  });

  it('each version carries its definition digest, v1 ≠ v2, recomputable from the file (D2)', async () => {
    const entry = requireModule(await loadModuleRegistry(), 'ops-assets');
    const [v1, v2] = entry.versions;
    expect(v1?.definitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(v1?.definitionDigest).not.toBe(v2?.definitionDigest);
    // Never a stored value the registry could drift from: the file's own content, digested now.
    const definition = await loadOntologyDefinitionFile(
      path.join(resolveOntologyDir(), 'ops-assets-v1.yaml'),
    );
    expect(contentDigest(definition)).toBe(v1?.definitionDigest);
  });
});

describe('isModulePack / moduleRegistryOf', () => {
  let fixture: PackFixtureDirs | undefined;
  afterEach(async () => {
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
    fixture = undefined;
  });

  it('a module is a pack whose every version publishes only the family named after it', async () => {
    fixture = await writePackFixture({
      'one-mod': [
        { ontology: [{ family: 'one-mod', domainPack: 'm.yaml', yaml: objectTypeYaml('M') }] },
      ],
      'two-parts': [
        {
          ontology: [
            { family: 'two-parts', domainPack: 'a.yaml', yaml: objectTypeYaml('A') },
            { family: 'two-parts-extra', domainPack: 'b.yaml', yaml: objectTypeYaml('B') },
          ],
        },
      ],
      'other-name': [
        { ontology: [{ family: 'not-the-name', domainPack: 'c.yaml', yaml: objectTypeYaml('C') }] },
      ],
    });
    const packs = await loadPackRegistry(fixture);
    expect([...packs.values()].map((pack) => [pack.name, isModulePack(pack)])).toEqual([
      ['one-mod', true],
      ['other-name', false],
      ['two-parts', false],
    ]);
    expect([...moduleRegistryOf(packs).keys()]).toEqual(['one-mod']);
  });

  it('refuses a module that requires other packs: install_module would not check them (P1-F)', async () => {
    fixture = await writePackFixture({
      base: [{ ontology: [{ family: 'base', domainPack: 'b.yaml', yaml: objectTypeYaml('B') }] }],
      'needs-base': [
        { ontology: [{ family: 'needs-base', domainPack: 'n.yaml', yaml: objectTypeYaml('N') }] },
        {
          ontology: [{ family: 'needs-base', domainPack: 'n.yaml', yaml: objectTypeYaml('N') }],
          requiresPacks: [{ name: 'base', minVersion: 1 }],
        },
      ],
    });
    const packs = await loadPackRegistry(fixture);
    expect(() => moduleRegistryOf(packs)).toThrow(PackRegistryError);
    expect(() => moduleRegistryOf(packs)).toThrow(
      'packs/needs-base/2: a module cannot require other packs',
    );
  });
});

describe('requireModule / ModuleNotFoundError', () => {
  it('throws for an unknown module name', async () => {
    const registry = await loadModuleRegistry();
    expect(() => requireModule(registry, 'no-such-module')).toThrow(ModuleNotFoundError);
  });
});

// -------------------------------------------------------------------------------------------
// classifyModuleState — pure, the four-way split (D2).
// -------------------------------------------------------------------------------------------

describe('classifyModuleState', () => {
  const version = (v: number, digest: string) => ({
    version: v,
    file: `v${v}.yaml`,
    notes: '',
    breaking: false,
    definitionDigest: digest,
  });
  // `classifyModuleState` reads the versions only; the pack behind them is not consulted.
  const entry = {
    name: 'test-mod',
    versions: [version(1, 'digest-v1'), version(2, 'digest-v2')],
    pack: { name: 'test-mod', versions: [] },
  };

  it('not_installed when no row exists', () => {
    const state = classifyModuleState(entry, null);
    expect(state).toEqual({ entry, installedVersion: null, status: 'not_installed' });
  });

  it('up_to_date when the installed digest matches the latest version', () => {
    const state = classifyModuleState(entry, 'digest-v2');
    expect(state.status).toBe('up_to_date');
    expect(state.installedVersion).toBe(2);
  });

  it('outdated when the installed digest matches an older version', () => {
    const state = classifyModuleState(entry, 'digest-v1');
    expect(state.status).toBe('outdated');
    expect(state.installedVersion).toBe(1);
  });

  it('customized when the installed digest matches no known version — installedVersion is null, not the raw row number', () => {
    const state = classifyModuleState(entry, 'digest-hand-edited');
    expect(state.status).toBe('customized');
    expect(state.installedVersion).toBeNull();
  });

  it('two versions with identical content: matching the latest is up_to_date, not outdated', () => {
    const same = { ...entry, versions: [version(1, 'digest-same'), version(2, 'digest-same')] };
    expect(classifyModuleState(same, 'digest-same')).toMatchObject({
      status: 'up_to_date',
      installedVersion: 2,
    });
  });
});

// -------------------------------------------------------------------------------------------
// installOrUpgradeModule — advisory-lock ordering (P2 hotfix, post-v0.16.0 review "module install
// race"; S11 P1: the family lock every publisher of the family shares). Fake-PoolClient, no real DB:
// the fake answers the lock queries and then throws on whatever query comes next, deliberately
// short-circuiting before the family's head is read or the ChangePlan apply's own
// multi-query write path — those stay covered by `modules.integration.test.ts` (DB-gated). This test
// only asserts the locks are issued, and issued *first*, which needs no real Postgres to observe.
// -------------------------------------------------------------------------------------------

describe('installOrUpgradeModule — advisory locks (P2 hotfix, module install race)', () => {
  it('takes the namespace lock, then the family lock, before reading installed state', async () => {
    const workspaceId = 'ws-1';
    const principalId = 'principal-1';
    const packId = deriveOntologyPackId('ops-assets');
    const registry = await loadModuleRegistry();
    const calls: { text: string; params: unknown[] }[] = [];
    const client = {
      query: async (text: string, params: unknown[] = []) => {
        calls.push({ text, params });
        if (calls.length <= 2) return { rows: [], rowCount: 0 }; // the two advisory locks
        // Anything past the locks is out of this unit test's scope — stop deterministically
        // rather than simulating the real DB reads and writes.
        throw new Error('stop-after-lock: this unit test only asserts lock-first ordering');
      },
    } as unknown as PoolClient;

    await expect(
      installOrUpgradeModule(client, workspaceId, principalId, registry, {
        name: 'ops-assets',
        channel: 'human',
      }),
    ).rejects.toThrow('stop-after-lock');

    expect(calls).toHaveLength(3);
    expect(calls[0]?.text.toLowerCase()).toContain('pg_advisory_xact_lock');
    expect(calls[0]?.params).toEqual([`ontology_namespace:${workspaceId}`]);
    expect(calls[1]?.text.toLowerCase()).toContain('pg_advisory_xact_lock');
    expect(calls[1]?.params).toEqual([`ontology_family:${workspaceId}:${packId}`]);
    expect(calls[2]?.text.toLowerCase()).toContain('from ontology_versions');
  });
});
