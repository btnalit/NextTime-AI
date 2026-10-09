/**
 * governance/redaction/secret-values: the kernel's one definition of "a value that looks like a
 * secret", and the scrubs that keep one out of anything an agent produced before a person sees it.
 *
 * **Why the kernel scrubs.** An agent container runs pi's built-in `bash`/`read` next to its own
 * Handle (`CAPABILITY_HANDLE` in its environment), and the model can be talked — by a user or by an
 * injected instruction — into printing it: in a tool result, in its reply, in a streamed delta, in
 * a Worker's report. A Handle is a bearer token the kernel accepts on its `/api` routes, so whoever
 * reads it can act as that agent's principal until it expires. The kernel is the trust boundary,
 * so every path that hands agent output to a person scrubs it here; the console's own
 * `redactSensitive` is display-only and matches keys, not values.
 *
 * **What this cannot do.** It catches a secret printed as it is. An agent that encodes it first
 * (`base64`, one character per line, spaces between characters) gets it through — pattern matching
 * cannot tell an encoded Handle from any other text. This is defence in depth against accidental
 * output; the fix for deliberate exfiltration is the Handle itself (its scope, its lifetime, and
 * keeping it out of the model's reach), a separate design item.
 *
 * What is replaced inside any string:
 *   - a PEM private key; an `Authorization` / `Cookie` header's value (the rest of the line);
 *   - a compact JWT (a Handle is one); a `Bearer`/`Basic` credential;
 *   - a vendor key with a well-known prefix;
 *   - the value of an upper-case env assignment whose name names a secret anywhere (`PGPASSWORD=`,
 *     `CAPABILITY_HANDLE=`, quoted or not);
 *   - the value of a `name: value` / `name=value` whose name's last word names a secret (YAML,
 *     `.ini`, query strings, `X-Api-Key:` — `max_tokens=1024` stays), and of a `--password value`
 *     style flag;
 *   - the password in a `scheme://user:password@host` URL;
 *   - the value of a quoted `"…token…": "…"` pair inside text that is itself JSON.
 * Over-redaction is the accepted failure mode: a value that only looks like a secret is hidden.
 *
 * **Linear time.** These run synchronously on the kernel's event loop over model and tool output,
 * so every pattern is written to run in time linear in its input: a pattern may only start where
 * the run of characters it scans begins (a lookbehind, not `\b`, where its class holds non-word
 * characters), every scan before a required delimiter is bounded or stops at a character outside
 * its class, and a name is matched as a whole run and judged afterwards rather than by nested
 * quantifiers. The adversarial inputs in secret-values.test.ts hold this. Callers bound what they
 * pass on top of that (`redactSecrets`'s `maxChars`, the chat sink's own limits).
 *
 * Users: application/chat (a Turn's tool calls, the stored reply), application/gateway (the audit
 * copy of every Handle-channel call's params, a Worker's result report) and, for a stream,
 * `secret-stream.ts`.
 */

export const REDACTED = '[redacted]';
/** What replaces a part of a structured value left out because it was past a walk bound. */
export const OMITTED = '[…]';

/** Nodes of a structured value visited before the rest is left out. */
export const MAX_WALK_NODES = 5_000;

/** A field name that names a secret wherever the word appears — for a structured key or a JSON
 *  key, which are field names, not prose. Same family as the console's `SENSITIVE_KEY`
 *  (packages/web/src/lib/format.ts), plus `handle`: a field named after a Handle carries one. */
export const SECRET_FIELD_NAME =
  /credential|secret|token|password|passwd|api[_-]?key|authorization|private[_-]?key|^handle$|capability[_-]?handle/i;

/** An upper-case env name with a secret word anywhere in it (`PGPASSWORD`, `CAPABILITY_HANDLE`). */
const ENV_SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?|HANDLE/;

/** A name whose last word names a secret — for `name: value` in free text, where `max_tokens` and
 *  `tokenCount` must stay. Run on a name of at most 64 characters. */
const LAST_WORD_SECRET_NAME =
  /(?:^|[_.-])(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|credentials?)$/i;
const CAMEL_CASE_SECRET_NAME =
  /[a-z0-9](?:Password|Passwd|Secret|Token|ApiKey|AccessKey|SecretKey|PrivateKey|ClientSecret|Credentials?)$/;

function namesASecret(name: string): boolean {
  return LAST_WORD_SECRET_NAME.test(name) || CAMEL_CASE_SECRET_NAME.test(name);
}

