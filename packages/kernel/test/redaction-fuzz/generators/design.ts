import { type Rng, int, pick } from '../rng.js';
import { type Generator, distinctRows, marked } from '../row.js';

/**
 * The generators the redaction-boundary design measured with (design doc §5): random concatenation in
 * four weightings, and well-formed JSON written plain or inside one more string.
 */

const S = 'Zq7Xw9Lm2Kp4';
const NAMES = [
  'token',
  'password',
  'api_key',
  'apikey',
  'secret',
  'TOKEN',
  'API_KEY',
  'APIKEY',
  'PGPASSWORD',
  'I_TOKEN',
  'passwordx',
  'tokenValue',
  'myToken',
  '_password',
  'Api_key',
];
const PLAIN = ['note', 'x', 'user', 'DEBUG', 'path', 'cmd', 'a', 'b'];
const FLAGS = ['--token', '--password', '--apikey', '--passwd', '--verbose'];
const SEPS = ['=', ':', ': ', ' = ', ' : ', '=', ':'];
const QUOTES = ['"', "'", '\\"', '\\\\\\"', '""', "''"];
const FILL = ['x', 'a', 'b', 'abc', 'y', '1', 'n'];
const DELIM = [' ', ' ', ',', ';', '&', '|', ', ', '{', '}', '  '];

interface Weights {
  readonly name: number;
  readonly plain: number;
  readonly flag: number;
  readonly sep: number;
  readonly quote: number;
  readonly fill: number;
  readonly delim: number;
}
const FLAVORS: Record<string, Weights> = {
  nested: { name: 3, plain: 1, flag: 1, sep: 3, quote: 6, fill: 3, delim: 1 },
  keys: { name: 6, plain: 2, flag: 1, sep: 4, quote: 3, fill: 2, delim: 2 },
  quotes: { name: 2, plain: 1, flag: 0, sep: 2, quote: 8, fill: 3, delim: 1 },
  valueName: { name: 5, plain: 1, flag: 2, sep: 5, quote: 3, fill: 1, delim: 3 },
};

function piece(r: Rng, w: Weights): string {
  const kinds: [number, () => string][] = [
    [w.name, () => pick(r, NAMES)],
    [w.plain, () => pick(r, PLAIN)],
    [w.flag, () => `${pick(r, FLAGS)} `],
    [w.sep, () => pick(r, SEPS)],
    [w.quote, () => pick(r, QUOTES)],
    [w.fill, () => pick(r, FILL)],
  ];
  let x = r() * (kinds.reduce((sum, [weight]) => sum + weight, 0) + w.delim);
  for (const [weight, make] of kinds) {
    if (x < weight) return make();
    x -= weight;
  }
  return pick(r, DELIM);
}

function concatenated(r: Rng, w: Weights): string {
  const n = 3 + int(r, 8);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) parts.push(piece(r, w));
  // The marker after a secret's name and separator somewhere before it: a pair goes first.
  const head = `${pick(r, NAMES)}${pick(r, SEPS)}`;
  parts.splice(1 + int(r, parts.length - 1), 0, S);
  return head + parts.join('');
}

function json(r: Rng): string {
  const o: Record<string, string> = {};
  const n = 1 + int(r, 3);
  for (let i = 0; i < n; i += 1) {
    o[pick(r, PLAIN) + i] = pick(r, [
      pick(r, FILL),
      `${pick(r, NAMES)}=${pick(r, FILL)}`,
      'a "b" c',
      "it's",
    ]);
  }
  o[pick(r, NAMES)] = r() < 0.3 ? `${pick(r, FILL)} ${S}` : S;
  if (r() < 0.5) o[`${pick(r, PLAIN)}z`] = pick(r, FILL);
  const text = JSON.stringify(o);
  return r() < 0.4
    ? `log: ${JSON.stringify({ cmd: text })}`
    : r() < 0.5
      ? `${pick(r, FILL)} ${text}`
      : text;
}

const of =
  (line: (r: Rng) => string): Generator =>
  (r, n) =>
    distinctRows(r, n, (rr) => marked(line(rr), S));

export const DESIGN_GENERATORS: Record<string, Generator> = {
  'design/nested': of((r) => concatenated(r, FLAVORS.nested as Weights)),
  'design/keys': of((r) => concatenated(r, FLAVORS.keys as Weights)),
  'design/quotes': of((r) => concatenated(r, FLAVORS.quotes as Weights)),
  'design/valueName': of((r) => concatenated(r, FLAVORS.valueName as Weights)),
  'design/json': of(json),
};
