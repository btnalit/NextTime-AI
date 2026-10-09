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
 * draft's field names are declarations (a JSON Schema's `properties.password`), not values.
 *
 * **Limits.** Over-counting is the accepted failure mode, as for the scrubs: a value that only
 * looks like a secret asks for one extra tick. An encoded secret (`base64`, split characters) is
 * not counted — pattern matching cannot tell it from other text; see `secret-values.ts`.
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

function countInto(value: unknown, secretFields: boolean): number {
  if (typeof value === 'string') return scrubSecretValues(value).redactedValues;
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    let count = 0;
    for (const item of value) count += countInto(item, secretFields);
    return count;
  }
  let count = 0;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (
      secretFields &&
      typeof inner === 'string' &&
      inner.trim() !== '' &&
      namesASecretValue(key)
    ) {
      count += 1;
    } else {
      count += countInto(inner, secretFields);
    }
  }
  return count;
}

/** How many secret-looking values `value` carries. Callers pass content already bounded by its
 *  schema (capability params, a stored draft). */
export function countSuspectedSecrets(
  value: unknown,
  options: SuspectedSecretsOptions = {},
): number {
  return countInto(value, options.secretFields === true);
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
 * `code = 'credentials_review_required'` and `details: { subject, suspectedSecretValues }`
 * (interfaces/http/capability-route.ts, interfaces/ws/rpc.ts), so the console can show the count
 * and the confirmation even where it did not know N beforehand.
 */
export class CredentialReviewRequiredError extends Error {
  readonly code = 'credentials_review_required' as const;
  readonly details: {
    readonly subject: CredentialReviewSubject;
    readonly suspectedSecretValues: number;
  };
  constructor(subject: CredentialReviewSubject, id: string, suspectedSecretValues: number) {
    super(
      `${subject} ${id} carries ${suspectedSecretValues} suspected credential value(s) — confirm with credentialsReviewed: true`,
    );
    this.name = 'CredentialReviewRequiredError';
    this.details = { subject, suspectedSecretValues };
  }
}

/** Throws `CredentialReviewRequiredError` when N > 0 and the caller did not confirm. */
export function assertCredentialsReviewed(
  subject: CredentialReviewSubject,
  id: string,
  suspectedSecretValues: number,
  credentialsReviewed: boolean | undefined,
): void {
  if (suspectedSecretValues > 0 && credentialsReviewed !== true) {
    throw new CredentialReviewRequiredError(subject, id, suspectedSecretValues);
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
  const suspectedSecretValues = countSuspectedSecrets(content, options);
  assertCredentialsReviewed(subject, id, suspectedSecretValues, actor.credentialsReviewed);
  return suspectedSecretValues;
}
