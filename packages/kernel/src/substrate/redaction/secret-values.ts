import {
  MAX_SECRET_LITERALS,
  MAX_SECRET_LITERAL_CHARS,
  MIN_SECRET_LITERAL_CHARS,
  SECRET_FIELD_MASK,
  isSecretFieldValue,
  namesASecretField,
  secretFieldLiterals,
  sliceKeepingPairs,
} from '@nexttime/shared';

/**
 * substrate/redaction/secret-values: the kernel's one definition of "a value that looks like a
 * secret", and the scrubs that keep one out of anything an agent produced before a person sees it.
 * (It lives in the substrate so the graph store can apply it where it writes; governance/redaction
 * re-exports it.)
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
 *   - a vendor key with a well-known prefix; a platform API key (`ntk_` and 43 base64url
 *     characters, or the 43 characters alone for one minted before the prefix);
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
 * Users: substrate/graph (a Fact's properties, an observed Object's), application/chat (a Turn's
 * tool calls, the stored reply), application/gateway (the audit copy of every call's params —
 * with the field rule, governance/redaction/credential-review.ts — a Worker's result report), the
 * review of an observe call's params (`HIGH_CONFIDENCE_SECRET_PATTERNS` refuse, the rest record)
 * and, for a stream, governance/redaction/secret-stream.ts.
 */

export const REDACTED = SECRET_FIELD_MASK;
/** What replaces a part of a structured value left out because it was past a walk bound. */
export const OMITTED = '[…]';

/** Nodes of a structured value visited before the rest is left out. */
export const MAX_WALK_NODES = 5_000;

/** How far past a cut a string is read and scrubbed before it is cut (`scrubbedCut`): longer than
 *  any secret a value pattern replaces whole (a PEM RSA-4096 private key is ~3.3k characters, a
 *  Handle well under 2k). */
export const CUT_LOOKAHEAD_CHARS = 4_096;

/**
 * Legacy 819: `text`, which is longer than `length`, cut to at most `length` characters where
 * reading stops, and scrubbed by `scrub` — never ending in the start of a secret. A value pattern
 * recognizes only a whole secret: cut inside one, `password: "correct horse`, a Bearer token, a
 * vendor key or a URL's password cut short is no match, and its start stays as it is. So the
 * `CUT_LOOKAHEAD_CHARS` characters past the cut are read and scrubbed too, and of that at most
 * `length` characters are kept — and, unless reading reached the end of `text`, never its last
 * `CUT_LOOKAHEAD_CHARS`. A secret the cut crosses lies whole in what was read and is replaced; one
 * that reading stopped in lies in the part never kept, however much the replacements before it
 * shortened the copy (which is then shorter than `length`, possibly empty). Never cuts a surrogate
 * pair in two (legacy 834: half of one is no text `jsonb` stores). Reads at most
 * `length + CUT_LOOKAHEAD_CHARS` characters of `text`.
 */
export function scrubbedCut(text: string, length: number, scrub: (read: string) => string): string {
  const read = text.slice(0, Math.max(length, 0) + CUT_LOOKAHEAD_CHARS);
  const scrubbed = scrub(read);
  const keep =
    read.length === text.length ? length : Math.min(length, scrubbed.length - CUT_LOOKAHEAD_CHARS);
  return sliceKeepingPairs(scrubbed, keep);
}

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

/** `value` replaced, its quotes kept — `\"…\"` and `\\\"…\\\"` (a quoted value written inside a
 *  string, once or twice over) too: only `ESCAPED_QUOTED` reads a value that opens with
 *  backslashes and a quote, closed by as many. A value whose closing quote is not on its line
 *  (`UNCLOSED`) is written without one: it never ends with its quote, which a closed one does,
 *  and is never its opening quote alone. */
