import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadOntologyDefinitionFile } from './loader.js';
import {
  type LinkTypeSignature,
  MAX_DECLARED_BETWEEN,
  declaredBetween,
  evaluateLink,
} from './registry.js';
import type { ObjectTypeDefinition, OntologyDefinition } from './schema.js';
import {
  MAX_VOCABULARY_LINK_TYPES,
  MAX_VOCABULARY_OBJECT_TYPES,
  typesTouchedBy,
  workerVocabulary,
} from './vocabulary.js';

/**
 * Legacy 968: the vocabulary `get_task` hands a Task's own Worker (vocabulary.ts), and what a
 * refusal of an undeclared LinkType names instead (`declaredBetween`). Pure — the two ontology
 * files every workspace with the ops packs publishes, merged as `loadPublishedOntology` merges
 * families.
 */

const ONTOLOGY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'ontology',
);

function merged(definitions: readonly OntologyDefinition[]) {
  const objectTypes = new Map<string, ObjectTypeDefinition>();
  const linkTypes = new Map<string, LinkTypeSignature[]>();
  for (const definition of definitions) {
    for (const objectType of definition.objectTypes) objectTypes.set(objectType.name, objectType);
    for (const { name, domain, range, description } of definition.linkTypes) {
      linkTypes.set(name, [...(linkTypes.get(name) ?? []), { domain, range, description }]);
    }
  }
  return { objectTypes, linkTypes };
}

async function publishedOpsOntology() {
  return merged([
    await loadOntologyDefinitionFile(path.join(ONTOLOGY_DIR, 'platform-meta.yaml')),
    await loadOntologyDefinitionFile(path.join(ONTOLOGY_DIR, 'ops-assets-v2.yaml')),
  ]);
}

const signature = (domain: string, range: string): LinkTypeSignature => ({
  domain,
  range,
  description: 'd',
});

describe('workerVocabulary (legacy 968)', () => {
  it('leaves out the platform meta-ontology and every signature with it at an end', async () => {
    const vocabulary = workerVocabulary(await publishedOpsOntology(), new Set());
    const names = vocabulary.objectTypes.map((objectType) => objectType.name);
    for (const meta of ['WorkerDefinition', 'Gatekeeper', 'Operation', 'Capability', 'Skill']) {
      expect(names).not.toContain(meta);
    }
    expect(names).not.toContain('Procedure');
    expect(names).toContain('Container');
    const signatures = vocabulary.linkTypes.map((l) => `${l.name}: ${l.domain} -> ${l.range}`);
    // platform-meta's own (all from a meta type) and ops-assets' `served_by` (to Gatekeeper).
    expect(signatures.some((s) => s.startsWith('exposes: Gatekeeper'))).toBe(false);
    expect(signatures.some((s) => s.startsWith('reads:'))).toBe(false);
    expect(signatures).not.toContain('served_by: KnowledgeBase -> Gatekeeper');
    expect(signatures).toContain('runs_on: Container -> Host');
    expect(signatures).toContain('exposes: Container -> Endpoint');
    expect(vocabulary.omittedObjectTypes).toBe(0);
    expect(vocabulary.omittedLinkTypes).toBe(0);
  });

  it('carries each ObjectType’s identity key, and null for one that declares none', async () => {
    const vocabulary = workerVocabulary(
      {
        objectTypes: new Map([
          ['Host', { name: 'Host', description: 'h', identityKey: ['hostname'] }],
          ['Note', { name: 'Note', description: 'n' }],
        ]),
        linkTypes: new Map([['about', [signature('Note', 'Host')]]]),
      },
      new Set(),
    );
    expect(vocabulary.objectTypes).toEqual([
      { name: 'Host', identityKey: ['hostname'], relevant: false },
      { name: 'Note', identityKey: null, relevant: false },
    ]);
  });

  it('puts what the Worker’s Operations read and write first, each part by name', async () => {
    const vocabulary = workerVocabulary(
      await publishedOpsOntology(),
      new Set(['Host', 'Container']),
    );
    expect(vocabulary.objectTypes.slice(0, 2)).toEqual([
      { name: 'Container', identityKey: ['composeProjectId', 'serviceName'], relevant: true },
      { name: 'Host', identityKey: ['hostname'], relevant: true },
    ]);
    expect(vocabulary.objectTypes.slice(2).every((objectType) => !objectType.relevant)).toBe(true);
    const rest = vocabulary.objectTypes.slice(2).map((objectType) => objectType.name);
    expect(rest).toEqual([...rest].sort());
    // Both ends must be among them: `runs_on: Container -> Host` and `depends_on: Container ->
    // Container` are; `uses_image: Container -> Image` is not.
    const relevant = vocabulary.linkTypes.filter((linkType) => linkType.relevant);
    expect(relevant.map((l) => `${l.name}: ${l.domain} -> ${l.range}`)).toEqual([
      'depends_on: Container -> Container',
      'runs_on: Container -> Host',
    ]);
    expect(vocabulary.linkTypes.slice(0, 2)).toEqual(relevant);
  });

  it('counts `*` as any type: relevant when its other end is', () => {
    const ontology = {
      objectTypes: new Map([['Host', { name: 'Host', description: 'h' }]]),
      linkTypes: new Map([
        ['mentions', [signature('Host', '*')]],
        ['anything', [signature('*', '*')]],
      ]),
    };
    expect(workerVocabulary(ontology, new Set()).linkTypes).toEqual([
      { name: 'anything', domain: '*', range: '*', relevant: true },
      { name: 'mentions', domain: 'Host', range: '*', relevant: false },
    ]);
    expect(workerVocabulary(ontology, new Set(['Host'])).linkTypes.map((l) => l.relevant)).toEqual([
      true,
      true,
    ]);
  });

  it('lists a signature two families both declare once', () => {
    const vocabulary = workerVocabulary(
      {
        objectTypes: new Map([['Host', { name: 'Host', description: 'h' }]]),
        linkTypes: new Map([['peer_of', [signature('Host', 'Host'), signature('Host', 'Host')]]]),
      },
      new Set(),
    );
    expect(vocabulary.linkTypes).toHaveLength(1);
  });

  it('keeps at most the caps, relevant entries never cut before the others', () => {
    const objectTypes = new Map<string, ObjectTypeDefinition>();
    for (let i = 0; i < MAX_VOCABULARY_OBJECT_TYPES + 30; i += 1) {
      const name = `T${String(i).padStart(3, '0')}`;
      objectTypes.set(name, { name, description: 'd' });
    }
    const linkTypes = new Map<string, LinkTypeSignature[]>();
    for (let i = 0; i < MAX_VOCABULARY_LINK_TYPES + 7; i += 1) {
      linkTypes.set(`l${String(i).padStart(3, '0')}`, [signature('T000', 'T001')]);
    }
    // The last ObjectType by name is the one the Worker touches.
    const last = `T${String(MAX_VOCABULARY_OBJECT_TYPES + 29).padStart(3, '0')}`;
    const vocabulary = workerVocabulary({ objectTypes, linkTypes }, new Set([last]));
    expect(vocabulary.objectTypes).toHaveLength(MAX_VOCABULARY_OBJECT_TYPES);
    expect(vocabulary.objectTypes[0]).toEqual({ name: last, identityKey: null, relevant: true });
    expect(vocabulary.omittedObjectTypes).toBe(30);
    expect(vocabulary.linkTypes).toHaveLength(MAX_VOCABULARY_LINK_TYPES);
    expect(vocabulary.omittedLinkTypes).toBe(7);
  });
});

