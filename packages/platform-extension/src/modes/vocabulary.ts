/**
 * Legacy 968 (`docs/tool-result-and-budget-design-2026-11-27.md` §5): the two parts of a Worker's
 * context that come from the workspace rather than the Task — the ontology vocabulary its
 * `factsToAssert` are written with, and the related Objects its `search` found — each kept to a
 * fixed number of characters. The context goes in front of the first user message and is re-read
 * by every model call of the run, so whatever it holds is paid for again on each call; before
 * 968 the related Objects had no limit at all (up to 50, each serialized in full).
 *
 * The vocabulary is `get_task`'s `ontologyVocabulary`, already in the kernel's order (what the
 * Worker's own Operations read and write first, then by name). Here it becomes text: one line per
 * ObjectType with its identity key and one per LinkType signature while they fit; once one does
 * not, the rest are listed by name only, and what still does not fit is counted. Nothing in it
 * changes from one call to the next, so the prompt up to it stays cached.
 *
 * A name is the owner's free text (an ontology only requires it non-empty), and it lands in the
 * context as text the model reads: a line break in one could start a section of its own. Each name
 * is written on one line — every control character and line or paragraph separator a space — and
 * at most {@link NAME_MAX_CHARS} characters (reviews #481 and #493 on #1633). A Worker could not
 * write such a name back as given either; the grammar a name is held to at publish is legacy
 * 938 / 943's.
 */

/** At most this many characters of vocabulary go into a Worker's context. */
export const VOCABULARY_MAX_CHARS = 4000;
/** At most this many characters of related Objects go into a Worker's context. */
export const RELEVANT_FACTS_MAX_CHARS = 4000;
/** At most this many characters of one name (an ObjectType, a LinkType, an identity key part). */
export const NAME_MAX_CHARS = 120;

const VOCABULARY_HEADING = '### Ontology vocabulary';

const VOCABULARY_LEAD =
  'Each `factsToAssert` entry is a Link: its `linkType` must be one of the LinkTypes below, ' +
  'from an Object of its source type to an Object of its target type, or the platform refuses ' +
  'the entry. Name an Object by `objectId`, or by `objectType` with `identity` holding the ' +
  'properties of its identity key. Do not make up a LinkType: a conclusion these cannot express ' +
  'goes in `findings`, with what backs it in `evidence`.';

const NO_VOCABULARY =
  'This workspace’s ontology declares no LinkType a Worker can write a Fact with: leave ' +
  '`factsToAssert` empty and put your conclusions in `findings`, with what backs them in ' +
  '`evidence`.';

const OBJECT_TYPES_HEADING = 'ObjectTypes (identity key):';
const LINK_TYPES_HEADING = 'LinkTypes (source -> target, * is any type):';
const NAMES_PREFIX = 'Also declared (names only): ';

/** Room kept for the names line and the count line while the full lines are placed. */
const TAIL_RESERVE = 120;

interface Entry {
  readonly kind: 'object' | 'link';
  /** What tells two entries apart: the kind and the name as the kernel sent it. */
  readonly key: string;
  /** The name as written into the context (`shownName`). */
  readonly name: string;
  readonly line: string;
}

/** Every character that would end a line where the model reads it, or that it would not see. */
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/** A name as it goes into the context: on one line, at most `NAME_MAX_CHARS` characters (module
 *  doc comment). */
