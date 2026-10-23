import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { OntologyDefinitionParseError } from '../../substrate/ontology/index.js';
import { contentDigest } from '../change-plan/index.js';
import { loadConnectorPresets } from '../gates/index.js';
import {
  type PackFixtureDirs,
  objectTypeYaml,
  skillFile,
  workerFile,
  writePackFixture,
} from './fixture.js';
import { PackManifestError } from './manifest.js';
import {
  PackNotFoundError,
  PackRegistryError,
  type PackVersion,
  WORKSPACE_OWNED_WORKER_FIELDS,
  derivePackComponentId,
  latestPackVersion,
  loadPackRegistry,
  packComponentDigest,
  packComponentKey,
  packOwnedWorkerDigest,
  requirePack,
} from './registry.js';

/** application/packs/registry.test: Pack Contract v1 manifests, their Skill and Worker files, and
 *  the rules across them (S11 P1-C / P1-D), against the real `packs/` and against fixtures that
 *  break one rule each. */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

let fixture: PackFixtureDirs | undefined;
afterEach(async () => {
  if (fixture) await rm(fixture.root, { recursive: true, force: true });
  fixture = undefined;
});

const ONE = (domainPack: string, type = 'Thing') => ({
  ontology: [{ family: 'test-pack', domainPack, yaml: objectTypeYaml(type) }],
});

