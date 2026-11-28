import { isMetaOntologyObjectType } from '@nexttime/shared';
import type { LinkTypeSignature } from './registry.js';
import type { ObjectTypeDefinition } from './schema.js';

/**
 * substrate/ontology/vocabulary: legacy 968 — the words a Worker may write Facts with. A
 * `factsToAssert[]` entry is a Link, and the ontology guard (`substrate/graph/ontology-guard.ts`)
 * accepts it only when the workspace's published ontology declares its LinkType for the two
 * Objects' types; a Worker that is never told that vocabulary guesses, and in a `reject`
 * workspace every guess is refused (v0.70.1 trial workspace, 2026-11-27). `get_task` hands the
 * Task's own Worker this projection of the published ontology
 * (`docs/tool-result-and-budget-design-2026-11-27.md` §5):
 *
 * - what a Worker cannot write is left out: the six platform meta-ontology ObjectTypes, and every
 *   signature with one of them at an end (I16 refuses a Handle's Fact that names one, before the
 *   guard is reached — `application/gateway/worker-result-handler.ts`'s `checkObjectRef`);
 * - what this Worker works with comes first (`relevant`): an ObjectType that an Operation it can
 *   call reads or writes, and a signature whose two ends are such types (`*`, which accepts any
 *   type, counts as one);
 * - one entry per ObjectType with its identity key, one per signature; no property definitions;
 * - at most {@link MAX_VOCABULARY_OBJECT_TYPES} / {@link MAX_VOCABULARY_LINK_TYPES} entries, the
 *   rest counted in `omitted*`. The Worker's own context shows less still (4,000 characters,
 *   platform-extension `modes/vocabulary.ts`); these caps bound the answer, not the prompt.
 *
 * Within each part the order is by name, so the same ontology gives the same text and the prompt
 * stays cacheable from one run to the next.
 */

export const MAX_VOCABULARY_OBJECT_TYPES = 100;
export const MAX_VOCABULARY_LINK_TYPES = 200;

export interface VocabularyObjectType {
  readonly name: string;
  /** The properties an `{objectType, identity}` ref names the Object by; `null` when the type
   *  declares none. */
  readonly identityKey: readonly string[] | null;
  readonly relevant: boolean;
}

export interface VocabularyLinkType {
  readonly name: string;
  readonly domain: string;
  readonly range: string;
  readonly relevant: boolean;
}

export interface WorkerVocabulary {
  readonly objectTypes: readonly VocabularyObjectType[];
  readonly linkTypes: readonly VocabularyLinkType[];
  readonly omittedObjectTypes: number;
  readonly omittedLinkTypes: number;
}

/** Relevant entries first, each part by `key`; at most `max`, the rest counted. */
function ranked<T extends { readonly relevant: boolean }>(
  entries: readonly T[],
  key: (entry: T) => string,
  max: number,
): { readonly kept: T[]; readonly omitted: number } {
  const byKey = (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const sorted = [
    ...entries.filter((entry) => entry.relevant).sort(byKey),
    ...entries.filter((entry) => !entry.relevant).sort(byKey),
  ];
  return { kept: sorted.slice(0, max), omitted: Math.max(0, sorted.length - max) };
}

/** The vocabulary of `ontology` a Worker whose Operations read and write `touchedTypes` may write
 *  Facts with (module doc comment). */
export function workerVocabulary(
  ontology: {
    readonly objectTypes: ReadonlyMap<string, ObjectTypeDefinition>;
    readonly linkTypes: ReadonlyMap<string, readonly LinkTypeSignature[]>;
  },
  touchedTypes: ReadonlySet<string>,
): WorkerVocabulary {
  const touches = (end: string) => end === '*' || touchedTypes.has(end);
  const objectTypes: VocabularyObjectType[] = [];
  for (const objectType of ontology.objectTypes.values()) {
    if (isMetaOntologyObjectType(objectType.name)) continue;
    objectTypes.push({
      name: objectType.name,
      identityKey: objectType.identityKey ? [...objectType.identityKey] : null,
      relevant: touchedTypes.has(objectType.name),
    });
  }
  const linkTypes: VocabularyLinkType[] = [];
  const seen = new Set<string>();
  for (const [name, signatures] of ontology.linkTypes) {
    for (const { domain, range } of signatures) {
      if (isMetaOntologyObjectType(domain) || isMetaOntologyObjectType(range)) continue;
      // Two families may declare the same signature; the Worker needs it once.
      const key = `${name}\u0000${domain}\u0000${range}`;
      if (seen.has(key)) continue;
      seen.add(key);
      linkTypes.push({ name, domain, range, relevant: touches(domain) && touches(range) });
    }
  }
  const keptObjectTypes = ranked(objectTypes, (entry) => entry.name, MAX_VOCABULARY_OBJECT_TYPES);
  const keptLinkTypes = ranked(
    linkTypes,
    (entry) => `${entry.name}\u0000${entry.domain}\u0000${entry.range}`,
    MAX_VOCABULARY_LINK_TYPES,
  );
  return {
    objectTypes: keptObjectTypes.kept,
    linkTypes: keptLinkTypes.kept,
    omittedObjectTypes: keptObjectTypes.omitted,
    omittedLinkTypes: keptLinkTypes.omitted,
  };
}

/** The ObjectTypes the Operations in `operations` read or write (`OperationSchema`'s `reads` /
 *  `writes`; an entry that is not a list of names counts for nothing). */
export function typesTouchedBy(operations: readonly unknown[]): Set<string> {
  const touched = new Set<string>();
  for (const operation of operations) {
    if (operation === null || typeof operation !== 'object') continue;
    for (const field of ['reads', 'writes'] as const) {
      const names = (operation as Record<string, unknown>)[field];
      if (!Array.isArray(names)) continue;
      for (const name of names) if (typeof name === 'string') touched.add(name);
    }
  }
  return touched;
}