function redactedValue(value: string): string {
  const opening = OPENING_QUOTE.exec(value)?.[0];
  if (opening === undefined) return REDACTED;
  return value.endsWith(opening.slice(-1))
    ? `${opening}${REDACTED}${opening}`
    : `${opening}${REDACTED}`;
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
 *  next space or quote; in a `name: value` also to the next `&`, a query string's separator).
 *  Quoted with `\"` too, to the next `\"` on the line: a quoted value written inside a string —
 *  `sh -c "export API_TOKEN=\"…\""`, a compose `command:`, source code. Read as it is written,
 *  the `\` alone was the bare run and the value after it was kept (#501 on #1573). And with
 *  `\\\"`, to the next `\\\"`: such a string written inside one more (a JSON string printed in a
 *  log, `"cmd": "export API_TOKEN=\\\"…\\\""`) — any odd run of up to seven backslashes (three
 *  strings deep) before the quote, closed by the same run (review #501 on #1575). First: the bare
 *  run starts with `\` too. Linear because that run is bounded: the run inside stops at the first
 *  `"` and the closing run is read back from each place before it, so with no bound a line of
 *  backslashes cost its length squared (review #501 on #1577: 42 s at 1 MiB). A longer run is
 *  read as `UNCLOSED`, to the first `"`. */
const ESCAPED_QUOTED = String.raw`(?<escapes>\\(?:\\\\){0,3})"[^"\r\n]*\k<escapes>"`;
/** What follows the quote that closes a `QUOTED` value: whitespace, or what ends a JSON value, a
 *  shell word or a query parameter. */
const AFTER_A_QUOTED_VALUE = String.raw`[\s,;:})\]&|]`;
const AFTER_A_QUOTED_VALUE_RE = new RegExp(`^${AFTER_A_QUOTED_VALUE}$`);
/** Whether the character `next` lets the `"` before it close a `QUOTED` value. Exported for
 *  `secret-stream.ts`: text cut right after a quote reads as if it ended there, where any quote
 *  closes one. */
export function endsAQuotedValue(next: string): boolean {
  return AFTER_A_QUOTED_VALUE_RE.test(next);
}
/** A `"…"` value with quotes inside it escaped — JSON text, a shell or YAML string
 *  (`{"password": "a \"b c"}`, `PASSWORD="a\"b"`): to the first `"` no backslash escapes. Read to
 *  the first `"`, the value ended at the `\"` inside it and the rest was kept (#501 on #1577,
 *  main before it). Closed only by a quote that `AFTER_A_QUOTED_VALUE` or the end of the text
 *  follows, as a string's closing quote is. Closed by any, a value that ends with `\` before its
 *  quote (a Windows path, cmd.exe) read on to the next pair's opening quote and the next value was
 *  kept (`--password "C:\dir\" --token "…"`; #493 on #1579); it still is when that value opens
 *  with a space. Before the plain `"…"`, which still closes a value that no such quote does on
 *  its line (`password="C:\dir\" x`), as it did. Linear: each step reads one character or one
 *  escape. */
const QUOTED = String.raw`"(?:[^"\\\r\n]|\\[^\r\n])*"(?=${AFTER_A_QUOTED_VALUE}|$)`;
/** A value opened with `\"` (or more backslashes) whose closing run is not on its line — tool
 *  output cut short, a string that goes on to the next line, one closed after a `\r` (legacy 921):
 *  to the end of the line or the first `"` on it, so a value written inside a string ends with
 *  that string (`"cmd":"PASSWORD=\"…","x":1`). Its backslashes are read two at a time, as a bare
 *  run's: never the `\` of a `\"` that ends it, a string one level up closing, which it keeps
 *  (`{\"env\":\"password: \\\"…\"}`). Read as it was, the `\` alone was the bare run and the
 *  value after it was kept. Second to its closed form, which is tried first; never a quote alone,
 *  which has no value to hide. A `"` or `'` with no close on its line is still no value: as often
 *  as it opens a value cut short, it closes a prompt or a label that ends with a name
 *  (`input("Password:")`, `{"label":"Password:"}`), and the stored rewrite would cut those rows
 *  for good (review #501 on #1577). */
const UNCLOSED = String.raw`\\(?:\\\\)*"(?:[^"\\\r\n]|\\\\|\\(?!"))+`;
/** A bare run, its backslashes read two at a time: never the `\` of a `\"` that ends it, which
 *  closes a string the pair is written inside (`-e \"API_TOKEN=…\" -e \"DEBUG=1\"`). Taken with
 *  the value it was cut, the `[redacted]"` left was read for a split `\"…\"` value at the next
 *  upgrade (review #501 on #1575). Before a `\\"` the pair is the value's own and the quote not
 *  escaped: it stays a quote that closes a string (`"cmd":"PASSWORD=…\\","x":1`). */
const ENV_VALUE = String.raw`(${ESCAPED_QUOTED}|${QUOTED}|"[^"\r\n]*"|'[^'\r\n]*'|${UNCLOSED}|(?:[^\s'"\\]|\\\\|\\(?!"))+)`;
const VALUE = String.raw`(${ESCAPED_QUOTED}|${QUOTED}|"[^"\r\n]*"|'[^'\r\n]*'|${UNCLOSED}|(?:[^\s'"&\\]|\\\\|\\(?!"))+)`;
const NOT_ALREADY_REDACTED = String.raw`(?!(?:\\+"|["'])?\[redacted\])`;
/** The quote a quoted value opens with — `"`, `'`, or the backslashes before a `"`. */
const OPENING_QUOTE = /^(?:\\+"|["'])/;

/** `"api_key": "…"` inside a string that is itself JSON text (a capability tool's result text).
 *  Exported for `secret-stream.ts`: the `"` that closes such a pair opens no JSON key. */
export const JSON_SECRET_PAIR: ValuePattern = {
  pattern: /"([^"\\\r\n]{1,128})"([ \t]{0,8}:[ \t]{0,8})/g,
  value: { names: (key) => namesASecretField(key), pattern: /"((?:[^"\\\r\n]|\\.)*)(")?/y },
  redact: (_match, [key, separator, value, close]) =>
    keepsJsonValue(value, close) ? undefined : `"${key}"${separator}"${REDACTED}${close ?? ''}`,
};

/** Whether a JSON pair's value is left as it is: none, already the mask, or an empty string that
 *  is not closed. A value not closed on its line — JSON text cut short, or not JSON after all — is
 *  hidden as far as it reads (to the line's end, or to a quote that does not close it) and written
 *  without the closing quote it lacks (legacy 921). */
function keepsJsonValue(value: string | undefined, close: string | undefined): boolean {
  return value === undefined || value === REDACTED || (close === undefined && value === '');
}

/** `\"api_key\": \"…\"`: that JSON text written inside one more string, its quotes escaped once
 *  more — a JSON body printed in a log or a command (`payload={\"password\":\"…\"}`). The key is
 *  read as `JSON_SECRET_PAIR` reads it; in the value, every escape of the inner text is written
 *  with two backslashes (`\\\"`, `\\\\`, `\\n`), so the first `\"` that is not part of one
 *  closes it. Review #501 on #1575: neither the name rules (no separator right after the name) nor
 *  `JSON_SECRET_PAIR` (no `\` in a key) read it. Exported for `secret-stream.ts`, as that one is.
 *  Linear: each step of the value reads one fixed token. */
export const ESCAPED_JSON_SECRET_PAIR: ValuePattern = {
  pattern: /\\"([^"\\\r\n]{1,128})\\"([ \t]{0,8}:[ \t]{0,8})/g,
  value: {
    names: (key) => namesASecretField(key),
    pattern: /\\"((?:[^"\\\r\n]|\\\\(?:\\\\|\\"|[^"\\\r\n]))*)(\\")?/y,
  },
  redact: (_match, [key, separator, value, close]) =>
    keepsJsonValue(value, close)
      ? undefined
      : `\\"${key}\\"${separator}\\"${REDACTED}${close ?? ''}`,
};

const PEM_PRIVATE_KEY: ValuePattern = {
  pattern:
    /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
  redact: () => REDACTED,
};

/**
 * What, written just before a secret, stands for a character the text was encoded from rather
 * than ending a word, though it ends in a letter or a digit: a JSON string escape (`\n`, `\t`,
 * `\r`, `\b`, `\f`, `\u4e2d`). A tool's result is JSON text, so a secret alone on its line of
 * output (`cat` of a file holding only a key) reaches a scrub as `…\nntk_…` or `…\neyJ…`; Python's
 * `json.dumps` writes Chinese as `\uXXXX`, so `密钥：` before it becomes `…\uff1a`. Review #493
 * and #501 on #1571. The rules that start where a run of a secret's characters starts take it as
 * a start too.
 */
