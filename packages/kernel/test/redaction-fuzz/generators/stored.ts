import { type Rng, between, int, pick } from '../rng.js';
import type { Generator, Row } from '../row.js';
import { distinctRows } from '../row.js';

/**
 * Rows as earlier releases stored them (review #493 on #1619): forms the last release no longer
 * writes, which the stored reading still reads on upgrade — read by it alone, from the row itself
 * (`Row.stored`). The secret is random each row.
 *
 * - `stored/split-masks`: a `\"…\"` value the value patterns split before they read it as one
 *   (legacy 916 for JSON text, 918 for plain text): its opening run hidden, the value kept,
 *   `API_TOKEN=[redacted]"<value>\"` — what `repairSplitQuotedMasks` writes again.
 * - `stored/masked-tails`: a mask with text against it, `password="[redacted]"<value>` and its
 *   kin (legacy 950), quoted every way the value rules read.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MASK = '[redacted]';

function secret(r: Rng): string {
  let out = 'FAKE';
  const length = between(r, 16, 40);
  while (out.length < length) out += LETTERS.charAt(int(r, LETTERS.length));
  return out;
}

/** Names before the split value, with the separator the mask stood right after. */
const SPLIT_PAIRS = [
  'export API_TOKEN=',
  'password: ',
  '-H X-Api-Key:',
  'run --password ',
  'password:\t',
  'DB_PASSWORD=',
  'client_secret: ',
];
/** What stood before and after the line, and after the value inside its quotes. */
const BEFORE = ['', 'step 2: ', 'command: "', '[INFO] ', 'docker run -e '];
const INSIDE = ['', ' x', ' and more'];
const AFTER = ['', ' && run', '"', ' now', ' -e \\"DEBUG=1\\" img', '\nnext line'];

function splitMask(r: Rng): Row {
  const value = secret(r);
  const [before, pair, inside, after] = [
    pick(r, BEFORE),
    pick(r, SPLIT_PAIRS),
    pick(r, INSIDE),
    pick(r, AFTER),
  ];
  if (int(r, 4) === 0) {
    // JSON text, a tool result's stdout (legacy 916): the value quoted `"…"` in the line, written
    // `\"…\"` in the JSON, its opening `\"` taken for the value. A tab is `\t` there, which no
    // separator took.
    const line = `${before}${pair.replace('\t', ' ')}"${value}${inside}"${after}`;
    const json = JSON.stringify({ stdout: line });
    return { t: json.replace(`\\"${value}`, `${MASK}"${value}`), req: [value], stored: true };
  }
  // Plain text (legacy 918): the run that opened and closed the value is `\"`, or `\\\"` in text
  // written inside a string — the opening run taken whole.
  const run = int(r, 4) === 0 ? '\\\\\\"' : '\\"';
  return {
    t: `${before}${pair}${MASK}"${value}${inside}${run}${after}`,
    req: [value],
    stored: true,
  };
}

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
  'stored/split-masks': (r, n) => distinctRows(r, n, splitMask),
  'stored/masked-tails': (r, n) => distinctRows(r, n, maskedTail),
};
