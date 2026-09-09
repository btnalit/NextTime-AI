/**
 * redact: sanitization applied to a process's command line before it is ever placed into an
 * Observation (docs/development-tasks.md S3.3 deliverable 2: "command lines / env-like strings
 * redact --token=…/password=…/key=…/bearer strings → ***; environ is never read; if a redaction
 * pattern throws or a value still matches a secret pattern after redaction, the WHOLE batch is
 * dropped and the run exits non-zero (acceptance: '脱敏失败整批不提交')").
 *
 * Scope: this module sanitizes exactly one shape of string — a process command line (`argv`
 * joined with spaces, `process-tree.ts`'s own output) — not every string this collector ever
 * produces. Container ids, image digests, git commit hashes, and similar long structural
 * identifiers are legitimate, non-secret data this collector's payload is *expected* to carry in
 * quantity; running the same "still looks like a secret" heuristic against them would make the
 * collector non-functional (a 64-hex-char container id or `sha256:...` image digest is
 * indistinguishable from an opaque token by shape alone). `environ` (`/proc/<pid>/environ`) is
 * never read anywhere in this package — grep `packages/*.ts` for `environ` to confirm — so no
 * redaction step is needed for it; it simply never enters this collector's data at all.
 *
 * Two-tier defense, both fail closed (throw, never silently pass through unredacted text):
 *   1. Structural redaction (`redactCommandLine`): replaces `--token=X` / `token=X` / `token: X` /
 *      `token X` / `password=X` / `key=X` (case-insensitive, optionally `--`-prefixed, quoted or
 *      bare values) and `Bearer <token>` with a fixed `***` marker — the exact four patterns the
 *      task names.
 *   2. Residual-secret sniff (`assertNoResidualSecret`): re-scans the *already-redacted* text for
 *      anything that still looks like a live secret independent of a preceding key name — a
 *      JWT-shaped three-part token, or any other long opaque (base64/hex/UUID-shaped) run of 32+
 *      characters. This is deliberately broad and will also flag a legitimate long non-secret
 *      argument (a UUID, a long hash) that happens to appear in a process's own command line with
 *      no recognizable secret key name near it — an intentional, documented trade-off: this
 *      collector would rather drop a whole batch on a false positive than ever risk shipping one
 *      real secret CLI tier 1 missed. This is exactly what the acceptance criterion's "value that
 *      resists redaction" case tests.
 */

const KEY_VALUE_SECRET_PATTERN = /(--)?(token|password|passwd|key)([=: ]+)("[^"]*"|'[^']*'|\S+)/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s"']+/gi;

/** A JWT's three base64url segments joined by `.` — matches regardless of a preceding key name. */
const JWT_SHAPE_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/;

/** Any other long opaque run (base64/hex/UUID-shaped) — see this module's own doc comment for why
 *  this is intentionally broad and applied only to command-line text, never to structural ids. */
const HIGH_ENTROPY_RUN_PATTERN = /\b[A-Za-z0-9+/_-]{32,}\b/;

export class SecretRedactionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecretRedactionError';
  }
}

/** Tier 1 — structural key=value / Bearer redaction. Never throws on its own (a pure string
 *  transform); the two named failure modes ("pattern throws", "still matches after redaction")
 *  are both surfaced by `sanitizeCommandLine` below, which is the function every real caller uses. */
export function redactCommandLine(commandLine: string): string {
  return commandLine
    .replace(
      KEY_VALUE_SECRET_PATTERN,
      (_match, dash: string | undefined, key: string, sep: string) => {
        const prefix = dash ?? '';
        return `${prefix}${key}${sep}***`;
      },
    )
    .replace(BEARER_PATTERN, 'Bearer ***');
}

/** Tier 2 — throws `SecretRedactionError` if `redacted` (the *output* of `redactCommandLine`)
 *  still contains anything that looks like a live secret. */
function assertNoResidualSecret(redacted: string): void {
  if (JWT_SHAPE_PATTERN.test(redacted) || HIGH_ENTROPY_RUN_PATTERN.test(redacted)) {
    throw new SecretRedactionError(
      'redact: command line still matches a secret-shaped pattern after redaction',
    );
  }
}

/**
 * The one function every real caller uses: redacts `commandLine`, then verifies the result no
 * longer matches either tier — throws `SecretRedactionError` on any failure (a thrown redaction
 * pattern, wrapped and rethrown as this same class, or a residual match). Never returns a value a
 * caller could mistake for "safe" without having gone through both checks.
 */
export function sanitizeCommandLine(commandLine: string): string {
  let redacted: string;
  try {
    redacted = redactCommandLine(commandLine);
  } catch (err) {
    throw new SecretRedactionError(
      'redact: redaction pattern threw while sanitizing a command line',
      {
        cause: err,
      },
    );
  }
  assertNoResidualSecret(redacted);
  return redacted;
}

/**
 * Sanitizes every process's `commandLine` in `processes`. On the *first* failure anywhere in the
 * batch, throws immediately (no partial/best-effort output) — the caller (`run.ts`) treats any
 * throw here as "drop the whole batch, exit non-zero" (the acceptance criterion's own wording).
 * `identity`/`index` are carried only for the error message, so an operator can see which process
 * entry failed without this module needing to know anything about the Process ObjectType shape.
 */
export function sanitizeCommandLines<T extends { readonly commandLine: string }>(
  processes: readonly T[],
): T[] {
  return processes.map((process, index) => {
    try {
      return { ...process, commandLine: sanitizeCommandLine(process.commandLine) };
    } catch (err) {
      throw new SecretRedactionError(
        `redact: sanitization failed for process entry #${index} — dropping the whole batch`,
        { cause: err },
      );
    }
  });
}
