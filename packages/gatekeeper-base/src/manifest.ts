import { OperationSchema } from '@nexttime/shared';
import type { Operation } from '@nexttime/shared';

/**
 * Parses and validates a manifest file's contents against `OperationSchema` (review lane 5, P3
 * batch: manifests were loaded with a bare `JSON.parse` cast and no runtime validation at all — a
 * malformed or hand-edited manifest file surfaced only as a downstream failure the first time some
 * particular Operation was actually invoked, not at load time). Shared by this package's own
 * `main()`/`startGatekeeperServer` and by `gatekeepers/docker`/`gatekeepers/ragflow`'s own
 * `loadManifest`, so all three validate identically and report the same shape of error, naming the
 * source file and the offending entry's index/name — never a raw Zod issue dump.
 */
export function parseManifestJson(raw: string, source: string): Operation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `manifest "${source}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`manifest "${source}" must be a JSON array of Operations`);
  }
  return parsed.map((entry, index) => {
    const result = OperationSchema.safeParse(entry);
    if (!result.success) {
      const name =
        entry && typeof entry === 'object' && 'name' in entry
          ? String((entry as { name: unknown }).name)
          : '?';
      throw new Error(
        `manifest "${source}" entry ${index} (name: ${name}) failed OperationSchema validation: ${result.error.message}`,
      );
    }
    return result.data;
  });
}
