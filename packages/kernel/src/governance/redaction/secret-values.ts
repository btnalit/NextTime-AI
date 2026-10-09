import { SECRET_FIELD_MASK, isSecretFieldValue, namesASecretField } from '@nexttime/shared';

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
 * quantifiers — judged before its value is matched, so only a secret's name takes a value with it
 * and the value is scanned once (`secretMatches`). The adversarial inputs in secret-values.test.ts
 * hold this. Callers bound what they
 * pass on top of that (`redactSecrets`'s `maxChars`, the chat sink's own limits).
 *
 * Users: application/chat (a Turn's tool calls, the stored reply), application/gateway (the audit
 * copy of every call's params — with the field rule, `credential-review.ts` — a Worker's result
 * report), the review of an observe call's params (`HIGH_CONFIDENCE_SECRET_PATTERNS` refuse, the
 * rest record) and, for a stream, `secret-stream.ts`.
 */

export const REDACTED = SECRET_FIELD_MASK;
/** What replaces a part of a structured value left out because it was past a walk bound. */
export const OMITTED = '[…]';

/** Nodes of a structured value visited before the rest is left out. */
export const MAX_WALK_NODES = 5_000;

/** A field name that names a secret (`apiKey0`, `x-api-key`, `PGPASSWORD`, `accessToken` —
 *  `maxTokens` stays): `@nexttime/shared`'s `namesASecretField`, the one rule the kernel's scrubs,
 *  its suspected-credential count and the console's display mask share. */
export { namesASecretField } from '@nexttime/shared';

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

/** The headers whose whole value the header pattern below replaces. */
const SECRET_HEADER_NAME = /^(?:proxy-)?authorization$|^(?:set-)?cookie$/i;

/** Whether `name` in `name=value` / `name: value` (or a `--name` flag, without its dashes) is one
 *  whose value some pattern below replaces — for `secret-stream.ts`, which must hold such a name
 *  back, with whatever follows it, until its value has ended. */
export function namesASecretValue(name: string): boolean {
  return (
    namesASecret(name) ||
    SECRET_HEADER_NAME.test(name) ||
    (/^[A-Z][A-Z0-9_]*$/.test(name) && ENV_SECRET_NAME.test(name))
  );
}

/** A `Bearer`/`Basic` value that looks issued rather than like the next English word ("Basic
 *  configuration"): it has a digit, or is long. */
function looksIssued(value: string): boolean {
  return /\d/.test(value) || value.length >= 20;
}

/** A `Basic` value that decodes to `user:password` — canonical base64 of printable text with a
 *  colon — rather than the next word (`Basic realm="api"`, `Basic auth failed`). */
function decodesToUserPass(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return false;
  const text = bytes.toString('utf8');
  if (!text.includes(':') || text.includes('\uFFFD')) return false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
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

export interface ValuePattern {
  /** Global. Finds a whole match — or, for a pattern with a `value`, a name and its separator. */
  readonly pattern: RegExp;
  /** For a `name`-then-value pattern: whether the name (`pattern`'s groups) is one whose value is
   *  replaced, and the value that follows it (sticky; its groups follow the name's). The name is
   *  judged before its value is matched, and only a secret's name takes its value with it: a pair
   *  whose name is not one would otherwise swallow a secret's pair in its value (`note:
   *  password=…`, `--user --password …`, `X=PGPASSWORD=…`). */
  readonly value?: { readonly names: (name: string) => boolean; readonly pattern: RegExp };
  readonly redact: Redact;
}

/** A value after `=`/`:` — quoted to its closing quote on the same line, or a bare run (to the
 *  next space or quote; in a `name: value` also to the next `&`, a query string's separator). */
const ENV_VALUE = String.raw`("[^"\r\n]*"|'[^'\r\n]*'|[^\s'"]+)`;
const VALUE = String.raw`("[^"\r\n]*"|'[^'\r\n]*'|[^\s'"&]+)`;
const NOT_ALREADY_REDACTED = String.raw`(?!["']?\[redacted\])`;

/** `"api_key": "…"` inside a string that is itself JSON text (a capability tool's result text).
 *  Exported for `secret-stream.ts`: the `"` that closes such a pair opens no JSON key. */
export const JSON_SECRET_PAIR: ValuePattern = {
  pattern: /"([^"\\\r\n]{1,128})"([ \t]{0,8}:[ \t]{0,8})/g,
  value: { names: (key) => namesASecretField(key), pattern: /"((?:[^"\\\r\n]|\\.)*)"/y },
  redact: (_match, [key, separator, value]) =>
    value === undefined || value === REDACTED ? undefined : `"${key}"${separator}"${REDACTED}"`,
};

const PEM_PRIVATE_KEY: ValuePattern = {
  pattern:
    /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
  redact: () => REDACTED,
};

