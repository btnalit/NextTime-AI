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
import * as released from './secret-values-v0.70.0.js';
import { type Segment, TailMasker, tailChecked, tailMarks } from './tail-check.js';

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
 * **A floor (legacy 939).** Every text is read with v0.70.0's rules as well, frozen in
 * secret-values-v0.70.0.ts, and a character either reading hides is hidden (`withFloor`): a change
 * to the rules here never hides less than that release did. Where v0.70.0 misread a text and hid
 * more than it meant to — the text after a JSON string it had closed, a key it took for a value —
 * that stays hidden too: the accepted cost. The floor belongs to `SECRET_VALUE_PATTERNS` and
 * `STORED_REWRITE_SECRET_PATTERNS`, the two lists v0.70.0 had; a list of a caller's own — a copy
 * of either, `HIGH_CONFIDENCE_SECRET_PATTERNS` — is read as it is. A stream does not cut inside
 * what v0.70.0 reads either (`floorReadSpans`, secret-stream.ts).
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

/** The words that make a name name a secret, as sources: in an upper-case env name anywhere
 *  (`ENV_SECRET_NAME`); as a name's last word, in any case (`LAST_WORD_SECRET_NAME`) or camel-cased
 *  (`CAMEL_CASE_SECRET_NAME`). Shared with `NEXT_SECRET_PAIR`, which must take for a secret's name
 *  what these do. */
const ENV_SECRET_WORDS = String.raw`TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?|HANDLE`;
const LAST_SECRET_WORDS = String.raw`password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|credentials?`;
const CAMEL_CASE_SECRET_WORDS = String.raw`Password|Passwd|Secret|Token|ApiKey|AccessKey|SecretKey|PrivateKey|ClientSecret|Credentials?`;

/** An upper-case env name with a secret word anywhere in it (`PGPASSWORD`, `CAPABILITY_HANDLE`). */
const ENV_SECRET_NAME = new RegExp(ENV_SECRET_WORDS);

/** A name whose last word names a secret — for `name: value` in free text, where `max_tokens` and
 *  `tokenCount` must stay. Run on a name of at most 64 characters. */
const LAST_WORD_SECRET_NAME = new RegExp(`(?:^|[_.-])(?:${LAST_SECRET_WORDS})$`, 'i');
const CAMEL_CASE_SECRET_NAME = new RegExp(`[a-z0-9](?:${CAMEL_CASE_SECRET_WORDS})$`);

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
 *  and is never its opening quote alone. One read on past its closing quote as the rest of its
 *  word (`restOfTheWord`) is written as the two it is, each masked: its quoted part, closed, and
 *  the rest of the word (`"[redacted]"[redacted]`, `\"[redacted]\"[redacted]`). Its quotes are
 *  kept where they stand: the rules after these read the text they rewrote, and a quote left out
 *  there pairs the quotes after it the other way (`{"token": ""x"…_password": "…"}`). */
function redactedValue(value: string): string {
  const opening = OPENING_QUOTE.exec(value)?.[0];
  if (opening === undefined) return REDACTED;
  if (wordClosedAt(value, opening) !== -1) return `${opening}${REDACTED}${opening}${REDACTED}`;
  return value.endsWith(opening.slice(-1))
    ? `${opening}${REDACTED}${opening}`
    : `${opening}${REDACTED}`;
}

/** Where in `value`, which opens with `opening`, the quote stands that closed its quoted part,
 *  when it read on past that quote as the rest of its word (`restOfTheWord`: `"x"<密钥>`,
 *  `"a\"b"<密钥>`, `"a\"<密钥>`, `\"x\"<密钥>`); else `-1`. Such a value holds its own `"` or `'`
 *  again and does not end with its opening quote, as no other value the name rules read does. For
 *  a `"…"`, that quote is the first one no backslash escapes, where its quoted part holds `\"`
 *  (`quotedValue`), else the one `"` it holds again (`PLAIN_QUOTED`: `"a\"<密钥>`); for a `\"…\"`,
 *  the first `"` after its opening, with as many backslashes before it as its opening has
 *  (`ESCAPED_QUOTED`). */
function wordClosedAt(value: string, opening: string): number {
  if (value.endsWith(opening)) return -1;
  if (opening === "'") return value.indexOf(opening, 1);
  if (opening === '"') {
    for (let at = 1; at < value.length; at += value.charAt(at) === '\\' ? 2 : 1) {
      if (value.charAt(at) === '"') return at;
    }
    return value.indexOf(opening, 1);
  }
  const quote = value.indexOf('"', opening.length);
  return quote === -1 ? -1 : quote - (opening.length - 1);
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
  /** Its value is a JSON string, and how many strings it is written in: one, from the `"` it
   *  opens with (`JSON_NAME_PAIR`), where a quote of its own is written `\"`; or, as JSON text
   *  written inside one more string, two, from the `\"` it opens with (`ESCAPED_JSON_NAME_PAIR`),
   *  where a quote of its own is written `\\\"`. Its quote closes it only where it stands escaped
   *  no further than its opening quote is: after no backslash, or two, four … (one string), after
   *  one backslash, or five, nine … (two) — never after one more than that (`closedByItsQuote`,
   *  `nextJsonQuoteOnTheLine`). */
  readonly jsonStrings?: 1 | 2;
}

/** Name-then-value patterns read together, as one pattern (`NAMED_VALUES`): each reads the text
 *  as it is written, and what any of them takes is hidden — where two cross, the first as it reads
 *  and the rest of the other's value after it (`readTogether`). */
export interface ValuePatternsReadTogether {
  readonly together: readonly ValuePattern[];
}

/** What the scrub applies to every string, in order: one pattern, or several read together. */
export type SecretPattern = ValuePattern | ValuePatternsReadTogether;

/** What follows the quote that closes a `QUOTED` value: whitespace, or what ends a JSON value, a
 *  shell word, a query parameter, an attribute or a sentence. Not `:`, which follows a JSON key's
 *  quote: a value read on to `"password":` took in the next pair's name (#501 on #1579). Nor `\`,
 *  which opens the next value as often (`token="\n…"`). */
const AFTER_A_QUOTED_VALUE = String.raw`[\s,;)}\]&.'|<>]`;
/** Not a key's quote either when spaces come before its colon or `=` (`"api_key" : `, and the
 *  `"api_key" = ` of TOML or HCL; #501 on #1579 and on 05f9be71). */
const NOT_A_KEYS_QUOTE = String.raw`(?![ \t]{0,8}[:=])`;
const CLOSES_A_QUOTED_VALUE = new RegExp(`^${NOT_A_KEYS_QUOTE}${AFTER_A_QUOTED_VALUE}`);
/** Whether what comes `after` a `"` lets it close a `QUOTED` value. Exported for
 *  `secret-stream.ts`: text cut right after a quote reads as if it ended there, where any quote
 *  closes one. */
export function endsAQuotedValue(after: string): boolean {
  return CLOSES_A_QUOTED_VALUE.test(after);
}
/** `source`, a pattern of lower-case words, matched in any case: for patterns built without the
 *  `i` flag, which would also widen the upper-case env names in them. */
function anyCase(source: string): string {
  return source.replace(/[a-z]/g, (letter) => `[${letter.toUpperCase()}${letter}]`);
}
/** A name and its separator, as the name, `--flag` and env-line rules below take a name, each
 *  with its own boundary and length, and only a name whose value that rule hides (`token=`,
 *  `password: `, `'token': `, `"api_key": `, `my.token=`, `--token `, `--token=`, `.--token `,
 *  `$env:API_TOKEN=`, `"API_TOKEN = `). Bounded: a name is at most 64 characters (an env name
 *  128) and is tried only where one can start. */
const SECRET_NAME_AND_SEPARATOR = String.raw`(?:(?<![A-Za-z0-9_.-])(?=[A-Za-z][A-Za-z0-9_.-]{0,63}["']?[ \t]{0,8}[:=])(?:(?:[A-Za-z0-9_.-]*[_.-])?(?:${anyCase(LAST_SECRET_WORDS)})|[A-Za-z0-9_.-]*[a-z0-9](?:${CAMEL_CASE_SECRET_WORDS}))["']?[ \t]{0,8}[:=][ \t]{0,8}|(?<![A-Za-z0-9-])--(?=[A-Za-z][A-Za-z0-9-]{0,63}(?:=|[ \t]))(?:(?:[A-Za-z0-9-]*-)?(?:${anyCase(LAST_SECRET_WORDS)})|[A-Za-z0-9-]*[a-z0-9](?:${CAMEL_CASE_SECRET_WORDS}))(?:=|[ \t]{1,8})|(?<![A-Za-z0-9_])(?=[A-Z][A-Z0-9_]{0,127}=)[A-Z0-9_]*?(?:${ENV_SECRET_WORDS})[A-Z0-9_]*=)`;
/** The next pair: a name and its separator (`SECRET_NAME_AND_SEPARATOR`), and the quote its value
 *  opens with. The quote is a `"`, or a `'` whose `'…'` holds a `"` before its closing `'` — the
 *  quote a value read on would close at (`token='x" …'`); one that holds none, or is not closed,
 *  is read on past and hidden with the value, as it was (`password="a\" token='b' …"`). So not a
 *  `"` after a `'` with no closing `'` (`token='"…`): that pair's rule hides no value there, and
 *  stopping before it kept the value read up to it (review #493 on #1583). A value read with
 *  escapes never reads it in: where it did, the rule could not take the next value and it was kept
 *  (`password="C:\dir\" token=" …"`, `token: "a\" --token 'x", …'`, `API_TOKEN=\"abc password="…"`;
 *  legacy 924, and after v0.69.2 since #1577 and #1579: legacy 926). A name whose value no rule
 *  hides is read in as the value's own text (`"a \"b note: " x`): stopping there kept the rest of
 *  the value for nothing. Bounded and linear: the look into a `'…'` stops at its first `'`, and a
 *  `"` must come before it. */
const NEXT_SECRET_PAIR = String.raw`${SECRET_NAME_AND_SEPARATOR}(?:"|'(?=[^'"\r\n]*"[^'\r\n]*'))`;
/** A key whose value the name rule hides, its closing quote, and the `:` or `=` after it
 *  (`password":`, `api_key" = `): as `NEXT_SECRET_PAIR` takes a name. */
const SECRET_KEY_AND_QUOTE = String.raw`(?=[A-Za-z][A-Za-z0-9_.-]{0,63}"[ \t]{0,8}[:=])(?:(?:[A-Za-z0-9_.-]*[_.-])?(?:${anyCase(LAST_SECRET_WORDS)})|[A-Za-z0-9_.-]*[a-z0-9](?:${CAMEL_CASE_SECRET_WORDS}))"[ \t]{0,8}[:=]`;
/** As `SECRET_KEY_AND_QUOTE`, the key's closing quote escaped (`password\":`, `api_key\\\" = `):
 *  a JSON or TOML key written inside a string. */
const SECRET_KEY_AND_ESCAPED_QUOTE = String.raw`(?=[A-Za-z][A-Za-z0-9_.-]{0,63}\\+"[ \t]{0,8}[:=])(?:(?:[A-Za-z0-9_.-]*[_.-])?(?:${anyCase(LAST_SECRET_WORDS)})|[A-Za-z0-9_.-]*[a-z0-9](?:${CAMEL_CASE_SECRET_WORDS}))\\+"[ \t]{0,8}[:=]`;
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
 *  read as `UNCLOSED`, to the first `"`. Never read past the next pair (`NEXT_SECRET_PAIR`): the
 *  `\"…\"` that closed it took the next pair's name and quote in (`API_TOKEN=\"} --token '\\"x'`).
 *  Save one that starts at its first character, as a bare run reads it (`--token
 *  \"TOKEN='\"'<密钥>\"`): read as no value there, the next pair took the quote after its own for
 *  its value and the rest was kept (legacy 934). A secret's key and its escaped quote is read as
 *  any value is (`token: \"password\": \"…\"`): the key's own pair, read with the name rules
 *  (`ESCAPED_JSON_NAME_PAIR`), crosses it, and both are hidden. Read as no value there, a value
 *  that ends with a secret's name was kept (`password=\"<密钥>myToken\": 1`; review #493 on
 *  #1591). */
