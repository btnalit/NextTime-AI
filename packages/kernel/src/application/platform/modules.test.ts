import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ModuleIndexParseError,
  ModuleNotFoundError,
  classifyModuleState,
  hashOntologyDefinition,
  loadModuleRegistry,
  readModulesIndexFile,
  requireModule,
} from './modules.js';

/**
 * application/platform/modules.test: pure, no-DB coverage (D2's hashing/canonicalization, the
 * module-index loader, and `classifyModuleState`'s four-way split) — same split `substrate/
 * ontology/loader.test.ts` already uses between its own pure describe blocks and its DB-gated
 * `describe.runIf` one. DB-dependent coverage (`installOrUpgradeModule`'s D3 branches,
 * `countModuleInstallations`, `create_workspace`'s default-module install) is
 * `modules.integration.test.ts`.
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

describe('hashOntologyDefinition', () => {
  it('is stable regardless of object key order', () => {
    const a = hashOntologyDefinition({
      objectTypes: [{ name: 'Thing', description: 'd', identityKey: ['x'] }],
      linkTypes: [],
    });
    const b = hashOntologyDefinition({
      objectTypes: [{ identityKey: ['x'], description: 'd', name: 'Thing' }],
      linkTypes: [],
    });
    expect(a).toBe(b);
  });

  it('differs when content actually differs', () => {
    const a = hashOntologyDefinition({
      objectTypes: [{ name: 'Thing', description: 'd' }],
      linkTypes: [],
    });
    const b = hashOntologyDefinition({
      objectTypes: [{ name: 'OtherThing', description: 'd' }],
      linkTypes: [],
    });
    expect(a).not.toBe(b);
  });

  it('produces a 64-char hex sha256 digest', () => {
    const hash = hashOntologyDefinition({ objectTypes: [], linkTypes: [] });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('readModulesIndexFile / loadModuleRegistry — the real ontology/modules.yaml', () => {
  it('parses the checked-in index and finds the ops-assets family', async () => {
    const index = await readModulesIndexFile(ONTOLOGY_DIR);
    const opsAssets = index.find((entry) => entry.name === 'ops-assets');
    expect(opsAssets).toBeDefined();
    expect(opsAssets?.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(opsAssets?.versions.every((v) => v.breaking === false)).toBe(true);
  });

  it('platform-meta / entry-agent / ops-runner are not modules (D1)', async () => {
    const index = await readModulesIndexFile(ONTOLOGY_DIR);
    const names = index.map((entry) => entry.name);
    expect(names).not.toContain('platform-meta');
    expect(names).not.toContain('entry-agent');
    expect(names).not.toContain('ops-runner');
  });

  it('loadModuleRegistry hashes each version against the real files, v1 ≠ v2', async () => {
    const registry = await loadModuleRegistry(ONTOLOGY_DIR);
    const entry = requireModule(registry, 'ops-assets');
    expect(entry.versions).toHaveLength(2);
    const [v1, v2] = entry.versions;
    expect(v1?.hash).toBeDefined();
    expect(v2?.hash).toBeDefined();
    expect(v1?.hash).not.toBe(v2?.hash);
    // Re-hashing the same file content independently must agree with the registry's own hash
    // (D2: "recomputed ... on every call" — never a stored/cached value the registry could drift
    // from).
    const { loadOntologyDefinitionFile } = await import('../../substrate/ontology/index.js');
    const definition = await loadOntologyDefinitionFile(
      path.join(ONTOLOGY_DIR, 'ops-assets-v1.yaml'),
    );
    expect(hashOntologyDefinition(definition)).toBe(v1?.hash);
  });
});

describe('requireModule / ModuleNotFoundError', () => {
  it('throws for an unknown module name', async () => {
    const registry = await loadModuleRegistry(ONTOLOGY_DIR);
    expect(() => requireModule(registry, 'no-such-module')).toThrow(ModuleNotFoundError);
  });
});

// -------------------------------------------------------------------------------------------
// index validation (dense-from-1) — a temp directory with a deliberately broken index.
// -------------------------------------------------------------------------------------------

describe('readModulesIndexFile — dense-from-1 validation', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('rejects a version list with a gap', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'nexttime-modules-test-'));
    await writeFile(
      path.join(dir, 'modules.yaml'),
      `modules:
  - name: gappy
    versions:
      - file: gappy-v1.yaml
        version: 1
        notes: v1
        breaking: false
      - file: gappy-v3.yaml
        version: 3
        notes: v3
        breaking: false
`,
    );
    await expect(readModulesIndexFile(dir)).rejects.toThrow(ModuleIndexParseError);
  });

  it('accepts a dense, out-of-order version list', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'nexttime-modules-test-'));
    await writeFile(
      path.join(dir, 'modules.yaml'),
      `modules:
  - name: dense
    versions:
      - file: dense-v2.yaml
        version: 2
        notes: v2
        breaking: false
      - file: dense-v1.yaml
        version: 1
        notes: v1
        breaking: false
`,
    );
    const index = await readModulesIndexFile(dir);
    expect(index[0]?.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('throws ModuleIndexParseError when modules.yaml is missing', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'nexttime-modules-test-'));
    await expect(readModulesIndexFile(dir)).rejects.toThrow(ModuleIndexParseError);
  });
});

// -------------------------------------------------------------------------------------------
// classifyModuleState — pure, the four-way split (D2).
// -------------------------------------------------------------------------------------------

describe('classifyModuleState', () => {
  const entry = {
    name: 'test-mod',
    versions: [
      { version: 1, file: 'v1.yaml', notes: '', breaking: false, hash: 'hash-v1' },
      { version: 2, file: 'v2.yaml', notes: '', breaking: false, hash: 'hash-v2' },
    ],
  };

  it('not_installed when no row exists', () => {
    const state = classifyModuleState(entry, null);
    expect(state).toEqual({ entry, installedVersion: null, status: 'not_installed' });
  });

  it('up_to_date when the installed hash matches the latest version', () => {
    const state = classifyModuleState(entry, 'hash-v2');
    expect(state.status).toBe('up_to_date');
    expect(state.installedVersion).toBe(2);
  });

  it('outdated when the installed hash matches an older version', () => {
    const state = classifyModuleState(entry, 'hash-v1');
    expect(state.status).toBe('outdated');
    expect(state.installedVersion).toBe(1);
  });

  it("customized when the installed hash matches no known version — installedVersion is null, not the raw hash-owner's row number", () => {
    const state = classifyModuleState(entry, 'hash-hand-edited');
    expect(state.status).toBe('customized');
    expect(state.installedVersion).toBeNull();
  });
});
