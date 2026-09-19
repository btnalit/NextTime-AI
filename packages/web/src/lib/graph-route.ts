import { hrefs } from './router.js';

/**
 * lib/graph-route: the graph page's own hash-query state (S6-D, docs/console-completion-plan.md
 * §5.7). The page lives at `#/work/graph` and keeps its four navigational facts in the hash query
 * — `objectId` (the focused Object, a deep link from any RefChip), `q` / `type` (the submitted
 * search), `at` (the "截至 As of" instant for `state_at`) — so a reload, a bookmark or a browser
 * Back lands on the same view. `lib/router.ts` only needs to recognise the path
 * (`/^#\/work\/graph(?:\?.*)?$/` → `{kind:'graph'}`); everything after `?` is parsed here, the
 * same way the audit page accepts `?nodeId=` on its own route. Pure functions; the React side
 * (`components/graph/useGraphQuery.ts`) listens to `hashchange` and calls these.
 */
export const GRAPH_PATH = '#/work/graph';

export interface GraphQuery {
  readonly objectId?: string;
  readonly q?: string;
  readonly type?: string;
  /** ISO instant for `state_at{at}`; absent = now (frozen per focus, see `ObjectView`). */
  readonly at?: string;
}

const KEYS = ['objectId', 'q', 'type', 'at'] as const;

/** `null` when `hash` is not the graph route at all. An empty query is `{}`. */
export function parseGraphHash(hash: string): GraphQuery | null {
  if (hash !== GRAPH_PATH && !hash.startsWith(`${GRAPH_PATH}?`)) return null;
  const queryText = hash.slice(GRAPH_PATH.length + 1);
  const params = new URLSearchParams(queryText);
  const query: { -readonly [K in keyof GraphQuery]?: string } = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (value !== null && value !== '') query[key] = value;
  }
  return query;
}

/** `#/work/graph?objectId=…&q=…` — keys in a fixed order, empty values dropped, so two equal
 *  states always serialize identically (the hash is compared as a string by `navigate`). */
export function graphHref(query: GraphQuery = {}): string {
  const params = new URLSearchParams();
  for (const key of KEYS) {
    const value = query[key];
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const text = params.toString();
  return text === '' ? GRAPH_PATH : `${GRAPH_PATH}?${text}`;
}

/**
 * "在审计页打开 Open in audit" — the audit page with the node pre-filled. Built on `hrefs.audit()`
 * (today `#/govern/audit`) plus `?nodeId=`, the query the S6-A audit lane accepts, so the link
 * follows wherever `lib/router.ts` says the audit page lives; the S6-D brief spelled it
 * `#/work/audit?nodeId=`, which is not a route in this tree — one place to change if it moves.
 */
export function auditHrefForNode(nodeId: string): string {
  return `${hrefs.audit()}?nodeId=${encodeURIComponent(nodeId)}`;
}
