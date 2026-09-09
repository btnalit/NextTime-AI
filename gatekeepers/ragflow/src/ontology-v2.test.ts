import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OntologyDefinitionSchema } from '@nexttime/shared';
import type { OntologyDefinition } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * ontology-v2.test.ts (S3.4 deliverable 4: "ontology v2 load/publish test"). Verifies the *load*
 * half against the real, checked-in `ontology/ops-assets-v2.yaml` (parses + validates against
 * `@nexttime/shared`'s `OntologyDefinitionSchema` — the exact schema
 * `packages/kernel/src/substrate/ontology/schema.ts`'s loader validates against, S3.1) and this
 * gate's own manifest/ontology consistency; the *publish* half (a real `ontology_versions` DB round
 * trip via `publishOntologyDomainPack`/`seedDomainPackFromCli`) needs no new kernel code — that
 * function is pack-content-agnostic (`packages/kernel/src/substrate/ontology/loader.ts`'s own doc
 * comment) — and is exercised on a target host instead
 * (`docs/runbooks/host-gatekeepers.md` §11), per this task's own dispatch: touch
 * `packages/kernel/src/**` only if the loader cannot load a v2 pack that extends v1. It can,
 * unverified-locally-but-unmodified, so no kernel test was added here either — see
 * `ontology/ops-assets-v2.yaml`'s own header comment for the full reasoning this file's assertions
 * follow.
 *
 * `yaml` (devDependency, added for this file only) mirrors exactly how
 * `packages/kernel/src/substrate/ontology/schema.ts`'s `parseOntologyDefinition` reads a domain
 * pack — this file does not reimplement any validation logic of its own, only calls the same
 * `OntologyDefinitionSchema` kernel already validates against.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const V1_PATH = path.join(REPO_ROOT, 'ontology', 'ops-assets-v1.yaml');
const V2_PATH = path.join(REPO_ROOT, 'ontology', 'ops-assets-v2.yaml');

function loadDefinition(filePath: string): OntologyDefinition {
  const raw = parseYaml(readFileSync(filePath, 'utf8'));
  return OntologyDefinitionSchema.parse(raw);
}

const MANIFEST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'manifest.json',
);

interface ManifestOperation {
  readonly name: string;
  readonly result_mapping?: { readonly object_type?: string; readonly identity_keys?: string[] };
}

function loadManifest(): ManifestOperation[] {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ManifestOperation[];
}

describe('ontology/ops-assets-v2.yaml', () => {
  it('parses and validates against the same OntologyDefinitionSchema the kernel loader uses', () => {
    expect(() => loadDefinition(V2_PATH)).not.toThrow();
  });

  it('extends v1: every v1 ObjectType is present, unchanged (same identityKey)', () => {
    const v1 = loadDefinition(V1_PATH);
    const v2 = loadDefinition(V2_PATH);
    const v2ByName = new Map(v2.objectTypes.map((t) => [t.name, t]));

    for (const v1Type of v1.objectTypes) {
      const v2Type = v2ByName.get(v1Type.name);
      expect(v2Type, `v2 is missing v1 ObjectType "${v1Type.name}"`).toBeDefined();
      expect(v2Type?.identityKey).toEqual(v1Type.identityKey);
    }
  });

  it('extends v1: every v1 LinkType signature is present, unchanged', () => {
    const v1 = loadDefinition(V1_PATH);
    const v2 = loadDefinition(V2_PATH);
    const v2Signatures = new Set(v2.linkTypes.map((l) => `${l.name}::${l.domain}::${l.range}`));

    for (const v1Link of v1.linkTypes) {
      expect(
        v2Signatures.has(`${v1Link.name}::${v1Link.domain}::${v1Link.range}`),
        `v2 is missing v1 LinkType signature "${v1Link.name}: ${v1Link.domain} -> ${v1Link.range}"`,
      ).toBe(true);
    }
  });

  it('adds KnowledgeBase/Document/Dataset with the declared identityKeys', () => {
    const v2 = loadDefinition(V2_PATH);
    const byName = new Map(v2.objectTypes.map((t) => [t.name, t]));

    expect(byName.get('KnowledgeBase')?.identityKey).toEqual(['gatekeeperId', 'kbId']);
    expect(byName.get('Document')?.identityKey).toEqual(['gatekeeperId', 'kbId', 'documentId']);
    expect(byName.get('Dataset')?.identityKey).toEqual(['gatekeeperId', 'datasetId']);
  });

  it('adds part_of (Document -> KnowledgeBase) and served_by (KnowledgeBase -> Gatekeeper)', () => {
    const v2 = loadDefinition(V2_PATH);
    const hasSignature = (name: string, domain: string, range: string) =>
      v2.linkTypes.some((l) => l.name === name && l.domain === domain && l.range === range);

    expect(hasSignature('part_of', 'Document', 'KnowledgeBase')).toBe(true);
    expect(hasSignature('served_by', 'KnowledgeBase', 'Gatekeeper')).toBe(true);
  });

  it('does NOT declare a part_of (Dataset -> KnowledgeBase) link — RAGFlow models no such hierarchy', () => {
    const v2 = loadDefinition(V2_PATH);
    const datasetLinks = v2.linkTypes.filter(
      (l) => l.domain === 'Dataset' || l.range === 'Dataset',
    );
    expect(datasetLinks).toEqual([]);
  });

  it("this gate's manifest.json result_mapping object types are all declared in ops-assets-v2.yaml", () => {
    const v2 = loadDefinition(V2_PATH);
    const declaredTypes = new Set(v2.objectTypes.map((t) => t.name));
    const manifest = loadManifest();

    const mappedTypes = manifest
      .map((op) => op.result_mapping?.object_type)
      .filter((t): t is string => typeof t === 'string');
    expect(mappedTypes.length).toBeGreaterThan(0);
    for (const objectType of mappedTypes) {
      expect(
        declaredTypes.has(objectType),
        `ops-assets-v2.yaml has no ObjectType "${objectType}"`,
      ).toBe(true);
    }
  });
});
