import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadOntologyDefinitionFile, resolveOntologyDir } from './loader.js';
import { OntologyDefinitionParseError, parseOntologyDefinition } from './schema.js';

/**
 * substrate/ontology/schema.test: S3.1's own additions to `OntologyDefinitionSchema` —
 * `identityKey` (ObjectType) and `actionTypes` (ActionType) — plus a structural load of the real
 * `ontology/ops-assets-v1.yaml` this task ships (mirrors `loader.test.ts`'s own
 * `platform-meta.yaml` load test).
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

describe('OntologyDefinitionSchema — S3.1 additions', () => {
  it('accepts an ObjectType with identityKey', () => {
    const definition = parseOntologyDefinition(`
objectTypes:
  - name: Thing
    description: A thing.
    identityKey: [hostId, name]
linkTypes:
  - name: relates_to
    domain: Thing
    range: "*"
    description: d
`);
    expect(definition.objectTypes[0]?.identityKey).toEqual(['hostId', 'name']);
  });

  it('still accepts an ObjectType with no identityKey (backward compatible)', () => {
    const definition = parseOntologyDefinition(`
objectTypes:
  - name: Thing
    description: A thing.
linkTypes:
  - name: relates_to
    domain: Thing
    range: "*"
    description: d
`);
    expect(definition.objectTypes[0]?.identityKey).toBeUndefined();
  });

  it('rejects an empty identityKey array', () => {
    expect(() =>
      parseOntologyDefinition(`
objectTypes:
  - name: Thing
    description: A thing.
    identityKey: []
linkTypes:
  - name: relates_to
    domain: Thing
    range: "*"
    description: d
`),
    ).toThrow(OntologyDefinitionParseError);
  });

  it('accepts an ActionType with mode/blastRadius metadata', () => {
    const definition = parseOntologyDefinition(`
objectTypes:
  - name: Thing
    description: A thing.
linkTypes:
  - name: relates_to
    domain: Thing
    range: "*"
    description: d
actionTypes:
  - name: restart
    description: Restart a Thing.
    mode: execute
    blastRadius: medium
    reversibility: true
    autoApprovable: false
`);
    expect(definition.actionTypes).toEqual([
      {
        name: 'restart',
        description: 'Restart a Thing.',
        mode: 'execute',
        blastRadius: 'medium',
        reversibility: true,
        autoApprovable: false,
      },
    ]);
  });

  it('still accepts a definition with no actionTypes at all (backward compatible)', () => {
    const definition = parseOntologyDefinition(`
objectTypes:
  - name: Thing
    description: A thing.
linkTypes:
  - name: relates_to
    domain: Thing
    range: "*"
    description: d
`);
    expect(definition.actionTypes).toBeUndefined();
  });

  it('rejects an ActionType with an invalid mode', () => {
    expect(() =>
      parseOntologyDefinition(`
objectTypes:
  - name: Thing
    description: A thing.
linkTypes:
  - name: relates_to
    domain: Thing
    range: "*"
    description: d
actionTypes:
  - name: restart
    description: d
    mode: sideways
    blastRadius: low
`),
    ).toThrow(OntologyDefinitionParseError);
  });
});

describe('ontology/ops-assets-v1.yaml', () => {
  it('honors ONTOLOGY_DIR resolution the same as every other ontology/*.yaml file', () => {
    expect(path.resolve(resolveOntologyDir({}))).toBe(path.resolve(ONTOLOGY_DIR));
  });

  it('loads and validates against OntologyDefinitionSchema, with every S3.1-required type present', async () => {
    const definition = await loadOntologyDefinitionFile(
      path.join(ONTOLOGY_DIR, 'ops-assets-v1.yaml'),
    );

    const objectTypeNames = definition.objectTypes.map((t) => t.name).sort();
    expect(objectTypeNames).toEqual(
      [
        'Host',
        'ComposeProject',
        'Container',
        'Image',
        'SystemdService',
        'Process',
        'Volume',
        'Network',
        'Endpoint',
        'Repository',
        'Owner',
      ].sort(),
    );

    // Deliverable 2: every ObjectType carries an identityKey.
    for (const objectType of definition.objectTypes) {
      expect(objectType.identityKey?.length, `${objectType.name} identityKey`).toBeGreaterThan(0);
    }

    const linkTypeNames = new Set(definition.linkTypes.map((t) => t.name));
    expect([...linkTypeNames].sort()).toEqual(
      [
        'runs_on',
        'part_of',
        'uses_image',
        'mounts',
        'attached_to',
        'exposes',
        'depends_on',
        'built_from',
        'owned_by',
        'spawned_by',
      ].sort(),
    );

    // I2: every domain/range names a real ObjectType from this same file (no "*" used here — see
    // the file's own header comment on why exact pairs are preferred over a wildcard).
    const objectTypeNameSet = new Set(objectTypeNames);
    for (const linkType of definition.linkTypes) {
      expect(objectTypeNameSet.has(linkType.domain), `${linkType.name} domain`).toBe(true);
      expect(objectTypeNameSet.has(linkType.range), `${linkType.name} range`).toBe(true);
    }

    // Deliverable 2's own design choice: no ActionTypes declared (see the file's own header
    // comment on why an infra-facts domain pack carries none at v1).
    expect(definition.actionTypes).toBeUndefined();

    // Design-doc-fixed identity keys (docs/development-tasks.md S3.1), verbatim.
    const byName = new Map(definition.objectTypes.map((t) => [t.name, t]));
    expect(byName.get('Container')?.identityKey).toEqual(['composeProjectId', 'serviceName']);
    expect(byName.get('Image')?.identityKey).toEqual(['digest']);
    expect(byName.get('Repository')?.identityKey).toEqual(['remoteUrl']);
    expect(byName.get('Process')?.identityKey).toEqual([
      'executablePath',
      'workingDirectory',
      'parentPid',
    ]);
  });
});