const AFTER_JSON_ESCAPE = String.raw`(?<=\\[bfnrt]|\\u[0-9A-Fa-f]{4})`;

/** A URL-encoded byte (`%20`, `%3D`, `%2F`) just before a secret, likewise: a query string
 *  `q=my%20key%20…` or an encoded path. Not for a rule that is never taken after `/` or `+`
 *  (`MINTED_PLATFORM_KEY`), which `%2F` and `%2B` stand for. */
const AFTER_URL_ENCODED_BYTE = String.raw`(?<=%[0-9A-Fa-f]{2})`;

// A compact JWS/JWT: three base64url segments, the first a JSON header (`{"` → `eyJ`). Starts only
// where a base64url run starts — `\b` would also start after every `-` inside one — or after a
// JSON escape or a URL-encoded byte.
const COMPACT_JWT: ValuePattern = {
  pattern: new RegExp(
    String.raw`(?:(?<![A-Za-z0-9_-])|${AFTER_JSON_ESCAPE}|${AFTER_URL_ENCODED_BYTE})eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}`,
    'g',
  ),
  redact: () => REDACTED,
};

// A vendor's key by its prefix, where a word starts (`\b`), or after a JSON escape or a
// URL-encoded byte.
const VENDOR_KEY: ValuePattern = {
  pattern: new RegExp(
    String.raw`(?:\b|${AFTER_JSON_ESCAPE}|${AFTER_URL_ENCODED_BYTE})(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{30,})`,
    'g',
  ),
  redact: () => REDACTED,
};

/** What every platform API key the kernel mints starts with (`generateApiKey`,
 *  application/gateway/auth.ts; legacy 906): it names a key as one wherever it is pasted, so the
 *  key no longer has to be told apart from a digest by its shape alone. */
export const PLATFORM_API_KEY_PREFIX = 'ntk_';

/**
 * A platform API key as the kernel mints it since legacy 906: `ntk_` and 32 random bytes in
 * base64url (43 characters). The prefix makes it a credential wherever it stands, unlike the bare
 * shape of a key minted before (`MINTED_PLATFORM_KEY`, below): hidden by every set — the
 * high-confidence one too, which refuses a call carrying it, and the rewrite of stored rows, where
 * no digest or public key can have this shape. Found inside a longer run after `_`, `-` or `/` too
 * (`call_ntk_…`, a URL path), not after a letter or a digit, where `ntk_` ends some other word —
 * unless that letter or digit ends a JSON escape or a URL-encoded byte (`AFTER_JSON_ESCAPE`,
 * `AFTER_URL_ENCODED_BYTE`), which stand for what precedes the key. The 43 characters after the
 * prefix are hidden even when more follow. Linear: each lookbehind reads at most six characters,
 * the literal prefix comes next, and the scan after it is bounded.
 */
const PREFIXED_PLATFORM_KEY: ValuePattern = {
  pattern: new RegExp(
    String.raw`(?:(?<![A-Za-z0-9])|${AFTER_JSON_ESCAPE}|${AFTER_URL_ENCODED_BYTE})ntk_[A-Za-z0-9_-]{43}`,
    'g',
  ),
  redact: () => REDACTED,
};

/**
 * A platform API key as the kernel minted it before legacy 906 (32 random bytes, base64url
 * without padding — exactly 43 characters, no prefix), standing alone: a run of
 * exactly 43 base64url characters, mixing upper and lower case with a digit, `-` or `_` (a random
 * key lacks one of those only about once in 7,500; a word or a lower-case hex digest never has
 * them all). Nothing of either base64 alphabet on either side — not base64url's, and not standard
 * base64's `+` and `/`, nor its `=` padding after — so a 32-byte value in standard base64 (a
 * WireGuard public key, a `SHA-256=` digest: 43 characters and `=`) and a 43-character stretch of
 * a larger block (a certificate, a data URI) between two `+` or `/` are not one. The price is a key
 * right after `/` or `+`, as in a URL path, which a key never travels in (it is sent only as
 * `Authorization: Bearer`). It has no prefix to find it by, and whoever holds it acts as that
 * person or service account on every `/api` route (legacy 168: a key pasted into a Handle's note
 * would have been kept and listed as written). Starts only where a run starts, or right after a
 * JSON escape (`AFTER_JSON_ESCAPE`: `\n` before a key on its own line of a tool's JSON output is
 * a line break, not part of the run) — not after a URL-encoded byte, which may stand for the `/`
 * or `+` this shape is not taken after. Each start reads at most 43 characters, so it is linear.
 *
 * Hidden, never refused: any other 32 bytes in base64url (a SHA-256 digest, an Ed25519 public
 * key's JWK `x`, a random id) has the same shape, so this is in `SECRET_VALUE_PATTERNS` only — such
 * a value is masked wherever values are scrubbed (the accepted over-redaction), and not in
 * `HIGH_CONFIDENCE_SECRET_PATTERNS`, where it would refuse a call outright.
 *
 * Kept while keys minted before the prefix are still issued: they authenticate as before, and
 * without this they would be written down as they are again. Dropped once the host's old keys are
 * rotated (legacy 906, second step); only then does a digest of this shape stop being hidden.
 */