describe('the packs this repository ships', () => {
  it('ops-assets: two versions, each one ontology component into the ops-assets family', async () => {
    const registry = await loadPackRegistry();
    const pack = requirePack(registry, 'ops-assets');
    expect(pack.versions.map((v) => v.version)).toEqual([1, 2]);
    const ontology = (v: PackVersion) =>
      v.components.flatMap((c) => (c.kind === 'ontology' ? [c] : []));
    expect(pack.versions.map((v) => ontology(v).map((c) => [c.family, c.domainPack]))).toEqual([
      [['ops-assets', 'ops-assets-v1.yaml']],
      [['ops-assets', 'ops-assets-v2.yaml']],
    ]);
    expect(pack.versions.every((v) => v.components.length === 1)).toBe(true);
    const latest = latestPackVersion(pack);
    expect(latest.version).toBe(2);
    expect(latest.breaking).toBe(false);
    expect(latest.summary.length).toBeGreaterThan(0);
    const [component] = ontology(latest);
    expect(component?.definitionDigest).toBe(contentDigest(component?.definition));
    expect(latest.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pack.versions[0]?.digest).not.toBe(latest.digest);
  });

  it('ops-base: its Skill and its Worker, the Worker mounting the Skill with the ops-runner template prompt', async () => {
    const registry = await loadPackRegistry();
    const latest = latestPackVersion(requirePack(registry, 'ops-base'));
    expect(latest.components.map(packComponentKey)).toEqual([
      'skill:docker-triage',
      'worker:ops-runner',
    ]);
    const [skill, worker] = latest.components;
    if (skill?.kind !== 'skill' || worker?.kind !== 'worker') throw new Error('unexpected kinds');
    expect(skill.skillId).toBe(derivePackComponentId('ops-base', 'skill', 'docker-triage'));
    expect(skill.content.markdown).toMatch(/^# Docker container triage/);
    expect(worker.definitionId).toBe(derivePackComponentId('ops-base', 'worker', 'ops-runner'));
    expect(worker.definition).toMatchObject({ name: 'ops-runner', skills: ['docker-triage'] });
    expect(worker.definition).not.toHaveProperty('gates');
    expect(worker.definition).not.toHaveProperty('model');
    expect(worker.definition).not.toHaveProperty('capabilities');
    // The pack's Worker is the ops-runner template's prompt word for word: change both together.
    const template = parseYaml(
      await readFile(path.join(REPO_ROOT, 'ontology', 'ops-runner.yaml'), 'utf8'),
    ) as { systemPrompt: string };
    expect(worker.definition.systemPrompt).toBe(template.systemPrompt);
    // No two packs claim one component, and ops-base is not a module (no ontology component).
    expect(latest.summary.length).toBeGreaterThan(0);
  });

  it('ops-base v2 needs docker (P1-E); v3 has its Worker act on it (P1-E2), the content unchanged', async () => {
    const registry = await loadPackRegistry();
    const pack = requirePack(registry, 'ops-base');
    expect(pack.versions.map((v) => [v.version, v.requiredConnectors])).toEqual([
      [1, []],
      [2, ['docker']],
      [3, ['docker']],
    ]);
    const [v1, v2, v3] = pack.versions;
    expect(v2?.components.map(packComponentDigest)).toEqual(
      v1?.components.map(packComponentDigest),
    );
    expect(v3?.components.map(packComponentDigest)).toEqual(
      v2?.components.map(packComponentDigest),
    );
    const systemsOf = (version: PackVersion | undefined) =>
      version?.components.flatMap((c) => (c.kind === 'worker' ? [[c.name, c.systems]] : []));
    expect(systemsOf(v2)).toEqual([['ops-runner', []]]);
    expect(systemsOf(v3)).toEqual([['ops-runner', ['docker']]]);
    expect([v2?.breaking, v3?.breaking]).toEqual([false, false]);
    expect(new Set([v1?.digest, v2?.digest, v3?.digest]).size).toBe(3);
  });

  it('knowledge v1 (S11 P1-F): a read-only Worker and its Skill on RAGFlow, building on ops-assets v2 for the types RAGFlow’s Operations read and write', async () => {
    const registry = await loadPackRegistry();
    const v1 = latestPackVersion(requirePack(registry, 'knowledge'));
    expect(v1.version).toBe(1);
    expect(v1.requiredConnectors).toEqual(['ragflow']);
    expect(v1.requiredPacks).toEqual([{ name: 'ops-assets', minVersion: 2 }]);
    expect(v1.components.map((c) => [c.kind, c.kind === 'ontology' ? c.family : c.name])).toEqual([
      ['skill', 'kb-retrieval'],
      ['worker', 'knowledge-researcher'],
    ]);
    const worker = v1.components.find((c) => c.kind === 'worker');
    expect(worker?.kind === 'worker' && worker.systems).toEqual(['ragflow']);
    expect(worker?.kind === 'worker' && worker.definition.skills).toEqual(['kb-retrieval']);
    // No capabilities: the platform's default, which never holds an execute-class tool.
    expect(worker?.kind === 'worker' && worker.definition.capabilities).toBeUndefined();

    // Every type the RAGFlow preset's Operations read or write is one the version it builds on
    // declares — the reason it builds on ops-assets v2 rather than publishing them again.
    const opsAssets = requirePack(registry, 'ops-assets').versions[1];
    const declared = new Set(
      opsAssets?.components.flatMap((c) =>
        c.kind === 'ontology' ? (c.definition.objectTypes ?? []).map((type) => type.name) : [],
      ),
    );
    const ragflow = (await loadConnectorPresets()).find((preset) => preset.name === 'ragflow');
    const used = new Set(
      ragflow?.operations.flatMap((operation) => [
        ...(operation.reads ?? []),
        ...(operation.writes ?? []),
      ]),
    );
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((type) => !declared.has(type))).toEqual([]);
  });

  it('what an owner reads (summary, notes, descriptions) has no space between two Chinese characters', async () => {
    // YAML folds a scalar written over several lines with a space where they meet: fine between
    // English words, a stray gap in Chinese (UX acceptance of #679 P3-3).
    const gap =
      /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef] +[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u;
    const registry = await loadPackRegistry();
    const texts = [...registry.values()].flatMap((pack) =>
      pack.versions.flatMap((v) => [
        v.summary,
        v.notes,
        ...v.components.flatMap((c) =>
          c.kind === 'skill'
            ? [c.content.description]
            : c.kind === 'worker'
              ? [c.definition.description ?? '']
              : [],
        ),
      ]),
    );
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((text) => gap.test(text))).toEqual([]);
  });

  it('a pack it does not ship is pack_not_found', async () => {
    const registry = await loadPackRegistry();
    expect(() => requirePack(registry, 'no-such-pack')).toThrow(PackNotFoundError);
  });
});