describe('typesTouchedBy', () => {
  it('is every name in the Operations’ reads and writes, and nothing from a malformed one', () => {
    expect(
      [
        ...typesTouchedBy([
          { reads: ['Container', 'Host'], writes: ['Container'] },
          { reads: 'Host', writes: [3, 'Image'] },
          null,
          'x',
        ]),
      ].sort(),
    ).toEqual(['Container', 'Host', 'Image']);
  });
});

describe('declaredBetween (an undeclared LinkType’s refusal, legacy 968)', () => {
  it('names the signatures joining the two types either way round, sorted', async () => {
    const { linkTypes } = await publishedOpsOntology();
    // A model that invented `hosts` for Host -> Container learns runs_on is Container -> Host.
    expect(declaredBetween(linkTypes, 'Host', 'Container')).toEqual(['runs_on: Container -> Host']);
    expect(declaredBetween(linkTypes, 'Container', 'Container')).toEqual([
      'depends_on: Container -> Container',
    ]);
    expect(declaredBetween(linkTypes, 'Image', 'Host')).toEqual([]);
  });

  it('counts a `*` end as any type, and names at most the cap', () => {
    const linkTypes = new Map<string, LinkTypeSignature[]>([
      ['mentions', [signature('Note', '*')]],
    ]);
    for (let i = 0; i < MAX_DECLARED_BETWEEN + 5; i += 1) {
      linkTypes.set(`r${String(i).padStart(2, '0')}`, [signature('A', 'B')]);
    }
    expect(declaredBetween(linkTypes, 'Host', 'Note')).toEqual(['mentions: Note -> *']);
    const many = declaredBetween(linkTypes, 'B', 'A');
    expect(many).toHaveLength(MAX_DECLARED_BETWEEN);
    expect(many[0]).toBe('r00: A -> B');
  });

  it('is what evaluateLink reports for an undeclared LinkType', async () => {
    const { linkTypes } = await publishedOpsOntology();
    expect(
      evaluateLink(linkTypes, { linkType: 'hosts', sourceType: 'Host', targetType: 'Container' }),
    ).toEqual({ kind: 'undeclared_link_type', declaredBetween: ['runs_on: Container -> Host'] });
  });
});
