import type { PoolClient } from 'pg';
import {
  SEAL_SPAN_CHARS,
  SealSpanIndex,
  canariesIn,
  normalizeSealText,
  sealStrings,
} from './span-index.js';

/**
 * application/eval-seal/seal: whether a value on its way to an agent carries evaluation content
 * (S10 E3-1c, I-E4 评测对人透明、对 agent 封闭) — any suite's canary, or a verbatim run of
 * {@link SEAL_SPAN_CHARS} normalized characters of any holdout case's text (its title, mechanism,
 * input, the conditions of its fixture rules, and its assertions; every row ever written, retired
 * ones included — a retired holdout case is no less held out).
 *
 * A fixture rule's answer is not indexed, nor the gate and operation it names (coordinator, #813
 * review): what a holdout case hides is what it asks and what it expects. A fixture stands in for a
 * real system, so its answer is usually copied from that system's real replies — indexing it would
 * refuse the real gate's same answer on the production path, which is not where evaluation runs.
 *
 * What it knows is built from `eval_suites` and `eval_cases` (read directly: `application/eval` is
 * for the human-channel handlers only) and kept in this process's memory, one snapshot per
 * workspace, rebuilt when the workspace's suite or holdout-row count moves (rows are only ever
 * added, so a count is a version). The snapshot holds the canaries and window hashes, never text;
 * nothing here logs, and nothing it holds goes into an error or an audit row.
 */

interface SealSnapshot {
  readonly version: string;
  readonly canaries: ReadonlySet<string>;
  readonly spans: SealSpanIndex;
}

/** Snapshots by workspace. Bounded: the oldest goes when a new workspace would pass the cap. */
const snapshots = new Map<string, SealSnapshot>();
const MAX_SNAPSHOTS = 256;

/** The normalized strings of `value` the seal must look at: those long enough to hold a window,
 *  or holding something shaped like a canary. Empty means nothing to look up. */
function candidates(value: unknown): string[] {
  const out: string[] = [];
  for (const text of sealStrings(value)) {
    // Normalized first, whatever its length: NFKC can lengthen a string (one character can become
    // eighteen), so a short one is not safely short.
    const normalized = normalizeSealText(text);
    if (normalized.length >= SEAL_SPAN_CHARS || normalized.includes('nteval-')) {
      out.push(normalized);
    }
  }
  return out;
}

async function snapshotFor(client: PoolClient, workspaceId: string): Promise<SealSnapshot | null> {
  const counts = await client.query<{ suites: number; holdout: number }>(
    `select (select count(*) from eval_suites where workspace_id = $1)::int as suites,
            (select count(*) from eval_cases where workspace_id = $1 and split = 'holdout')::int
              as holdout`,
    [workspaceId],
  );
  const suites = counts.rows[0]?.suites ?? 0;
  if (suites === 0) return null;
  const version = `${suites}:${counts.rows[0]?.holdout ?? 0}`;
  const cached = snapshots.get(workspaceId);
  if (cached?.version === version) return cached;

  const canaryRows = await client.query<{ canary: string }>(
    'select canary from eval_suites where workspace_id = $1',
    [workspaceId],
  );
  // Of the fixture rules, only their `when` conditions (see the module comment).
  const caseRows = await client.query<{
    title: string;
    mechanism: string | null;
    input: unknown;
    fixture_conditions: unknown;
    assertions: unknown;
  }>(
    `select title, mechanism, input,
            jsonb_path_query_array(fixtures, '$[*].when') as fixture_conditions, assertions
       from eval_cases
      where workspace_id = $1 and split = 'holdout'`,
    [workspaceId],
  );
  const spans = new SealSpanIndex();
  for (const row of caseRows.rows) {
    for (const text of sealStrings([
      row.title,
      row.mechanism,
      row.input,
      row.fixture_conditions,
      row.assertions,
    ])) {
      spans.add(text);
    }
  }
  const snapshot: SealSnapshot = {
    version,
    canaries: new Set(canaryRows.rows.map((row) => normalizeSealText(row.canary))),
    spans,
  };
  snapshots.delete(workspaceId);
  if (snapshots.size >= MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
  snapshots.set(workspaceId, snapshot);
  return snapshot;
}

export interface SealOptions {
  /** S10 E3-2a: text whose windows pass — an evaluation Task's own input, which its Worker is
   *  meant to read even when its case is held out. Only that case's input: another case's text,
   *  any assertion or fixture condition, and every canary are still stopped. */
  readonly allow?: unknown;
}

/**
 * Whether `value` carries evaluation content of `workspaceId`'s suites. `client` is any
 * transaction scoped to that workspace (the caller's own). Reads nothing at all when `value` has
 * no string long enough to matter.
 */
export async function sealWithholds(
  client: PoolClient,
  workspaceId: string,
  value: unknown,
  options: SealOptions = {},
): Promise<boolean> {
  const texts = candidates(value);
  if (texts.length === 0) return false;
  const snapshot = await snapshotFor(client, workspaceId);
  if (snapshot === null) return false;
  let allowed: SealSpanIndex | null = null;
  if (options.allow !== undefined) {
    allowed = new SealSpanIndex();
    for (const text of sealStrings(options.allow)) allowed.add(text);
  }
  for (const text of texts) {
    if (canariesIn(text).some((canary) => snapshot.canaries.has(canary))) return true;
    if (
      allowed === null
        ? snapshot.spans.holdsWindowOf(text)
        : snapshot.spans.holdsWindowOutside(text, allowed)
    ) {
      return true;
    }
  }
  return false;
}

/** Tests only: forgets every snapshot. */
export function resetEvaluationSealForTests(): void {
  snapshots.clear();
}
