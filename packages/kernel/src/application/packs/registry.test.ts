import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { OntologyDefinitionParseError } from '../../substrate/ontology/index.js';
import { contentDigest } from '../change-plan/index.js';
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
  derivePackComponentId,
  latestPackVersion,
  loadPackRegistry,
  packComponentKey,
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
    expect(await loadWith(`schema: 1\n${head}requires: {}\n${ontology}`)).toBeInstanceOf(
      PackManifestError,
    );
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
