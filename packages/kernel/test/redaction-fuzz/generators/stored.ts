import { type Rng, between, int, pick } from '../rng.js';
import type { Generator, Row } from '../row.js';
import { distinctRows } from '../row.js';

/**
 * Rows as earlier releases stored them (review #493 on #1619): forms the last release no longer
 * writes, which the stored reading still reads on upgrade — read by it alone, from the row itself
 * (`Row.stored`). The secret is random each row.
 *
 * - `stored/masked-tails`: a mask with text against it, `password="[redacted]"<value>` and its
 *   kin (legacy 950), quoted every way the value rules read.
 * - `stored/records-…`: a tool result as pi sent it, read as a tool-call record (`Row.record`):
 *   JSON, indented or not, with a secret in it — as a value in a line of output or as a
 *   secret-naming key's — that pi cut before legacy 967 at a character count, the note appended
 *   after a raw newline (`truncateToolResult`). The release's record reads the string the text ends
 *   inside to the end of the text, the note in it, and cannot decode it (review #501 on #1629).
 *   `cut-after-value`: cut inside the string after the value and its closing quote. `cut-in-value`:
 *   cut inside the value, at least 8 of its characters kept — a quoted value's quote left open,
 *   which the rewrite hides from its quote to the cut (`openValueAtTheCut`). `cut-elsewhere`: not
 *   cut, cut where the string has closed, or cut inside it before the value. `open-control`: text
 *   that is not JSON as written, a raw control character in its open string (review #501 on
 *   #1631).
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MASK = '[redacted]';

function secret(r: Rng): string {
  let out = 'FAKE';
  const length = between(r, 16, 40);
  while (out.length < length) out += LETTERS.charAt(int(r, LETTERS.length));
  return out;
}

/** What stood before the line. */
const BEFORE = ['', 'step 2: ', 'command: "', '[INFO] ', 'docker run -e '];

const TAIL_PAIRS = ['password=', 'TOKEN=', 'api_key: ', '"token":', 'run password=', '--secret '];
const QUOTES = ['"', "'", '\\"', '\\\\\\"'];
const AGAINST = ['', 'y', ' y', '"', "'", '": 1', '\\"'];

function maskedTail(r: Rng): Row {
  const value = secret(r);
  const quote = pick(r, QUOTES);
  const t = `${pick(r, BEFORE)}${pick(r, TAIL_PAIRS)}${quote}${MASK}${quote}${value}${pick(r, AGAINST)}`;
  return { t, req: [value], stored: true };
}

export const STORED_GENERATORS: Record<string, Generator> = {
  'stored/masked-tails': (r, n) => distinctRows(r, n, maskedTail),
};

/** A tool result's lines around the one with the secret: plain, quoted, escaped, not ASCII. */
const RESULT_LINES = [
  'HOME=/workspace',
  'PATH=/usr/local/bin:/usr/bin',
  '[INFO] step 1 ok',
  'say "hi"',
  'C:\\tmp\\out.log',
  '完成 3 项',
  'naïve\tcafé',
  '',
];
const SECRET_NAMES = [
  'PGPASSWORD',
  'AWS_SECRET_ACCESS_KEY',
  'API_TOKEN',
  'DB_PASSWORD',
  'GITHUB_TOKEN',
  'client_secret',
];
/** What stood before the name: the start of the line, `export`, a space — or nothing between the
 *  name and the escape before it (`\nPGPASSWORD=…` in the JSON), which an undecoded string reads
 *  as one word. */
const LEADS = ['', 'export ', '  '];
const VALUE_QUOTES = ['', '"', "'"];
const INDENTS = [undefined, 2];
const NOTE = (omitted: number) =>
  `\n\n[... ${omitted} more characters omitted — the full result is not shown ...]`;

const someLines = (r: Rng, most: number) =>
  Array.from({ length: int(r, most + 1) }, () => pick(r, RESULT_LINES));

/**
 * A tool result's JSON text with `value` in one string of it: `at`, where the value starts;
 * `end`, where the value and its closing quote end (`\"` in the JSON is two characters); `close`,
 * the string's closing quote. `line`: the value is in a line of output (`NAME=<value>`), not the
 * whole value of a secret-naming key.
 */
interface ResultJson {
  readonly json: string;
  readonly at: number;
  readonly end: number;
  readonly close: number;
  readonly line: boolean;
}

function resultJson(r: Rng, value: string, line = int(r, 4) !== 0): ResultJson {
  if (!line) {
    // The secret is the value of a secret-naming key: the key rule reads it.
    const object = { config: { user: 'app', password: value, retries: 3 }, note: 'loaded' };
    const json = JSON.stringify(object, null, pick(r, INDENTS));
    const at = json.indexOf(value);
    return { json, at, end: at + value.length, close: at + value.length, line };
  }
  const quote = pick(r, VALUE_QUOTES);
  const secretLine = `${pick(r, LEADS)}${pick(r, SECRET_NAMES)}=${quote}${value}${quote}`;
  const stdout = [...someLines(r, 3), secretLine, ...someLines(r, 4)].join('\n');
  const shapes = [
    { stdout, stderr: '', code: 0 },
    { result: { stdout, code: 0 }, ok: true, note: 'see the log' },
    { output: stdout, status: 'done' },
  ];
  const json = JSON.stringify(pick(r, shapes), null, pick(r, INDENTS));
  const at = json.indexOf(value);
  const end = at + value.length + JSON.stringify(quote).length - 2;
  let close = end;
  while (json.charAt(close) !== '"') close += json.charAt(close) === '\\' ? 2 : 1;
  return { json, at, end, close, line };
}