/** Whether `name` in `name=value` / `name: value` (or a `--name` flag, without its dashes) is one
 *  whose value the patterns below replace — for `secret-stream.ts`, which must hold such a value
 *  back until it ends. */
export function namesASecretValue(name: string): boolean {
  return namesASecret(name) || (/^[A-Z][A-Z0-9_]*$/.test(name) && ENV_SECRET_NAME.test(name));
}

/** A `Bearer`/`Basic` value that looks issued rather than like the next English word ("Basic
 *  configuration"): it has a digit, or is long. */
function looksIssued(value: string): boolean {
  return /\d/.test(value) || value.length >= 20;
}

/** `value` replaced, its quotes kept. */
function redactedValue(value: string): string {
  const quote = value.charAt(0);
  return (quote === '"' || quote === "'") && value.length >= 2
    ? `${quote}${REDACTED}${quote}`
    : REDACTED;
}

/** Returns the replacement for one match, or `undefined` to keep it as it is. */
type Redact = (match: string, groups: readonly (string | undefined)[]) => string | undefined;

interface ValuePattern {
  readonly pattern: RegExp;
  readonly redact: Redact;
}

/** A value after `=`/`:` — quoted to its closing quote on the same line, or a bare run (to the
 *  next space or quote; in a `name: value` also to the next `&`, a query string's separator). */
const ENV_VALUE = String.raw`("[^"\r\n]*"|'[^'\r\n]*'|[^\s'"]+)`;
const VALUE = String.raw`("[^"\r\n]*"|'[^'\r\n]*'|[^\s'"&]+)`;
const NOT_ALREADY_REDACTED = String.raw`(?!["']?\[redacted\])`;

/** Applied in order to every string; each is global. Exported for `secret-stream.ts`, which must
 *  know where a match starts and ends. */
export const SECRET_VALUE_PATTERNS: readonly ValuePattern[] = [
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
    redact: () => REDACTED,
  },
  // `Authorization: token …`, `Cookie: a=1; b=2` — the whole value, to the end of the line.
  {
    pattern:
      /(?<![A-Za-z0-9-])((?:proxy-)?authorization|(?:set-)?cookie)([ \t]{0,8}:[ \t]{0,8})(?!\[redacted\])[^\r\n]+/gi,
    redact: (_match, [name, separator]) => `${name}${separator}${REDACTED}`,
  },
  // A compact JWS/JWT: three base64url segments, the first a JSON header (`{"` → `eyJ`). Starts
  // only where a base64url run starts — `\b` would also start after every `-` inside one.
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    redact: () => REDACTED,
  },
  {
    pattern: /\b(Bearer|Basic)([ \t]{1,16})([A-Za-z0-9._~+/=-]{8,})/gi,
    redact: (_match, [scheme, space, value]) =>
      value !== undefined && looksIssued(value) ? `${scheme}${space}${REDACTED}` : undefined,
  },
  {
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{30,})/g,
    redact: () => REDACTED,
  },
  // `PGPASSWORD=…`, `export API_TOKEN="…"` — an `env` / `.env` line. Upper case only, the env-var
  // convention; the name is matched whole and judged afterwards.
  {
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{0,127})=${NOT_ALREADY_REDACTED}${ENV_VALUE}`,
      'g',
    ),
    redact: (_match, [name, value]) =>
      name !== undefined && value !== undefined && ENV_SECRET_NAME.test(name)
        ? `${name}=${redactedValue(value)}`
        : undefined,
  },
  // `password: …`, `POSTGRES_PASSWORD: …`, `aws_secret_access_key = …`, `X-Api-Key: …`,
  // `?token=…` — any case, the name's last word decides.
  {
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]{0,63})(["']?)([ \t]{0,8}[:=][ \t]{0,8})${NOT_ALREADY_REDACTED}${VALUE}`,
      'g',
    ),
    redact: (_match, [name, quote, separator, value]) =>
      name !== undefined && value !== undefined && namesASecret(name)
        ? `${name}${quote ?? ''}${separator ?? ''}${redactedValue(value)}`
        : undefined,
  },
  // `--password hunter2`, `--api-key=…`.
  {
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9-])(--[A-Za-z][A-Za-z0-9-]{0,63})(=|[ \t]{1,8})${NOT_ALREADY_REDACTED}${VALUE}`,
      'g',
    ),
    redact: (_match, [flag, separator, value]) =>
      flag !== undefined && value !== undefined && namesASecret(flag.slice(2))
        ? `${flag}${separator ?? ''}${redactedValue(value)}`
        : undefined,
  },
  // `scheme://user:password@host` — keeps the user, drops the password.
  {
    pattern:
      /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,256}):(?!\[redacted\]@)[^\s/@]{1,256}@/g,
    redact: (_match, [prefix]) => `${prefix}:${REDACTED}@`,
  },
  // `"api_key": "…"` inside a string that is itself JSON text (a capability tool's result text).
  {
    pattern: /"([^"\\\r\n]{1,128})"([ \t]{0,8}:[ \t]{0,8})"((?:[^"\\\r\n]|\\.)*)"/g,
    redact: (_match, [key, separator, value]) =>
      key !== undefined && value !== REDACTED && SECRET_FIELD_NAME.test(key)
        ? `"${key}"${separator}"${REDACTED}"`
        : undefined,
  },
];

/** A scrubbed value and how many values in it were replaced. */
export interface Scrubbed<T> {
  readonly value: T;
  readonly redactedValues: number;
}

interface WalkState {
  count: number;
  nodes: number;
  chars: number;
  omitted: boolean;
}

/** How many capture groups each pattern has — so a replacement callback can take its groups
 *  without searching its arguments. */
const GROUP_COUNTS: readonly number[] = SECRET_VALUE_PATTERNS.map(
  ({ pattern }) => (new RegExp(`${pattern.source}|`).exec('')?.length ?? 1) - 1,
);

function scrubInto(text: string, state: WalkState): string {
  let out = text;
  SECRET_VALUE_PATTERNS.forEach(({ pattern, redact }, index) => {
    const groupCount = GROUP_COUNTS[index] ?? 0;
    out = out.replace(pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      const replacement = redact(match, args.slice(1, 1 + groupCount) as (string | undefined)[]);
      if (replacement === undefined) return match;
      state.count += 1;
      return replacement;
    });
  });
  return out;
}