describe('loadPackRegistry: one rule broken each', () => {
  it('reads a valid fixture, versions ascending', async () => {
    fixture = await writePackFixture({ 'test-pack': [ONE('t-v1.yaml'), ONE('t-v2.yaml', 'T2')] });
    const registry = await loadPackRegistry(fixture);
    expect(requirePack(registry, 'test-pack').versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it('requires.connectors: read in order, and part of the digest', async () => {
    fixture = await writePackFixture({
      'test-pack': [{ ...ONE('t-v1.yaml'), requires: ['docker', 'ragflow'] }],
    });
    const needs = latestPackVersion(requirePack(await loadPackRegistry(fixture), 'test-pack'));
    expect(needs.requiredConnectors).toEqual(['docker', 'ragflow']);
    await rm(fixture.root, { recursive: true, force: true });
    fixture = await writePackFixture({ 'test-pack': [ONE('t-v1.yaml')] });
    const none = latestPackVersion(requirePack(await loadPackRegistry(fixture), 'test-pack'));
    expect(none.requiredConnectors).toEqual([]);
    expect(none.digest).not.toBe(needs.digest);
  });

  it('the digest changes with the notes, not only the content', async () => {
    fixture = await writePackFixture({ 'test-pack': [{ ...ONE('t-v1.yaml'), notes: 'a' }] });
    const a = latestPackVersion(requirePack(await loadPackRegistry(fixture), 'test-pack')).digest;
    await rm(fixture.root, { recursive: true, force: true });
    fixture = await writePackFixture({ 'test-pack': [{ ...ONE('t-v1.yaml'), notes: 'b' }] });
    const b = latestPackVersion(requirePack(await loadPackRegistry(fixture), 'test-pack')).digest;
    expect(a).not.toBe(b);
  });

  it('versions not dense from 1', async () => {
    fixture = await writePackFixture({ 'test-pack': [ONE('t-v1.yaml')] });
    await mkdir(path.join(fixture.packsDir, 'test-pack', '3'));
    await expect(loadPackRegistry(fixture)).rejects.toThrow(/dense from 1/);
  });

  it('a version directory that is not a number', async () => {
    fixture = await writePackFixture({ 'test-pack': [ONE('t-v1.yaml')] });
    await mkdir(path.join(fixture.packsDir, 'test-pack', 'v2'));
    await expect(loadPackRegistry(fixture)).rejects.toThrow(PackRegistryError);
  });

  it('a pack directory that is not a pack name', async () => {
    fixture = await writePackFixture({ 'test-pack': [ONE('t-v1.yaml')] });
    await mkdir(path.join(fixture.packsDir, 'Bad_Name', '1'), { recursive: true });
    await expect(loadPackRegistry(fixture)).rejects.toThrow(/not a pack name/);
  });

  it('a manifest whose name or version is not its directory’s', async () => {
    fixture = await writePackFixture({ 'test-pack': [ONE('t-v1.yaml')] });
    const file = path.join(fixture.packsDir, 'test-pack', '1', 'pack.yaml');
    await writeFile(
      file,
      'schema: 1\nname: other-pack\nversion: 1\nsummary: s\nnotes: n\nbreaking: false\ncomponents:\n  ontology:\n    - family: test-pack\n      domainPack: t-v1.yaml\n',
    );
    await expect(loadPackRegistry(fixture)).rejects.toThrow(/sits at test-pack\/1/);
  });

  it('one family published by two packs', async () => {
    fixture = await writePackFixture({
      'pack-a': [
        { ontology: [{ family: 'shared', domainPack: 'a.yaml', yaml: objectTypeYaml('A') }] },
      ],
      'pack-b': [
        { ontology: [{ family: 'shared', domainPack: 'b.yaml', yaml: objectTypeYaml('B') }] },
      ],
    });
    await expect(loadPackRegistry(fixture)).rejects.toThrow(/belongs to one pack/);
  });

  it('a later version that drops a family an earlier one publishes', async () => {
    fixture = await writePackFixture({
      'test-pack': [
        {
          ontology: [
            { family: 'test-pack', domainPack: 't-v1.yaml', yaml: objectTypeYaml('T1') },
            { family: 'test-extra', domainPack: 'x-v1.yaml', yaml: objectTypeYaml('X1') },
          ],
        },
        ONE('t-v2.yaml', 'T2'),
      ],
    });
    await expect(loadPackRegistry(fixture)).rejects.toThrow(/drops ontology family "test-extra"/);
  });

  it('a domain pack that is missing or does not parse', async () => {
    fixture = await writePackFixture({ 'test-pack': [ONE('t-v1.yaml')] });
    await rm(path.join(fixture.ontologyDir, 't-v1.yaml'));
    await expect(loadPackRegistry(fixture)).rejects.toThrow(OntologyDefinitionParseError);
  });

  it('no packs at all is an empty registry', async () => {
    fixture = await writePackFixture({});
    await mkdir(fixture.packsDir, { recursive: true });
    expect((await loadPackRegistry(fixture)).size).toBe(0);
  });

  it('a packs directory that is not there is a deployment bug', async () => {
    fixture = await writePackFixture({});
    await expect(loadPackRegistry(fixture)).rejects.toThrow(PackRegistryError);
  });
});

describe('parsePackManifest (through the registry): the manifest’s own rules', () => {
  /** Writes `body` as the fixture's only manifest and loads the registry; returns the rejection. */
  async function loadWith(body: string): Promise<unknown> {
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
    fixture = await writePackFixture({ 'test-pack': [ONE('t-v1.yaml')] });
    await writeFile(path.join(fixture.packsDir, 'test-pack', '1', 'pack.yaml'), body);
    return loadPackRegistry(fixture).then(
      () => {
        throw new Error('the registry loaded');
      },
      (err: unknown) => err,
    );
  }
  const head = 'name: test-pack\nversion: 1\nsummary: s\nnotes: n\nbreaking: false\n';
  const ontology =
    'components:\n  ontology:\n    - family: test-pack\n      domainPack: t-v1.yaml\n';

  it('another schema is refused by number', async () => {
    expect(String(await loadWith(`schema: 2\n${head}${ontology}`))).toMatch(
      /schema 2 is not supported/,
    );
  });

  it('a component kind this platform does not implement is refused by name', async () => {
    const err = await loadWith(`schema: 1\n${head}${ontology}  procedures:\n    - x\n`);
    expect(String(err)).toMatch(/"procedures" not supported/);
  });

  it('version 1 cannot be breaking', async () => {
    const err = await loadWith(
      `schema: 1\n${head.replace('breaking: false', 'breaking: true')}${ontology}`,
    );
    expect(String(err)).toMatch(/version 1 cannot be breaking/);
  });

  it('one family twice in a version', async () => {
    const err = await loadWith(
      `schema: 1\n${head}${ontology}    - family: test-pack\n      domainPack: t-v1.yaml\n`,
    );
    expect(String(err)).toMatch(/named twice/);
  });

  it('a domain pack that is a path, or the platform meta-ontology', async () => {
    const asPath = `schema: 1\n${head}${ontology.replace('t-v1.yaml', '../t-v1.yaml')}`;
    expect(await loadWith(asPath)).toBeInstanceOf(PackManifestError);
    const meta = `schema: 1\n${head}${ontology.replace('t-v1.yaml', 'platform-meta.yaml')}`;
    expect(String(await loadWith(meta))).toMatch(/not a domain pack/);
  });

  it('an empty summary, or an unknown field', async () => {
    const blank = `schema: 1\n${head.replace('summary: s', 'summary: " "')}${ontology}`;
    expect(await loadWith(blank)).toBeInstanceOf(PackManifestError);
    expect(await loadWith(`schema: 1\n${head}provides: {}\n${ontology}`)).toBeInstanceOf(
      PackManifestError,
    );
  });

  it('requires.connectors: systems only, each once, at least one', async () => {
    const requires = (lines: string) => `schema: 1\n${head}requires:\n${lines}${ontology}`;
    expect(String(await loadWith(requires('  connectors:\n    - ssh\n')))).toMatch(
      /names a transport/,
    );
    expect(String(await loadWith(requires('  connectors:\n    - docker\n    - docker\n')))).toMatch(
      /requires connector "docker" twice/,
    );
    expect(await loadWith(requires('  connectors: []\n'))).toBeInstanceOf(PackManifestError);
    expect(await loadWith(requires('  connectors:\n    - Docker\n'))).toBeInstanceOf(
      PackManifestError,
    );
    expect(await loadWith(requires('  gates:\n    - docker\n'))).toBeInstanceOf(PackManifestError);
  });

  it('requires.packs (S11 P1-F): a pack name and a version from 1, each pack once, never its own', async () => {
    const requires = (lines: string) => `schema: 1\n${head}requires:\n${lines}${ontology}`;
    expect(
      String(
        await loadWith(
          requires(
            '  packs:\n    - name: base\n      minVersion: 1\n    - name: base\n      minVersion: 2\n',
          ),
        ),
      ),
    ).toMatch(/requires pack "base" twice/);
    expect(
      String(await loadWith(requires('  packs:\n    - name: test-pack\n      minVersion: 1\n'))),
    ).toMatch(/never requires itself/);
    expect(
      await loadWith(requires('  packs:\n    - name: base\n      minVersion: 0\n')),
    ).toBeInstanceOf(PackManifestError);
    expect(await loadWith(requires('  packs:\n    - name: base\n'))).toBeInstanceOf(
      PackManifestError,
    );
    expect(
      await loadWith(requires('  packs:\n    - name: Base\n      minVersion: 1\n')),
    ).toBeInstanceOf(PackManifestError);
    expect(await loadWith(requires('  packs: []\n'))).toBeInstanceOf(PackManifestError);
    expect(String(await loadWith(requires('  {}\n')))).toMatch(/requires names connectors, packs/);
  });
});

describe('requires.packs across the registry (S11 P1-F)', () => {
  const BASE = (type: string) => ({
    ontology: [{ family: 'base', domainPack: `base-${type}.yaml`, yaml: objectTypeYaml(type) }],
  });
  const needs = (name: string, minVersion: number, type = 'Uses') => ({
    ontology: [
      {
        family: `uses-${name}`,
        domainPack: `uses-${name}-${type}.yaml`,
        yaml: objectTypeYaml(type),
      },
    ],
    requiresPacks: [{ name, minVersion }],
  });

  it('reads them in order, and counts them in the digest only when declared', async () => {
    fixture = await writePackFixture({
      base: [BASE('A'), BASE('B')],
      user: [{ ...needs('base', 2), requires: ['docker'] }],
    });
    const registry = await loadPackRegistry(fixture);
    const user = latestPackVersion(requirePack(registry, 'user'));
    expect(user.requiredPacks).toEqual([{ name: 'base', minVersion: 2 }]);
    expect(user.requiredConnectors).toEqual(['docker']);
    expect(latestPackVersion(requirePack(registry, 'base')).requiredPacks).toEqual([]);
    await rm(fixture.root, { recursive: true, force: true });
    fixture = await writePackFixture({
      base: [BASE('A'), BASE('B')],
      user: [{ ...needs('base', 2), requiresPacks: undefined, requires: ['docker'] }],
    });
    const without = latestPackVersion(requirePack(await loadPackRegistry(fixture), 'user'));
    expect(without.requiredPacks).toEqual([]);
    expect(without.digest).not.toBe(user.digest);
  });

  it('a pack this deployment does not ship, or a version it does not reach', async () => {
    fixture = await writePackFixture({ user: [needs('base', 1)] });
    await expect(loadPackRegistry(fixture)).rejects.toThrow(
      /requires pack "base", which this deployment does not ship/,
    );
    await rm(fixture.root, { recursive: true, force: true });
    fixture = await writePackFixture({ base: [BASE('A')], user: [needs('base', 2)] });
    await expect(loadPackRegistry(fixture)).rejects.toThrow(
      /requires pack "base" v2 or later, but it goes up to v1/,
    );
  });

  it('packs requiring each other in a cycle, through any of their versions', async () => {
    // third requires first in its v1 only: its v2 keeps the component and drops the requirement.
    fixture = await writePackFixture({
      first: [needs('second', 1, 'One')],
      second: [needs('third', 1, 'Two')],
      third: [
        needs('first', 1, 'Three'),
        {
          ontology: [
            {
              family: 'uses-first',
              domainPack: 'uses-first-v2.yaml',
              yaml: objectTypeYaml('Three'),
            },
          ],
        },
      ],
    });
    const err = await loadPackRegistry(fixture).then(
      () => {
        throw new Error('the registry loaded');
      },
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(PackRegistryError);
    expect(String(err)).toMatch(/cycle: first → second → third → first/);
  });
});

describe('Skill and Worker files (P1-D)', () => {
  const SKILL = skillFile('fix-it', 'Fix the thing.', '# Fix it\n\nDo the steps.');
  const WORKER = workerFile('fixer', 'You fix things.', 'skills:\n  - fix-it\n');

  async function loadWith(
    version: Parameters<typeof writePackFixture>[0][string][number],
  ): Promise<unknown> {
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
    fixture = await writePackFixture({ kit: [version] });
    return loadPackRegistry(fixture).then(
      () => {
        throw new Error('the registry loaded');
      },
      (err: unknown) => err,
    );
  }

  it('reads them after the ontology components, with family ids derived from pack and name', async () => {
    fixture = await writePackFixture({
      kit: [
        {
          ontology: [{ family: 'kit-core', domainPack: 'k.yaml', yaml: objectTypeYaml('Alpha') }],
          skills: [SKILL],
          workers: [
            workerFile(
              'fixer',
              'You fix things.',
              'skills:\n  - fix-it\negressDeny:\n  - "*.Example.COM"\n',
            ),
          ],
        },
      ],
    });
    const latest = latestPackVersion(requirePack(await loadPackRegistry(fixture), 'kit'));
    expect(latest.components.map(packComponentKey)).toEqual([
      'ontology:kit-core',
      'skill:fix-it',
      'worker:fixer',
    ]);
    const [, skill, worker] = latest.components;
    if (skill?.kind !== 'skill' || worker?.kind !== 'worker') throw new Error('unexpected kinds');
    expect(skill.content).toEqual({
      name: 'fix-it',
      description: 'Fix the thing.',
      markdown: '# Fix it\n\nDo the steps.\n',
      applicable: {},
    });
    expect(skill.contentDigest).toBe(contentDigest(skill.content));
    expect(skill.skillId).toBe(derivePackComponentId('kit', 'skill', 'fix-it'));
    expect(skill.skillId).not.toBe(derivePackComponentId('other', 'skill', 'fix-it'));
    expect(skill.skillId).not.toBe(derivePackComponentId('kit', 'worker', 'fix-it'));
    // The definition as published: named, parsed (an egress entry normalized).
    expect(worker.definition).toEqual({
      name: 'fixer',
      systemPrompt: 'You fix things.',
      skills: ['fix-it'],
      egressDeny: ['example.com'],
    });
    expect(worker.contentDigest).toBe(contentDigest(worker.definition));
  });

  it('a version with no component at all', async () => {
    expect(String(await loadWith({}))).toMatch(/has no components/);
  });

  it('a Skill file without frontmatter, naming another Skill, or with an empty body', async () => {
    expect(String(await loadWith({ skills: [{ name: 'fix-it', text: '# Fix it\n' }] }))).toMatch(
      /frontmatter block/,
    );
    expect(
      String(await loadWith({ skills: [{ ...skillFile('other', 'd', 'body'), name: 'fix-it' }] })),
    ).toMatch(/names Skill "other"/);
    expect(String(await loadWith({ skills: [skillFile('fix-it', 'd', '   ')] }))).toMatch(
      /must not be empty/,
    );
    expect(
      await loadWith({
        skills: [
          { name: 'fix-it', text: '---\nname: fix-it\ndescription: d\nextra: 1\n---\nbody\n' },
        ],
      }),
    ).toBeInstanceOf(PackManifestError);
  });

  it('a Worker file declaring its name, kind, gates or model', async () => {
    for (const [field, line] of [
      ['name', 'name: fixer\n'],
      ['kind', 'kind: worker\n'],
      ['gates', 'gates:\n  - g1\n'],
      ['model', 'model: some-model\n'],
    ] as const) {
      const err = await loadWith({ workers: [workerFile('fixer', 'p', line)] });
      expect(String(err)).toMatch(new RegExp(`declares \`${field}\``));
    }
  });

  it('a Worker’s systems (P1-E2): read beside its content, each one the version requires, named once', async () => {
    fixture = await writePackFixture({
      kit: [
        {
          requires: ['docker', 'ragflow'],
          workers: [workerFile('fixer', 'p', 'systems:\n  - ragflow\n  - docker\n')],
        },
      ],
    });
    const [worker] = latestPackVersion(
      requirePack(await loadPackRegistry(fixture), 'kit'),
    ).components;
    if (worker?.kind !== 'worker') throw new Error('unexpected kind');
    expect(worker.systems).toEqual(['ragflow', 'docker']);
    // Not content: the definition a workspace gets has no `systems`, so its digest is the one a
    // Worker without them has.
    expect(worker.definition).toEqual({ name: 'fixer', systemPrompt: 'p' });
    expect(worker.contentDigest).toBe(contentDigest({ name: 'fixer', systemPrompt: 'p' }));

    expect(
      String(
        await loadWith({
          requires: ['docker'],
          workers: [workerFile('fixer', 'p', 'systems:\n  - ragflow\n')],
        }),
      ),
    ).toMatch(/system\(s\) "ragflow" that the version does not require/);
    expect(
      String(await loadWith({ workers: [workerFile('fixer', 'p', 'systems:\n  - docker\n')] })),
    ).toMatch(/does not require/);
    expect(
      String(
        await loadWith({
          requires: ['docker'],
          workers: [workerFile('fixer', 'p', 'systems:\n  - docker\n  - docker\n')],
        }),
      ),
    ).toMatch(/names system "docker" twice/);
    for (const line of ['systems: []\n', 'systems: docker\n', 'systems:\n  - Not A Name\n']) {
      expect(
        await loadWith({ requires: ['docker'], workers: [workerFile('fixer', 'p', line)] }),
      ).toBeInstanceOf(PackManifestError);
    }
  });

  it('a version’s digest counts a Worker’s systems only when it names some', async () => {
    const digestWith = async (extra: string) => {
      if (fixture) await rm(fixture.root, { recursive: true, force: true });
      fixture = await writePackFixture({
        kit: [{ requires: ['docker'], workers: [workerFile('fixer', 'p', extra)] }],
      });
      return latestPackVersion(requirePack(await loadPackRegistry(fixture), 'kit')).digest;
    };
    const without = await digestWith('');
    const named = await digestWith('systems:\n  - docker\n');
    expect(named).not.toBe(without);
    // A version shipped before `systems` existed keeps its digest: nothing about it changed.
    expect(await digestWith('')).toBe(without);
  });

  it('packOwnedWorkerDigest: the workspace’s gates and model are not the pack’s content', () => {
    const shipped = { name: 'fixer', systemPrompt: 'p', skills: ['fix-it'] };
    expect(packOwnedWorkerDigest(shipped)).toBe(contentDigest(shipped));
    expect(packOwnedWorkerDigest({ ...shipped, gates: ['g1', 'g2'], model: 'a/b' })).toBe(
      contentDigest(shipped),
    );
    expect(packOwnedWorkerDigest({ ...shipped, systemPrompt: 'q', gates: ['g1'] })).not.toBe(
      contentDigest(shipped),
    );
    expect(WORKSPACE_OWNED_WORKER_FIELDS).toEqual(['gates', 'model']);
  });

  it('a Worker mounting a Skill its version does not ship, or declaring a capability beyond the worker ceiling', async () => {
    expect(String(await loadWith({ workers: [WORKER] }))).toMatch(/does not ship/);
    expect(
      String(
        await loadWith({
          workers: [workerFile('fixer', 'p', 'capabilities:\n  - delete_workspace_forever\n')],
        }),
      ),
    ).toMatch(/can never hold: delete_workspace_forever/);
  });

  it('a suspected credential in a Skill or a Worker', async () => {
    const fake = 'abcdefghijklmnopqrstuvwxyz0123';
    expect(
      String(await loadWith({ skills: [skillFile('fix-it', 'd', `export API_TOKEN="${fake}"`)] })),
    ).toMatch(/suspected credential/);
    expect(
      String(await loadWith({ workers: [workerFile('fixer', `export API_TOKEN="${fake}"`)] })),
    ).toMatch(/workers\/fixer\.yaml.*suspected credential/);
  });

  it('one Skill twice in a version', async () => {
    expect(String(await loadWith({ skills: [SKILL, SKILL] }))).toMatch(
      /Skill "fix-it" is named twice/,
    );
  });

  it('one Skill in two packs, and a later version dropping a Worker', async () => {
    fixture = await writePackFixture({
      kit: [{ skills: [SKILL] }],
      other: [{ skills: [SKILL] }],
    });
    await expect(loadPackRegistry(fixture)).rejects.toThrow(
      /Skill "fix-it" is published by both pack "kit" and pack "other"/,
    );
    await rm(fixture.root, { recursive: true, force: true });
    fixture = await writePackFixture({
      kit: [{ skills: [SKILL], workers: [WORKER] }, { skills: [SKILL] }],
    });
    await expect(loadPackRegistry(fixture)).rejects.toThrow(/drops Worker "fixer"/);
  });
});