// A compact JWS/JWT: three base64url segments, the first a JSON header (`{"` → `eyJ`). Starts only
// where a base64url run starts — `\b` would also start after every `-` inside one.
const COMPACT_JWT: ValuePattern = {
  pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  redact: () => REDACTED,
};

const VENDOR_KEY: ValuePattern = {
  pattern:
    /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{30,})/g,
  redact: () => REDACTED,
};

/** `scheme://user:password@host`, the password captured. */
const URL_PASSWORD =
  /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,256}):(?!\[redacted\]@)([^\s/@]{1,256})@/g;

/** An env-variable reference standing in for a value (`$PGPASS`, `${TOKEN}`), not a value. */
const PLACEHOLDER = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

/** Applied in order to every string. Exported for `secret-stream.ts`, which must know where a
 *  match starts and ends (`secretMatches`). */
export const SECRET_VALUE_PATTERNS: readonly ValuePattern[] = [
  PEM_PRIVATE_KEY,
  // `Authorization: token …`, `Cookie: a=1; b=2` — the whole value, to the end of the line.
  {
    pattern:
      /(?<![A-Za-z0-9-])((?:proxy-)?authorization|(?:set-)?cookie)([ \t]{0,8}:[ \t]{0,8})(?!\[redacted\])[^\r\n]+/gi,
    redact: (_match, [name, separator]) => `${name}${separator}${REDACTED}`,
  },
  COMPACT_JWT,
  {
    pattern: /\b(Bearer|Basic)([ \t]{1,16})([A-Za-z0-9._~+/=-]{8,})/gi,
    redact: (_match, [scheme, space, value]) =>
      value !== undefined &&
      (looksIssued(value) || (scheme?.toLowerCase() === 'basic' && decodesToUserPass(value)))
        ? `${scheme}${space}${REDACTED}`
        : undefined,
  },
  VENDOR_KEY,
  // `PGPASSWORD=…`, `export API_TOKEN="…"` — an `env` / `.env` line. Upper case only, the env-var
  // convention; the name is matched whole and judged afterwards.
  {
    pattern: /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{0,127})=/g,
    value: {
      names: (name) => ENV_SECRET_NAME.test(name),
      pattern: new RegExp(`${NOT_ALREADY_REDACTED}${ENV_VALUE}`, 'y'),
    },
    redact: (_match, [name, value]) =>
      value === undefined ? undefined : `${name}=${redactedValue(value)}`,
  },
  // `password: …`, `POSTGRES_PASSWORD: …`, `aws_secret_access_key = …`, `X-Api-Key: …`,
  // `?token=…` — any case, the name's last word decides.
  {
    pattern: /(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]{0,63})(["']?)([ \t]{0,8}[:=][ \t]{0,8})/g,
    value: {
      names: namesASecret,
      pattern: new RegExp(`${NOT_ALREADY_REDACTED}${VALUE}`, 'y'),
    },
    redact: (_match, [name, quote, separator, value]) =>
      value === undefined
        ? undefined
        : `${name}${quote ?? ''}${separator ?? ''}${redactedValue(value)}`,
  },
  // `--password hunter2`, `--api-key=…`.
  {
    pattern: /(?<![A-Za-z0-9-])(--[A-Za-z][A-Za-z0-9-]{0,63})(=|[ \t]{1,8})/g,
    value: {
      names: (flag) => namesASecret(flag.slice(2)),
      pattern: new RegExp(`${NOT_ALREADY_REDACTED}${VALUE}`, 'y'),
    },
    redact: (_match, [flag, separator, value]) =>
      value === undefined ? undefined : `${flag}${separator ?? ''}${redactedValue(value)}`,
  },
  // `scheme://user:password@host` — keeps the user, drops the password.
  { pattern: URL_PASSWORD, redact: (_match, [prefix]) => `${prefix}:${REDACTED}@` },
  JSON_SECRET_PAIR,
];

/**
 * The patterns that match only what is almost certainly a credential itself, never text that
 * merely talks about one — stricter than `SECRET_VALUE_PATTERNS`, which hides whatever these
 * match: a PEM private key, a compact JWT (a Handle is one), a vendor key with a well-known prefix,
 * an issued-looking value after `Bearer` (20 or more token characters with a digit — `Bearer
 * $TOKEN` / `${TOKEN}` never match, `$` and `{` are not token characters), a `Basic` value that
 * decodes to `user:password`, the same issued-looking value after the `token` scheme of an
 * `Authorization:` header (`Authorization: token ****` does not match), and a URL's password that
 * is not an env reference (`$PGPASS`, `${PGPASS}`).
 * Not here, because ordinary query text hits them: an `Authorization:` / `Cookie:` header's value
 * otherwise (`|= "Authorization: failed"`), `name=value` / `name: value` and `--flag value`
 * (`token=expired`, `--password=$VAR`), an env assignment, a `"…token…": "…"` pair and a short
 * `Bearer` value. For refusing content outright (an observe-class Operation's params, legacy
 * 175), where every other pattern is only recorded.
 */
