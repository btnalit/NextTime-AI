import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * application/packs/fixture: test support — writes packs (Pack Contract v1) and the domain packs
 * they name into a fresh temporary directory, laid out as the image lays them out (`packs/`,
 * `ontology/`), with each version's Skill and Worker files beside its manifest. Not used by any
 * production path.
 */

export interface PackFixtureComponent {
  readonly family: string;
  readonly domainPack: string;
  /** The domain pack file's YAML (an `OntologyDefinition`). */
  readonly yaml: string;
}

/** A Skill file: `skills/<name>.md`, written as given (frontmatter and body). */
export interface PackFixtureFile {
  readonly name: string;
  readonly text: string;
}

export interface PackFixtureVersion {
  readonly summary?: string;
  readonly notes?: string;
  readonly breaking?: boolean;
  /** `requires.connectors`. */
  readonly requires?: readonly string[];
  readonly ontology?: readonly PackFixtureComponent[];
  /** `skills/<name>.md`. */
  readonly skills?: readonly PackFixtureFile[];
  /** `workers/<name>.yaml`. */
  readonly workers?: readonly PackFixtureFile[];
}

export interface PackFixtureDirs {
  /** Remove this when done. */
  readonly root: string;
  readonly packsDir: string;
  readonly ontologyDir: string;
}

/** A minimal domain pack declaring one ObjectType `name` (and the one LinkType the schema needs). */
export function objectTypeYaml(name: string): string {
  return `objectTypes:\n  - name: ${name}\n    description: d\nlinkTypes:\n  - name: relates_to\n    domain: ${name}\n    range: "*"\n    description: d\n`;
}

/** A Skill file with this frontmatter and body. */
export function skillFile(name: string, description: string, body: string): PackFixtureFile {
  return {
    name,
    text: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`,
  };
}

/** A Worker file with this system prompt (and any further YAML lines). */
export function workerFile(name: string, systemPrompt: string, extra = ''): PackFixtureFile {
  return { name, text: `systemPrompt: ${JSON.stringify(systemPrompt)}\n${extra}` };
}

/** `packs[name]` lists its versions in order (version 1 first). */
export async function writePackFixture(
  packs: Readonly<Record<string, readonly PackFixtureVersion[]>>,
): Promise<PackFixtureDirs> {
  const root = await mkdtemp(path.join(tmpdir(), 'nexttime-packs-fixture-'));
  const packsDir = path.join(root, 'packs');
  const ontologyDir = path.join(root, 'ontology');
  await mkdir(ontologyDir, { recursive: true });
  for (const [name, versions] of Object.entries(packs)) {
    for (const [index, version] of versions.entries()) {
      const dir = path.join(packsDir, name, String(index + 1));
      await mkdir(dir, { recursive: true });
      const ontology = version.ontology ?? [];
      const skills = version.skills ?? [];
      const workers = version.workers ?? [];
      const list = (key: string, names: readonly string[]) =>
        names.length > 0 ? `  ${key}:\n${names.map((n) => `    - ${n}\n`).join('')}` : '';
      const components = [
        ontology.length > 0
          ? `  ontology:\n${ontology
              .map((c) => `    - family: ${c.family}\n      domainPack: ${c.domainPack}\n`)
              .join('')}`
          : '',
        list(
          'skills',
          skills.map((f) => f.name),
        ),
        list(
          'workers',
          workers.map((f) => f.name),
        ),
      ].join('');
      const requires = version.requires
        ? `requires:\n  connectors:\n${version.requires.map((c) => `    - ${c}\n`).join('')}`
        : '';
      await writeFile(
        path.join(dir, 'pack.yaml'),
        `schema: 1\nname: ${name}\nversion: ${index + 1}\nsummary: ${JSON.stringify(version.summary ?? `${name} pack`)}\nnotes: ${JSON.stringify(version.notes ?? `v${index + 1}`)}\nbreaking: ${version.breaking ?? false}\n${requires}components:${components === '' ? ' {}\n' : `\n${components}`}`,
      );
      for (const component of ontology) {
        await writeFile(path.join(ontologyDir, component.domainPack), component.yaml);
      }
      for (const [sub, files, ext] of [
        ['skills', skills, 'md'],
        ['workers', workers, 'yaml'],
      ] as const) {
        if (files.length === 0) continue;
        await mkdir(path.join(dir, sub), { recursive: true });
        for (const file of files) {
          await writeFile(path.join(dir, sub, `${file.name}.${ext}`), file.text);
        }
      }
    }
  }
  return { root, packsDir, ontologyDir };
}