const MINTED_PLATFORM_KEY: ValuePattern = {
  pattern: new RegExp(
    String.raw`(?:(?<![A-Za-z0-9_+/-])|${AFTER_JSON_ESCAPE})[A-Za-z0-9_-]{43}(?![A-Za-z0-9_+/=-])`,
    'g',
  ),
  redact: (match) =>
    /[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9_-]/.test(match) ? REDACTED : undefined,
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
  // `Authorization: token …`, `Cookie: a=1; b=2` — the whole value, to the end of the line. A value
  // that is only `[redacted]` (this pattern's own output) is left as it is (legacy 420); anything
  // after it on the line is not.
  {
    pattern:
      /(?<![A-Za-z0-9-])((?:proxy-)?authorization|(?:set-)?cookie)([ \t]{0,8}:[ \t]{0,8})(?![ \t]*\[redacted\][ \t]*(?:[\r\n]|$))[^\r\n]+/gi,
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
  // Before the vendor rule (review #501 on #1571): a key's random body can spell `-sk-` and 16
  // more, and the vendor rule, run first, hid only that tail and left the rest of the key.
  PREFIXED_PLATFORM_KEY,
  MINTED_PLATFORM_KEY,
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
  ESCAPED_JSON_SECRET_PAIR,
];

/**
 * `SECRET_VALUE_PATTERNS` but a pre-prefix platform API key standing alone (`MINTED_PLATFORM_KEY`;
 * a prefixed key, `PREFIXED_PLATFORM_KEY`, is rewritten like any other credential): what a
 * one-way rewrite of rows already stored hides (application/platform/scrub-raw-secrets — historical
 * Turn reports, agent Decisions, tool-call records; legacy 168 review). The key's shape is any 32
 * bytes in base64url, so masking it there would lose every digest and public key in that history for
 * good: such a value is counted by row id instead (`PLATFORM_KEY_SHAPE_PATTERNS`), for the keys
 * still valid among them to be found and rotated. What is written from now on is masked by the full
 * set.
 */
export const STORED_REWRITE_SECRET_PATTERNS: readonly ValuePattern[] = SECRET_VALUE_PATTERNS.filter(
  (valuePattern) => valuePattern !== MINTED_PLATFORM_KEY,
);

/** Only a pre-prefix platform API key standing alone — what a rewrite of stored rows leaves and
 *  counts. */
export const PLATFORM_KEY_SHAPE_PATTERNS: readonly ValuePattern[] = [MINTED_PLATFORM_KEY];

/** `[redacted]"…\"`: a quoted value written with `\"` that the value patterns split before they
 *  read `\"…\"` as one (legacy 916 for JSON text; legacy 918 for plain text) —
 *  `API_TOKEN=\"…\"` became `API_TOKEN=[redacted]"…\"`, the `\` taken for the value and the value
 *  itself kept. The mask stands right after a name pattern's separator (`=`, `:`, a space or a
 *  tab); the mask written whole, `"[redacted]"`, stands after its own quote (review #501 on #1573:
 *  `[INFO] password="[redacted]" msg=\"x\"`). Between `[redacted]"` and the next `\"` there is no
 *  quote that is not escaped, and no line break or other control character: the value was
 *  quoted to the next `\"` on its line. In JSON that is valid, a string's closing quote is
 *  followed, before any `\"`, by the opening quote of the next string, or by nothing. What it
 *  cannot tell from a split value, and takes the text up to that `\"` for the value of: a bare
 *  value cut by a closing quote with a `\"` later on its line (`-e "PW_TOKEN=[redacted]" img
 *  \"x\"`), and a name with its bare value written inside `\"…\"`, the `\` of the closing `\"`
 *  taken with the value (`-e \"API_TOKEN=[redacted]" -e \"DEBUG=1\"`, review #501 on #1575). The
 *  value patterns still write the first (the second no longer: a bare run leaves that `\`), and
 *  the stored rewrite runs over every row at each upgrade: a row written from now on is rewritten
 *  too, once, at the next upgrade — text lost, no value shown — until this repair is dropped. */
const SPLIT_QUOTED_MASK = /(?<=[=: \t])\[redacted\]"(?:[^"\\]|\\[^"])*\\"/g;

/** Whether `text` holds a C0 control character — a char-code loop, not a regex class (biome's
 *  `noControlCharactersInRegex`). */
function holdsControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

/** Stored text with each `SPLIT_QUOTED_MASK` written as the value patterns write that value now —
 *  `\"[redacted]\"`, or `\\\"[redacted]\\\"` when the run that closes it is `\\\"` (a value written
 *  inside a string twice over, whose opening run the mask took) — counted: for a one-way rewrite of
 *  rows already stored, before the stored set (`STORED_REWRITE_SECRET_PATTERNS`) runs over it
 *  (application/platform/scrub-raw-secrets; application/chat's `rescrubStoredToolCallResult`).
 *  Linear: the run inside stops at a quote. */
export function repairSplitQuotedMasks(text: string): Scrubbed<string> {
  // `SPLIT_QUOTED_MASK` spells the mask out: it reads what earlier releases wrote.
  if (!text.includes(`${REDACTED}"`)) return { value: text, redactedValues: 0 };
  let redactedValues = 0;
  const value = text.replace(SPLIT_QUOTED_MASK, (match) => {
    if (holdsControlCharacter(match)) return match;
    redactedValues += 1;
    // The run before its closing quote: odd, as the run inside reads backslashes two at a time.
    let closing = 1;
    while (match.charAt(match.length - 2 - closing) === '\\') closing += 1;
    const escapes = '\\'.repeat(closing);
    return `${escapes}"${REDACTED}${escapes}"`;
  });
  return { value, redactedValues };
}

/**
 * Each value of a platform API key's shape `text` holds, as written: exactly what
 * `scrubSecretValues(text, { patterns: PLATFORM_KEY_SHAPE_PATTERNS })` replaces, in order. Only
 * for comparing stored copies against the keys issued, by their hash (application/platform/
 * scrub-raw-secrets.ts's `issuedKeyHashes`): hash each one and drop it, never store, log or show
 * it.
 */
export function platformKeyShapes(text: string): string[] {
  const found: string[] = [];
  for (const { start, end, replacement } of secretMatches(MINTED_PLATFORM_KEY, text)) {
    if (replacement !== undefined) found.push(text.slice(start, end));
  }
  return found;
}

/**
 * Every platform API key `text` holds, as written and in order: a prefixed one (`ntk_…`, legacy
 * 906) and every bare shape of one minted before (`platformKeyShapes`). Only for comparing stored
 * copies against the keys issued, by their hash (application/platform/scrub-raw-secrets.ts's
 * `liveApiKeys`): hash each one and drop it, never store, log or show it.
 */
export function platformApiKeys(text: string): string[] {
  const found: { readonly start: number; readonly key: string }[] = [];
  for (const valuePattern of [PREFIXED_PLATFORM_KEY, MINTED_PLATFORM_KEY]) {
    for (const { start, end, replacement } of secretMatches(valuePattern, text)) {
      if (replacement !== undefined) found.push({ start, key: text.slice(start, end) });
    }
  }
  return found.sort((a, b) => a.start - b.start).map(({ key }) => key);
}

/**
 * The patterns that match only what is almost certainly a credential itself, never text that
 * merely talks about one — stricter than `SECRET_VALUE_PATTERNS`, which hides whatever these
 * match: a PEM private key, a compact JWT (a Handle is one), a vendor key with a well-known prefix,
 * a platform API key with its `ntk_` prefix (legacy 906), an issued-looking value after `Bearer` (20 or more token characters with a digit — `Bearer
 * $TOKEN` / `${TOKEN}` never match, `$` and `{` are not token characters), a `Basic` value that
 * decodes to `user:password`, the same issued-looking value after the `token` scheme of an
 * `Authorization:` header (`Authorization: token ****` does not match), and a URL's password that
 * is not an env reference (`$PGPASS`, `${PGPASS}`).
 * Not here, because ordinary query text hits them: an `Authorization:` / `Cookie:` header's value
 * otherwise (`|= "Authorization: failed"`), `name=value` / `name: value` and `--flag value`
 * (`token=expired`, `--password=$VAR`), an env assignment, a `"…token…": "…"` pair and a short
 * `Bearer` value; nor a platform API key minted before the prefix, standing alone
 * (`MINTED_PLATFORM_KEY`): its shape is any 32 random bytes in base64url — a SHA-256 digest, an
 * Ed25519 public key's JWK `x` — so a call that names one by its digest would be refused (legacy
 * 168 review). For refusing content outright (an
 * observe-class Operation's params, legacy 175), where every other pattern is only recorded.
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
  // Before the vendor rule, as in `SECRET_VALUE_PATTERNS`.
  PREFIXED_PLATFORM_KEY,
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
  /** A finite `maxChars` was passed: every item read is charged at least one character, a key is
   *  cut like a string, and once either budget is spent the rest of a container is left out
   *  unread (`RedactSecretsOptions.maxChars`). */
  readonly bounded: boolean;
  /** Hidden as literals in every string, before the patterns run (`RedactSecretsOptions`). */
  readonly literals: readonly string[];
  /** The key rule over every string that is JSON text, before the literals
   *  (`RedactSecretsOptions.jsonTextFields`). */
  readonly jsonTextKey: ((key: string) => boolean) | undefined;
  /** Where values were replaced — only for a caller that asked (`onRedacted`). */
  readonly onRedacted: ((path: string, count: number) => void) | undefined;
  readonly patterns: readonly ValuePattern[];
}