export const HIGH_CONFIDENCE_SECRET_PATTERNS: readonly ValuePattern[] = [
  PEM_PRIVATE_KEY,
  COMPACT_JWT,
  {
    pattern: /\b(Bearer)([ \t]{1,16})([A-Za-z0-9._~+/=-]{20,})/gi,
    redact: (_match, [scheme, space, value]) =>
      value !== undefined && /\d/.test(value) ? `${scheme}${space}${REDACTED}` : undefined,
  },
  {
    pattern: /\b(Basic)([ \t]{1,16})([A-Za-z0-9._~+/=-]{8,})/gi,
    redact: (_match, [scheme, space, value]) =>
      value !== undefined && decodesToUserPass(value) ? `${scheme}${space}${REDACTED}` : undefined,
  },
  // `Authorization: token …` (GitHub's scheme). Only right after the header's name: `token` alone
  // is an ordinary word in text.
  {
    pattern:
      /(?<=(?<![A-Za-z0-9-])(?:proxy-)?authorization[ \t]{0,8}:[ \t]{0,8})(token)([ \t]{1,16})([A-Za-z0-9._~+/=-]{20,})/gi,
    redact: (_match, [scheme, space, value]) =>
      value !== undefined && /\d/.test(value) ? `${scheme}${space}${REDACTED}` : undefined,
  },
  VENDOR_KEY,
  {
    pattern: URL_PASSWORD,
    redact: (_match, [prefix, password]) =>
      password === undefined || PLACEHOLDER.test(password) ? undefined : `${prefix}:${REDACTED}@`,
  },
];

/** Where one match of a pattern starts and ends, and what replaces it (`undefined`: kept). */
export interface SecretMatch {
  readonly start: number;
  readonly end: number;
  readonly replacement: string | undefined;
}

/** Every match of `valuePattern` in `text`, left to right, as a global `replace` would visit them —
 *  except that a name-then-value pattern's name that is not a secret's takes nothing with it, so
 *  the scan goes on right after its separator. Linear in `text`: a name and its separator are
 *  bounded, and a value is scanned once, by the match that then takes it. */
export function secretMatches(valuePattern: ValuePattern, text: string): SecretMatch[] {
  const { pattern, value, redact } = valuePattern;
  const matches: SecretMatch[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }
    const groups = match.slice(1);
    let end = match.index + match[0].length;
    if (value !== undefined) {
      if (!value.names(groups[0] ?? '')) continue;
      value.pattern.lastIndex = end;
      const tail = value.pattern.exec(text);
      if (tail === null) continue;
      end += tail[0].length;
      groups.push(...tail.slice(1));
      pattern.lastIndex = end;
    }
    const whole = text.slice(match.index, end);
    matches.push({ start: match.index, end, replacement: redact(whole, groups) });
  }
  return matches;
}

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
  /** Where values were replaced — only for a caller that asked (`onRedacted`). */
  readonly onRedacted: ((path: string, count: number) => void) | undefined;
  readonly patterns: readonly ValuePattern[];
}

function scrubInto(text: string, state: WalkState): string {
  let out = text;
  for (const valuePattern of state.patterns) {
    let scrubbed = '';
    let from = 0;
    for (const { start, end, replacement } of secretMatches(valuePattern, out)) {
      if (replacement === undefined) continue;
      scrubbed += out.slice(from, start) + replacement;
      from = end;
      state.count += 1;
    }
    if (from > 0) out = scrubbed + out.slice(from);
  }
  return out;
}