const ESCAPED_QUOTED = String.raw`(?<escapes>\\(?:\\\\){0,3})"(?:(?=${NEXT_SECRET_PAIR})[^"\r\n])?(?:(?!${NEXT_SECRET_PAIR})[^"\r\n])*\k<escapes>"`;
/** A `"…"` value with quotes inside it escaped — JSON text, a shell or YAML string
 *  (`{"password": "a \"b c"}`, `PASSWORD="a\"b"`): to the first `"` no backslash escapes. Read to
 *  the first `"`, the value ended at the `\"` inside it and the rest was kept (#501 on #1577,
 *  main before it). Closed only by a quote that `AFTER_A_QUOTED_VALUE` or the end of the text
 *  follows (`CLOSES_QUOTED`), as a string's closing quote is, or that more of its word is written
 *  right against (`quotedValue`), an escape read whole as the string's own reader reads
 *  it; never read past the next pair whose value opens with `"` (`NEXT_SECRET_PAIR`), whose
 *  opening quote it would close at, taking that pair in. Past one whose `'…'` value holds that
 *  quote, though: that pair crosses it, and both are hidden (`readTogether`). Ended before it
 *  (#501 on #1581), it ended at the `\"` before it and the rest of the string was kept
 *  (`password:"\"a TOKEN='"'<密钥>"`; review #501 on #1591). Before the plain `"…"`, which still
 *  closes a value that no such quote does on its line (`password="C:\dir\" x`), as it did, and one
 *  that would read the next pair in. Linear: each step reads one character or one escape, the look
 *  ahead for the next pair is tried only where a name can start, and the look ahead at a quote is
 *  bounded. */