/** `text` with the literals, then every value pattern, replaced. */
function scrubPlain(
  text: string,
  literals: readonly string[],
  patterns: readonly ValuePattern[],
): Scrubbed<string> {
  let out = text;
  let redactedValues = 0;
  if (literals.length > 0) {
    const literal = scrubSecretLiterals(out, literals);
    redactedValues += literal.redactedValues;
    out = literal.value;
  }
  for (const valuePattern of patterns) {
    let scrubbed = '';
    let from = 0;
    for (const { start, end, replacement } of secretMatches(valuePattern, out)) {
      if (replacement === undefined) continue;
      scrubbed += out.slice(from, start) + replacement;
      from = end;
      redactedValues += 1;
    }
    if (from > 0) out = scrubbed + out.slice(from);
  }
  return { value: out, redactedValues };
}

function scrubInto(text: string, state: WalkState): string {
  if (state.jsonTextKey !== undefined) {
    // The strings of JSON text decoded too (legacy 916), then the rest of the text as it is.
    const fields = redactSecretFieldsInJsonText(text, state.jsonTextKey, (value) =>
      scrubPlain(value, state.literals, state.patterns),
    );
    const rest = scrubOutsideSpans(fields.value, fields.decodedSpans, (part) =>
      scrubPlain(part, state.literals, state.patterns),
    );
    state.count += fields.redactedValues + rest.redactedValues;
    return rest.value;
  }
  const plain = scrubPlain(text, state.literals, state.patterns);
  state.count += plain.redactedValues;
  return plain.value;
}

function freshState(options: RedactSecretsOptions = {}): WalkState {
  return {
    count: 0,
    nodes: options.maxNodes ?? MAX_WALK_NODES,
    chars: options.maxChars ?? Number.POSITIVE_INFINITY,
    omitted: false,
    bounded: options.maxChars !== undefined && Number.isFinite(options.maxChars),
    onRedacted: options.onRedacted,
    patterns: options.patterns ?? SECRET_VALUE_PATTERNS,
    literals: options.literals ?? [],
    jsonTextKey: options.jsonTextFields === true ? options.isSecretKey : undefined,
  };
}

/** `text` with every secret-looking value replaced. Linear in `text`; a caller holding text of
 *  unbounded size bounds it first. `patterns` defaults to `SECRET_VALUE_PATTERNS`; a rewrite of rows
 *  already stored passes `STORED_REWRITE_SECRET_PATTERNS`. */
export function scrubSecretValues(
  text: string,
  options: { readonly patterns?: readonly ValuePattern[] } = {},
): Scrubbed<string> {
  const state = freshState({ patterns: options.patterns ?? SECRET_VALUE_PATTERNS });
  return { value: scrubInto(text, state), redactedValues: state.count };
}

/** Whether a character code is JSON whitespace. */
function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

/** A character of a JSON number or of `true` / `false` / `null`. */
function isJsonScalarChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2e
  );
}

/** Where an open object or array of `redactSecretFieldsInJsonText`'s walk is: before a key (an
 *  object, after `{` or `,`), between a key and its `:`, before a value (an array after `[` or
 *  `,`, an object after `:`), or after a value (before `,` or the close). */
type JsonExpecting = 'key' | 'colon' | 'value' | 'next';

/** One open object or array of `redactSecretFieldsInJsonText`'s walk. */
interface JsonFrame {
  readonly array: boolean;
  /** Under a secret-named key: every value inside is a secret value. */
  readonly secret: boolean;
  expecting: JsonExpecting;
  /** The key the object's current value sits under names a secret. */
  keySecret: boolean;
}

/** The string literal that starts at `start` (a `"`): the index of its closing quote, or
 *  `text.length` when the text ends inside it. */
function jsonStringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x5c) index += 2;
    else if (code === 0x22) return index;
    else index += 1;
  }
  return text.length;
}

/** A key as written in JSON (`"apiKey"` → `apiKey`); the raw text between the quotes when it
 *  does not decode. */
function decodedJsonKey(literal: string): string {
  try {
    const decoded: unknown = JSON.parse(literal);
    return typeof decoded === 'string' ? decoded : literal.slice(1, -1);
  } catch {
    return literal.slice(1, -1);
  }
}

