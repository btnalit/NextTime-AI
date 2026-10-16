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

/** One rendered entry of a list section. An entry with an `id` is the same entry when its line
 *  changes (a Fact's id, a link type's name); `ref` is how an update names it once it is gone. */
interface SectionEntry {
  readonly line: string;
  readonly id?: string;
  readonly ref?: string;
}

/** A section that lists entries one per line, with its heading and closing lines kept apart so an
 *  update can say what changed in it entry by entry (`renderSectionChange`). */
interface ListSection {
  readonly heading: string;
  readonly entries: readonly SectionEntry[];
  readonly trailer?: readonly string[];
}

function listSection(heading: string, items: unknown[] | undefined): ListSection | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  return {
    heading: `### ${heading}`,
    entries: items.map((item) => {
      const id = (item as { id?: unknown } | null)?.id;
      return typeof id === 'string'
        ? { line: `- ${JSON.stringify(item)}`, id, ref: `- id ${JSON.stringify(id)}` }
        : { line: `- ${JSON.stringify(item)}` };
    }),
  };
}

function listText(list: ListSection): string {
  return [list.heading, ...list.entries.map((entry) => entry.line), ...(list.trailer ?? [])].join(
    '\n',
  );
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

function renderGraphOverview(
  counts: readonly LinkTypeCount[] | undefined,
): string | ListSection | undefined {
  if (counts === undefined) return undefined;
  if (counts.length === 0) {
    return '### Knowledge graph overview\nThe knowledge graph has no active Facts yet.';
  }
  const ranked = [...counts].sort(
    (a, b) => b.count - a.count || (a.linkType < b.linkType ? -1 : a.linkType > b.linkType ? 1 : 0),
  );
  const shown = ranked.slice(0, MAX_OVERVIEW_LINK_TYPES);
  const omitted = ranked.slice(MAX_OVERVIEW_LINK_TYPES);
  // Each link type's count is an entry of its own, so a Fact recorded mid-Turn updates one line.
  const entries = shown.map(({ linkType, count }) => ({
    line: `- ${renderLinkType(linkType)}: ${count}`,
    id: linkType,
    ref: `- ${renderLinkType(linkType)}`,
  }));
  if (omitted.length === 0) {
    return {
      heading: '### Knowledge graph overview — active Facts per link type (complete counts)',
      entries,
      trailer: [`${GRAPH_QUESTION_GUIDANCE} ${COMPLETE_OVERVIEW_GUIDANCE}`],
    };
  }
  const omittedFacts = omitted.reduce((sum, { count }) => sum + count, 0);
  return {
    heading: `### Knowledge graph overview — active Facts per link type (the ${shown.length} most common of ${ranked.length})`,
    entries,
    trailer: [
      `- …and ${omitted.length} more link types with ${omittedFacts} Facts in total, not listed`,
      `${GRAPH_QUESTION_GUIDANCE} This list is cut: a link type not listed here may still have Facts, so check it with \`list_facts\` before saying the graph has none.`,
    ],
  };
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

function recentFactsSection(
  facts: unknown[] | undefined,
  counts: readonly LinkTypeCount[] | undefined,
): ListSection | undefined {
  if (!Array.isArray(facts) || facts.length === 0) return undefined;
  const total = counts?.reduce((sum, { count }) => sum + count, 0);
  const sampled =
    total !== undefined && total >= facts.length
      ? `${facts.length} of ${total}`
      : `${facts.length}`;
  return listSection(
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
  /** The heading, entries and closing lines `text` is made of, for a section that lists entries
   *  (every section but an empty graph's overview). */
  readonly list?: ListSection;
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
  const rendered: Record<EntryContextSectionKey, string | ListSection | undefined> = {
    pendingApprovals: listSection(SECTION_NAMES.pendingApprovals, context.pendingApprovals),
    tasks: listSection(SECTION_NAMES.tasks, context.tasks),
    graphOverview: renderGraphOverview(counts),
    recentFacts: recentFactsSection(context.facts, counts),
    precedents: listSection(SECTION_NAMES.precedents, context.precedents),
  };
  return SECTION_ORDER.flatMap((key): EntryContextSection[] => {
    const section = rendered[key];
    if (section === undefined) return [];
    return typeof section === 'string'
      ? [{ key, text: section }]
      : [{ key, text: listText(section), list: section }];
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

const REPLACED_BY_ID = 'New or changed (an entry here replaces the entry above with the same id)';

/** How an update introduces a section's new or changed entries (`replaced`: when one of them
 *  has the id of an earlier entry) and the entries that are gone. */
const CHANGE_LABELS: Readonly<
  Record<EntryContextSectionKey, { readonly replaced: string; readonly gone: string }>
> = {
  pendingApprovals: { replaced: REPLACED_BY_ID, gone: 'No longer pending' },
  tasks: { replaced: REPLACED_BY_ID, gone: 'No longer listed' },
  graphOverview: {
    replaced: 'New or changed (a count here replaces the count above for the same link type)',
    gone: 'No longer listed (no active Facts left, or, in a cut list, no longer among the most common)',
  },
  recentFacts: {
    replaced: REPLACED_BY_ID,
    gone: 'No longer in this recency sample (newer Facts pushed them out, or they are no longer active: `explain` tells which)',
  },
  precedents: { replaced: REPLACED_BY_ID, gone: 'No longer listed' },
};

/**
 * One changed section as an update carries it. A list section says only what changed in it — the
 * entries that are new or changed, and the ones that are gone (by `id` when the earlier entry had
 * one, else in full) — so a collector recording one more Fact in the middle of a Turn costs one
 * Fact, one id and one overview count, not the whole 20-Fact sample and overview again (the #575
 * real-model run's later calls still carried about 2.2k fresh input tokens each). A section's
 * closing lines are repeated only when they changed. When all that is not shorter than the
 * section itself (a one-entry section whose entry changed), or there is nothing to compare (a
 * section that only now appears, an empty graph's overview), the section is repeated in full and
 * replaces the earlier one. A section that is gone reads "(none now)".
 */
function renderSectionChange(
  key: EntryContextSectionKey,
  before: EntryContextSection | undefined,
  after: EntryContextSection | undefined,
): string {
  if (!after) return `### ${SECTION_NAMES[key]}\n(none now)`;
  if (!before?.list || !after.list) return after.text;
  const beforeLines = new Set(before.list.entries.map((entry) => entry.line));
  const afterLines = new Set(after.list.entries.map((entry) => entry.line));
  const added = after.list.entries.filter((entry) => !beforeLines.has(entry.line));
  const idUses = new Map<string, number>();
  for (const entry of before.list.entries) {
    if (entry.id !== undefined) idUses.set(entry.id, (idUses.get(entry.id) ?? 0) + 1);
  }
  // Ids of earlier entries that a new line takes the place of — named once, as the replacement.
  const replacedIds = new Set(
    added.flatMap((entry) => (entry.id !== undefined && idUses.has(entry.id) ? [entry.id] : [])),
  );
  const gone = before.list.entries.filter(
    (entry) =>
      !afterLines.has(entry.line) && !(entry.id !== undefined && replacedIds.has(entry.id)),
  );
  const labels = CHANGE_LABELS[key];
  const lines = [`${after.list.heading} — changes since the same section above`];
  if (added.length > 0) {
    lines.push(`${replacedIds.size > 0 ? labels.replaced : 'New'}:`, ...added.map((e) => e.line));
  }
  if (gone.length > 0) {
    lines.push(
      `${labels.gone}:`,
      ...gone.map((entry) =>
        entry.ref !== undefined && entry.id !== undefined && idUses.get(entry.id) === 1
          ? entry.ref
          : entry.line,
      ),
    );
  }
  if (added.length === 0 && gone.length === 0) lines.push('(entries unchanged)');
  const trailer = after.list.trailer ?? [];
  if (trailer.join('\n') !== (before.list.trailer ?? []).join('\n')) lines.push(...trailer);
  const change = lines.join('\n');
  return change.length < after.text.length ? change : after.text;
}

/**
 * The sections of `current` that differ from `snapshot` (`live-context.ts`: the context already
 * placed earlier in the conversation), each as `renderSectionChange` words it. Empty string when
 * nothing differs.
 */
export function renderEntryContextUpdate(
  snapshot: readonly EntryContextSection[],
  current: readonly EntryContextSection[],
  title: string,
): string {
  const before = new Map(snapshot.map((section) => [section.key, section]));
  const now = new Map(current.map((section) => [section.key, section]));
  const changed = changedSectionKeys(snapshot, current).map((key) =>
    renderSectionChange(key, before.get(key), now.get(key)),
  );
  if (changed.length === 0) return '';
  return [
    `## ${title} — update`,
    `These sections changed since the ${title} earlier in this conversation. A section headed "— changes" lists only what changed in it; any other section here replaces the same section there in full; every section not repeated here is unchanged.`,
    ...changed,
  ].join('\n\n');
}
