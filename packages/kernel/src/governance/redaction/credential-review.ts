import { namesASecretValue, scrubSecretValues } from './secret-values.js';

/**
 * governance/redaction/credential-review: a person confirms suspected credentials before content
 * an agent can write takes effect (maintainer decision 2026-10-09, "二次确认").
 *
 * **What is counted.** The secret-looking values in the content a decision makes take effect: an
 * ActionRequest's `params` on `approve`, a draft's content on `publish_*`. The detector is this
 * module's own `secret-values.ts` — the same patterns that scrub a Turn's live stream, its stored
 * tool calls and reply (#520), the audit copy of a Handle-channel call and a Worker's report — so
 * "suspected" means one thing everywhere. Call arguments also count a non-blank string under a
 * field whose name names a secret (`password`, `apiKey`, `X-Api-Key` — `namesASecretValue`,
 * whose last-word rule keeps `max_tokens` / `tokenCount` out); a draft does not, because a
 * draft's field names are declarations (a JSON Schema's `properties.password`), not values. Both
 * count the literals a schema carries for a secret-named property (`default`, `const`, `enum`,
 * `examples`, `example` under `properties.apiKey`).
 *
 * **Limits.** Over-counting is the accepted failure mode, as for the scrubs: a value that only
 * looks like a secret asks for one extra tick. An encoded secret (`base64`, split characters), or a
 * bare one inside free text no pattern knows (a CLI template's `mysql -phunter2`), is not counted —
 * pattern matching cannot tell it from other text; see `secret-values.ts`.
 *
 * **What is enforced.** Counting happens on the server at decision time, on the row or draft the
 * decision reads under its own lock or transaction — never a count the client sent. With N > 0
 * the call must carry `credentialsReviewed: true` (`CredentialReviewRequiredError` otherwise), and
 * the audit row records N with the confirmation (`credentialReviewAudit`). Nothing is rewritten:
 * replacing a value would change what runs.
 */

export interface SuspectedSecretsOptions {
  /** Also count a non-blank string under a field whose name names a secret — for call arguments.
   *  Leave off for a document. */
  readonly secretFields?: boolean;
}

/** JSON Schema / OpenAPI keywords whose values are literal instances of the property they sit
 *  under — `properties.apiKey.default: "…"` is a value even in a document. */
const SCHEMA_VALUE_KEYWORDS = new Set(['default', 'const', 'enum', 'examples', 'example']);

function countLiterals(value: unknown): number {
  if (typeof value === 'string') return value.trim() === '' ? 0 : 1;
  if (Array.isArray(value)) {
    let count = 0;
    for (const item of value) count += countLiterals(item);
    return count;
  }
  return 0;
}

/** At most this many paths go on the wire — the count stays exact. */
const MAX_PATHS = 20;
const MAX_SEGMENT_CHARS = 64;

/** A path segment as the console shows it. Field names come from the content (an agent's call
 *  arguments), so a name that itself looks like a secret is scrubbed and a long one cut. */
function segment(key: string): string {
  const scrubbed = scrubSecretValues(key).value;
  return scrubbed.length > MAX_SEGMENT_CHARS
    ? `${scrubbed.slice(0, MAX_SEGMENT_CHARS)}…`
    : scrubbed;
}

function join(path: string, key: string): string {
  return path === '' ? segment(key) : `${path}.${segment(key)}`;
}

interface Walk {
  count: number;
  readonly paths: string[];
}

function note(walk: Walk, path: string, count: number): void {
  if (count <= 0) return;
  walk.count += count;
  if (walk.paths.length < MAX_PATHS && !walk.paths.includes(path)) walk.paths.push(path);
}

function walkInto(
  walk: Walk,
  value: unknown,
  path: string,
  secretFields: boolean,
  underSecretName: boolean,
): void {
  if (typeof value === 'string') {
    note(walk, path, scrubSecretValues(value).redactedValues);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkInto(walk, item, `${path}[${index}]`, secretFields, false));
    return;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const secretName = namesASecretValue(key);
    const innerPath = join(path, key);
    if (secretFields && typeof inner === 'string' && inner.trim() !== '' && secretName) {
      note(walk, innerPath, 1);
    } else if (underSecretName && SCHEMA_VALUE_KEYWORDS.has(key)) {
      // A literal the schema itself carries for a secret-named property: counted whether or not
      // the pattern list recognises it (a bare `hunter2` matches none).
      note(walk, innerPath, countLiterals(inner));
    } else {
      walkInto(walk, inner, innerPath, secretFields, secretName);
    }
  }
}

