import {
  HIGH_CONFIDENCE_SECRET_PATTERNS,
  type RedactSecretsOptions,
  namesASecretField,
  redactSecrets,
  scrubSecretValues,
} from './secret-values.js';

/**
 * governance/redaction/credential-review: a person confirms suspected credentials before content
 * an agent can write takes effect (maintainer decision 2026-10-09, "二次确认").
 *
 * **What is counted.** The secret-looking values in the content a decision makes take effect: an
 * ActionRequest's `params` on `approve`, a draft's content on `publish_*`. The detector is this
 * module's own `secret-values.ts` — the same patterns that scrub a Turn's live stream, its stored
 * tool calls and reply (#520), the audit copy of every call's params and a Worker's report — so
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
 *
 * **The same rule elsewhere.** The audit copy of every capability call's params, on every channel,
 * is the content with exactly these values replaced (`redactSuspectedSecrets`, call-argument rule;
 * `application/gateway/dispatch.ts`'s `auditParams`). An observe-class Operation's params, which
 * no decision reads, are reviewed when the call is made (`reviewObserveParams`, legacy 175): a
 * value that is almost certainly a credential is refused, every other suspected value is recorded
 * in the audit row.
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

/** One walk of the redactor (`redactSecrets`) with `rule`, keeping where values were replaced.
 *  Every function below is this walk, so a count, its paths and a redacted copy of the same
 *  content always agree. Callers pass content already bounded by its schema (capability params, a
 *  stored draft), so the walk is unbounded. */
function detect(
  value: unknown,
  rule: Pick<RedactSecretsOptions, 'isSecretKey' | 'schemaLiterals' | 'patterns'>,
): SuspectedSecrets & { readonly value: unknown } {
  const paths: string[] = [];
  const redacted = redactSecrets(value, {
    ...rule,
    maxNodes: Number.POSITIVE_INFINITY,
    pathKey: segment,
    onRedacted: (path) => {
      if (paths.length < MAX_PATHS && !paths.includes(path)) paths.push(path);
    },
  });
  return { value: redacted.value, count: redacted.redactedValues, paths };
}

function suspectedSecretsRule(
  options: SuspectedSecretsOptions,
): Pick<RedactSecretsOptions, 'isSecretKey' | 'schemaLiterals'> {
  return {
    ...(options.secretFields === true ? { isSecretKey: namesASecretField } : {}),
    schemaLiterals: true,
  };
}

/** The secret-looking values `value` carries, and where. It is the redactor's own walk
 *  (`redactSecrets`), so what is counted is exactly what a scrub of the same content replaces —
 *  and, with `secretFields`, every value the console masks (`maskSecretFields`, the same
 *  `namesASecretField` rule). */
export function findSuspectedSecrets(
  value: unknown,
  options: SuspectedSecretsOptions = {},
): SuspectedSecrets {
  const { count, paths } = detect(value, suspectedSecretsRule(options));
  return { count, paths };
}

/** `value` with every suspected secret `findSuspectedSecrets` counts (same options) replaced by
 *  `[redacted]`, its shape kept — the copy a record keeps when the original must not be: the audit
 *  copy of every capability call's params (`application/gateway/dispatch.ts`). The count and the
 *  paths are those of the same walk. */
export function redactSuspectedSecrets(
  value: unknown,
  options: SuspectedSecretsOptions = {},
): SuspectedSecrets & { readonly value: unknown } {
  return detect(value, suspectedSecretsRule(options));
}

/** The audit copy of caller-supplied fields an audit row carries outside its `params` — a
 *  person's approve / reject reason, a chat's old and new title, a connection request's target —
 *  under the same rule as the `params` copy (`redactSuspectedSecrets`, call-argument rule). Pass
 *  only those fields, never a whole payload: a payload's own fields (`credentialReview`,
 *  `suspectedSecretValues`) are named after secrets and would be replaced. */
export function redactedForAudit(fields: Record<string, unknown>): Record<string, unknown> {
  return redactSuspectedSecrets(fields, { secretFields: true }).value as Record<string, unknown>;
}

