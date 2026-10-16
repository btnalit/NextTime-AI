/**
 * The `get_entry_context` result as entry and interactive mode inject it before an LLM call — one
 * renderer for both, so the two never describe the same kernel data differently.
 *
 * Real-model round 4 (dependency_chat 0/10) is why the facts section is worded the way it is. The
 * kernel's `facts` are the most recently recorded Facts, never chosen for the question, but this
 * section used to be titled "Relevant facts"; a model asked "哪个服务依赖哪个" answered from those 20
 * Facts as if they were the graph and never enumerated the `depends_on` edges. Now the section says
 * what it is, and the graph overview (`factCountsByLinkType`, complete counts per link type) tells
 * the model which relationships exist and that `list_facts` enumerates them.
 */

/** Loose shape of a `get_entry_context` result, read defensively — an unexpected or missing field
 *  renders as an empty section rather than throwing (an older kernel has no
 *  `factCountsByLinkType`). */
export interface EntryContextResult {
  pendingApprovals?: unknown[];
  tasks?: unknown[];
  facts?: unknown[];
  factCountsByLinkType?: unknown[];
  precedents?: unknown[];
}

interface LinkTypeCount {
  readonly linkType: string;
  readonly count: number;
}

function linkTypeCounts(items: unknown[] | undefined): LinkTypeCount[] | undefined {
  if (!Array.isArray(items)) return undefined;
  return items.filter((item): item is LinkTypeCount => {
    const candidate = item as { linkType?: unknown; count?: unknown } | null;
    return (
      typeof candidate?.linkType === 'string' &&
      typeof candidate.count === 'number' &&
      Number.isInteger(candidate.count) &&
      candidate.count >= 0
    );
  });
}

function renderSection(title: string, items: unknown[] | undefined): string | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  return [`### ${title}`, ...items.map((item) => `- ${JSON.stringify(item)}`)].join('\n');
}

const GRAPH_QUESTION_GUIDANCE =
  'To answer a question about relationships in the graph, enumerate the link type with ' +
  '`list_facts` (follow `nextCursor` until it is absent) or `traverse` from a known Object.';
const COMPLETE_OVERVIEW_GUIDANCE =
  'A link type not listed here has no Facts: say the graph has no such data instead of guessing.';

/** Overview lines rendered at most — the most common link types first. Without a published
 *  ontology (or with it in warn mode) nothing bounds how many distinct link types a Worker or
 *  collector can write, and this section is in every model call's context. */
export const MAX_OVERVIEW_LINK_TYPES = 30;
/** A link type longer than this is cut in the overview (and marked as cut). */
export const MAX_OVERVIEW_LINK_TYPE_CHARS = 100;

/** A link type is written by Workers and collectors, not by the platform: rendered as a JSON
 *  string so a newline or `###` in it stays inside the quotes instead of opening a new context
 *  section — the same quoting every other graph-sourced value here gets from `renderSection`. */
function renderLinkType(linkType: string): string {
  if (linkType.length <= MAX_OVERVIEW_LINK_TYPE_CHARS) return JSON.stringify(linkType);
  return `${JSON.stringify(linkType.slice(0, MAX_OVERVIEW_LINK_TYPE_CHARS))} (name cut at ${MAX_OVERVIEW_LINK_TYPE_CHARS} characters)`;
}

function renderGraphOverview(counts: readonly LinkTypeCount[] | undefined): string | undefined {
  if (counts === undefined) return undefined;
  if (counts.length === 0) {
    return '### Knowledge graph overview\nThe knowledge graph has no active Facts yet.';
  }
  const ranked = [...counts].sort(
    (a, b) => b.count - a.count || (a.linkType < b.linkType ? -1 : a.linkType > b.linkType ? 1 : 0),
  );
  const shown = ranked.slice(0, MAX_OVERVIEW_LINK_TYPES);
  const omitted = ranked.slice(MAX_OVERVIEW_LINK_TYPES);
  const lines = shown.map(({ linkType, count }) => `- ${renderLinkType(linkType)}: ${count}`);
  if (omitted.length === 0) {
    return [
      '### Knowledge graph overview — active Facts per link type (complete counts)',
      ...lines,
      `${GRAPH_QUESTION_GUIDANCE} ${COMPLETE_OVERVIEW_GUIDANCE}`,
    ].join('\n');
  }
  const omittedFacts = omitted.reduce((sum, { count }) => sum + count, 0);
  return [
    `### Knowledge graph overview — active Facts per link type (the ${shown.length} most common of ${ranked.length})`,
    ...lines,
    `- …and ${omitted.length} more link types with ${omittedFacts} Facts in total, not listed`,
    `${GRAPH_QUESTION_GUIDANCE} This list is cut: a link type not listed here may still have Facts, so check it with \`list_facts\` before saying the graph has none.`,
  ].join('\n');
}

