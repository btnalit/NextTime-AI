import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * application/packs/fixture: test support — writes packs (Pack Contract v1) and the domain packs
 * they name into a fresh temporary directory, laid out as the image lays them out (`packs/`,
 * `ontology/`). Not used by any production path.
 */

export interface PackFixtureComponent {
  readonly family: string;
  readonly domainPack: string;
  /** The domain pack file's YAML (an `OntologyDefinition`). */
  readonly yaml: string;
}

export interface PackFixtureVersion {
  readonly summary?: string;
  readonly notes?: string;
  readonly breaking?: boolean;
  readonly ontology: readonly PackFixtureComponent[];
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
      const components = version.ontology
        .map((c) => `    - family: ${c.family}\n      domainPack: ${c.domainPack}\n`)
        .join('');
      await writeFile(
        path.join(dir, 'pack.yaml'),
        `schema: 1\nname: ${name}\nversion: ${index + 1}\nsummary: ${JSON.stringify(version.summary ?? `${name} pack`)}\nnotes: ${JSON.stringify(version.notes ?? `v${index + 1}`)}\nbreaking: ${version.breaking ?? false}\ncomponents:\n  ontology:\n${components}`,
      );
      for (const component of version.ontology) {
        await writeFile(path.join(ontologyDir, component.domainPack), component.yaml);
      }
    }
  }
  return { root, packsDir, ontologyDir };
}
