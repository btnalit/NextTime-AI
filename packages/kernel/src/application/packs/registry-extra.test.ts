import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moduleRegistryOf } from '../platform/modules.js';
import {
  type PackFixtureDirs,
  type PackFixtureVersion,
  objectTypeYaml,
  skillFile,
  workerFile,
  writePackFixture,
} from './fixture.js';
import {
  PackRegistryError,
  diskPackFiles,
  latestPackVersion,
  loadPackEntry,
  loadPackRegistry,
  memoryPackFiles,
  readPackRegistry,
  requirePack,
} from './registry.js';

/** application/packs/registry-extra.test: the deployment's extra packs (S11 AA5d) — read beside
 *  the image's, each one that breaks a rule left out with the reason (never the whole registry),
 *  never a module; and the in-memory files a pack can be read from. */

const fixtures: PackFixtureDirs[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await rm(fixture.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function packs(
  builtin: Readonly<Record<string, readonly PackFixtureVersion[]>>,
  extra: Readonly<Record<string, readonly PackFixtureVersion[]>>,
): Promise<{ readonly packsDir: string; readonly ontologyDir: string; readonly extraDir: string }> {
  const image = await writePackFixture(builtin);
  const added = await writePackFixture(extra, { extra: true });
  fixtures.push(image, added);
  // Either may have no packs; its directory is still there.
  await mkdir(image.packsDir, { recursive: true });
  await mkdir(added.packsDir, { recursive: true });
  return { packsDir: image.packsDir, ontologyDir: image.ontologyDir, extraDir: added.packsDir };
}

const read = (dirs: Awaited<ReturnType<typeof packs>>) =>
  readPackRegistry({
    packsDir: dirs.packsDir,
    ontologyDir: dirs.ontologyDir,
    extraPacksDir: dirs.extraDir,
  });

const FAMILY = (family: string, domainPack: string, type: string): PackFixtureVersion => ({
  ontology: [{ family, domainPack, yaml: objectTypeYaml(type) }],
});

const BASE = { 'base-pack': [FAMILY('base-pack', 'base.yaml', 'Base')] };

describe('extra packs: read beside the image’s', () => {
  it('an extra pack is read from its own version directory, source extra; the image’s are builtin', async () => {
    const dirs = await packs(BASE, {
      'org-pack': [
        {
          ...FAMILY('org-pack', 'org.yaml', 'Org'),
          skills: [skillFile('org-skill', 'Org skill.', 'Do the org thing.')],
          workers: [
            workerFile('org-worker', 'You are the org worker.', 'skills:\n  - org-skill\n'),
          ],
        },
      ],
    });
    const { registry, skipped, extraPacksDir, extraPacksUnreadable } = await read(dirs);
    expect(skipped).toEqual([]);
    expect(extraPacksUnreadable).toBeNull();
    expect(extraPacksDir).toBe(dirs.extraDir);
    expect(requirePack(registry, 'base-pack').source).toBe('builtin');
    const org = requirePack(registry, 'org-pack');
    expect(org.source).toBe('extra');
    expect(latestPackVersion(org).components.map((component) => component.kind)).toEqual([
      'ontology',
      'skill',
      'worker',
    ]);
    // The image's packs first, then the extra ones.
    expect([...registry.keys()]).toEqual(['base-pack', 'org-pack']);
  });

  it('an extra pack is never a module, even one shaped like one', async () => {
    const dirs = await packs(BASE, { 'org-pack': [FAMILY('org-pack', 'org.yaml', 'Org')] });
    const { registry } = await read(dirs);
    expect([...moduleRegistryOf(registry).keys()]).toEqual(['base-pack']);
  });

  it('an extra pack’s domainPack is its own: one only in the ontology library is not read', async () => {
    const dirs = await packs(BASE, { 'org-pack': [FAMILY('org-pack', 'org.yaml', 'Org')] });
    await rm(path.join(dirs.extraDir, 'org-pack', '1', 'ontology', 'org.yaml'));
    await writeFile(path.join(dirs.ontologyDir, 'org.yaml'), objectTypeYaml('Org'));
    const { registry, skipped } = await read(dirs);
    expect(registry.has('org-pack')).toBe(false);
    expect(skipped).toEqual([{ name: 'org-pack', reason: expect.stringContaining('org.yaml') }]);
  });

  it('no extra packs directory configured: none, nothing skipped', async () => {
    const dirs = await packs(BASE, { 'org-pack': [FAMILY('org-pack', 'org.yaml', 'Org')] });
    const result = await readPackRegistry({
      packsDir: dirs.packsDir,
      ontologyDir: dirs.ontologyDir,
      extraPacksDir: null,
    });
    expect([...result.registry.keys()]).toEqual(['base-pack']);
    expect(result).toMatchObject({ extraPacksDir: null, skipped: [], extraPacksUnreadable: null });
  });

  it('a configured directory that is not there is no extra packs, not an error', async () => {
    const dirs = await packs(BASE, {});
    const result = await readPackRegistry({
      packsDir: dirs.packsDir,
      ontologyDir: dirs.ontologyDir,
      extraPacksDir: path.join(dirs.extraDir, 'missing'),
    });
    expect([...result.registry.keys()]).toEqual(['base-pack']);
    expect(result).toMatchObject({ skipped: [], extraPacksUnreadable: null });
  });

  it('a directory that cannot be read is reported, and the image’s packs still read', async () => {
    const dirs = await packs(BASE, {});
    const file = path.join(path.dirname(dirs.extraDir), 'not-a-directory');
    await writeFile(file, '');
    const result = await readPackRegistry({
      packsDir: dirs.packsDir,
      ontologyDir: dirs.ontologyDir,
      extraPacksDir: file,
    });
    expect([...result.registry.keys()]).toEqual(['base-pack']);
    expect(result.extraPacksUnreadable).toMatch(/ENOTDIR/);
  });

  it('an image pack breaking a rule still refuses the whole registry', async () => {
    const dirs = await packs(BASE, { 'org-pack': [FAMILY('org-pack', 'org.yaml', 'Org')] });
    await rm(path.join(dirs.ontologyDir, 'base.yaml'));
    await expect(read(dirs)).rejects.toThrow();
  });
});

describe('extra packs: one breaking a rule is left out, with the reason', () => {
  it('its own rules: a manifest, a name, versions — the rest still read; a file named under the directory', async () => {
    const dirs = await packs(BASE, {
      'good-pack': [FAMILY('good-pack', 'good.yaml', 'Good')],
      'bad-pack': [FAMILY('bad-pack', 'bad.yaml', 'Bad')],
      'gap-pack': [FAMILY('gap-pack', 'gap.yaml', 'Gap')],
    });
    await writeFile(path.join(dirs.extraDir, 'bad-pack', '1', 'pack.yaml'), 'schema: 1\nname: [\n');
    await mkdir(path.join(dirs.extraDir, 'gap-pack', '3'));
    await mkdir(path.join(dirs.extraDir, 'Bad_Name', '1'), { recursive: true });
    const { registry, skipped } = await read(dirs);
    expect([...registry.keys()]).toEqual(['base-pack', 'good-pack']);
    expect(skipped.map((skip) => skip.name)).toEqual(['Bad_Name', 'bad-pack', 'gap-pack']);
    const reason = (name: string) => skipped.find((skip) => skip.name === name)?.reason ?? '';
    expect(reason('Bad_Name')).toMatch(/not a pack name/);
    expect(reason('bad-pack')).toContain('"bad-pack/1/pack.yaml"');
    expect(reason('gap-pack')).toMatch(/dense from 1/);
    for (const skip of skipped) expect(skip.reason).not.toContain(dirs.extraDir);
  });

  it('a value that looks like a credential is masked in the reason', async () => {
    const token = `gh${'p_'}${'a1B2c3D4'.repeat(4)}`;
    const dirs = await packs(BASE, { 'leaky-pack': [FAMILY('leaky-pack', 'l.yaml', 'Leak')] });
    await writeFile(
      path.join(dirs.extraDir, 'leaky-pack', '1', 'pack.yaml'),
      `schema: 1\nname: leaky-pack\nsummary: [${token}\n`,
    );
    const { skipped } = await read(dirs);
    expect(skipped).toHaveLength(1);
    // The parser's message quotes the line; the value is masked, the rest kept.
    expect(skipped[0]?.reason).toContain('leaky-pack/1/pack.yaml');
    expect(skipped[0]?.reason).toContain('[redacted]');
    expect(skipped[0]?.reason).not.toContain(token);
  });

  it('a manifest the schema refuses: each field to fix as `path: message`, never zod’s issue JSON', async () => {
    const dirs = await packs(BASE, { 'thin-pack': [FAMILY('thin-pack', 't.yaml', 'Thin')] });
    await writeFile(
      path.join(dirs.extraDir, 'thin-pack', '1', 'pack.yaml'),
      'schema: 1\nname: thin-pack\nversion: 1\nnotes: ""\nbreaking: false\n',
    );
    const { skipped } = await read(dirs);
    expect(skipped).toEqual([
      {
        name: 'thin-pack',
        reason:
          'pack manifest "thin-pack/1/pack.yaml": summary: Invalid input: expected string, received undefined; components: Invalid input: expected object, received undefined',
      },
    ]);
  });

  it('a file that is a symbolic link, or sits under one, is refused: a pack’s files are its own', async () => {
    const secret = 'not-for-any-pack: the content of a file outside the packs directory';
    const withSkill = (family: string, type: string): PackFixtureVersion => ({
      ...FAMILY(family, `${family}.yaml`, type),
      skills: [skillFile('linked-skill', 'A Skill.', 'Do it.')],
    });
    const dirs = await packs(BASE, {
      'good-pack': [FAMILY('good-pack', 'good.yaml', 'Good')],
      'file-link-pack': [withSkill('file-link-pack', 'FileLink')],
      'dir-link-pack': [withSkill('dir-link-pack', 'DirLink')],
    });
    const outside = path.join(path.dirname(dirs.extraDir), 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(
      path.join(outside, 'linked-skill.md'),
      `---\nname: linked-skill\ndescription: ${secret}\n---\nbody\n`,
    );
    // A Skill file that is a link to a file outside the directory.
    const fileLink = path.join(dirs.extraDir, 'file-link-pack', '1', 'skills', 'linked-skill.md');
    await rm(fileLink);
    await symlink(path.join(outside, 'linked-skill.md'), fileLink);
    // A Skill directory that is a link to a directory outside it.
    const dirLink = path.join(dirs.extraDir, 'dir-link-pack', '1', 'skills');
    await rm(dirLink, { recursive: true });
    await symlink(outside, dirLink);
    const { registry, skipped } = await read(dirs);
    expect([...registry.keys()]).toEqual(['base-pack', 'good-pack']);
    expect(skipped.map((skip) => skip.name)).toEqual(['dir-link-pack', 'file-link-pack']);
    for (const skip of skipped) {
      expect(skip.reason).toMatch(/symbolic link or under one/);
      expect(skip.reason).not.toContain(secret);
    }
  });

  it('the extra packs directory itself may be reached through a link', async () => {
    const dirs = await packs(BASE, { 'org-pack': [FAMILY('org-pack', 'org.yaml', 'Org')] });
    const linked = path.join(path.dirname(dirs.extraDir), 'linked-packs');
    await symlink(dirs.extraDir, linked);
    const { registry, skipped } = await read({ ...dirs, extraDir: linked });
    expect(skipped).toEqual([]);
    expect(requirePack(registry, 'org-pack').source).toBe('extra');
  });

  it('a long reason is clipped to 2000 characters', async () => {
    const dirs = await packs(BASE, { 'long-pack': [FAMILY('long-pack', 'l.yaml', 'Long')] });
    // Each name breaks the rule for a Skill name: the parser reports every one of them.
    const names = Array.from({ length: 200 }, (_, index) => `Bad_Skill_${index}`);
    await writeFile(
      path.join(dirs.extraDir, 'long-pack', '1', 'pack.yaml'),
      `schema: 1\nname: long-pack\nversion: 1\nsummary: s\ncomponents:\n  skills: [${names.join(', ')}]\n`,
    );
    const { skipped } = await read(dirs);
    expect(skipped.map((skip) => skip.name)).toEqual(['long-pack']);
    const reason = skipped[0]?.reason ?? '';
    expect(reason.startsWith('pack manifest "long-pack/1/pack.yaml"')).toBe(true);
    expect(reason).toHaveLength(2_001);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('a name a pack of the image has', async () => {
    const dirs = await packs(BASE, { 'base-pack': [FAMILY('base-pack', 'other.yaml', 'Other')] });
    const { registry, skipped } = await read(dirs);
    expect(requirePack(registry, 'base-pack').source).toBe('builtin');
    expect(skipped).toEqual([
      { name: 'base-pack', reason: 'a pack named "base-pack" ships with the platform' },
    ]);
  });

  it('a component a pack of the image publishes', async () => {
    const dirs = await packs(BASE, { 'org-pack': [FAMILY('base-pack', 'org.yaml', 'Org')] });
    const { registry, skipped } = await read(dirs);
    expect(registry.has('org-pack')).toBe(false);
    expect(skipped).toEqual([
      {
        name: 'org-pack',
        reason:
          'publishes ontology family "base-pack", which pack "base-pack" that ships with the platform publishes',
      },
    ]);
  });

  it('a component another extra pack publishes too: both are left out', async () => {
    const skill = skillFile('shared-skill', 'Shared.', 'Body.');
    const dirs = await packs(BASE, {
      'one-pack': [{ ...FAMILY('one-pack', 'one.yaml', 'One'), skills: [skill] }],
      'two-pack': [{ ...FAMILY('two-pack', 'two.yaml', 'Two'), skills: [skill] }],
      'third-pack': [FAMILY('third-pack', 'third.yaml', 'Third')],
    });
    const { registry, skipped } = await read(dirs);
    expect([...registry.keys()]).toEqual(['base-pack', 'third-pack']);
    expect(skipped).toEqual([
      {
        name: 'one-pack',
        reason:
          'publishes Skill "shared-skill", which extra pack(s) "two-pack" publish too; a component belongs to one pack',
      },
      {
        name: 'two-pack',
        reason:
          'publishes Skill "shared-skill", which extra pack(s) "one-pack" publish too; a component belongs to one pack',
      },
    ]);
  });

  it('requires: a pack of the image or a kept extra one does; one not here, one left out, or a version too high does not — and that cascades', async () => {
    const needs = (
      family: string,
      requiresPacks: PackFixtureVersion['requiresPacks'],
    ): PackFixtureVersion => ({ ...FAMILY(family, `${family}.yaml`, 'T'), requiresPacks });
    const dirs = await packs(BASE, {
      'on-base': [needs('on-base', [{ name: 'base-pack', minVersion: 1 }])],
      'on-kept': [needs('on-kept', [{ name: 'on-base', minVersion: 1 }])],
      'too-high': [needs('too-high', [{ name: 'base-pack', minVersion: 2 }])],
      'on-missing': [needs('on-missing', [{ name: 'nowhere', minVersion: 1 }])],
      'on-skipped': [needs('on-skipped', [{ name: 'on-missing', minVersion: 1 }])],
      'on-on-skipped': [needs('on-on-skipped', [{ name: 'on-skipped', minVersion: 1 }])],
    });
    const { registry, skipped } = await read(dirs);
    expect([...registry.keys()]).toEqual(['base-pack', 'on-base', 'on-kept']);
    expect(Object.fromEntries(skipped.map((skip) => [skip.name, skip.reason]))).toEqual({
      'on-missing': 'version 1 requires pack "nowhere", which is not here',
      'on-on-skipped': 'version 1 requires pack "on-skipped", which is not here',
      'on-skipped': 'version 1 requires pack "on-missing", which is not here',
      'too-high': 'version 1 requires pack "base-pack" v2 or later, but it goes up to v1',
    });
  });

  it('extra packs requiring each other in a cycle are left out, and so is one requiring them', async () => {
    const needs = (family: string, required: string): PackFixtureVersion => ({
      ...FAMILY(family, `${family}.yaml`, 'T'),
      requiresPacks: [{ name: required, minVersion: 1 }],
    });
    const dirs = await packs(BASE, {
      'loop-a': [needs('loop-a', 'loop-b')],
      'loop-b': [needs('loop-b', 'loop-a')],
      'on-loop': [needs('on-loop', 'loop-a')],
    });
    const { registry, skipped } = await read(dirs);
    expect([...registry.keys()]).toEqual(['base-pack']);
    expect(Object.fromEntries(skipped.map((skip) => [skip.name, skip.reason]))).toEqual({
      'loop-a': 'requires its way back to itself: loop-a → loop-b → loop-a',
      'loop-b': 'requires its way back to itself: loop-a → loop-b → loop-a',
      'on-loop': 'version 1 requires pack "loop-a", which is not here',
    });
  });

  it('loadPackRegistry logs each one left out once per process, and returns the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dirs = await packs(BASE, { 'base-pack': [FAMILY('base-pack', 'o.yaml', 'O')] });
    const options = {
      packsDir: dirs.packsDir,
      ontologyDir: dirs.ontologyDir,
      extraPacksDir: dirs.extraDir,
    };
    expect([...(await loadPackRegistry(options)).keys()]).toEqual(['base-pack']);
    await loadPackRegistry(options);
    const lines = warn.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((line) => line.event === 'extra_pack_skipped');
    expect(lines).toEqual([
      {
        event: 'extra_pack_skipped',
        pack: 'base-pack',
        reason: 'a pack named "base-pack" ships with the platform',
      },
    ]);
  });
});

describe('memoryPackFiles: a pack read from files held in memory', () => {
  async function filesUnder(root: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      files.set(path.relative(root, file).split(path.sep).join('/'), await readFile(file, 'utf8'));
    }
    return files;
  }

  it('reads the same pack, digest and all, as the directory on disk', async () => {
    const v1: PackFixtureVersion = {
      ...FAMILY('org-pack', 'org.yaml', 'Org'),
      skills: [skillFile('org-skill', 'Org skill.', 'Do the org thing.')],
      workers: [workerFile('org-worker', 'You are the org worker.', 'skills:\n  - org-skill\n')],
    };
    const dirs = await packs(BASE, {
      'org-pack': [v1, { ...v1, ...FAMILY('org-pack', 'org-2.yaml', 'Org2'), notes: 'v2' }],
    });
    const root = '/memory';
    const memory = memoryPackFiles(root, await filesUnder(dirs.extraDir));
    expect(await memory.subdirectories(root)).toEqual(['org-pack']);
    const fromMemory = await loadPackEntry(
      memory,
      path.join(root, 'org-pack'),
      'org-pack',
      'extra',
      'version',
    );
    const fromDisk = await loadPackEntry(
      diskPackFiles,
      path.join(dirs.extraDir, 'org-pack'),
      'org-pack',
      'extra',
      'version',
    );
    expect(fromMemory.versions.map((version) => version.digest)).toEqual(
      fromDisk.versions.map((version) => version.digest),
    );
    expect(fromMemory.versions.map((version) => version.version)).toEqual([1, 2]);
  });

  it('hidden directories are left out in memory as on disk: one being unpacked is not a pack', async () => {
    const dirs = await packs(BASE, { 'org-pack': [FAMILY('org-pack', 'org.yaml', 'Org')] });
    // operations.md §14.10 unpacks into `.incoming` under the directory before moving a pack in.
    const incoming = path.join(dirs.extraDir, '.incoming', 'half-pack', '1');
    await mkdir(incoming, { recursive: true });
    await writeFile(path.join(incoming, 'pack.yaml'), 'schema: 1\nname: [\n');
    await mkdir(path.join(dirs.extraDir, 'org-pack', '.draft'));
    await writeFile(path.join(dirs.extraDir, 'org-pack', '.draft', 'pack.yaml'), 'schema: 1\n');
    const { registry, skipped } = await read(dirs);
    expect([...registry.keys()]).toEqual(['base-pack', 'org-pack']);
    expect(skipped).toEqual([]);
    const files = await filesUnder(dirs.extraDir);
    expect(files.has('.incoming/half-pack/1/pack.yaml')).toBe(true);
    const memory = memoryPackFiles('/memory', files);
    expect(await memory.subdirectories('/memory')).toEqual(['org-pack']);
    expect(await memory.subdirectories('/memory')).toEqual(
      await diskPackFiles.subdirectories(dirs.extraDir),
    );
    expect(await memory.subdirectories('/memory/org-pack')).toEqual(['1']);
    expect(await memory.subdirectories('/memory/org-pack')).toEqual(
      await diskPackFiles.subdirectories(path.join(dirs.extraDir, 'org-pack')),
    );
  });

  it('a file or directory that is not there is refused, as on disk', async () => {
    const memory = memoryPackFiles('/memory', new Map([['org-pack/1/pack.yaml', 'schema: 1\n']]));
    await expect(memory.readText('/memory/org-pack/1/skills/a.md')).rejects.toThrow(/ENOENT/);
    await expect(memory.subdirectories('/memory/other')).rejects.toThrow(/ENOENT/);
    expect(await memory.subdirectories('/memory/org-pack')).toEqual(['1']);
    // A file directly in a directory is not one of its subdirectories.
    expect(await memory.subdirectories('/memory/org-pack/1')).toEqual([]);
    await expect(
      loadPackEntry(memory, '/memory/org-pack', 'org-pack', 'extra', 'version'),
    ).rejects.toThrow();
    await expect(
      loadPackEntry(memory, '/memory/other-pack', 'other-pack', 'extra', 'version'),
    ).rejects.toThrow(PackRegistryError);
  });
});