/** A JSON string literal's value, or `undefined` when it does not decode. */
function decodedJsonString(literal: string): string | undefined {
  try {
    const decoded: unknown = JSON.parse(literal);
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the `\` at `at` in `inner` starts an escape: an even run of `\` comes before it. */
function startsEscape(inner: string, at: number): boolean {
  let run = 0;
  while (at - 1 - run >= 0 && inner.charCodeAt(at - 1 - run) === 0x5c) run += 1;
  return run % 2 === 0;
}

/** How many characters at the end of an unterminated string's `inner` are an escape the cut
 *  left unfinished — a lone `\`, or `\u` with fewer than four hex digits — or 0. */
function partialEscapeLength(inner: string): number {
  const tail = inner.slice(-5);
  const unicode = /\\u[0-9A-Fa-f]{0,3}$/.exec(tail);
  if (unicode !== null) {
    const at = inner.length - tail.length + unicode.index;
    if (startsEscape(inner, at)) return inner.length - at;
  }
  return inner.endsWith('\\') && startsEscape(inner, inner.length - 1) ? 1 : 0;
}

/** Where a string `redactSecretFieldsInJsonText`'s `scrubValue` read is, in its output: from its
 *  opening quote to just past its closing one (or the text's end). */
export type JsonTextSpan = readonly [start: number, end: number];

export interface ScrubbedJsonText extends Scrubbed<string> {
  /** The strings `scrubValue` read, in order, rewritten or kept: already scrubbed decoded, so a
   *  pass over the text as it is skips them (`scrubOutsideSpans`). */
  readonly decodedSpans: readonly JsonTextSpan[];
}

/** `scrub` over each run of `text` between `spans` (in order, disjoint); the spans as they are. */
export function scrubOutsideSpans(
  text: string,
  spans: readonly JsonTextSpan[],
  scrub: (part: string) => Scrubbed<string>,
): Scrubbed<string> {
  if (spans.length === 0) return scrub(text);
  const parts: string[] = [];
  let redactedValues = 0;
  let from = 0;
  for (const [start, end] of [...spans, [text.length, text.length] as const]) {
    if (start > from) {
      const scrubbed = scrub(text.slice(from, start));
      parts.push(scrubbed.value);
      redactedValues += scrubbed.redactedValues;
    }
    parts.push(text.slice(start, end));
    from = end;
  }
  return { value: parts.join(''), redactedValues };
}

/**
 * `text` that is JSON — or the start of JSON, cut anywhere — with every secret value under a key
 * `isSecretKey` names replaced by `"[redacted]"`: the field rule of `redactSecrets`'s
 * `isSecretKey`, applied to JSON *text*. A capability tool's result is its JSON as text
 * (`JSON.stringify(result, null, 2)`), and a result that echoes the call's arguments (an
 * ActionRequest's `params`) must show a field the way the arguments showed it — hidden, and counted
 * (legacy 185; the value patterns alone miss a number, an object or an array under `password`).
 * Every string or number inside such a key's value, at any depth, is replaced (a blank string, a
 * boolean or `null` shows — `isSecretFieldValue`), and a string the text ends inside is replaced to
 * its end. Formatting is kept. Text that does not start as JSON (`{` or `[` after whitespace) is
 * returned as it is, and so is everything from the first character that cannot continue it (a
 * runtime's `[… more characters omitted]` note) — the value patterns still run over all of it.
 *
 * `scrubValue`, when given, also runs over every other string value that holds an escape, decoded
 * (legacy 916): the value patterns read JSON text as it is written, so a line of output
 * such as `PGPASSWORD=…` or `Bearer …` reaches them as `…\nPGPASSWORD=…`, where the `n` of the
 * escape is taken for the end of another word and the value is passed over — and a quoted value
 * (`API_TOKEN=\"…\"`) as one that starts with `\`, which the name rules take for the whole
 * value. A string it changes is written back with `JSON.stringify` — its other escapes in their
 * shortest form (`\u4e2d` as `中`) — and its count is added; one it leaves is kept byte for
 * byte. A string the text ends inside (cut at a read bound) is decoded
 * without the escape the cut left unfinished, and written back without a closing quote, that
 * escape after it. Every string it read is in `decodedSpans`, and a pass over the text as it is
 * skips them: it would read their escapes the same wrong way (`API_TOKEN=\"[redacted]\"` as a
 * value `\`, the JSON broken). A string without an escape reads the same decoded, and one that
 * does not decode is not read: the patterns over the text see them as they are. Keys are names,
 * not values: they are not scrubbed.
 *
 * One pass, linear in `text`: each character is visited once (a key, and a string `scrubValue`
 * reads, is decoded once more, by `JSON.parse` of its own literal), and nesting is an explicit
 * stack, never recursion.
 */
export function redactSecretFieldsInJsonText(
  text: string,
  isSecretKey: (key: string) => boolean,
  scrubValue?: (value: string) => Scrubbed<string>,
): ScrubbedJsonText {
  const length = text.length;
  let index = 0;
  while (index < length && isJsonWhitespace(text.charCodeAt(index))) index += 1;
  const first = text.charCodeAt(index);
  if (first !== 0x7b && first !== 0x5b) return { value: text, redactedValues: 0, decodedSpans: [] };

  const stack: JsonFrame[] = [];
  const parts: string[] = [];
  const decodedSpans: JsonTextSpan[] = [];
  let copiedTo = 0;
  /** Characters of the output in `parts`. */
  let written = 0;
  let redactedValues = 0;
  const push = (...chunks: string[]): void => {
    for (const chunk of chunks) {
      parts.push(chunk);
      written += chunk.length;
    }
  };
  const replace = (start: number, end: number): void => {
    push(text.slice(copiedTo, start), `"${REDACTED}"`);
    copiedTo = end;
    redactedValues += 1;
  };
  /** The string literal from `start` to its closing quote at `quote` (`length`: the text ends
   *  inside it), decoded and scrubbed; written back when `scrubValue` changed it. */
  const rewrite = (start: number, quote: number): void => {
    const closed = quote < length;
    const end = closed ? quote + 1 : length;
    const inner = text.slice(start + 1, closed ? quote : length);
    if (scrubValue === undefined || !inner.includes('\\')) return;
    const partial = closed ? 0 : partialEscapeLength(inner);
    const decoded = decodedJsonString(`"${inner.slice(0, inner.length - partial)}"`);
    if (decoded === undefined) return;
    const scrubbed = scrubValue(decoded);
    if (scrubbed.value === decoded) {
      // Kept as written — still read: the pass over the text skips it.
      decodedSpans.push([written + start - copiedTo, written + end - copiedTo]);
      return;
    }
    const encoded = JSON.stringify(scrubbed.value);
    push(text.slice(copiedTo, start));
    const spanStart = written;
    push(closed ? encoded : `${encoded.slice(0, -1)}${inner.slice(inner.length - partial)}`);
    decodedSpans.push([spanStart, written]);
    copiedTo = end;
    redactedValues += scrubbed.redactedValues;
  };

  scan: while (index < length) {
    const code = text.charCodeAt(index);
    if (isJsonWhitespace(code)) {
      index += 1;
      continue;
    }
    const top = stack[stack.length - 1];
    // No frame only before the outermost value (the walk ends when it closes).
    const atValue = top === undefined || top.expecting === 'value';
    const valueIsSecret = top !== undefined && (top.secret || (!top.array && top.keySecret));
    switch (code) {
      case 0x7b: // {
      case 0x5b: {
        // [
        if (!atValue) break scan;
        if (top !== undefined) top.expecting = 'next';
        stack.push({
          array: code === 0x5b,
          secret: valueIsSecret,
          expecting: code === 0x5b ? 'value' : 'key',
          keySecret: false,
        });
        index += 1;
        break;
      }
      case 0x7d: // }
      case 0x5d: {
        // ]
        if (top === undefined || top.array !== (code === 0x5d)) break scan;
        if (top.expecting !== 'next' && top.expecting !== (top.array ? 'value' : 'key')) {
          break scan;
        }
        stack.pop();
        index += 1;
        // The outermost value is done; whatever follows is not part of it.
        if (stack.length === 0) break scan;
        break;
      }
      case 0x3a: // :
        if (top === undefined || top.expecting !== 'colon') break scan;
        top.expecting = 'value';
        index += 1;
        break;
      case 0x2c: // ,
        if (top === undefined || top.expecting !== 'next') break scan;
        top.expecting = top.array ? 'value' : 'key';
        top.keySecret = false;
        index += 1;
        break;
      case 0x22: {
        // "
        if (top === undefined) break scan;
        const end = jsonStringEnd(text, index);
        if (top.expecting === 'key') {
          if (end >= length) break scan;
          top.keySecret = isSecretKey(decodedJsonKey(text.slice(index, end + 1)));
          top.expecting = 'colon';
        } else if (top.expecting === 'value') {
          // Blank, or already the mask (a copy scrubbed before): nothing to hide or count.
          const inner = text.slice(index + 1, end);
          if (valueIsSecret && inner.trim() !== '' && inner !== REDACTED) {
            replace(index, Math.min(end + 1, length));
          } else if (!valueIsSecret) {
            rewrite(index, end);
          }
          top.expecting = 'next';
        } else {
          break scan;
        }
        index = end + 1;
        break;
      }
      default: {
        // A number or a literal (`true`, `false`, `null`): a run of the characters they use.
        if (top === undefined || top.expecting !== 'value') break scan;
        const start = index;
        while (index < length && isJsonScalarChar(text.charCodeAt(index))) index += 1;
        if (index === start) break scan;
        const isNumber = code === 0x2d || (code >= 0x30 && code <= 0x39);
        if (isNumber && valueIsSecret) replace(start, index);
        top.expecting = 'next';
        break;
      }
    }
  }
  if (copiedTo === 0) return { value: text, redactedValues: 0, decodedSpans };
  push(text.slice(copiedTo));
  return { value: parts.join(''), redactedValues, decodedSpans };
}

// The literals a structured value's secret fields hold, and their bounds, are `@nexttime/shared`'s
// (secret-field-name.ts) since legacy 155: worker mode collects them too, with the same walk.
export {
  MAX_SECRET_LITERALS,
  MAX_SECRET_LITERAL_CHARS,
  MIN_SECRET_LITERAL_CHARS,
  secretFieldLiterals,
};

/** `text` with every occurrence of each of `literals` (`secretFieldLiterals`, longest first)
 *  replaced by `[redacted]`. One search per literal — at most `MAX_SECRET_LITERALS` of them. */
export function scrubSecretLiterals(text: string, literals: readonly string[]): Scrubbed<string> {
  let out = text;
  let redactedValues = 0;
  for (const literal of literals) {
    if (
      literal.length < MIN_SECRET_LITERAL_CHARS ||
      REDACTED.includes(literal) ||
      !out.includes(literal)
    ) {
      continue;
    }
    const pieces = out.split(literal);
    redactedValues += pieces.length - 1;
    out = pieces.join(REDACTED);
  }
  return { value: out, redactedValues };
}

/** A JSON value with `scrubSecretLiterals` applied to every string in it (keys stay). */
export function scrubSecretLiteralsIn(
  value: unknown,
  literals: readonly string[],
): Scrubbed<unknown> {
  if (literals.length === 0 || value === undefined) return { value, redactedValues: 0 };
  let redactedValues = 0;
  let scrubbed: unknown;
  try {
    scrubbed = JSON.parse(JSON.stringify(value), (_key, inner: unknown) => {
      if (typeof inner !== 'string') return inner;
      const result = scrubSecretLiterals(inner, literals);
      redactedValues += result.redactedValues;
      return result.value;
    });
  } catch {
    // Not JSON (a cycle, a BigInt): nothing a gate or the wire produces.
    return { value, redactedValues: 0 };
  }
  return { value: scrubbed, redactedValues };
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
  /** Characters read in all: string content (an empty string counts one), object keys, and the
   *  characters of a number, a boolean or null; a string or key past the budget is cut (ending in
   *  `…`, and never in the start of a secret — `scrubbedCut`, which reads `CUT_LOOKAHEAD_CHARS`
   *  past the cut), and a value under a secret-named field, replaced unread, is charged what
   *  replaces it (`[redacted]`). Once the budget is spent — or
   *  `maxNodes` is — the rest of every container is left out unread, as one `[…]` (an array's
   *  last item, an object's last entry): a value is read only up to the bound, however many keys
   *  or items it has (legacy 237). Defaults to no bound — for display, or for a value nothing has
   *  bounded upstream, pass one. */
  readonly maxChars?: number;
  /** Told each place values were replaced: its path (`a.b[2].c`) and how many. */
  readonly onRedacted?: (path: string, count: number) => void;
  /** How a key is written in an `onRedacted` path. Defaults to the key as it is. */
  readonly pathKey?: (key: string) => string;
  /** The value patterns run over every string. Defaults to `SECRET_VALUE_PATTERNS`; a check that
   *  refuses rather than redacts passes `HIGH_CONFIDENCE_SECRET_PATTERNS`. */
  readonly patterns?: readonly ValuePattern[];
  /** Known secret values (`secretFieldLiterals` of the content this value quotes — a tool call's
   *  arguments, for its result) hidden as literals in every string, before the patterns. */
  readonly literals?: readonly string[];
  /** With `isSecretKey`: every string that is JSON text gets the same key rule over its text
   *  (`redactSecretFieldsInJsonText`), before the literals — a tool's result is its JSON as text,
   *  and one that echoes the call's arguments must hide a field as they did (legacy 185). In the
   *  same walk, so it reads what the walk reads and no more (legacy 819). */
  readonly jsonTextFields?: boolean;
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

/**
 * Legacy 444: an object's key, as the walk writes it. A key is content too — an agent's call
 * arguments, a gate's output, a Procedure's start parameters can carry `{"Bearer …": 1}` as easily
 * as `{"note": "Bearer …"}` — so the value patterns run over it and every match is counted like a
 * value's (so a count, a refusal and a masked read all see it). A key that changes is reported at
 * its shown spelling; the original is never reported. Two keys that come out the same (two
 * different tokens behind one `Bearer [redacted]`) stay two fields: the later one gets ` (2)`,
 * ` (3)`, … — a key is never merged into another, so no value is lost from the copy. A key is
 * charged to `maxChars` like a string, and cut like one past it (legacy 237: a value with a
 * million keys is read only up to the bound).
 */
function shownKey(
  key: string,
  taken: Record<string, unknown>,
  state: WalkState,
  path: string | undefined,
  options: RedactSecretsOptions,
): string {
  const before = state.count;
  let scrubbed: string;
  if (key.length <= state.chars) {
    state.chars -= key.length;
    scrubbed = scrubInto(key, state);
  } else {
    state.omitted = true;
    const length = Math.max(state.chars, 0);
    state.chars = 0;
    scrubbed = `${scrubbedCut(key, length, (read) => scrubInto(read, state))}…`;
  }
  let shown = scrubbed;
  for (let n = 2; Object.hasOwn(taken, shown); n += 1) shown = `${scrubbed} (${n})`;
  noted(state, childPath(path, shown, options), before);
  return shown;
}

function redactInto(
  value: unknown,
  options: RedactSecretsOptions,
  state: WalkState,
  within: Within,
  path: string | undefined,
): unknown {
  if (within === 'field' && isSecretFieldValue(value)) {
    // Replaced unread: what it looks like does not matter. A bounded walk charges what it writes,
    // so an array of millions of them under a secret-named field stops at the bound too.
    state.count += 1;
    if (path !== undefined) state.onRedacted?.(path, 1);
    if (state.bounded) state.chars -= REDACTED.length;
    return REDACTED;
  }
  if (typeof value === 'string') {
    const before = state.count;
    let out: string;
    if (value.length <= state.chars) {
      // A bounded walk charges an empty string one character, like any other item it reads.
      state.chars -= state.bounded ? Math.max(value.length, 1) : value.length;
      out = scrubInto(value, state);
    } else {
      state.omitted = true;
      if (state.chars <= 0) return OMITTED;
      const length = state.chars;
      state.chars = 0;
      out = `${scrubbedCut(value, length, (read) => scrubInto(read, state))}…`;
    }
    noted(state, path, before);
    return out;
  }
  if (value === null || typeof value !== 'object') {
    // A number, a boolean or null is read too: its characters are charged like a string's, so
    // an array of millions of them is read only up to a bound as well.
    if (state.bounded) state.chars -= String(value).length;
    return value;
  }
  state.nodes -= 1;
  if (state.nodes < 0) {
    state.omitted = true;
    return OMITTED;
  }
  if (Array.isArray(value)) {
    // An array item is a value, not a property declaration: only `field` carries into it.
    const itemWithin: Within = within === 'field' ? 'field' : 'plain';
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (spent(state)) {
        items.push(OMITTED);
        break;
      }
      items.push(
        redactInto(
          value[index],
          options,
          state,
          itemWithin,
          path === undefined ? undefined : `${path}[${index}]`,
        ),
      );
    }
    return items;
  }
  const out: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (spent(state)) {
      let marker = OMITTED;
      for (let n = 2; Object.hasOwn(out, marker); n += 1) marker = `${OMITTED} (${n})`;
      defineEntry(out, marker, OMITTED);
      break;
    }
    const inner = record[key];
    let innerWithin: Within;
    if (within === 'field' || options.isSecretKey?.(key) === true) innerWithin = 'field';
    else if (within === 'property' && SCHEMA_VALUE_KEYWORDS.has(key)) innerWithin = 'field';
    else
      innerWithin =
        options.schemaLiterals === true && namesASecretField(key) ? 'property' : 'plain';
    const written = shownKey(key, out, state, path, options);
    defineEntry(
      out,
      written,
      redactInto(inner, options, state, innerWithin, childPath(path, written, options)),
    );
  }
  return out;
}

/** Defined as an own property: assigning `out[key]` with a `"__proto__"` key would swap the
 *  prototype instead of keeping a field. */
function defineEntry(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A bounded walk (`maxChars`) whose characters or nodes are spent reads no further: the rest of
 *  the container it is in is left out. */
function spent(state: WalkState): boolean {
  if (!state.bounded || (state.chars > 0 && state.nodes >= 0)) return false;
  state.omitted = true;
  return true;
}

/** A structured value with every string in it scrubbed — object keys included (legacy 444,
 *  `shownKey`) — and, with `isSecretKey`, the values under secret-named keys replaced whole,
 *  within the bounds `options` sets. */
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