const QUOTED = String.raw`"(?:(?!${NEXT_SECRET_PAIR}(?<="))[^"\\\r\n]|\\[^\r\n])*"`;
const CLOSES_QUOTED = String.raw`(?=${NOT_A_KEYS_QUOTE}${AFTER_A_QUOTED_VALUE}|$)`;
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
 *  for good (review #501 on #1577). Never read past the next pair (`NEXT_SECRET_PAIR`), nor the
 *  blanks before it: it took the next pair's name and quote in and that value was kept
 *  (`API_TOKEN=\"abc password="…"`; legacy 926); save one that starts at its first character, as
 *  in `ESCAPED_QUOTED` (`api_key: \"TOKEN='\"'<密钥> y;`; legacy 934). Nor the blanks before the
 *  end of its line, so a value cut there reads as the whole line does; the blanks are read all at
 *  once, never one fewer in turn (review #501 on #1583). And never a secret's key and its quote,
 *  a JSON or TOML key written with an escaped opening quote (`token: \"password":…`,
 *  `token: \"password" = …`): hidden as the value of the name before it, the key's own value was
 *  kept (since #1577; legacy 929). Read as no value there, the key's rule reads the pair. With its
 *  closing quote escaped too (`token: \"password\": \"…`), it is read as any value is, as in
 *  `ESCAPED_QUOTED`: that key's own pair is read with the name rules (`ESCAPED_JSON_NAME_PAIR`),
 *  crosses it, and both are hidden; the plain JSON pair rule is not (legacy 930). */
const UNCLOSED = String.raw`\\(?:\\\\)*"(?!${SECRET_KEY_AND_QUOTE})(?:(?=${NEXT_SECRET_PAIR})[^"\\\r\n])?(?:(?!(?=(?<unclosedBlanks>[ \t]{0,8}))\k<unclosedBlanks>(?:'?${NEXT_SECRET_PAIR}|[\r\n]|$))(?:[^"\\\r\n]|\\\\|\\(?!")))+`;
/** A bare run, its backslashes read two at a time: never the `\` of a `\"` that ends it, which
 *  closes a string the pair is written inside (`-e \"API_TOKEN=…\" -e \"DEBUG=1\"`). Taken with
 *  the value it was cut, the `[redacted]"` left was read for a split `\"…\"` value at the next
 *  upgrade (review #501 on #1575). Before a `\\"` the pair is the value's own and the quote not
 *  escaped: it stays a quote that closes a string (`"cmd":"PASSWORD=…\\","x":1`). Never read past
 *  the next pair's name and the quote its value opens with (`NEXT_SECRET_PAIR`) after a `,`, `;`,
 *  `&` or `|` in it, as a quoted value is not: a bare run that took them in kept that value
 *  (`token=x,api_key="…"`, since v0.69.2 and before). Only there: a name takes in what is written
 *  against it, so the next pair's name could start where the value does and the value was kept
 *  (`--password=…--api-key="…"`, review #493 on #1586); and never before its first character, nor
 *  its second where the first is one of them (`token=;…`). Nor where that quote opens a secret's
 *  key (`SECRET_KEY_AND_QUOTE`, `token=x,password: "api_key": …`): the next name took the key for
 *  its value and the key's own value was kept (review #501 on #1586). Read on there, the key's
 *  rule reads the pair, as in v0.70.0. */
const bareValue = (notInIt: string): string => {
  const char = String.raw`(?:[^\s'"${notInIt}\\]|\\\\|\\(?!"))`;
  return String.raw`${char}(?:(?<=[,;&|])${char})?(?:(?!(?<=[,;&|])${NEXT_SECRET_PAIR}(?!${SECRET_KEY_AND_QUOTE}))${char})*`;
};
const NEXT_SECRET_PAIR_AFTER_A_STOP = new RegExp(String.raw`[,;&|]${NEXT_SECRET_PAIR}`, 'g');
const SECRET_KEY_AND_QUOTE_HERE = new RegExp(SECRET_KEY_AND_QUOTE, 'y');
/** What can still turn out to be a secret's key and its quote once more text comes: a key not yet
 *  closed, or closed with only blanks after it so far, to the end of the text. */
const SECRET_KEY_AND_QUOTE_TO_COME = /[A-Za-z][A-Za-z0-9_.-]{0,63}(?:"[ \t]{0,8})?$/y;
/** Where in `text`, from `from` on, text cut there reads a bare value as ending at a `,`, `;`, `&`
 *  or `|` before the next pair that the whole text reads on past, as that pair's value opens with a
 *  secret's key and its quote (`bareValue`): from the quote to the end of the key. And while what
 *  follows the quote can still become such a key, from that character to the end of `text`: the
 *  value ends there or reads on as the key turns out. Cut before the quote, the text reads on as
 *  the whole does. Exported for `secret-stream.ts`, which never cuts inside one (review #501 on
 *  #1586). Linear: no such pair holds another's `,`, `;`, `&` or `|`, and the key after each is 74
 *  characters at most. */
export function bareValueEndsToCome(text: string, from = 0): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  NEXT_SECRET_PAIR_AFTER_A_STOP.lastIndex = from;
  for (
    let pair = NEXT_SECRET_PAIR_AFTER_A_STOP.exec(text);
    pair !== null;
    pair = NEXT_SECRET_PAIR_AFTER_A_STOP.exec(text)
  ) {
    const quoteEnd = pair.index + pair[0].length;
    SECRET_KEY_AND_QUOTE_HERE.lastIndex = quoteEnd;
    const key = SECRET_KEY_AND_QUOTE_HERE.exec(text);
    SECRET_KEY_AND_QUOTE_TO_COME.lastIndex = quoteEnd;
    if (key !== null) spans.push({ start: quoteEnd - 1, end: quoteEnd + key[0].length });
    else if (quoteEnd === text.length || SECRET_KEY_AND_QUOTE_TO_COME.test(text))
      spans.push({ start: pair.index, end: text.length });
  }
  return spans;
}
/** A `"…"` value, to its closing quote whatever follows it — a secret's key and its quote too
 *  (`token: "password": <密钥>`): the key's own pair, which starts inside that value and goes on
 *  past it, crosses it, and both values are hidden, the key with them (`readTogether`). Read as no
 *  value there, as since v0.69.2, a value that ends like a key was kept (`token="…Secret" = 1`;
 *  review #493 on #1591). */
const PLAIN_QUOTED = String.raw`"[^"\r\n]*"`;
/** A `"…` value not closed on its line after a key written as JSON writes one, in quotes and
 *  before a `:` (`"api_key": "<密钥>`): to the end of the line, as `JSON_SECRET_PAIR` reads it
 *  (legacy 921). Read by that rule alone, on the text these rules had rewritten, the pair was kept
 *  where the value of a pair before it was its key (`token: "password": "<密钥>`,
 *  `token=password: "api_key": "<密钥>`: `"[redacted]": "<密钥>`; review #493 on #1591); read
 *  here, it crosses that value, and both are hidden. Only there: a `"` with no close on its line is
 *  no value after any other name (`UNCLOSED`). Tried only where no `"` follows on the line, at
 *  which `PLAIN_QUOTED` closes it, so it reads no next pair (`NEXT_SECRET_PAIR`) in. */
const UNCLOSED_AFTER_A_QUOTED_KEY = String.raw`(?<="[^"\\\r\n]{1,128}"[ \t]{0,8}:[ \t]{0,8})"[^"\r\n]+`;
/** The rest of a word that a `"…"`, `'…'` or `\"…\"` value is closed right against
 *  (`TOKEN=""<密钥>""`, `token="x"<密钥>`, `token='x'<密钥> …`, `token=\"x\"<密钥>`), read as a bare
 *  run reads it (`bareValue`), to a blank or a quote. Stopped at its quote, the value was the `""`
 *  alone, and the text after it was kept, in every version (`APIKEY=\"TOKEN=""<密钥>""\"`; legacy
 *  937). So too after a quote a backslash escapes (`password="a\"<密钥>`, `password: '\'a<密钥>`):
 *  read as it is, the value goes on past that quote, and the word with it; stopped there, the rest
 *  was kept, in every version (legacy 948). It starts with no character that may follow a
 *  value's closing quote (`AFTER_A_QUOTED_VALUE`), nor a key's `:` or `=` (`token: "password": …`,
 *  read by that key's own pair), a `\` or a quote, nor a backtick or the full-width punctuation
 *  that ends a phrase of Chinese text (`，。、；：！？）」』】》`): what follows there closes the code
 *  span a value is written in (`` `API_TOKEN="…"` ``) or the phrase, and read on, the mask took it
 *  with the text up to the next blank; and not where the text up to the next quote is a key, a `:`
 *  or `=` after that quote (`token="x"x,passwordx": …`, `token=\"x\"x,passwordx\": …`): the quote
 *  it is closed against opens that key, which a rule after these reads on the text they rewrote. It
 *  ends before a secret's name and its separator (`SECRET_NAME_AND_SEPARATOR`: `token="x"api_key:
 *  …`): that pair is read by its own rule, from where it starts, as after any value; read in, it
 *  was inside the value of a pair that crossed this one, read on past where this one ended, and
 *  its own value was kept. Its backslashes are read two at a time, a last one only where no quote
 *  comes after it, as main reads them. Written as the two it is (`redactedValue`). */
const restOfTheWord = (notInIt: string): string => String.raw`(?:${moreOfTheWord(notInIt)})?`;
const wordOf = (char: string): string =>
  String.raw`(?=[^\s'"\\:=,;)}\]&.|<>\x60，。、；：！？）」』】》])(?![^\s'"]*["'][ \t]{0,8}[:=])(?:(?!${SECRET_NAME_AND_SEPARATOR})${char})+`;
/** `restOfTheWord`, of at least one character. */
const moreOfTheWord = (notInIt: string): string =>
  wordOf(String.raw`(?:[^\s'"${notInIt}\\]|\\\\|\\(?!"))`);
/** `moreOfTheWord` after a `\"…\"` value (`ESCAPED_QUOTED`), which main reads no further. A run of
 *  backslashes is read whole, and where a quote comes after it, only if it is even, the
 *  backslashes escaping each other and the quote a quote, as main reads `\\"`. An odd one is not
 *  read at all: it escapes that quote, and read two at a time, the word stopped inside a `\\\"`,
 *  and the `\"` left closed the JSON string the value is written in, as the rules after these read
 *  it, which kept what came after (`\"password\":\"APIKEY=TOKEN=\\\"\\\"y\\\"<密钥>`, where main
 *  hid it; review #501 on #1600). Not after a `"…"` or `'…'` value, read on as main reads it: there
 *  an odd run left whole ended in a `\\\"` that closed the `\\\"…\\\"` value around it, which main
 *  reads on past (`--passwd \\\"TOKEN='\\\\\\\"'x\\\\\\\"'<密钥> y`, where main hid it; review #493 on
 *  #1600). */
const moreOfTheEscapedWord = (notInIt: string): string =>
  wordOf(String.raw`(?:[^\s'"${notInIt}\\]|\\+(?!["\\])|(?:\\\\)+(?="))`);
const restOfTheEscapedWord = (notInIt: string): string =>
  String.raw`(?:${moreOfTheEscapedWord(notInIt)})?`;
/** A `QUOTED` value, closed where a string's closing quote is (`CLOSES_QUOTED`) or right against
 *  more of its word (`password="a\"b"<密钥>`). Read to the first `"`, as only `PLAIN_QUOTED` reads
 *  it, the value ended at the `\"` inside it, and the rest of the word after its own closing quote
 *  was kept, in every version (legacy 948). Right against more of its word only with no next
 *  pair inside it (`NEXT_SECRET_PAIR`), not even one whose `'…'` value `QUOTED` reads past: that
 *  value holds the closing quote, and read on to the end of the word, the value was crossed by no
 *  such pair, and what the pair's value held past the word was kept (`apikey="TOKEN='\"'"x'<密钥>`,
 *  where main hid it). Read to the first `"`, as main reads it, that pair crosses it. Nor one right
 *  after a backslash, which an escape read whole took in with it (`token:"\password='\"'"n'<密钥>`). */
const NO_PAIR_HERE = String.raw`(?!${NEXT_SECRET_PAIR})`;
/** Nor, past the value's first `\"`, a secret's name at all, whatever its value is
 *  (`SECRET_NAME_AND_SEPARATOR`, which `NEXT_SECRET_PAIR` begins with). Main reads the value to that
 *  `\"`, and what follows on its own: a key written there with an escaped quote and the value after
 *  it, or a name and its value, went on past the closing quote and hid what came after
 *  (`token:"\"apikey,\"=\" token:="e <密钥>`, `"token": "x\"api-key\" = \"note: y token: x, "TOKEN\""x
 *  <密钥>`, `api_key: "\"secretx\": \"a --token x y"x <密钥>`). Read on to the end of the word, that
 *  pair was inside the value, crossing nothing, and what main hid was kept (review #501 on #1600).
 *  A name before it is read on (`api_key: "apikey:\""<密钥>`), and one right after a backslash past
 *  it (`token:"\"x\token:e"<密钥>`), both kept by main. */
const NO_NAME_HERE = String.raw`(?!${SECRET_NAME_AND_SEPARATOR})`;
/** The `"…"` value `quotedValue` reads on: its first `\"` read apart, an escape before it escapes
 *  anything else. */
const QUOTED_WITH_NO_PAIR_IN_IT = String.raw`"(?:${NO_PAIR_HERE}[^"\\\r\n]|\\(?!")${NO_PAIR_HERE}[^\r\n])*(?:\\"(?:${NO_NAME_HERE}[^"\\\r\n]|\\${NO_PAIR_HERE}[^\r\n])*)?"`;
const quotedValue = (notInIt: string): string =>
  String.raw`${QUOTED}${CLOSES_QUOTED}|${QUOTED_WITH_NO_PAIR_IN_IT}${moreOfTheWord(notInIt)}`;
const quotedWord = (notInIt: string): string =>
  String.raw`${PLAIN_QUOTED}${restOfTheWord(notInIt)}|'[^'\r\n]*'${restOfTheWord(notInIt)}`;
const ENV_VALUE = String.raw`(${ESCAPED_QUOTED}${restOfTheEscapedWord('')}|${quotedValue('')}|${quotedWord('')}|${UNCLOSED}|${bareValue('')})`;
const VALUE = String.raw`(${ESCAPED_QUOTED}${restOfTheEscapedWord('&')}|${quotedValue('&')}|${quotedWord('&')}|${UNCLOSED}|${UNCLOSED_AFTER_A_QUOTED_KEY}|${bareValue('&')})`;
const NOT_ALREADY_REDACTED = String.raw`(?!(?:\\+"|["'])?\[redacted\])`;
/** The quote a quoted value opens with — `"`, `'`, or the backslashes before a `"`. */
const OPENING_QUOTE = /^(?:\\+"|["'])/;
/** A JSON key in which no pair can be written, of at most 128 characters — as long as a key the
 *  JSON rule reads (`JSON_SECRET_PAIR`), so that no key it reads is left to it alone once a value
 *  before it read the key in (review #493 on #1593): no `:` or `=`, one of
 *  which stands between every pair's name and its value but a `--flag`'s, and no `--flag` with a
 *  blank after it, which stands between that flag and its value (`FLAG_PAIR`). Blanks may stand
 *  in it (`"x passwordx"`), and so may `--` (`"max_tokens--password"`), but not both around a
 *  flag's name. */
const KEY_WITH_NO_PAIR_IN_IT = String.raw`(?:[^"\\\r\n:=-]|-(?!-[A-Za-z][A-Za-z0-9-]{0,63}[ \t])){1,128}`;

/** `"api_key": "…"` inside a string that is itself JSON text (a capability tool's result text).
 *  Read after the name rules, on the text they rewrote, and with them where the name rule reads no
 *  name at its key's end (`JSON_NAME_PAIR`). Its value is never a secret's key and its quote
 *  (`"token": "password": "<密钥>"`): that key's own value was kept (legacy 930). Exported for
 *  `secret-stream.ts`: the `"` that closes such a pair opens no JSON key. */
export const JSON_SECRET_PAIR: ValuePattern = {
  pattern: /"([^"\\\r\n]{1,128})"([ \t]{0,8}:[ \t]{0,8})/g,
  value: {
    names: (key) => namesASecretField(key),
    pattern: new RegExp(String.raw`"(?!${SECRET_KEY_AND_QUOTE})((?:[^"\\\r\n]|\\.)*)(")?`, 'y'),
  },
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
 *  `JSON_SECRET_PAIR` (no `\` in a key) read it. With `=` too, as a PowerShell hash table or HCL
 *  written inside a string has it (`pwsh -c "… @{\"Password\" = \"…\"}"`): kept since v0.69.2
 *  (review #501 on #1581). Read after the name rules, on the text they rewrote, and with them
 *  where its key allows (`ESCAPED_JSON_NAME_PAIR`): a key whose opening quote opens the value
 *  before it (`token: \"password\": \"…\"`, `\"token\": \"password\": \"…\"`) crosses that value,
 *  and both are hidden. So its value may be a secret's key and its escaped quote, as that one's
 *  may not: read as no value there, a value that ends with a secret's name was kept
 *  (`\"password\": \"<密钥>myToken\": 1`; review #493 on #1591). Exported for `secret-stream.ts`, as
 *  that one is. Linear: each step of the value reads one fixed token. */
export const ESCAPED_JSON_SECRET_PAIR: ValuePattern = {
  pattern: /\\"([^"\\\r\n]{1,128})\\"([ \t]{0,8}[:=][ \t]{0,8})/g,
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

// `PGPASSWORD=…`, `export API_TOKEN="…"` — an `env` / `.env` line. Upper case only, the env-var
// convention; the name is matched whole and judged afterwards.
const ENV_PAIR: ValuePattern = {
  pattern: /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{0,127})=/g,
  value: {
    names: (name) => ENV_SECRET_NAME.test(name),
    pattern: new RegExp(`${NOT_ALREADY_REDACTED}${ENV_VALUE}`, 'y'),
  },
  redact: (_match, [name, value]) =>
    value === undefined ? undefined : `${name}=${redactedValue(value)}`,
};

// `password: …`, `POSTGRES_PASSWORD: …`, `aws_secret_access_key = …`, `X-Api-Key: …`,
// `?token=…` — any case, the name's last word decides.
const NAME_PAIR: ValuePattern = {
  pattern: /(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]{0,63})(["']?)([ \t]{0,8}[:=][ \t]{0,8})/g,
  value: {
    names: namesASecret,
    pattern: new RegExp(`${NOT_ALREADY_REDACTED}${VALUE}`, 'y'),
  },
  redact: (_match, [name, quote, separator, value]) =>
    value === undefined
      ? undefined
      : `${name}${quote ?? ''}${separator ?? ''}${redactedValue(value)}`,
};

// `--password hunter2`, `--api-key=…`.
const FLAG_PAIR: ValuePattern = {
  pattern: /(?<![A-Za-z0-9-])(--[A-Za-z][A-Za-z0-9-]{0,63})(=|[ \t]{1,8})/g,
  value: {
    names: (flag) => namesASecret(flag.slice(2)),
    pattern: new RegExp(`${NOT_ALREADY_REDACTED}${VALUE}`, 'y'),
  },
  redact: (_match, [flag, separator, value]) =>
    value === undefined ? undefined : `${flag}${separator ?? ''}${redactedValue(value)}`,
};

/** `ESCAPED_JSON_SECRET_PAIR` where no pair can be written in its key (`KEY_WITH_NO_PAIR_IN_IT`):
 *  read with the name rules (`NAMED_VALUES`), where what a match covers and does not hide must be
 *  text no other pair is written in. A key that may hold anything held a pair whose value it then
 *  kept (`{\"api_key=<密钥>&token\": \"x\"}`). Nor need it start with a letter, as a name does,
 *  or hold a name's characters alone: read after them alone, a key that did not
 *  (`token: \"_password\": \"<密钥>\"`, `--token --token \",passwd\"=\"<密钥>`; legacy 930) was
 *  hidden as the value before it, and its own value was kept. And its value stops before a
 *  secret's name and separator, as the name rule's value stops before the next pair: that pair is
 *  then read as its own, and on from its value, where one more may start. Covered by this value,
 *  it was read on from where it ended, and the pair in its value kept its own
 *  (`\"password\": \"token: apiKey' = \"<密钥>\"`). The JSON rule after them still hides the rest
 *  of the value. */
const ESCAPED_JSON_NAME_PAIR: ValuePattern = {
  ...ESCAPED_JSON_SECRET_PAIR,
  pattern: new RegExp(String.raw`\\"(${KEY_WITH_NO_PAIR_IN_IT})\\"([ \t]{0,8}[:=][ \t]{0,8})`, 'g'),
  value: {
    names: (key) => namesASecretField(key),
    pattern: new RegExp(
      String.raw`\\"((?:(?!${SECRET_NAME_AND_SEPARATOR})(?:[^"\\\r\n]|\\\\(?:\\\\|\\"|[^"\\\r\n])))*)(\\")?`,
      'y',
    ),
  },
  jsonStrings: 2,
};

const NAME_AT_THE_END = /(?<![A-Za-z0-9_.-])[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** Whether the name rule reads a name at the end of `key` (`NAME_PAIR`: a letter, after no
 *  name's character, then a name's characters to the key's closing quote) and its value with it:
 *  `"api_key"`, `"x,password"`, not `"passwordx"` or `"_password"`. */
function theNameRuleReads(key: string): boolean {
  const name = NAME_AT_THE_END.exec(key)?.[0];
  return name !== undefined && namesASecret(name);
}

/** `JSON_SECRET_PAIR` where no pair can be written in its key, as in `ESCAPED_JSON_NAME_PAIR`'s,
 *  and the name rule reads no name at its end (`theNameRuleReads`): read with the name rules
 *  (`NAMED_VALUES`), on the text as it is written. `namesASecretField` reads more keys than a
 *  name's last word does (`"passwordx"`, `"_password"`, `"apikeye"`, `"x passwordx"`). Read after
 *  them alone, on the text they rewrote, such a key was hidden where a value before it read it in,
 *  and its own value was kept (`APIKEY=password:"passwordx":"<密钥>"`,
 *  `{\"token\": \"passwordx": "<密钥>"`, `token: "token: "x passwordx": "<密钥>"`; legacy 930).
 *  Not a key the name rule reads: that rule reads its value as it reads any name's, and so crosses
 *  the value before it as any name does. Read here too, from its opening quote, it crossed that
 *  value one character sooner, and kept what that rule hid (`token='token="'"apikey":""<密钥>`).
 *  Its value stops before a secret's name and separator, as `ESCAPED_JSON_NAME_PAIR`'s does. The
 *  JSON rule after them still hides the rest of the value. */
const JSON_NAME_PAIR: ValuePattern = {
  ...JSON_SECRET_PAIR,
  pattern: new RegExp(String.raw`"(${KEY_WITH_NO_PAIR_IN_IT})"([ \t]{0,8}:[ \t]{0,8})`, 'g'),
  value: {
    names: (key) => namesASecretField(key) && !theNameRuleReads(key),
    pattern: new RegExp(
      String.raw`"((?:(?!${SECRET_NAME_AND_SEPARATOR})(?:[^"\\\r\n]|\\.))*)(")?`,
      'y',
    ),
  },
  jsonStrings: 1,
};

/** The env-line, name and `--flag` rules, and the JSON pairs whose key no other of them reads
 *  (`ESCAPED_JSON_NAME_PAIR`, `JSON_NAME_PAIR`), read together (`readTogether`): each reads the
 *  text as it is written, and what any of them reads for a value is hidden. Where two pairs
 *  cross — the value of the one that starts first reads in the name of the other, whose value
 *  goes on past it — both are hidden, the rest of the second's value after the first's
 *  (`"api_key": "'.API_TOKEN="<密钥>"`). Run one after another, each rule read the text the rules
 *  before it had rewritten: where one had hidden a value that held a later rule's closing quote,
 *  the later rule read no value and kept it (`--token='<密钥>":api_key=\"'\"`,
 *  `note: API_TOKEN: '<密钥>} .API_TOKEN=\"x'`; legacy 928). So did the JSON rules after them:
 *  where a value before a key only they read had read it in, they found it hidden and kept its
 *  own value (legacy 930). They are read here where their key allows, so that a key whose opening
 *  quote opens the value before it crosses that value (`token: \"password\": \"<密钥>\"`), as the
 *  name rule's key does (`token: "password": "<密钥>"`); read after them alone, it found that key
 *  hidden as the value before it and kept the key's own value (review #493 on #1591). */
const NAMED_VALUES: ValuePatternsReadTogether = {
  together: [ENV_PAIR, NAME_PAIR, FLAG_PAIR, ESCAPED_JSON_NAME_PAIR, JSON_NAME_PAIR],
};

/** `NOT_ALREADY_REDACTED`, but where the mask an earlier release wrote for a `"…"`, `'…'` or
 *  `\"…\"` value has more of its word right against its closing quote, which that release kept as
 *  written (`TOKEN="[redacted]"<密钥>`, written for `TOKEN="x"<密钥>` or `TOKEN=""<密钥>`; legacy
 *  937, review #493 on #1597; `TOKEN=\"[redacted]\"<密钥>`, written for `TOKEN=\"x\"<密钥>`; legacy
 *  948): there the value is read again, as the quoted value and the rest of its word that it
 *  is, and hidden. Not where that rest is a mask already, as the rules write such a value now
 *  (`"[redacted]"[redacted]`), nor where they read no rest at all (`moreOfTheWord`: a `，` after
 *  the quote, a key's quote and `:`, a secret's name): a row written from now on is not rewritten
 *  again. For rows already stored only (`STORED_NAMED_VALUES`). */
const notAlreadyRedactedInStore = (notInIt: string): string => {
  // Only whether there is more: its first character is never a backslash, so after a `\"…\"` mask
  // too, either reading of a run (`moreOfTheEscapedWord`) finds the same, and the value read reads it.
  const more = String.raw`(?!\[redacted\])${moreOfTheWord(notInIt)}`;
  // `\"`, `\\\"` … as `ESCAPED_QUOTED` reads them, spelled out: a group here would move the value's.
  const escaped = [1, 3, 5, 7]
    .map((backslashes) => {
      const quote = `${'\\\\'.repeat(backslashes)}"`;
      return String.raw`${quote}\[redacted\]${quote}${more}`;
    })
    .join('|');
  return String.raw`(?!(?!"\[redacted\]"${more}|'\[redacted\]'${more}|${escaped})(?:\\+"|["'])?\[redacted\])`;
};

/** `rule` with its value read as in `notAlreadyRedactedInStore`. */
function readingStoredMasks(rule: ValuePattern, notInIt: string, value: string): ValuePattern {
  if (rule.value === undefined) return rule;
  return {
    ...rule,
    pattern: new RegExp(rule.pattern.source, rule.pattern.flags),
    value: {
      names: rule.value.names,
      pattern: new RegExp(`${notAlreadyRedactedInStore(notInIt)}${value}`, 'y'),
    },
  };
}

/** `NAMED_VALUES` over rows already stored: the env-line, name and `--flag` rules also read a
 *  mask an earlier release left with more of its word (`notAlreadyRedactedInStore`). */
const STORED_NAMED_VALUES: ValuePatternsReadTogether = {
  together: [
    readingStoredMasks(ENV_PAIR, '', ENV_VALUE),
    readingStoredMasks(NAME_PAIR, '&', VALUE),
    readingStoredMasks(FLAG_PAIR, '&', VALUE),
    ESCAPED_JSON_NAME_PAIR,
    JSON_NAME_PAIR,
  ],
};

/** Applied in order to every string. Exported for `secret-stream.ts`, which must know where a
 *  match starts and ends (`secretMatches`). */
export const SECRET_VALUE_PATTERNS: readonly SecretPattern[] = [
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
  // `PGPASSWORD=…`, `password: …`, `--password …`: the three name rules, read together.
  NAMED_VALUES,
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
 * set. Its name rules read one thing more, which only rows an earlier release wrote hold: a quoted
 * value's mask with the rest of its word kept after it (`STORED_NAMED_VALUES`; legacy 937).
 */
export const STORED_REWRITE_SECRET_PATTERNS: readonly SecretPattern[] =
  SECRET_VALUE_PATTERNS.filter((valuePattern) => valuePattern !== MINTED_PLATFORM_KEY).map(
    (valuePattern) => (valuePattern === NAMED_VALUES ? STORED_NAMED_VALUES : valuePattern),
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
  /** How many values it replaces, when more than one: pairs read together that cross
   *  (`readTogether`). */
  readonly values?: number;
  /** The value it ends with is quoted and not closed, stopped short of a next pair or the line's
   *  end: a pair right after it, past blanks, may yet be read as inside it (`readTogether`). */
  readonly open?: true;
  /** Where the text read past its end to settle how it reads ends: a JSON string closed short of a
   *  pair in it, read on to the next key's `:` (`jsonGoesOnAfterItsClose`). Cut before there, or
   *  where that read reached the text's end, the text reads it otherwise (`secret-stream.ts`). */
  readonly settledAt?: number;
}

/** A match, and where its value starts (its start, for a pattern with no `value`). */
interface ReadMatch extends SecretMatch {
  readonly valueAt: number;
  /** Its pattern's value is a JSON string written in so many strings (`ValuePattern.jsonStrings`). */
  readonly jsonStrings?: 1 | 2;
}

/** The first match of `valuePattern` in `text` from `from` on, as a global `replace` would find it
 *  — except that a name-then-value pattern's name that is not a secret's takes nothing with it, so
 *  the scan goes on right after its separator. */
function readMatchFrom(
  valuePattern: ValuePattern,
  text: string,
  from: number,
): ReadMatch | undefined {
  const { pattern, value, redact } = valuePattern;
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }
    const groups = match.slice(1);
    let end = match.index + match[0].length;
    const valueAt = value === undefined ? match.index : end;
    if (value !== undefined) {
      if (!value.names(groups[0] ?? '')) continue;
      value.pattern.lastIndex = end;
      const tail = value.pattern.exec(text);
      if (tail === null) continue;
      end += tail[0].length;
      groups.push(...tail.slice(1));
    }
    const whole = text.slice(match.index, end);
    return {
      start: match.index,
      end,
      valueAt,
      replacement: redact(whole, groups),
      ...(valuePattern.jsonStrings === undefined ? {} : { jsonStrings: valuePattern.jsonStrings }),
    };
  }
  return undefined;
}

/** Every match of `valuePattern` in `text` from `from` on, left to right, each read on from where
 *  the one before ends (`readMatchFrom`). Linear in `text`: a name and its separator are bounded,
 *  and a value is scanned once, by the match that then takes it. */
function readMatches(valuePattern: ValuePattern, text: string, from: number): ReadMatch[] {
  const matches: ReadMatch[] = [];
  for (
    let match = readMatchFrom(valuePattern, text, from);
    match !== undefined;
    match = readMatchFrom(valuePattern, text, match.end)
  ) {
    matches.push(match);
  }
  return matches;
}

/** What replaces the rest of `match`'s value from `from` on, where a pair before it ends inside it,
 *  written as `redactedValue` writes a value: the mask, and its closing quote kept — for a JSON
 *  string, only a quote that closes it (`closedByItsQuote`). `undefined` when nothing of the value
 *  is left but that quote. */
function restOfValue(match: ReadMatch, from: number, text: string): string | undefined {
  const value = text.slice(match.valueAt, match.end);
  const opening = OPENING_QUOTE.exec(value)?.[0];
  if (match.jsonStrings !== undefined && opening !== undefined) {
    const closing = closedByItsQuote(value, opening, match.jsonStrings) ? opening : '';
    if (from <= match.valueAt) {
      return `${text.slice(from, match.valueAt)}${opening}${REDACTED}${closing}`;
    }
    return closing.endsWith(text.slice(from, match.end)) ? undefined : `${REDACTED}${closing}`;
  }
  if (from <= match.valueAt) return text.slice(from, match.valueAt) + redactedValue(value);
  const closedAt = opening === undefined ? -1 : wordClosedAt(value, opening);
  if (opening !== undefined && closedAt !== -1) {
    // A word (`redactedValue`): the rest of its quoted part and its quote, then the rest of it —
    // of a quote of more than one character (`\"`), what is left of it.
    const quoteAt = match.valueAt + closedAt;
    const restAt = quoteAt + opening.length;
    if (from < quoteAt) return `${REDACTED}${opening}${REDACTED}`;
    return from < restAt ? `${text.slice(from, restAt)}${REDACTED}` : REDACTED;
  }
  const closing =
    opening !== undefined && value.length > opening.length && value.endsWith(opening.slice(-1))
      ? opening
      : '';
  return closing.endsWith(text.slice(from, match.end)) ? undefined : `${REDACTED}${closing}`;
}

/** A match `readTogether` has taken: what replaces it, in parts — joined once, at the end, so a
 *  run of pairs that cross one another costs no more than the pairs (a string built up by `+=` is
 *  copied whole each time it is read). */
interface TakenMatch {
  readonly start: number;
  end: number;
  readonly parts: string[];
  /** What replaces it ends with `[redacted]`. */
  masked: boolean;
  values: number;
  /** Where it ended before it last went on to where a match that crossed it ends. */
  crossedAt: number;
  /** The quote that closes the value it ends with, and where that quote starts; `''` when that
   *  value is not quoted or not closed. */
  closingQuote: string;
  closingQuoteAt: number;
  /** Where the value it ends with starts, when that value is a word read on past the quote that
   *  closed its quoted part (`restOfTheWord`), which is then `closingQuote`; else `-1`. */
  wordAt: number;
  /** The quote the value it ends with opens with, when that value is not closed; else `''`. */
  openQuote: string;
  /** The same of the last value left out inside it since a match last crossed it, and where that
   *  value stopped; `''` when there is none. */
  insideOpenQuote: string;
  insideOpenEnd: number;
  /** How many strings the value it ends with is a JSON string written in, `0` for one that is not
   *  (`ValuePattern.jsonStrings`); the same of the last value left out inside it. */
  jsonStrings: JsonStrings;
  insideOpenJsonStrings: JsonStrings;
  /** `SecretMatch.settledAt`; `-1` while no text past it was read. */
  settledAt: number;
}

/** The quote that closes `match`'s value, and where it starts — or, when the value is quoted but
 *  not closed, the quote it opens with. A value read on past that quote as the rest of its word
 *  (`restOfTheWord`: `"x"<密钥>`) is closed by it, as it was before it read on: it holds its own `"`
 *  or `'` again, where no value opened by one and not closed does. */
function quotesOf(
  match: ReadMatch,
  text: string,
): Pick<TakenMatch, 'closingQuote' | 'closingQuoteAt' | 'wordAt' | 'openQuote' | 'jsonStrings'> {
  const value = text.slice(match.valueAt, match.end);
  const opening = OPENING_QUOTE.exec(value)?.[0];
  const jsonStrings = match.jsonStrings ?? 0;
  if (opening === undefined) {
    return { closingQuote: '', closingQuoteAt: -1, wordAt: -1, openQuote: '', jsonStrings };
  }
  const closedInIt = jsonStrings === 0 ? wordClosedAt(value, opening) : -1;
  if (closedInIt !== -1) {
    return {
      closingQuote: opening,
      closingQuoteAt: match.valueAt + closedInIt,
      wordAt: match.valueAt,
      openQuote: '',
      jsonStrings,
    };
  }
  if (!closedByItsQuote(value, opening, jsonStrings)) {
    return { closingQuote: '', closingQuoteAt: -1, wordAt: -1, openQuote: opening, jsonStrings };
  }
  const closingQuoteAt = match.end - opening.length;
  return { closingQuote: opening, closingQuoteAt, wordAt: -1, openQuote: '', jsonStrings };
}

/** How many strings a value is a JSON string written in (`ValuePattern.jsonStrings`); `0` for one
 *  that is not. */
type JsonStrings = 0 | 1 | 2;

/** The quote a JSON string written in `jsonStrings` strings opens with. */
function jsonQuote(jsonStrings: 1 | 2): string {
  return jsonStrings === 1 ? '"' : '\\"';
}

/** Whether a `"` after `backslashes` backslashes, in a JSON string written in `jsonStrings`
 *  strings, is the quote that closes it: escaped as far as its opening quote is, no further. After
 *  no backslash, or two, four … in one string: after one, three … it is `\"`, a quote of the
 *  string's own (`"passwordx": "a token: x\" <密钥>"`, read as closed at that quote, was hidden to
 *  it and closed; review #501 on #1593). After one backslash, or five, nine … in two: after three,
 *  or seven …, it is `\\\"`, a quote of the JSON text's own (`password=\"\"password\"=\"\\\"<密钥>Token:`;
 *  review #501 on #1591). */
function closesAJsonString(backslashes: number, jsonStrings: 1 | 2): boolean {
  return jsonStrings === 1 ? backslashes % 2 === 0 : backslashes % 4 === 1;
}

/** Whether `value`, which opens with `opening`, ends with the quote that closes it — for a JSON
 *  string that opens with its own quote, one that stands escaped no further than that quote does
 *  (`closesAJsonString`). */
function closedByItsQuote(value: string, opening: string, jsonStrings: JsonStrings): boolean {
  if (value.length < 2 * opening.length || !value.endsWith(opening)) return false;
  if (jsonStrings === 0 || opening !== jsonQuote(jsonStrings)) return true;
  let backslashes = 0;
  while (value.charAt(value.length - 2 - backslashes) === '\\') backslashes += 1;
  return closesAJsonString(backslashes, jsonStrings);
}

/** After the quote that closes a JSON string written in one string, or in two: JSON going on —
 *  past blanks and any `}` or `]` that close what the string is in, a `,` — or, after one of those
 *  at least, only blanks before the next object or array (`{…} {…}`, review #501 on #1593) — any
 *  `{` or `[` that open the next object, and its first key, up to its `:` (a key of at most 128
 *  characters and no backslash, as `JSON_SECRET_PAIR` reads one); or the line's end. For a string
 *  written in two, also the `"` that closes the string it is written in, and JSON in one string
 *  going on after that (`{"log": "{\"passwordx\": \"a token: \"}"}`).
 *  Not other text (`{"passwordx": "a token: "} and <密钥>"`: `token: "} and <密钥>"` may be a pair),
 *  nor a key straight after a `}` or `]` (`{"passwordx": "a token: "} "note": "<密钥>"}`). */
const JSON_CLOSES = String.raw`(?:[}\]][ \t]*)`;
const JSON_ON_TO_THE_NEXT_KEY = String.raw`(?:${JSON_CLOSES}*,[ \t]*|${JSON_CLOSES}+(?=[{[]))(?:[{[][ \t]*)*`;
const JSON_GOES_ON_IN_ONE = String.raw`[ \t]*(?:${JSON_ON_TO_THE_NEXT_KEY}"[^"\\\r\n]{0,128}"[ \t]*:|${JSON_CLOSES}*(?:$|[\r\n]))`;
const JSON_GOES_ON_HERE = {
  1: new RegExp(JSON_GOES_ON_IN_ONE, 'y'),
  2: new RegExp(
    String.raw`[ \t]*(?:${JSON_ON_TO_THE_NEXT_KEY}\\"[^"\\\r\n]{0,128}\\"[ \t]*:|${JSON_CLOSES}*(?:$|[\r\n]|"${JSON_GOES_ON_IN_ONE}))`,
    'y',
  ),
} as const;
/** Where JSON going on (`JSON_GOES_ON_HERE`) ends, read from right after the quote at `at` that
 *  closes a JSON string written in `jsonStrings` strings — the value of a pair inside that string
 *  starts there, with that quote, not escaped, as the pair's separator stands before it; `-1` when
 *  no JSON goes on, or no such quote is there. Linear: it reads on from that quote no further than
 *  the next key, which no other such quote is inside. */
function jsonGoesOnAfterItsClose(text: string, at: number, jsonStrings: 1 | 2): number {
  const quote = jsonQuote(jsonStrings);
  if (!text.startsWith(quote, at)) return -1;
  const goesOn = JSON_GOES_ON_HERE[jsonStrings];
  goesOn.lastIndex = at + quote.length;
  return goesOn.test(text) ? goesOn.lastIndex : -1;
}

/** `match`, whose value a pair inside it ended at a quote not its own, goes on with that value
 *  from where it now ends to the value's next `quote` on the line, short of the next pair and the
 *  line's end (`nextOnTheLine`) — for a JSON string, to its next quote that closes it
 *  (`nextJsonQuoteOnTheLine`): hidden, and that quote kept. */
function goOnTo(match: TakenMatch, quote: string, text: string, jsonStrings: JsonStrings): void {
  const next =
    jsonStrings !== 0 && quote === jsonQuote(jsonStrings)
      ? nextJsonQuoteOnTheLine(text, match.end, jsonStrings)
      : nextOnTheLine(text, quote, match.end);
  if (next.at > match.end && !match.masked) {
    match.values += 1;
    append(match, REDACTED);
  }
  if (next.found) append(match, quote);
  match.end = next.found ? next.at + quote.length : next.at;
  match.closingQuote = next.found ? quote : '';
  match.closingQuoteAt = next.found ? next.at : -1;
  match.wordAt = -1;
  match.openQuote = next.found ? '' : quote;
}

const BLANKS_ONLY = /^[ \t]*$/;

const ESCAPED_QUOTE_HERE = /\\+"/y;
const NEXT_SECRET_PAIR_HERE = new RegExp(NEXT_SECRET_PAIR, 'y');
/** A `"…"` value that is a secret's key and its quote, whole (`PLAIN_QUOTED`, `token: "password":`). */
const SECRET_KEY_VALUE_HERE = new RegExp(String.raw`"(?=${SECRET_KEY_AND_QUOTE})[^"\r\n]*"`, 'y');
/** Where a pair starts at the first character of `match`'s value: the pair of the key that the
 *  value is, from its opening quote (`PLAIN_QUOTED`, which reads it as one), or one after the
 *  escaped quote it opens with (`ESCAPED_QUOTED`, `UNCLOSED`, which read it in); else `undefined`. */
function pairAtFirstCharacter(match: ReadMatch, text: string): number | undefined {
  SECRET_KEY_VALUE_HERE.lastIndex = match.valueAt;
  if (SECRET_KEY_VALUE_HERE.test(text) && SECRET_KEY_VALUE_HERE.lastIndex === match.end) {
    return match.valueAt;
  }
  ESCAPED_QUOTE_HERE.lastIndex = match.valueAt;
  if (!ESCAPED_QUOTE_HERE.test(text) || ESCAPED_QUOTE_HERE.lastIndex >= match.end) return undefined;
  NEXT_SECRET_PAIR_HERE.lastIndex = ESCAPED_QUOTE_HERE.lastIndex;
  return NEXT_SECRET_PAIR_HERE.test(text) ? ESCAPED_QUOTE_HERE.lastIndex : undefined;
}

/** Whether `taken`'s value is a `"…"` closed by a quote a backslash escapes, as only `PLAIN_QUOTED`
 *  reads one (`"\"`), and `match`, right after it, a next pair whose `'…'` value holds a `"`
 *  (`NEXT_SECRET_PAIR`): read with escapes, as `QUOTED` reads it, the value is not closed there, and
 *  that `"` may be where it is (`--password "\"secret:'"='<密钥>"`; review #501 on #1591).
 *  Not a word read on past that quote (`restOfTheWord`): the pair comes after the word, and read
 *  inside the value, the pair after it that crossed it, as main read it, was not
 *  (`--passwd "\"a,TOKEN='"TOKEN:'"'<密钥>`; legacy 948). */
function closedShortOfAPair(taken: TakenMatch, match: ReadMatch, text: string): boolean {
  if (taken.closingQuote !== '"' || taken.wordAt !== -1) return false;
  let backslashes = 0;
  while (text.charAt(taken.closingQuoteAt - backslashes - 1) === '\\') backslashes += 1;
  if (backslashes % 2 === 0) return false;
  NEXT_SECRET_PAIR_HERE.lastIndex = match.start;
  return (
    NEXT_SECRET_PAIR_HERE.test(text) && text.charAt(NEXT_SECRET_PAIR_HERE.lastIndex - 1) === "'"
  );
}

/** Whether a value left out inside `taken` (`readTogether`) stopped, not closed, right where
 *  `taken` ends — where `taken`'s value is a word read on past its quote to the blank that value
 *  stopped at (`restOfTheWord`: `password:\"x… api_key: \"a --apikey=…`). What comes after is
 *  read as after that value: read on no further than its quote, `taken` was crossed by it, and
 *  went on as that value does (legacy 948). Only for such a word: a value closed by its own
 *  quote where one inside it stopped (`apikey:'token=\"' password:'…`) is closed there, and a
 *  pair after it read as inside that one hid less than main did. */
function endsWhereALeftOutValueStopped(taken: TakenMatch): boolean {
  return taken.wordAt !== -1 && taken.insideOpenQuote !== '' && taken.insideOpenEnd === taken.end;
}

/** How long the quote `match`'s value opens with is: at least one, so that a quote right where a
 *  bare value starts counts as inside it no more than its opening quote does. */
function openingQuoteLength(match: ReadMatch, text: string): number {
  return Math.max(1, OPENING_QUOTE.exec(text.slice(match.valueAt, match.end))?.[0].length ?? 0);
}

/** The next pair, or a secret's key and its value's opening quote as a JSON rule reads them
 *  (`"password": "`, `\"api_key\" = \"`: `JSON_SECRET_PAIR`, `ESCAPED_JSON_SECRET_PAIR`), from
 *  the key's opening quote. Only where that rule reads a value: a key it does not read
 *  (`\"password\": "…"`, `"api_key\" = …`) is hidden as the rest of the value it is in, and so is
 *  one whose opening quote is escaped (`\"secret" = "`, `\\\"api_key\" = \"`), which is text
 *  in the value as any `\"` is. */
const A_PAIR_HERE = new RegExp(
  String.raw`${NEXT_SECRET_PAIR}|(?<!\\)"${SECRET_KEY_AND_QUOTE}[ \t]{0,8}"|(?<!\\)\\"(?=[A-Za-z][A-Za-z0-9_.-]{0,63}\\"[ \t]{0,8}[:=][ \t]{0,8}\\")${SECRET_KEY_AND_ESCAPED_QUOTE}`,
  'y',
);
/** What lets a quote close a value: as after a `QUOTED` value's, or the end of the text. */
const CLOSES_A_VALUE_HERE = new RegExp(`${NOT_A_KEYS_QUOTE}(?:${AFTER_A_QUOTED_VALUE}|$)`, 'y');
/** Where `quote` next closes a value in `text` from `from` on (`CLOSES_A_VALUE_HERE`), on the same
 *  line and before the next pair or a secret's key (`A_PAIR_HERE`); else where that pair or key
 *  starts or the line ends. */
function nextOnTheLine(text: string, quote: string, from: number): { at: number; found: boolean } {
  let at = from;
  while (at < text.length && text[at] !== '\n' && text[at] !== '\r') {
    CLOSES_A_VALUE_HERE.lastIndex = at + quote.length;
    if (text.startsWith(quote, at) && CLOSES_A_VALUE_HERE.test(text)) return { at, found: true };
    A_PAIR_HERE.lastIndex = at;
    if (A_PAIR_HERE.test(text)) break;
    at += 1;
  }
  return { at, found: false };
}

/** `nextOnTheLine` for a JSON string written in `jsonStrings` strings, to the quote that closes it
 *  (`ValuePattern.jsonStrings`): a `"` escaped as far as its opening quote is
 *  (`closesAJsonString`), where a quote may close a value. Escaped one further, it is a quote of
 *  the string's own: read as any `"` or `\"` value is, the value closed at the `"` of a `\"`
 *  (`"passwordx": "a token: x\" <密钥>"`; review #501 on #1593), or at the `\"` of a `\\\"`
 *  (`\"token\":\"'apikey=x&\\\"'<密钥>`; review #501 on #1591), and the rest was kept. No pair starts
 *  inside a run of backslashes, nor at a quote one ends with: each run is read once. */
function nextJsonQuoteOnTheLine(
  text: string,
  from: number,
  jsonStrings: 1 | 2,
): { at: number; found: boolean } {
  const quoteLength = jsonQuote(jsonStrings).length;
  let at = from;
  while (at < text.length && text[at] !== '\n' && text[at] !== '\r') {
    let end = at;
    while (text[end] === '\\') end += 1;
    if (text[end] === '"') {
      CLOSES_A_VALUE_HERE.lastIndex = end + 1;
      if (closesAJsonString(end - at, jsonStrings) && CLOSES_A_VALUE_HERE.test(text)) {
        return { at: end + 1 - quoteLength, found: true };
      }
    }
    A_PAIR_HERE.lastIndex = at;
    if (A_PAIR_HERE.test(text)) break;
    at = text[end] === '"' ? end + 1 : Math.max(end, at + 1);
  }
  return { at, found: false };
}

function append(match: TakenMatch, part: string): void {
  if (part === '') return;
  match.parts.push(part);
  match.masked = part.endsWith(REDACTED);
}

/** The matches of patterns read together (`ValuePatternsReadTogether`), from each pattern's own,
 *  found on the text as it is written, left to right; at one place, in the order of the patterns.
 *  One that starts inside a match taken before it and ends there too is left out: that match
 *  hides it. One that goes on past it crosses it, and the match taken goes on to where it ends,
 *  the rest of its value hidden after what it replaced — one mask where that ends with one — and
 *  its pattern reads on from where the match it crossed ended, so a pair inside the rest of its
 *  value is read as it would be after that match; so does one left out that goes on past there,
 *  so at one place the pattern read first decides nothing (review #493 on #1586). Where the quote
 *  that closed the value of the match it crossed is inside its own value, that value was closed by
 *  a quote not its own: it goes on past it, to its next quote on the line, short of the next pair
 *  (`NEXT_SECRET_PAIR`) and the line's end (`password:"TOKEN='"'<密钥>"`; v0.70.0 hid it, as one
 *  rule rewrote the pair before the next read it; review #501 on #1589). So does a value that
 *  stopped there, not closed (`password:\"TOKEN='"'<密钥>`), and one left out inside it that did,
 *  or that stopped before that pair, past blanks alone (`--password 'Password:\"TOKEN='"'<密钥>`;
 *  review #501 on #1591). A pattern whose match is taken reads on from where that match's value
 *  starts, so a pair that starts inside its value and goes on past it crosses it
 *  (`TOKEN=x,token="apikey:"<密钥>"`: `token="apikey:"`, then `apikey:"<密钥>"`; legacy 934); so
 *  does one left out that starts where that match starts. One left out whose value reads a pair
 *  in from its first character, after the escaped quote it opens with (`ESCAPED_QUOTED`,
 *  `UNCLOSED`; `--token='token: \"api_key="'<密钥>"`, review #493 on #1591), or is a secret's key
 *  and its quote (`--token='x,api_key="api_key":'<密钥>'`), reads on from that pair,
 *  which may cross the match taken. One match, so that text cut inside it is never read apart from
 *  the pair it crosses (`secret-stream.ts`). Linear in `text`: a pattern reads text again only from
 *  where the value of a match taken starts, once when it is taken; from where a match taken ended
 *  before the last match crossed it, at most once for each crossing (what it then reads starts
 *  there); or from a pair at the first character of a value left out, which stops short of every
 *  pair after it or is a key of at most 128 characters, so no text is read again for two of them. A
 *  quote is looked for only past where the match taken ends, which then ends where the look
 *  stopped; and no later crossing reads behind where that match now ends.
 *
 *  A match whose value stopped, not closed, short of the next pair goes on past that pair the same
 *  way, where only blanks stand before it: that pair is inside the value, as v0.70.0 read it
 *  (`--token \"xa TOKEN='\"'<密钥> y'`, `apikey=\"a TOKEN='"'<密钥>`; legacy 934). So does a
 *  `"…"` closed by a quote a backslash escapes, before a pair whose `'…'` value holds a `"`
 *  (`closedShortOfAPair`: `--password "\"secret:'"='<密钥>"`; review #501 on #1591). Such a match
 *  is `open`: text cut after it, before what may be that pair, is held with it
 *  (`secret-stream.ts`).
 *
 *  A JSON string goes on to the quote that closes it (`nextJsonQuoteOnTheLine`). One that stopped
 *  short of a pair whose value starts at that quote, where JSON goes on after it
 *  (`jsonGoesOnAfterItsClose`), closes there instead, and that pair is not read: its name is a word
 *  of the string's. */
function readTogether(
  patterns: readonly ValuePattern[],
  text: string,
  from: number,
): SecretMatch[] {
  const taken: TakenMatch[] = [];
  const next = patterns.map((valuePattern) => readMatchFrom(valuePattern, text, from));
  for (;;) {
    let index = -1;
    for (let at = 0; at < next.length; at += 1) {
      const start = next[at]?.start;
      if (start !== undefined && (index === -1 || start < (next[index]?.start ?? start)))
        index = at;
    }
    const valuePattern = patterns[index];
    const first = next[index];
    if (valuePattern === undefined || first === undefined) {
      return taken.map((match) => ({
        start: match.start,
        end: match.end,
        replacement: match.parts.join(''),
        values: match.values,
        ...(match.openQuote === '' && !endsWhereALeftOutValueStopped(match)
          ? {}
          : { open: true as const }),
        ...(match.settledAt > match.end ? { settledAt: match.settledAt } : {}),
      }));
    }
    const last = taken.at(-1);
    let readOn = first.end;
    const inside = last !== undefined && first.end <= last.end;
    if (first.replacement === undefined || inside) {
      // Kept, or hidden by the match before it. One that goes on past where that match ended
      // before the last match crossed it reads on from there, as the one that crossed it did.
      if (inside && first.start < last.crossedAt && last.crossedAt < first.end) {
        readOn = last.crossedAt;
      }
      if (inside && first.start === last.start) readOn = Math.min(readOn, first.valueAt);
      // One whose value reads a pair in from its first character, or is the key of a pair, reads
      // on from that pair, which may go on past the match taken.
      const pairAt = inside ? pairAtFirstCharacter(first, text) : undefined;
      if (pairAt !== undefined) readOn = Math.min(readOn, pairAt);
      // One whose value stopped, not closed, may yet be crossed where it stopped.
      const { openQuote } = inside ? quotesOf(first, text) : { openQuote: '' };
      if (inside && openQuote !== '') {
        last.insideOpenQuote = openQuote;
        last.insideOpenEnd = first.end;
        last.insideOpenJsonStrings = first.jsonStrings ?? 0;
      }
      // Its value holds the quote that closed the quoted part of the word the match taken ends
      // with (`restOfTheWord`): that word was closed by a quote not its own, and goes on past it,
      // as where such a pair crosses it (`TOKEN='\"x\"=\"'<密钥>"&…`).
      if (
        inside &&
        first.replacement !== undefined &&
        last.wordAt !== -1 &&
        first.start > last.wordAt &&
        last.closingQuoteAt >= first.valueAt + openingQuoteLength(first, text) &&
        last.closingQuoteAt < first.end
      ) {
        last.crossedAt = last.end;
        goOnTo(last, last.closingQuote, text, last.jsonStrings);
      }
    } else if (
      last !== undefined &&
      first.start >= last.end &&
      last.jsonStrings !== 0 &&
      last.openQuote === jsonQuote(last.jsonStrings) &&
      BLANKS_ONLY.test(text.slice(last.end, first.start)) &&
      jsonGoesOnAfterItsClose(text, first.valueAt, last.jsonStrings) !== -1
    ) {
      // Its value, a JSON string, stopped before this pair, whose value starts at the quote that
      // closes that string where JSON goes on: the string closes there, and this pair, its name
      // hidden with the string, is not read (`{"passwordx": "a token: ", "password:k": "<密钥>"}`:
      // gone on past it, the string read in the next key, which the JSON rule then no longer
      // found; review #501 on #1593).
      const quote = jsonQuote(last.jsonStrings);
      if (!last.masked) {
        append(last, REDACTED);
        last.values += 1;
      }
      append(last, quote);
      last.crossedAt = last.end;
      last.end = first.valueAt + quote.length;
      last.closingQuote = quote;
      last.closingQuoteAt = first.valueAt;
      last.wordAt = -1;
      last.openQuote = '';
      last.insideOpenQuote = '';
      last.settledAt = jsonGoesOnAfterItsClose(text, first.valueAt, last.jsonStrings);
      readOn = last.end;
    } else if (
      last !== undefined &&
      first.start >= last.end &&
      (last.openQuote !== '' ||
        endsWhereALeftOutValueStopped(last) ||
        closedShortOfAPair(last, first, text)) &&
      BLANKS_ONLY.test(text.slice(last.end, first.start))
    ) {
      // Its value stopped, not closed, before this pair: this pair is inside that value, which
      // goes on past it (`goOnTo`). So too where it was closed short of it, and where a value left
      // out inside it stopped, not closed, where it ends: that value goes on to its own quote.
      const [quote, jsonStrings] =
        last.openQuote !== ''
          ? [last.openQuote, last.jsonStrings]
          : endsWhereALeftOutValueStopped(last)
            ? [last.insideOpenQuote, last.insideOpenJsonStrings]
            : [last.closingQuote, last.jsonStrings];
      append(last, text.slice(last.end, first.start));
      append(last, first.replacement);
      last.values += 1;
      last.crossedAt = last.end;
      last.end = first.end;
      last.insideOpenQuote = '';
      goOnTo(last, quote, text, jsonStrings);
      readOn = first.valueAt;
    } else if (last === undefined || first.start >= last.end) {
      const { start, end, replacement } = first;
      taken.push({
        start,
        end,
        parts: [replacement],
        masked: replacement.endsWith(REDACTED),
        values: 1,
        crossedAt: end,
        ...quotesOf(first, text),
        insideOpenQuote: '',
        insideOpenEnd: -1,
        insideOpenJsonStrings: 0,
        settledAt: -1,
      });
      readOn = first.valueAt;
    } else {
      const rest = restOfValue(first, last.end, text);
      if (rest === undefined) {
        append(last, text.slice(last.end, first.end));
      } else if (last.masked && rest.startsWith(REDACTED)) {
        append(last, rest.slice(REDACTED.length));
        // A word's rest is masked (`redactedValue`); the value after it is another one.
        if (last.wordAt !== -1) last.values += 1;
      } else {
        append(last, rest);
        last.values += 1;
      }
      readOn = last.end;
      last.crossedAt = last.end;
      last.end = first.end;
      const insideOpenQuote = last.insideOpenQuote;
      last.insideOpenQuote = '';
      if (
        last.closingQuote !== '' &&
        last.closingQuoteAt >= first.valueAt + openingQuoteLength(first, text)
      ) {
        // The quote that closed its value is inside the value of the pair that crossed it.
        goOnTo(last, last.closingQuote, text, last.jsonStrings);
      } else if (
        last.openQuote !== '' &&
        last.crossedAt >= first.valueAt + openingQuoteLength(first, text)
      ) {
        // So is where its value stopped, not closed.
        goOnTo(last, last.openQuote, text, last.jsonStrings);
      } else if (
        insideOpenQuote !== '' &&
        (last.insideOpenEnd >= first.valueAt + openingQuoteLength(first, text) ||
          (last.insideOpenEnd <= first.start &&
            BLANKS_ONLY.test(text.slice(last.insideOpenEnd, first.start))))
      ) {
        // So is where a value left out inside it stopped, not closed, or the pair that crossed it
        // stands right after that value, past blanks alone: that value goes on to its own quote.
        goOnTo(last, insideOpenQuote, text, last.insideOpenJsonStrings);
      } else {
        Object.assign(last, quotesOf(first, text));
      }
    }
    next[index] = readMatchFrom(valuePattern, text, readOn);
  }
}

/** Every match of `secretPattern` in `text` that starts at `from` or after it, left to right and
 *  apart, and what replaces each — for patterns read together, as `readTogether` takes them from
 *  each one's own (`readMatches`). What comes before `from` is only looked back into, as a pattern
 *  looks behind where a match starts. Linear in `text`. */
export function secretMatches(secretPattern: SecretPattern, text: string, from = 0): SecretMatch[] {
  if (!('together' in secretPattern)) return readMatches(secretPattern, text, from);
  return readTogether(secretPattern.together, text, from);
}

/** A scrubbed value and how many values in it were replaced. */
export interface Scrubbed<T> {
  readonly value: T;
  readonly redactedValues: number;
  /** Of those, the values the tail check hid to the end of their line, a value read after a
   *  secret's name that did not close cleanly (`tail-check.ts`), and the characters (UTF-16 code
   *  units) of the text read those tails hid, each from where it starts to the end of its line.
   *  Present only when above 0. A tail is a value in `redactedValues` too. */
  readonly redactedTails?: number;
  readonly redactedTailChars?: number;
}

/** `scrubbed` with `tails` tails that hid `tailChars` characters, the fields present only when
 *  there are any. */
export function withTailCounts<T extends Scrubbed<unknown>>(
  scrubbed: T,
  tails: number,
  tailChars: number,
): T {
  const { redactedTails: _tails, redactedTailChars: _chars, ...rest } = scrubbed;
  return (tails > 0 ? { ...rest, redactedTails: tails, redactedTailChars: tailChars } : rest) as T;
}

interface WalkState {
  count: number;
  /** Of `count`, tails, and the characters they hid (`Scrubbed.redactedTails`). */
  tails: number;
  tailChars: number;
  nodes: number;
  chars: number;
  omitted: boolean;
  /** A finite `maxChars` was passed: every item read is charged at least one character, a key is
   *  cut like a string, and once either budget is spent the rest of a container is left out
   *  unread (`RedactSecretsOptions.maxChars`). */
  readonly bounded: boolean;
  /** Hidden as literals in every string, before the patterns run (`RedactSecretsOptions`). */
  readonly literals: readonly string[];
  /** `RedactSecretsOptions.tailCheck`. */
  readonly tailCheck: boolean;
  /** The key rule over every string that is JSON text, before the literals
   *  (`RedactSecretsOptions.jsonTextFields`). */
  readonly jsonTextKey: ((key: string) => boolean) | undefined;
  /** Where values were replaced — only for a caller that asked (`onRedacted`). */
  readonly onRedacted: ((path: string, count: number) => void) | undefined;
  readonly patterns: readonly SecretPattern[];
}

/** What a reading wrote rather than kept (`Run.at`): a `[redacted]` of its own, or other text a
 *  replacement wrote that is not `text` where it came from. */
const WROTE_MASK = -1;
const WROTE_OTHER = -2;

/** A stretch of what a reading made of `text`: `text` from `at` on, kept, or (`at` below 0)
 *  characters it wrote, which stand for `text` from `first` to `end` — what the match replaced. */
interface Run {
  readonly at: number;
  readonly length: number;
  readonly first: number;
  readonly end: number;
}

/** One pattern's matches, in the text as the patterns before it left it. */
type Pass = (text: string) => readonly SecretMatch[];

/** A pass that replaced something: the text it read, and its matches. */
interface Step {
  readonly read: string;
  readonly matches: readonly SecretMatch[];
}

/** What `passes` made of a text, one after the other as `scrubPlain` runs patterns, and each pass
 *  that replaced something (`withFloor` places them in the text only when it must). */
interface Reading extends Scrubbed<string> {
  readonly steps: readonly Step[];
}

function readWith(text: string, passes: readonly Pass[]): Reading {
  let out = text;
  let redactedValues = 0;
  const steps: Step[] = [];
  for (const pass of passes) {
    const matches = pass(out);
    let scrubbed = '';
    let from = 0;
    for (const { start, end, replacement, values } of matches) {
      if (replacement === undefined) continue;
      scrubbed += out.slice(from, start) + replacement;
      from = end;
      redactedValues += values ?? 1;
    }
    if (from === 0) continue;
    steps.push({ read: out, matches });
    out = scrubbed + out.slice(from);
  }
  return { value: out, redactedValues, steps };
}

/** Where the parts of `replacement` come from in `replaced`, the text it replaces, in order: a
 *  stretch of it from `at`, or a `[redacted]` (`WROTE_MASK`). A replacement keeps `replaced`'s own
 *  text, in order, between the masks it writes: its first part where `replaced` starts, its last
 *  where it ends, each one between at the first place after the part before. A replacement not
 *  so has only what it starts and ends with as `replaced` does placed, and the rest `WROTE_OTHER`.
 *  No rule here writes such a replacement yet; exported for the tests that place one. */
export function placeIn(replaced: string, replacement: string): { at: number; length: number }[] {
  const parts = replacement.split(REDACTED);
  const last = parts.length - 1;
  const places: { at: number; length: number }[] = [];
  let at = 0;
  for (let index = 0; index <= last; index += 1) {
    const part = parts[index] ?? '';
    let found = -1;
    if (index === 0) {
      if (replaced.startsWith(part) && (last > 0 || part.length === replaced.length)) found = 0;
    } else if (index === last) {
      const from = replaced.length - part.length;
      if (from >= at && replaced.endsWith(part)) found = from;
    } else {
      found = replaced.indexOf(part, at);
    }
    if (found === -1) return placedAtItsEnds(replaced, replacement);
    if (index > 0) places.push({ at: WROTE_MASK, length: REDACTED.length });
    if (part !== '') places.push({ at: found, length: part.length });
    at = found + part.length;
  }
  return places;
}

function placedAtItsEnds(replaced: string, replacement: string): { at: number; length: number }[] {
  let prefix = 0;
  while (
    prefix < replaced.length &&
    prefix < replacement.length &&
    replaced[prefix] === replacement[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < replaced.length - prefix &&
    suffix < replacement.length - prefix &&
    replaced[replaced.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    { at: 0, length: prefix },
    { at: WROTE_OTHER, length: replacement.length - prefix - suffix },
    { at: replaced.length - suffix, length: suffix },
  ].filter(({ length }) => length > 0);
}

/** Reads `runs` left to right, taking them up to a place, split there. */
class RunCursor {
  private index = 0;
  private inner = 0;
  private at = 0;
  private readonly runs: readonly Run[];
  constructor(runs: readonly Run[]) {
    this.runs = runs;
  }

  /** The runs from here to `to`, onto `into` (all but dropped, without it); then here is `to`. */
  take(to: number, into?: Run[]): void {
    while (this.at < to) {
      const run = this.runs[this.index];
      if (run === undefined) return;
      const length = Math.min(run.length - this.inner, to - this.at);
      if (into !== undefined) {
        into.push(
          run.at >= 0
            ? {
                at: run.at + this.inner,
                length,
                first: run.at + this.inner,
                end: run.at + this.inner + length,
              }
            : { at: run.at, length, first: run.first, end: run.end },
        );
      }
      this.inner += length;
      this.at += length;
      if (this.inner === run.length) {
        this.index += 1;
        this.inner = 0;
      }
    }
  }
}

/** `run` added to `runs`, joined to the last where the two are one stretch. */
function pushRun(runs: Run[], run: Run): void {
  const before = runs.at(-1);
  if (before !== undefined && before.at >= 0 && run.at === before.at + before.length) {
    runs[runs.length - 1] = { ...before, length: before.length + run.length, end: run.end };
  } else if (
    before !== undefined &&
    before.at < 0 &&
    run.at === before.at &&
    run.first === before.first &&
    run.end === before.end
  ) {
    runs[runs.length - 1] = { ...before, length: before.length + run.length };
  } else if (run.length > 0) {
    runs.push(run);
  }
}

/** The runs of what `step` made of its text, given the runs of that text. */
function runsAfter(runs: readonly Run[], step: Step): Run[] {
  const next: Run[] = [];
  const add = (into: Run[]) => (run: Run) => pushRun(into, run);
  const cursor = new RunCursor(runs);
  for (const { start, end, replacement } of step.matches) {
    if (replacement === undefined) continue;
    const kept: Run[] = [];
    cursor.take(start, kept);
    kept.forEach(add(next));
    const replaced: Run[] = [];
    cursor.take(end, replaced);
    let first = Number.POSITIVE_INFINITY;
    let last = -1;
    for (const run of replaced) {
      first = Math.min(first, run.first);
      last = Math.max(last, run.end);
    }
    const inside = new RunCursor(replaced);
    for (const place of placeIn(step.read.slice(start, end), replacement)) {
      if (place.at < 0) {
        pushRun(next, { at: place.at, length: place.length, first, end: last });
        continue;
      }
      inside.take(place.at);
      const taken: Run[] = [];
      inside.take(place.at + place.length, taken);
      taken.forEach(add(next));
    }
  }
  const rest: Run[] = [];
  cursor.take(Number.POSITIVE_INFINITY, rest);
  rest.forEach(add(next));
  return next;
}

/** The runs of what `reading` made of `text`. */
function runsOf(text: string, reading: Reading): Run[] {
  let runs: Run[] = text === '' ? [] : [{ at: 0, length: text.length, first: 0, end: text.length }];
  for (const step of reading.steps) runs = runsAfter(runs, step);
  return runs;
}

/** The stretches of `text` `runs` keep, left to right (a reading keeps text in order). */
function keptOf(runs: readonly Run[]): { start: number; end: number }[] {
  return runs
    .filter(({ at }) => at >= 0)
    .map(({ at, length }) => ({ start: at, end: at + length }));
}

/** Of `shown`, what `alsoShown` does not show: stretches of `text`, left to right. */
function shownOnlyBy(
  shown: readonly { start: number; end: number }[],
  alsoShown: readonly { start: number; end: number }[],
): { start: number; end: number }[] {
  const only: { start: number; end: number }[] = [];
  let index = 0;
  for (const { start, end } of shown) {
    let at = start;
    while (at < end) {
      while (index < alsoShown.length && (alsoShown[index]?.end ?? 0) <= at) index += 1;
      const other = alsoShown[index];
      if (other === undefined || other.start >= end) {
        only.push({ start: at, end });
        break;
      }
      if (other.start > at) only.push({ start: at, end: other.start });
      at = Math.max(at, other.end);
    }
  }
  return only;
}

/** The passes of `patterns` over a text whose matches start at `readFrom` or after it. */
function ownPasses(patterns: readonly SecretPattern[], readFrom: number): Pass[] {
  return patterns.map((valuePattern) => (out) => secretMatches(valuePattern, out, readFrom));
}

/** The passes of v0.70.0's `patterns`, their matches that start before `readFrom` dropped. */
function releasedPasses(patterns: readonly released.ValuePattern[], readFrom: number): Pass[] {
  return patterns.map(
    (valuePattern) => (out) =>
      released.secretMatches(valuePattern, out).filter(({ start }) => start >= readFrom),
  );
}

/** v0.70.0's list for each list it had (`withFloor`). */
const FLOORS = new Map<readonly SecretPattern[], readonly released.ValuePattern[]>([
  [SECRET_VALUE_PATTERNS, released.SECRET_VALUE_PATTERNS],
  [STORED_REWRITE_SECRET_PATTERNS, released.STORED_REWRITE_SECRET_PATTERNS],
]);

/** `text` read by `patterns` and by `floor`, v0.70.0's: a character either hides is hidden
 *  (legacy 939). Most text one leaves as it is, or both read alike: that reading. Else each
 *  reading is placed in `text` (`runsOf`); what this file's shows and v0.70.0's hid is hidden, and
 *  so is what this file's wrote that is not where it came from (`WROTE_OTHER`), one `[redacted]`
 *  for each stretch of hidden text and the masks beside it. Each stretch the result shows is text
 *  both readings show where it is placed. Text a replacement keeps between two of its masks is
 *  placed where it is first found after the part before (`placeIn`), not always where it came
 *  from: placed on text the other reading hid, it is hidden with it — more hidden than either
 *  reading, never less (review #493 on #1595). So whether it is can turn on text elsewhere in the
 *  same text, which decides if the two readings are aligned at all. Exported for its tests, which
 *  read with rules of their own; `scrubPlain` passes the two lists v0.70.0 had (`FLOORS`). */
export function withFloor(
  text: string,
  patterns: readonly SecretPattern[],
  floor: readonly released.ValuePattern[],
  readFrom: number,
): Scrubbed<string> {
  const { value, redactedValues } = floorReading(text, patterns, floor, readFrom, false);
  return { value, redactedValues };
}

/** A reading, and with `placed` where in the text it read each stretch of it comes from
 *  (`Segment`): what the composition with the tail check takes (`composeWithTailCheck`). */
interface FloorReading extends Scrubbed<string> {
  readonly segments?: readonly Segment[];
}

/** The segments of what `reading` made of `text`, its runs (`runsOf`) as characters. */
function segmentsOf(runs: readonly Run[], value: string): Segment[] {
  const segments: Segment[] = [];
  let from = 0;
  for (const run of runs) {
    segments.push({ at: run.at >= 0 ? run.at : -1, text: value.slice(from, from + run.length) });
    from += run.length;
  }
  return segments;
}

/** `withFloor`, and the segments of its reading with `placed`. */
function floorReading(
  text: string,
  patterns: readonly SecretPattern[],
  floor: readonly released.ValuePattern[],
  readFrom: number,
  placed: boolean,
): FloorReading {
  const own = readWith(text, ownPasses(patterns, readFrom));
  const old = readWith(text, releasedPasses(floor, readFrom));
  const ownOnly = (runs?: readonly Run[]): FloorReading =>
    placed
      ? {
          value: own.value,
          redactedValues: own.redactedValues,
          segments: segmentsOf(runs ?? runsOf(text, own), own.value),
        }
      : own;
  if (old.value === text || old.value === own.value) return ownOnly();
  const runs = runsOf(text, own);
  const hidden = shownOnlyBy(keptOf(runs), keptOf(runsOf(text, old)));
  if (hidden.length === 0 && runs.every(({ at }) => at !== WROTE_OTHER)) return ownOnly(runs);
  let value = '';
  let redactedValues = own.redactedValues;
  const segments: Segment[] = [];
  // In a stretch of hidden text: its one mask is written, and it counts one value more unless it
  // holds a mask of this file's reading, whose value is counted.
  let masking = false;
  let ownMask = false;
  const hide = (isOwnMask: boolean): void => {
    if (!masking) {
      value += REDACTED;
      if (placed) segments.push({ at: -1, text: REDACTED });
    }
    masking = true;
    ownMask ||= isOwnMask;
  };
  const show = (at: number, until: number): void => {
    if (masking && !ownMask) redactedValues += 1;
    masking = false;
    ownMask = false;
    if (until > at) {
      value += text.slice(at, until);
      if (placed) segments.push({ at, text: text.slice(at, until) });
    }
  };
  let index = 0;
  for (const run of runs) {
    if (run.at < 0) {
      hide(run.at === WROTE_MASK);
      continue;
    }
    const runEnd = run.at + run.length;
    for (let at = run.at; at < runEnd; ) {
      while (index < hidden.length && (hidden[index]?.end ?? 0) <= at) index += 1;
      const next = hidden[index];
      if (next !== undefined && next.start <= at) {
        hide(false);
        at = Math.min(next.end, runEnd);
      } else {
        const until = Math.min(next?.start ?? runEnd, runEnd);
        show(at, until);
        at = until;
      }
    }
  }
  show(0, 0);
  return placed ? { value, redactedValues, segments } : { value, redactedValues };
}

/** What each match of v0.70.0's rules covers in `text`, of those that start at `from` or after
 *  it, read as `withFloor` reads it: where a stream must not cut (`secret-stream.ts`), for the
 *  text before the cut to read as the whole text does. What a pass before wrote stands for all
 *  it replaced. */
export function floorReadSpans(text: string, from = 0): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let runs: Run[] = text === '' ? [] : [{ at: 0, length: text.length, first: 0, end: text.length }];
  let out = text;
  for (const pass of releasedPasses(released.SECRET_VALUE_PATTERNS, from)) {
    const matches = pass(out);
    if (matches.length === 0) continue;
    let run = 0;
    let runStart = 0;
    for (const { start, end } of matches) {
      while (run < runs.length && runStart + (runs[run]?.length ?? 0) <= start) {
        runStart += runs[run]?.length ?? 0;
        run += 1;
      }
      let first = Number.POSITIVE_INFINITY;
      let last = -1;
      for (let k = run, kStart = runStart; k < runs.length && kStart < end; k += 1) {
        const covering = runs[k];
        if (covering === undefined) break;
        const inFrom = Math.max(start, kStart) - kStart;
        const inTo = Math.min(end, kStart + covering.length) - kStart;
        first = Math.min(first, covering.at >= 0 ? covering.at + inFrom : covering.first);
        last = Math.max(last, covering.at >= 0 ? covering.at + inTo : covering.end);
        kStart += covering.length;
      }
      if (last > first) spans.push({ start: first, end: last });
    }
    if (matches.every(({ replacement }) => replacement === undefined)) continue;
    const step = { read: out, matches };
    runs = runsAfter(runs, step);
    out = readWith(out, [() => matches]).value;
  }
  return spans;
}

/** `text` with the literals, then every value pattern, replaced — `SECRET_VALUE_PATTERNS` composed
 *  with the tail check unless `tailCheck` is false (`RedactSecretsOptions.tailCheck`). */
function scrubPlain(
  text: string,
  literals: readonly string[],
  patterns: readonly SecretPattern[],
  readFrom = 0,
  tailCheck = true,
): Scrubbed<string> {
  let out = text;
  let redactedValues = 0;
  if (literals.length > 0) {
    const literal = scrubSecretLiterals(out, literals);
    redactedValues += literal.redactedValues;
    out = literal.value;
  }
  const floor = FLOORS.get(patterns);
  if (floor !== undefined && patterns === SECRET_VALUE_PATTERNS && readFrom === 0 && tailCheck) {
    const composed = composeWithTailCheck(out, floor);
    return { ...composed, redactedValues: redactedValues + composed.redactedValues };
  }
  const read =
    floor === undefined
      ? readWith(out, ownPasses(patterns, readFrom))
      : withFloor(out, patterns, floor, readFrom);
  return { value: read.value, redactedValues: redactedValues + read.redactedValues };
}

/**
 * `text` read by `SECRET_VALUE_PATTERNS` (with their floor) and by the tail check together
 * (`docs/redaction-boundary-design-2026-11-27.md` §4.3): the value rules read the text, the check
 * reads the same text, and what it hides is hidden in what they kept (`TailMasker`) — every
 * character shown is one they show. Then the check reads that once more, and what it hides there is
 * hidden too: where the rules hid a value further than the check reads it (the `&` after it, say),
 * the mask stands against text the check then reads as an unclean close, and the result is the
 * text the check leaves as it is (`tailChecked` of it changes nothing). The check alone is
 * `STORED_REWRITE_SECRET_PATTERNS`'s never (design D3), and a list of a caller's own never
 * gets it; a stream composes the same way in its own steps (`secret-stream.ts`).
 */
function composeWithTailCheck(
  text: string,
  floor: readonly released.ValuePattern[],
): Scrubbed<string> {
  const checked = tailMarks(text);
  let first: Scrubbed<string>;
  if (checked.marks.length === 0) {
    first = withFloor(text, SECRET_VALUE_PATTERNS, floor, 0);
    // The rules kept `text` as it is: the read once more is of `text`, which the check has just
    // read and marked nothing in (no marks, no tails). Most short parts end here — a JSON text's
    // strings are read one by one (legacy 916) — so the second read is not made.
    if (first.value === text) return first;
  } else {
    const read = floorReading(text, SECRET_VALUE_PATTERNS, floor, 0, true);
    const masker = new TailMasker();
    masker.add(read.segments ?? []);
    const value = masker.compose(text.length, checked.marks) + masker.finish();
    first = { value, redactedValues: read.redactedValues + masker.redactedValues };
  }
  const again = tailChecked(first.value);
  return withTailCounts(
    { value: again.value, redactedValues: first.redactedValues + again.redactedValues },
    checked.tails + again.tails,
    checked.tailChars + again.tailChars,
  );
}

/** What `scrubSecretValues` makes of `text` with the value rules alone (no tail check), and where
 *  each stretch of it comes from in `text` (`Segment`): a stream's step, which composes with the
 *  check over the stream itself (`secret-stream.ts`). */
export function placedSecretValues(
  text: string,
): Scrubbed<string> & { readonly segments: readonly Segment[] } {
  const floor = FLOORS.get(SECRET_VALUE_PATTERNS) ?? [];
  const read = floorReading(text, SECRET_VALUE_PATTERNS, floor, 0, true);
  return { value: read.value, redactedValues: read.redactedValues, segments: read.segments ?? [] };
}

function scrubInto(text: string, state: WalkState): string {
  // Each part read counts its tails here; its values are summed by whoever reads it.
  const plain = (part: string): Scrubbed<string> => {
    const scrubbed = scrubPlain(part, state.literals, state.patterns, 0, state.tailCheck);
    state.tails += scrubbed.redactedTails ?? 0;
    state.tailChars += scrubbed.redactedTailChars ?? 0;
    return scrubbed;
  };
  if (state.jsonTextKey !== undefined) {
    // The strings of JSON text decoded too (legacy 916), then the rest of the text as it is.
    const fields = redactSecretFieldsInJsonText(text, state.jsonTextKey, plain);
    const rest = scrubOutsideSpans(fields.value, fields.decodedSpans, plain);
    state.count += fields.redactedValues + rest.redactedValues;
    return rest.value;
  }
  const scrubbed = plain(text);
  state.count += scrubbed.redactedValues;
  return scrubbed.value;
}

function freshState(options: RedactSecretsOptions = {}): WalkState {
  return {
    count: 0,
    tails: 0,
    tailChars: 0,
    nodes: options.maxNodes ?? MAX_WALK_NODES,
    chars: options.maxChars ?? Number.POSITIVE_INFINITY,
    omitted: false,
    bounded: options.maxChars !== undefined && Number.isFinite(options.maxChars),
    onRedacted: options.onRedacted,
    patterns: options.patterns ?? SECRET_VALUE_PATTERNS,
    literals: options.literals ?? [],
    tailCheck: options.tailCheck ?? true,
    jsonTextKey: options.jsonTextFields === true ? options.isSecretKey : undefined,
  };
}

/** `text` with every secret-looking value replaced. Linear in `text`; a caller holding text of
 *  unbounded size bounds it first. `patterns` defaults to `SECRET_VALUE_PATTERNS`, with the tail
 *  check (`tailCheck`, as `RedactSecretsOptions`'); a rewrite of rows already stored passes
 *  `STORED_REWRITE_SECRET_PATTERNS`, which never gets it (design D3). */
export function scrubSecretValues(
  text: string,
  options: {
    readonly patterns?: readonly SecretPattern[];
    readonly tailCheck?: boolean;
  } = {},
): Scrubbed<string> {
  const patterns = options.patterns ?? SECRET_VALUE_PATTERNS;
  const state = freshState({
    patterns,
    ...(options.tailCheck !== undefined ? { tailCheck: options.tailCheck } : {}),
  });
  return withTailCounts(
    { value: scrubInto(text, state), redactedValues: state.count },
    state.tails,
    state.tailChars,
  );
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

/** The index of the first character below U+0020 in `text` from `from`, or `text.length`. */
function firstControlChar(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 0x20) return index;
  }
  return text.length;
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

/** A secret's name and separator (`SECRET_NAME_AND_SEPARATOR`), and the quote its value opens
 *  with. */
const SECRET_NAME_AND_OPENING_QUOTE = new RegExp(String.raw`${SECRET_NAME_AND_SEPARATOR}["']`, 'g');

/**
 * Where the value starts — at its opening quote — that `decoded` ends with: a string the text ends
 * inside, read to where it was cut (legacy 982, review #501 on #1629). Its last line ends in a value
 * quoted after a secret's name (the last such on the line) that nothing after its quote closes. The
 * cut took the rest of the value, so what is left of it is the start of a secret, and nothing of the
 * string comes after it: hiding it to the cut hides nothing else. A quote left open on a line that
 * goes on is not this (legacy 923: no rule reads it as a value). `-1` when the line does not end
 * so, or what is left of the value is empty, the mask or the start of it (a copy cut inside a mask
 * it wrote). Not the tail check: it reads one end the text is known to have, and never past it.
 */
function openValueAtTheCut(decoded: string): number {
  const lineStart = Math.max(decoded.lastIndexOf('\n'), decoded.lastIndexOf('\r')) + 1;
  let quoteAt = -1;
  for (const pair of decoded.slice(lineStart).matchAll(SECRET_NAME_AND_OPENING_QUOTE)) {
    quoteAt = lineStart + pair.index + pair[0].length - 1;
  }
  if (quoteAt === -1) return -1;
  const value = decoded.slice(quoteAt + 1);
  if (value === '' || value.includes(decoded.charAt(quoteAt)) || REDACTED.startsWith(value)) {
    return -1;
  }
  return quoteAt;
}

/** `read` — a string the text ends inside, decoded and scrubbed — with the value it ends with
 *  hidden from its quote to the cut (`openValueAtTheCut`), as the tail check hides one open at
 *  its line's end; counted. */
function hiddenToTheCut(read: Scrubbed<string>): Scrubbed<string> {
  const at = openValueAtTheCut(read.value);
  if (at === -1) return read;
  return {
    ...read,
    value: `${read.value.slice(0, at)}${REDACTED}`,
    redactedValues: read.redactedValues + 1,
  };
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
   *  inside it), decoded and scrubbed; written back when `scrubValue` changed it. One the text
   *  ends inside ends at its first raw control character, if any: JSON writes none inside a
   *  string, so it is where the cut was — a runtime's note after it (`\n\n[... more characters
   *  omitted ...]`) — and the string read to there decodes, the note is left to the pass over the
   *  text as it is (review #501 on #1629). What is left of a value it was cut inside, quoted and
   *  open to the cut, is hidden there (`hiddenToTheCut`): only this read sees the string end. */
  const rewrite = (start: number, quote: number): void => {
    const closed = quote < length;
    const stop = closed ? quote : firstControlChar(text, start + 1);
    const end = closed ? quote + 1 : stop;
    const inner = text.slice(start + 1, stop);
    if (scrubValue === undefined) return;
    // Without an escape a string reads the same decoded, and the pass over the text as it is
    // reads it — unless it was cut inside a value.
    const escaped = inner.includes('\\');
    if (!escaped && (closed || openValueAtTheCut(inner) === -1)) return;
    const partial = closed ? 0 : partialEscapeLength(inner);
    const decoded = decodedJsonString(`"${inner.slice(0, inner.length - partial)}"`);
    if (decoded === undefined) return;
    const read = scrubValue(decoded);
    const scrubbed = closed ? read : hiddenToTheCut(read);
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
  readonly patterns?: readonly SecretPattern[];
  /** Known secret values (`secretFieldLiterals` of the content this value quotes — a tool call's
   *  arguments, for its result) hidden as literals in every string, before the patterns. */
  readonly literals?: readonly string[];
  /** With `isSecretKey`: every string that is JSON text gets the same key rule over its text
   *  (`redactSecretFieldsInJsonText`), before the literals — a tool's result is its JSON as text,
   *  and one that echoes the call's arguments must hide a field as they did (legacy 185). In the
   *  same walk, so it reads what the walk reads and no more (legacy 819). */
  readonly jsonTextFields?: boolean;
  /** Whether `SECRET_VALUE_PATTERNS` are read together with the tail check (`tail-check.ts`,
   *  `composeWithTailCheck`; design §4.2–§4.3), which hides the rest of a line from a value read
   *  after a secret's name that did not close cleanly. Defaults to true; other patterns never get
   *  it. Only the scrub report passes false, to read a stored row as the value rules alone read it
   *  and tell what the check adds («收尾未证明», `application/platform/scrub-raw-secrets.ts`) —
   *  `tail-check.guard.test.ts` holds every other caller to the default. */
  readonly tailCheck?: boolean;
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
  return withTailCounts(
    { value: redacted, redactedValues: state.count, omitted: state.omitted },
    state.tails,
    state.tailChars,
  );
}