/** Only the values that are almost certainly a credential themselves, whatever field holds them
 *  (`HIGH_CONFIDENCE_SECRET_PATTERNS`: a PEM private key, a JWT, a vendor key, an issued-looking
 *  `Bearer` value, a URL's literal password), with no field-name rule. For refusing content
 *  outright: a field's name alone (`pageToken`, `accessKeyId`) is too often an ordinary cursor or
 *  id, and the other value patterns hit ordinary query text (`|= "Authorization: failed"`,
 *  `token=expired`, `--password=$VAR`). Whatever this finds, `findSuspectedSecrets` finds too. */
export function findCredentialValues(value: unknown): SuspectedSecrets {
  const { count, paths } = detect(value, { patterns: HIGH_CONFIDENCE_SECRET_PATTERNS });
  return { count, paths };
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

/**
 * An observe-class Operation's params carrying a value that is almost certainly a credential,
 * whatever field holds it (`findCredentialValues`: a PEM private key, a JWT, a vendor key, an
 * issued-looking `Bearer` value, a URL's literal password). Refused before anything reaches the
 * gate: an observation runs with no approval (design doc §11 "观察免审"), so nobody would see a
 * credential an agent was talked into sending. A gate authenticates with the credentials
 * configured on it, never with one in a call's params. Maps to HTTP 400 / WS invalid-params with
 * `code = 'credentials_in_observe_params'` and `details: { suspectedSecretValues,
 * suspectedSecretPaths }` — paths within the Operation's params, never a fragment of a value.
 */
export class ObserveParamsCarryCredentialsError extends Error {
  readonly code = 'credentials_in_observe_params' as const;
  readonly details: {
    readonly suspectedSecretValues: number;
    readonly suspectedSecretPaths: readonly string[];
  };
  constructor(gateName: string, operation: string, found: SuspectedSecrets) {
    const where = found.paths.length > 0 ? ` (at ${found.paths.join(', ')})` : '';
    super(
      `${gateName}.${operation}: the params carry ${found.count} credential value(s)${where} (a JWT, a vendor API key, a private key, a literal Bearer token or a URL's password) — refused, nothing was sent to the gate. Do not pass credentials as Operation params: the gate authenticates with the credentials configured on it. Text that only mentions one is fine (an Authorization header name, token=expired, a $VAR placeholder).`,
    );
    this.name = 'ObserveParamsCarryCredentialsError';
    this.details = { suspectedSecretValues: found.count, suspectedSecretPaths: found.paths };
  }
}

/**
 * The credential review of an observe-class Operation's params (legacy 175), run by both ways in
 * — `observe_operation` and `request_action`'s observe branch, through `request-action-handler.ts`'s
 * `runObserve` — before anything else, on every channel (the rule is about the content):
 *   - a value that is almost certainly a credential whatever holds it is refused
 *     (`findCredentialValues`, `ObserveParamsCarryCredentialsError`);
 *   - every other suspected value passes, and the audit row records how many and where
 *     (`findSuspectedSecrets`, call-argument rule): one under a secret-named field (`pageToken`,
 *     `nextPageToken`, `secretName`, `accessKeyId` — as often an ordinary cursor or resource id),
 *     and one only the text patterns hit — observe params are mostly query text, where
 *     `|= "Authorization: failed"`, `level=error token=expired`, `Authorization: Bearer $TOKEN`
 *     and `--password=$MYSQL_PWD` are searches and placeholders, not credentials.
 * Returns the audit payload fields: `credentialReview: { suspectedSecretValues,
 * suspectedSecretPaths }` (count and paths within the params, the same as an ActionRequest's), or
 * nothing when no value is suspect. Unlike an approval's `credentialReview`, it has no
 * `confirmed`: an observation asks nobody.
 */
export function reviewObserveParams(
  gateName: string,
  operation: string,
  params: unknown,
): Record<string, unknown> {
  const refused = findCredentialValues(params);
  if (refused.count > 0) {
    throw new ObserveParamsCarryCredentialsError(gateName, operation, refused);
  }
  const found = findSuspectedSecrets(params, { secretFields: true });
  return found.count > 0
    ? {
        credentialReview: {
          suspectedSecretValues: found.count,
          suspectedSecretPaths: found.paths,
        },
      }
    : {};
}
