/**
 * egress-map: registers/unregisters spawned containers' IPs with `@nexttime/egress-proxy`'s
 * `SOURCE_MAP_FILE` (design doc §7.9 "来源 ip → WorkerRun / 入口会话由 supervisor 注册表解析"; that
 * package's own `admin.ts` — read as part of this task's research — serves only `GET /healthz`,
 * no registration endpoint, so the file is the actual, documented integration contract, not a
 * stand-in this task invents. Schema verified against `packages/egress-proxy/src/source-map.ts`
 * `SourceEntrySchema`: `{sourceId: string, allow?: string[], deny?: string[]}`, keyed by client IP.
 *
 * `sourceId` encoding: egress-proxy treats it as an opaque string it only ever echoes back into
 * `EgressObservation.sourceId` (`report.ts`'s own doc comment: "this proxy only ever knows a
 * request's sourceId ... never the workspaceId / activityId ... turning a sourceId into a
 * WorkerRun/entry-session Activity is the kernel host-bridge's job"). Since the real
 * `{workspaceId, principalId, sessionKind}` triple this task's dispatch describes has nowhere else
 * to live, it is packed into that one opaque string as `entry:<workspaceId>:<principalId>` — the
 * `entry:` prefix *is* `sessionKind` for this half (resident mode only ever spawns entry sessions).
 * The agent-host / kernel host-bridge half (S1.5's other dispatch) is expected to parse this
 * exact format back apart; documented here and in the PR body so that half doesn't have to
 * reverse-engineer it.
 *
 * Write semantics: plain `fs.writeFileSync` (open+truncate+write, no rename) — matching
 * `SOURCE_MAP_FILE`'s documented reload behavior (`source-map.ts`'s doc comment: `fs.watch` "fires
 * reliably on same-inode edits ... but not always on a replace-by-rename"). A rename-based atomic
 * write here would silently break egress-proxy's hot reload.
 */

import { readFileSync, writeFileSync } from 'node:fs';

export interface SourceMapEntry {
  readonly sourceId: string;
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export type SourceMapFile = Record<string, SourceMapEntry>;

export function entrySourceId(workspaceId: string, principalId: string): string {
  return `entry:${workspaceId}:${principalId}`;
}

export interface EgressMapStore {
  register(ip: string, entry: SourceMapEntry): void;
  unregister(ip: string): void;
  read(): SourceMapFile;
}

/** File-backed store. Read failures (missing file, invalid JSON) are treated as "start from
 *  empty" — `scripts/host-env-init.sh` (E2) always creates the file, but a fresh test fixture or
 *  a not-yet-bootstrapped host shouldn't crash the supervisor over it; the next successful write
 *  re-creates a valid file regardless. */
export function createEgressMapStore(filePath: string): EgressMapStore {
  function readFile(): SourceMapFile {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as SourceMapFile;
      }
      return {};
    } catch {
      return {};
    }
  }

  function writeFile(map: SourceMapFile): void {
    writeFileSync(filePath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  }

  return {
    register(ip: string, entry: SourceMapEntry): void {
      const map = readFile();
      map[ip] = entry;
      writeFile(map);
    },
    unregister(ip: string): void {
      const map = readFile();
      if (ip in map) {
        delete map[ip];
        writeFile(map);
      }
    },
    read(): SourceMapFile {
      return readFile();
    },
  };
}