/** The string's opening quote, before `at`. */
function openOf(json: string, at: number): number {
  let open = at;
  while (json.charAt(open - 1) !== '"' || json.charAt(open - 2) === '\\') open -= 1;
  return open;
}

/** `json` as pi cut it at `cut` characters, the note after it; all of it when `cut` is past it. */
const cutAt = (json: string, cut: number): string =>
  cut >= json.length ? json : `${json.slice(0, cut)}${NOTE(json.length - cut)}`;

/** Cut inside the string, the value and its closing quote kept: the release's record reads the
 *  value out of an undecoded string, as `\nPGPASSWORD=…` with the escape against the name. */
function cutAfterValue(r: Rng): Row | undefined {
  const value = secret(r);
  const { json, end, close } = resultJson(r, value, true);
  return { t: cutAt(json, between(r, end, close)), req: [value], record: true };
}

/** Cut inside the value, at least 8 of its characters kept; a quoted value's quote left open. */
function cutInValue(r: Rng): Row | undefined {
  const value = secret(r);
  const { json, at, end } = resultJson(r, value);
  const cut = between(r, at + 8, end - 1);
  return {
    t: cutAt(json, cut),
    req: [json.slice(at, Math.min(cut, at + value.length))],
    record: true,
  };
}

/** Not cut; cut once the string with the value closed (between fields, inside a later string);
 *  or cut inside it before the value. */
function cutElsewhere(r: Rng): Row | undefined {
  const value = secret(r);
  const { json, at, close } = resultJson(r, value);
  const where = int(r, 3);
  if (where === 0) return { t: json, req: [value], record: true };
  if (where === 1) {
    if (close + 1 >= json.length - 1) return undefined;
    return { t: cutAt(json, between(r, close + 1, json.length - 1)), req: [value], record: true };
  }
  const open = openOf(json, at);
  if (open >= at) return undefined;
  return { t: cutAt(json, between(r, open, at)), req: [], record: true };
}

/**
 * A tool result's text that is not JSON as written (command output passed on raw, a file cut at a
 * byte count; review #501 on #1631), opening with `{` and ending inside a string with an escape in
 * it, and a raw control character inside what must be read as one: a name and its value either
 * side of a tab (`pair`), a key block across a line break (`block`); or a line break with no key
 * block open before it, the cut legacy 982 reads apart (`line`). Read apart at the tab or across
 * the block, the name no longer meets its value and the block loses its BEGIN; the string is left
 * whole to the reading of the text as it is, as v0.70.1 read it. The names and separators are ones
 * v0.70.1's record reads across these characters (a vertical tab or a form feed between a name and
 * its value, `--token` and an escaped key before a tab: neither version reads them, so no row
 * requires them).
 */
const OPEN_KEYS = ['out', 'stdout', 'cmd', 'result'];
const ESCAPED = [
  'echo \\"x\\"; ',
  'cfg \\"a\\" ',
  'C:\\\\tmp\\\\a ',
  'ok\\nnext ',
  'say \\u0041 ',
  '',
];
const TABS = ['\t', '\t\t'];
const BREAKS = ['\n', '\r\n', '\r'];
const OPEN_PAIRS = ['PASSWORD=', 'password:', 'password: ', 'api_key=', 'TOKEN=', 'client_secret:'];
const OPEN_QUOTES = ['', '\\"', "'"];
const KEY_KINDS = ['RSA PRIVATE KEY', 'PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'EC PRIVATE KEY'];
const OPEN_TAILS = ['', ' more', ' && run', '\\" x', NOTE(120)];

function openControl(r: Rng): Row | undefined {
  const lead = `{"${pick(r, OPEN_KEYS)}": "${pick(r, ESCAPED)}`;
  const tail = pick(r, OPEN_TAILS);
  const shape = int(r, 3);
  if (shape === 2) {
    const kind = pick(r, KEY_KINDS);
    const lineBreak = pick(r, BREAKS);
    const body = Array.from({ length: 1 + int(r, 3) }, () => secret(r));
    const end = int(r, 2) === 0 ? `${lineBreak}-----END ${kind}-----` : '';
    const block = `-----BEGIN ${kind}-----${lineBreak}${body.join(lineBreak)}${end}`;
    return { t: `${lead}key \\"id\\": ${block}${tail}`, req: body, record: true };
  }
  const value = secret(r);
  const quote = pick(r, OPEN_QUOTES);
  const split = shape === 0 ? pick(r, TABS) : '';
  const pair = `${pick(r, OPEN_PAIRS)}${split}${quote}${value}${quote}`;
  // `line`: the pair on a line of its own, a raw line break after it and nothing open before.
  const after = shape === 1 ? `${pick(r, BREAKS)}more${pick(r, TABS)}` : '';
  return { t: `${lead}${pair}${after}${tail}`, req: [value], record: true };
}

/** Tool results read as tool-call records (`Row.record`). */
export const RECORD_GENERATORS: Record<string, Generator> = {
  'stored/records-cut-after-value': (r, n) => distinctRows(r, n, cutAfterValue),
  'stored/records-cut-in-value': (r, n) => distinctRows(r, n, cutInValue),
  'stored/records-cut-elsewhere': (r, n) => distinctRows(r, n, cutElsewhere),
  'stored/records-open-control': (r, n) => distinctRows(r, n, openControl),
};
