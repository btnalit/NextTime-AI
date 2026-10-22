import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OntologyDefinitionParseError } from '../../substrate/ontology/index.js';
import { contentDigest } from '../change-plan/index.js';
import { type PackFixtureDirs, objectTypeYaml, writePackFixture } from './fixture.js';
import { PackManifestError } from './manifest.js';
import {
  PackNotFoundError,
  PackRegistryError,
  latestPackVersion,
  loadPackRegistry,
  requirePack,
} from './registry.js';

/** application/packs/registry.test: Pack Contract v1 manifests and the rules across them (S11
 *  P1-C), against the real `packs/` and against fixtures that break one rule each. */

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
    expect(pack.versions.map((v) => v.components.map((c) => [c.family, c.domainPack]))).toEqual([
      [['ops-assets', 'ops-assets-v1.yaml']],
      [['ops-assets', 'ops-assets-v2.yaml']],
    ]);
    const latest = latestPackVersion(pack);
    expect(latest.version).toBe(2);
    expect(latest.breaking).toBe(false);
    expect(latest.summary.length).toBeGreaterThan(0);
    expect(latest.components[0]?.definitionDigest).toBe(
      contentDigest(latest.components[0]?.definition),
    );
    expect(latest.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pack.versions[0]?.digest).not.toBe(latest.digest);
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
    const err = await loadWith(`schema: 1\n${head}${ontology}  skills:\n    - skills/x/\n`);
    expect(String(err)).toMatch(/"skills" not supported/);
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
