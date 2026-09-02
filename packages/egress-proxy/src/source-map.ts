import { type FSWatcher, readFileSync, watch } from 'node:fs';
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
});

const SourceMapFileSchema = z.record(z.string(), SourceEntrySchema);

export interface SourceMap {
  resolveSource(clientIp: string): SourcePolicy | undefined;
  close(): void;
}

export interface CreateSourceMapOptions {
  onError?: (err: unknown) => void;
}

/**
 * Loads `filePath` (if given) and watches it for changes, hot-reloading on every change event. A
 * missing file, invalid JSON, or a schema mismatch is reported via `onError` and leaves the
 * previously-loaded map (or an empty one, on first load) in place rather than crashing the proxy.
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

  function load(): void {
    if (!filePath) return;
    try {
      const raw = readFileSync(filePath, 'utf8');
      entries = SourceMapFileSchema.parse(JSON.parse(raw));
    } catch (err) {
      onError(err);
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
      watcher?.close();
    },
  };
}
