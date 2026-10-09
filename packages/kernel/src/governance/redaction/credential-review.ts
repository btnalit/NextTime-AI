import { namesASecretField, redactSecrets, scrubSecretValues } from './secret-values.js';

/**
 * governance/redaction/credential-review: a person confirms suspected credentials before content
 * an agent can write takes effect (maintainer decision 2026-10-09, "二次确认").
 *
 * **What is counted.** The secret-looking values in the content a decision makes take effect: an
 * ActionRequest's `params` on `approve`, a draft's content on `publish_*`. The detector is this
 * module's own `secret-values.ts` — the same patterns that scrub a Turn's live stream, its stored
 * tool calls and reply (#520), the audit copy of a Handle-channel call and a Worker's report — so
 * "suspected" means one thing everywhere; the count is that redactor's own walk (`redactSecrets`),
 * so it counts exactly what a scrub replaces, at any depth, inside a JSON string's `"apiKey": "…"`
 * pairs included. Call arguments also count every string or number under a field whose name names
 * a secret (`password`, `apiKey0`, `x-api-key`, `tokenValue` — `@nexttime/shared`'s
 * `namesASecretField`, which keeps `maxTokens` / `tokenCount` / `tokenizer` out), at any depth:
 * that is the rule the console masks by (`maskSecretFields`), so every `[redacted]` an approver
 * sees is a counted value. A draft does not, because a draft's field names are declarations (a
 * JSON Schema's `properties.password`), not values. Both count the literals a schema carries for a
 * secret-named property (`default`, `const`, `enum`, `examples`, `example` under
 * `properties.apiKey`, an object or array literal walked into).
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
  /** Also count every secret value under a field whose name names a secret — for call
   *  arguments, which fill fields. Leave off for a document, which declares them. */
  readonly secretFields?: boolean;
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

/** What the detector found: the exact count, and where (dot paths, `[i]` for array items, at most
 *  20) — the field names only, never a fragment of a value. */
export interface SuspectedSecrets {
  readonly count: number;
  readonly paths: readonly string[];
}

/** The secret-looking values `value` carries, and where. It is the redactor's own walk
 *  (`redactSecrets`), so what is counted is exactly what a scrub of the same content replaces —
 *  and, with `secretFields`, every value the console masks (`maskSecretFields`, the same
 *  `namesASecretField` rule). Callers pass content already bounded by its schema (capability
 *  params, a stored draft), so the walk is unbounded. */
export function findSuspectedSecrets(
  value: unknown,
  options: SuspectedSecretsOptions = {},
): SuspectedSecrets {
  const paths: string[] = [];
  const { redactedValues } = redactSecrets(value, {
    ...(options.secretFields === true ? { isSecretKey: namesASecretField } : {}),
    schemaLiterals: true,
    maxNodes: Number.POSITIVE_INFINITY,
    pathKey: segment,
    onRedacted: (path) => {
      if (paths.length < MAX_PATHS && !paths.includes(path)) paths.push(path);
    },
  });
  return { count: redactedValues, paths };
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