function shownName(name: string): string {
  const flat = name.replace(LINE_BREAKING, ' ');
  return flat.length <= NAME_MAX_CHARS ? flat : `${flat.slice(0, NAME_MAX_CHARS - 1)}…`;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** The entries of `ontologyVocabulary` in the kernel's order: relevant ObjectTypes, relevant
 *  signatures, the other ObjectTypes, the other signatures. A malformed entry is skipped. */
function entriesOf(vocabulary: Record<string, unknown>): Entry[] {
  const objectTypes = Array.isArray(vocabulary.objectTypes) ? vocabulary.objectTypes : [];
  const linkTypes = Array.isArray(vocabulary.linkTypes) ? vocabulary.linkTypes : [];
  const relevantFirst: Entry[][] = [[], [], [], []];
  for (const raw of objectTypes) {
    const entry = recordOf(raw);
    const name = text(entry?.name);
    if (!entry || !name) continue;
    const identityKey = Array.isArray(entry.identityKey)
      ? entry.identityKey.filter((part): part is string => typeof part === 'string').map(shownName)
      : [];
    const shown = shownName(name);
    const line = identityKey.length > 0 ? `- ${shown} (${identityKey.join(', ')})` : `- ${shown}`;
    relevantFirst[entry.relevant === true ? 0 : 2]?.push({
      kind: 'object',
      key: `object:${name}`,
      name: shown,
      line,
    });
  }
  for (const raw of linkTypes) {
    const entry = recordOf(raw);
    const name = text(entry?.name);
    const domain = text(entry?.domain);
    const range = text(entry?.range);
    if (!entry || !name || !domain || !range) continue;
    const shown = shownName(name);
    const line = `- ${shown}: ${shownName(domain)} -> ${shownName(range)}`;
    relevantFirst[entry.relevant === true ? 1 : 3]?.push({
      kind: 'link',
      key: `link:${name}`,
      name: shown,
      line,
    });
  }
  return relevantFirst.flat();
}

/** The vocabulary section of a Worker's context (module doc comment), at most `maxChars`
 *  characters; `undefined` when `get_task` gave none — a kernel before 968, an evaluation trial's
 *  Worker, or a workspace with no published ontology, where no Link is checked. With no LinkType to
 *  write — ObjectTypes or not — it says to leave `factsToAssert` empty (review #481 on #1633). */
export function renderVocabulary(
  ontologyVocabulary: unknown,
  maxChars: number = VOCABULARY_MAX_CHARS,
): string | undefined {
  const vocabulary = recordOf(ontologyVocabulary);
  if (!vocabulary) return undefined;
  const entries = entriesOf(vocabulary);
  const omittedLinkTypes = count(vocabulary.omittedLinkTypes);
  const omittedByKernel = count(vocabulary.omittedObjectTypes) + omittedLinkTypes;
  if (!entries.some((entry) => entry.kind === 'link') && omittedLinkTypes === 0) {
    return `${VOCABULARY_HEADING}\n${NO_VOCABULARY}`;
  }

  const head = `${VOCABULARY_HEADING}\n${VOCABULARY_LEAD}`;
  let used = head.length;
  const full = new Set<Entry>();
  const headed = new Set<Entry['kind']>();
  for (const entry of entries) {
    const heading = headed.has(entry.kind)
      ? 0
      : (entry.kind === 'object' ? OBJECT_TYPES_HEADING : LINK_TYPES_HEADING).length + 1;
    const cost = heading + entry.line.length + 1;
    if (used + cost + TAIL_RESERVE > maxChars) break;
    used += cost;
    full.add(entry);
    headed.add(entry.kind);
  }

  // What did not get a line of its own: its name, once, while the names still fit. A name stands
  // for every signature of it that got no line; a signature of a LinkType that has a line, and
  // anything once the names no longer fit, is counted.
  const fullNames = new Set([...full].map((entry) => entry.key));
  const names: string[] = [];
  const named = new Set<string>();
  let notListed = omittedByKernel;
  for (const entry of entries) {
    if (full.has(entry)) continue;
    const key = entry.key;
    if (named.has(key)) continue;
    const added = (names.length === 0 ? NAMES_PREFIX.length + 1 : 2) + entry.name.length;
    if (fullNames.has(key) || used + added + TAIL_RESERVE / 2 > maxChars) {
      notListed += 1;
      continue;
    }
    used += added;
    names.push(entry.name);
    named.add(key);
  }
  const lines = [head];
  const objectLines = entries.filter((entry) => full.has(entry) && entry.kind === 'object');
  const linkLines = entries.filter((entry) => full.has(entry) && entry.kind === 'link');
  if (objectLines.length > 0) {
    lines.push(OBJECT_TYPES_HEADING, ...objectLines.map((entry) => entry.line));
  }
  if (linkLines.length > 0) lines.push(LINK_TYPES_HEADING, ...linkLines.map((entry) => entry.line));
  if (names.length > 0) lines.push(`${NAMES_PREFIX}${names.join(', ')}`);
  if (notListed > 0) lines.push(`… and ${notListed} more not listed.`);
  return lines.join('\n');
}

/** The related-Objects section of a Worker's context: one line per Object `search` found, each
 *  whole, at most `maxChars` characters; an Object whose line does not fit is counted instead, and
 *  the ones after it are still tried. `undefined` when there are none. */
export function renderRelevantFacts(
  facts: readonly unknown[],
  maxChars: number = RELEVANT_FACTS_MAX_CHARS,
): string | undefined {
  if (facts.length === 0) return undefined;
  const heading = '### Relevant facts';
  // Room for the count line (`- … and 50 more not shown`).
  const reserve = 32;
  let used = heading.length;
  const lines: string[] = [];
  let notShown = 0;
  for (const fact of facts) {
    let line: string;
    try {
      line = `- ${JSON.stringify(fact) ?? String(fact)}`;
    } catch {
      line = `- ${String(fact)}`;
    }
    if (used + line.length + 1 + reserve > maxChars) {
      notShown += 1;
      continue;
    }
    used += line.length + 1;
    lines.push(line);
  }
  if (notShown > 0) lines.push(`- … and ${notShown} more not shown`);
  return [heading, ...lines].join('\n');
}
