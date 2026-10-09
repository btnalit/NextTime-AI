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
  if (!items || items.length === 0) return undefined;
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

function renderRecentFacts(
  facts: unknown[] | undefined,
  counts: readonly LinkTypeCount[] | undefined,
): string | undefined {
  if (!facts || facts.length === 0) return undefined;
  const total = counts?.reduce((sum, { count }) => sum + count, 0);
  const sampled =
    total !== undefined && total >= facts.length
      ? `${facts.length} of ${total}`
      : `${facts.length}`;
  return renderSection(
    `Most recently recorded facts (${sampled}; a recency sample, not chosen for this question and not the whole graph)`,
    facts,
  );
}

/** `title` is the mode's own heading (`NextTime entry context`, `NextTime interactive-session
 *  context`). Empty string when there is nothing to inject. */
export function renderEntryContext(context: EntryContextResult, title: string): string {
  const counts = linkTypeCounts(context.factCountsByLinkType);
  const sections = [
    renderSection('Pending approvals', context.pendingApprovals),
    renderSection('Running tasks', context.tasks),
    renderGraphOverview(counts),
    renderRecentFacts(context.facts, counts),
    renderSection('Precedents', context.precedents),
  ].filter((section): section is string => section !== undefined);
  if (sections.length === 0) return '';
  return [`## ${title}`, ...sections].join('\n\n');
}