/**
 * Fact fields left out of the context (legacy 229): the per-observation bookkeeping a collector
 * rewrites every time it sees the same Fact again (`queries.ts` sets `last_observation_id` and
 * `last_observed_at = now()` on each re-observation), and the Activity that recorded it. They
 * made the section — and with it the whole context — differ between two model calls with nothing
 * new in the graph, so it could never be served from the prompt cache; and three of the four are
 * UUIDs, the most expensive tokens in the section. `explain` on the Fact id still returns all of
 * them. Null-valued fields (an active Fact's `supersededAt`, `invalidatedAt`, …) carry nothing and
 * are left out too. Everything else, including fields a newer kernel adds, is kept.
 */
export const CONTEXT_OMITTED_FACT_FIELDS: ReadonlySet<string> = new Set([
  'activityId',
  'observationId',
  'lastObservationId',
  'lastObservedAt',
]);

function contextFact(fact: unknown): unknown {
  if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) return fact;
  return Object.fromEntries(
    Object.entries(fact).filter(
      ([key, value]) => value !== null && !CONTEXT_OMITTED_FACT_FIELDS.has(key),
    ),
  );
}

function renderRecentFacts(
  facts: unknown[] | undefined,
  counts: readonly LinkTypeCount[] | undefined,
): string | undefined {
  if (!Array.isArray(facts) || facts.length === 0) return undefined;
  const total = counts?.reduce((sum, { count }) => sum + count, 0);
  const sampled =
    total !== undefined && total >= facts.length
      ? `${facts.length} of ${total}`
      : `${facts.length}`;
  return renderSection(
    `Most recently recorded facts (${sampled}; a recency sample, not chosen for this question and not the whole graph)`,
    facts.map(contextFact),
  );
}

/** The context's sections, in the order they are rendered. A section's key is stable while its
 *  heading may carry counts, so two renderings are compared section by section by key. */
export type EntryContextSectionKey =
  | 'pendingApprovals'
  | 'tasks'
  | 'graphOverview'
  | 'recentFacts'
  | 'precedents';

export interface EntryContextSection {
  readonly key: EntryContextSectionKey;
  readonly text: string;
}

/** Heading of a section that was present and is now empty (`renderEntryContextUpdate`). */
const SECTION_NAMES: Readonly<Record<EntryContextSectionKey, string>> = {
  pendingApprovals: 'Pending approvals',
  tasks: 'Running tasks',
  graphOverview: 'Knowledge graph overview',
  recentFacts: 'Most recently recorded facts',
  precedents: 'Precedents',
};

const SECTION_ORDER = Object.keys(SECTION_NAMES) as EntryContextSectionKey[];

/** The non-empty sections of `context`, in render order. */
export function renderEntryContextSections(context: EntryContextResult): EntryContextSection[] {
  const counts = linkTypeCounts(context.factCountsByLinkType);
  const texts: Record<EntryContextSectionKey, string | undefined> = {
    pendingApprovals: renderSection(SECTION_NAMES.pendingApprovals, context.pendingApprovals),
    tasks: renderSection(SECTION_NAMES.tasks, context.tasks),
    graphOverview: renderGraphOverview(counts),
    recentFacts: renderRecentFacts(context.facts, counts),
    precedents: renderSection(SECTION_NAMES.precedents, context.precedents),
  };
  return SECTION_ORDER.flatMap((key) => {
    const text = texts[key];
    return text === undefined ? [] : [{ key, text }];
  });
}

/** `title` is the mode's own heading (`NextTime entry context`, `NextTime interactive-session
 *  context`). Empty string when there are no sections. */
export function joinEntryContext(sections: readonly EntryContextSection[], title: string): string {
  if (sections.length === 0) return '';
  return [`## ${title}`, ...sections.map((section) => section.text)].join('\n\n');
}

/** `title` is the mode's own heading (`NextTime entry context`, `NextTime interactive-session
 *  context`). Empty string when there is nothing to inject. */
export function renderEntryContext(context: EntryContextResult, title: string): string {
  return joinEntryContext(renderEntryContextSections(context), title);
}

/** The keys whose text differs between two renderings, in render order. */
export function changedSectionKeys(
  a: readonly EntryContextSection[],
  b: readonly EntryContextSection[],
): EntryContextSectionKey[] {
  const left = new Map(a.map((section) => [section.key, section.text]));
  const right = new Map(b.map((section) => [section.key, section.text]));
  return SECTION_ORDER.filter((key) => left.get(key) !== right.get(key));
}

/**
 * The sections of `current` that differ from `snapshot` (`live-context.ts`: the context already
 * placed earlier in the conversation), worded as replacing those sections there — a section that
 * is gone now reads "(none now)". Empty string when nothing differs.
 */
export function renderEntryContextUpdate(
  snapshot: readonly EntryContextSection[],
  current: readonly EntryContextSection[],
  title: string,
): string {
  const now = new Map(current.map((section) => [section.key, section.text]));
  const changed = changedSectionKeys(snapshot, current).map(
    (key) => now.get(key) ?? `### ${SECTION_NAMES[key]}\n(none now)`,
  );
  if (changed.length === 0) return '';
  return [
    `## ${title} — update`,
    `These sections changed since the ${title} earlier in this conversation and replace the same sections there; every section not repeated here is unchanged.`,
    ...changed,
  ].join('\n\n');
}