function freshState(options: RedactSecretsOptions = {}): WalkState {
  return {
    count: 0,
    nodes: options.maxNodes ?? MAX_WALK_NODES,
    chars: options.maxChars ?? Number.POSITIVE_INFINITY,
    omitted: false,
  };
}

/** `text` with every secret-looking value replaced. Linear in `text`; a caller holding text of
 *  unbounded size bounds it first. */
export function scrubSecretValues(text: string): Scrubbed<string> {
  const state = freshState();
  return { value: scrubInto(text, state), redactedValues: state.count };
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface RedactSecretsOptions {
  /** A key whose value is replaced whole, whatever it is (a tool's `password` argument, say).
   *  Absent: only values are scrubbed, every key and the shape are kept. */
  readonly isSecretKey?: (key: string) => boolean;
  /** Objects and arrays visited before the rest is left out (`OMITTED`). Defaults to
   *  `MAX_WALK_NODES`, for a value nothing has bounded yet (a runtime's tool result); a caller that
   *  writes the result back as structured data passes `Infinity` for a value already validated and
   *  bounded upstream (capability params, at most 1 MiB). */
  readonly maxNodes?: number;
  /** Characters of string content read in all; a string past the budget is cut (ending in `…`)
   *  or left out. Defaults to no bound — for display, pass one. */
  readonly maxChars?: number;
}

export interface RedactedValue extends Scrubbed<unknown> {
  /** Whether anything was cut or left out to stay within `maxNodes` / `maxChars`. */
  readonly omitted: boolean;
}

function redactInto(value: unknown, options: RedactSecretsOptions, state: WalkState): unknown {
  if (typeof value === 'string') {
    if (value.length <= state.chars) {
      state.chars -= value.length;
      return scrubInto(value, state);
    }
    state.omitted = true;
    if (state.chars <= 0) return OMITTED;
    const head = value.slice(0, state.chars);
    state.chars = 0;
    return `${scrubInto(head, state)}…`;
  }
  if (value === null || typeof value !== 'object') return value;
  state.nodes -= 1;
  if (state.nodes < 0) {
    state.omitted = true;
    return OMITTED;
  }
  if (Array.isArray(value)) return value.map((item) => redactInto(item, options, state));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (options.isSecretKey?.(key)) {
      out[key] = REDACTED;
      state.count += 1;
    } else {
      out[key] = redactInto(inner, options, state);
    }
  }
  return out;
}

/** A structured value with every string in it scrubbed (and, with `isSecretKey`, secret-named
 *  keys replaced whole), within the bounds `options` sets. */
export function redactSecrets(value: unknown, options: RedactSecretsOptions = {}): RedactedValue {
  const state = freshState(options);
  const redacted = redactInto(value, options, state);
  return { value: redacted, redactedValues: state.count, omitted: state.omitted };
}