/** What the detector found: the exact count, and where (dot paths, `[i]` for array items, at most
 *  20) — the field names only, never a fragment of a value. */
export interface SuspectedSecrets {
  readonly count: number;
  readonly paths: readonly string[];
}

/** The secret-looking values `value` carries, and where. Callers pass content already bounded by
 *  its schema (capability params, a stored draft). */
export function findSuspectedSecrets(
  value: unknown,
  options: SuspectedSecretsOptions = {},
): SuspectedSecrets {
  const walk: Walk = { count: 0, paths: [] };
  walkInto(walk, value, '', options.secretFields === true, false);
  return { count: walk.count, paths: walk.paths };
}

/** How many secret-looking values `value` carries. */
export function countSuspectedSecrets(
  value: unknown,
  options: SuspectedSecretsOptions = {},
): number {
  return findSuspectedSecrets(value, options).count;
}

/** What a decision makes take effect, for the error message and the console's copy. */
export type CredentialReviewSubject =
  | 'action_request'
  | 'operation'
  | 'skill'
  | 'procedure'
  | 'worker_definition';

/**
 * A decision whose content carries suspected credentials (N > 0), sent without
 * `credentialsReviewed: true`. Maps to HTTP 400 / WS invalid-params with
 * `code = 'credentials_review_required'` and
 * `details: { subject, suspectedSecretValues, suspectedSecretPaths }`
 * (interfaces/http/capability-route.ts, interfaces/ws/rpc.ts), so the console can show the count
 * and the confirmation even where it did not know N beforehand.
 */
export class CredentialReviewRequiredError extends Error {
  readonly code = 'credentials_review_required' as const;
  readonly details: {
    readonly subject: CredentialReviewSubject;
    readonly suspectedSecretValues: number;
    readonly suspectedSecretPaths: readonly string[];
  };
  constructor(subject: CredentialReviewSubject, id: string, found: SuspectedSecrets) {
    super(
      `${subject} ${id} carries ${found.count} suspected credential value(s) — confirm with credentialsReviewed: true`,
    );
    this.name = 'CredentialReviewRequiredError';
    this.details = {
      subject,
      suspectedSecretValues: found.count,
      suspectedSecretPaths: found.paths,
    };
  }
}

/** Throws `CredentialReviewRequiredError` when N > 0 and the caller did not confirm. */
export function assertCredentialsReviewed(
  subject: CredentialReviewSubject,
  id: string,
  found: SuspectedSecrets,
  credentialsReviewed: boolean | undefined,
): void {
  if (found.count > 0 && credentialsReviewed !== true) {
    throw new CredentialReviewRequiredError(subject, id, found);
  }
}

/** The audit payload fields of a confirmed review — empty when there was nothing to confirm, so
 *  an ordinary decision's audit row is unchanged. The actor is the audit row's own actor. */
export function credentialReviewAudit(suspectedSecretValues: number): Record<string, unknown> {
  return suspectedSecretValues > 0
    ? { credentialReview: { suspectedSecretValues, confirmed: true } }
    : {};
}

/** `publish_*`: counts a draft's suspected credentials and requires the publisher's confirmation.
 *  Only a person's call is checked (`actor` present) — internal callers publish content the
 *  kernel wrote itself (a workspace's default entry definition) and have nobody to confirm.
 *  Returns the count, for the caller's audit row. */
export function assertDraftCredentialsReviewed(
  subject: CredentialReviewSubject,
  id: string,
  content: unknown,
  actor: { readonly credentialsReviewed?: boolean } | undefined,
  options: SuspectedSecretsOptions = {},
): number {
  if (actor === undefined) return 0;
  const found = findSuspectedSecrets(content, options);
  assertCredentialsReviewed(subject, id, found, actor.credentialsReviewed);
  return found.count;
}