function freshState(options: RedactSecretsOptions = {}): WalkState {
  return {
    count: 0,
    nodes: options.maxNodes ?? MAX_WALK_NODES,
    chars: options.maxChars ?? Number.POSITIVE_INFINITY,
    omitted: false,
    onRedacted: options.onRedacted,
    patterns: options.patterns ?? SECRET_VALUE_PATTERNS,
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
  /** A key whose secret values are replaced whatever they look like (a tool's `password`
   *  argument, say): every string and number under it, at any depth (`isSecretFieldValue`) — the
   *  shape is kept. Absent: only values are scrubbed. Pass `namesASecretField` (plus anything a
   *  capability declares) — the rule the console masks by. */
  readonly isSecretKey?: (key: string) => boolean;
  /** For a document that declares fields rather than filling them (a JSON Schema, an OpenAPI
   *  operation): the literals a schema carries for a secret-named property (`default`, `const`,
   *  `enum`, `examples`, `example` under `properties.apiKey`) are secret values, at any depth. */
  readonly schemaLiterals?: boolean;
  /** Objects and arrays visited before the rest is left out (`OMITTED`). Defaults to
   *  `MAX_WALK_NODES`, for a value nothing has bounded yet (a runtime's tool result); a caller that
   *  writes the result back as structured data passes `Infinity` for a value already validated and
   *  bounded upstream (capability params, at most 1 MiB). */
  readonly maxNodes?: number;
  /** Characters of string content read in all; a string past the budget is cut (ending in `…`)
   *  or left out. Defaults to no bound — for display, pass one. */
  readonly maxChars?: number;
  /** Told each place values were replaced: its path (`a.b[2].c`) and how many. */
  readonly onRedacted?: (path: string, count: number) => void;
  /** How a key is written in an `onRedacted` path. Defaults to the key as it is. */
  readonly pathKey?: (key: string) => string;
  /** The value patterns run over every string. Defaults to `SECRET_VALUE_PATTERNS`; a check that
   *  refuses rather than redacts passes `HIGH_CONFIDENCE_SECRET_PATTERNS`. */
  readonly patterns?: readonly ValuePattern[];
}

export interface RedactedValue extends Scrubbed<unknown> {
  /** Whether anything was cut or left out to stay within `maxNodes` / `maxChars`. */
  readonly omitted: boolean;
}

/** JSON Schema / OpenAPI keywords whose values are literal instances of the property they sit
 *  under — `properties.apiKey.default: "…"` is a value even in a document. */
const SCHEMA_VALUE_KEYWORDS = new Set(['default', 'const', 'enum', 'examples', 'example']);

/** Where the walk is: `field` — under a secret-named field (or a schema literal of a secret-named
 *  property), so every secret value is replaced whole; `property` — directly under a secret-named
 *  key of a document, whose schema literals are values; `plain` — anywhere else. */
type Within = 'plain' | 'property' | 'field';

function noted(state: WalkState, path: string | undefined, before: number): void {
  const count = state.count - before;
  if (count > 0 && path !== undefined) state.onRedacted?.(path, count);
}

function childPath(
  path: string | undefined,
  key: string,
  options: RedactSecretsOptions,
): string | undefined {
  if (path === undefined) return undefined;
  const written = options.pathKey ? options.pathKey(key) : key;
  return path === '' ? written : `${path}.${written}`;
}

function redactInto(
  value: unknown,
  options: RedactSecretsOptions,
  state: WalkState,
  within: Within,
  path: string | undefined,
): unknown {
  if (within === 'field' && isSecretFieldValue(value)) {
    // Replaced unread: what it looks like does not matter.
    state.count += 1;
    if (path !== undefined) state.onRedacted?.(path, 1);
    return REDACTED;
  }
  if (typeof value === 'string') {
    const before = state.count;
    let out: string;
    if (value.length <= state.chars) {
      state.chars -= value.length;
      out = scrubInto(value, state);
    } else {
      state.omitted = true;
      if (state.chars <= 0) return OMITTED;
      const head = value.slice(0, state.chars);
      state.chars = 0;
      out = `${scrubInto(head, state)}…`;
    }
    noted(state, path, before);
    return out;
  }
  if (value === null || typeof value !== 'object') return value;
  state.nodes -= 1;
  if (state.nodes < 0) {
    state.omitted = true;
    return OMITTED;
  }
  if (Array.isArray(value)) {
    // An array item is a value, not a property declaration: only `field` carries into it.
    const itemWithin: Within = within === 'field' ? 'field' : 'plain';
    return value.map((item, index) =>
      redactInto(
        item,
        options,
        state,
        itemWithin,
        path === undefined ? undefined : `${path}[${index}]`,
      ),
    );
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    let innerWithin: Within;
    if (within === 'field' || options.isSecretKey?.(key) === true) innerWithin = 'field';
    else if (within === 'property' && SCHEMA_VALUE_KEYWORDS.has(key)) innerWithin = 'field';
    else
      innerWithin =
        options.schemaLiterals === true && namesASecretField(key) ? 'property' : 'plain';
    // Defined as an own property: assigning `out[key]` with a `"__proto__"` key would swap the
    // prototype instead of keeping a field.
    Object.defineProperty(out, key, {
      value: redactInto(inner, options, state, innerWithin, childPath(path, key, options)),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** A structured value with every string in it scrubbed (and, with `isSecretKey`, secret-named
 *  keys replaced whole), within the bounds `options` sets. */
export function redactSecrets(value: unknown, options: RedactSecretsOptions = {}): RedactedValue {
  const state = freshState(options);
  const redacted = redactInto(
    value,
    options,
    state,
    'plain',
    options.onRedacted === undefined ? undefined : '',
  );
  return { value: redacted, redactedValues: state.count, omitted: state.omitted };
}
