import { type FSWatcher, readFileSync, watch } from 'node:fs';
import { hostPatternProblem, normalizeDenyHostPattern } from '@nexttime/shared';
import { z } from 'zod';
import type { SourcePolicy } from './policy.js';

/**
 * `SOURCE_MAP_FILE` loader (design doc §7.9): `{ "<clientIp>": {"sourceId": "...", "allow": [...],
 * "deny": [...]} }`. This is the S1 stand-in for `resolveSource(clientIp)` — a future supervisor
 * registry (S1.5) replaces the file with a live `(worker_run_id, container_id, ip)` lookup behind
 * the same interface.
 *
 * Reload is driven by `fs.watch`, which — per Node's docs — fires reliably on same-inode edits
 * (`echo ... > file`, most editors' "save") but not always on a replace-by-rename; a full write
 * followed by an atomic rename may be missed. README.md calls this out for operators.
 */

const SourceEntrySchema = z.object({
  sourceId: z.string(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  // Leftover 87: a Worker container's inherited correlation id (worker-supervisor's egress-map.ts
  // writes it for Task containers) — only ever copied into log lines, and only when it is a valid
  // id (`isValidCorrelationId`), so a malformed map entry can never inject into a log line.
  correlationId: z.string().optional(),
});

const SourceMapFileSchema = z.record(z.string(), SourceEntrySchema);

export interface SourceMap {
  resolveSource(clientIp: string): SourcePolicy | undefined;
  close(): void;
}

/** One `allow` / `deny` entry that can never match a request host (`hostPatternProblem`). */
export interface SourcePatternProblem {
  readonly clientIp: string;
  readonly sourceId: string;
  readonly list: 'allow' | 'deny';
  readonly entry: string;
  readonly problem: string;
}

/**
 * fix/egress-suffix-match: the entries of a loaded map that can never match. `deny` is checked
 * after `normalizeDenyHostPattern` — `.x` / `*.x` deny like `x` there (policy.ts
 * `matchesDenySuffix`), so only a form that is still unmatchable is reported. `allow` is checked as
 * written: policy.ts matches it strictly, so a `.x` / `*.x` allow entry never matches and only
 * narrows (fail-closed) — it is reported, never rewritten into a match (that would widen egress),
 * and never makes the whole file fail to load (a rejected file freezes the map: new containers'
 * registrations would stop applying while a stale IP kept a departed container's policy).
 * No code path writes `allow` today (worker-supervisor writes only `deny`), so a reported `allow`
 * entry is a hand edit.
 */
export function findSourcePatternProblems(
  entries: Readonly<Record<string, SourcePolicy>>,
): SourcePatternProblem[] {
  const problems: SourcePatternProblem[] = [];
  for (const [clientIp, source] of Object.entries(entries)) {
    for (const entry of source.allow ?? []) {
      const problem = hostPatternProblem(entry);
      if (problem)
        problems.push({ clientIp, sourceId: source.sourceId, list: 'allow', entry, problem });
    }
    for (const entry of source.deny ?? []) {
      const problem = hostPatternProblem(normalizeDenyHostPattern(entry));
      if (problem)
        problems.push({ clientIp, sourceId: source.sourceId, list: 'deny', entry, problem });
    }
  }
  return problems;
}

export interface CreateSourceMapOptions {
  onError?: (err: unknown) => void;
  /** Called after a load whose unmatchable entries differ from the previous load's (so a busy
   *  host rewriting the file per container event does not repeat the same report). Defaults to
   *  one `error` log line. */
  onPatternProblems?: (problems: readonly SourcePatternProblem[]) => void;
}

/** leftover 61: `egress-map.ts`'s writer is a plain, non-atomic `writeFileSync` (open + truncate +
 *  write, no rename) — deliberately, since a rename-based atomic write would silently break this
 *  file's own `fs.watch` hot reload (that file's own doc comment; the trade-off is kept, not
 *  reversed, here). An `fs.watch` change event landing mid-write is therefore an *expected*, near-
 *  routine race, not a sign of real corruption — one short retry almost always sees the finished
 *  write instead. */
const RETRY_DELAY_MS = 50;

/**
 * Loads `filePath` (if given) and watches it for changes, hot-reloading on every change event. A
 * missing file, invalid JSON, or a schema mismatch is reported via `onError` and leaves the
 * previously-loaded map (or an empty one, on first load) in place rather than crashing the proxy.
 *
 * A failed read/parse gets one retry after `RETRY_DELAY_MS` before it is treated as real (see
 * `RETRY_DELAY_MS`'s own doc comment) — and even a failure that persists past the retry is only
 * ever reported once per "burst": `erroring` stays set until the next successful load, so a busy
 * host generating one `fs.watch` event per container spawn/stop no longer logs one error line per
 * event for what is, underneath, the same torn read repeating.
 */
export function createSourceMap(
  filePath: string | undefined,
  options: CreateSourceMapOptions = {},
): SourceMap {
  let entries: Record<string, SourcePolicy> = {};
  const onError =
    options.onError ??
    ((err: unknown) => {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'egress-proxy: source map load failed',
          error: String(err),
        }),
      );
    });

  const onPatternProblems =
    options.onPatternProblems ??
    ((problems: readonly SourcePatternProblem[]) => {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'egress-proxy: source map has allow/deny entries that can never match a host — an allow entry stays inert (fail-closed), a deny entry denies nothing; fix them',
          problems,
        }),
      );
    });

  let erroring = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPatternReport = '';

  function readOnce(): void {
    const raw = readFileSync(filePath as string, 'utf8');
    entries = SourceMapFileSchema.parse(JSON.parse(raw));
    erroring = false;
    const problems = findSourcePatternProblems(entries);
    const report = JSON.stringify(problems);
    if (report !== lastPatternReport) {
      lastPatternReport = report;
      if (problems.length > 0) onPatternProblems(problems);
    }
  }

  function load(): void {
    if (!filePath) return;
    try {
      readOnce();
    } catch {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        try {
          readOnce();
        } catch (err) {
          if (!erroring) {
            erroring = true;
            onError(err);
          }
        }
      }, RETRY_DELAY_MS);
    }
  }

  load();

  let watcher: FSWatcher | undefined;
  if (filePath) {
    try {
      watcher = watch(filePath, { persistent: false }, () => load());
    } catch (err) {
      onError(err);
    }
  }

  return {
    resolveSource(clientIp: string): SourcePolicy | undefined {
      return entries[clientIp];
    },
    close(): void {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      watcher?.close();
    },
  };
}
