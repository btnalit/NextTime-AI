import { type Rng, between, int, pick } from '../rng.js';
import { type Generator, type Row, distinctRows } from '../row.js';

/**
 * The real-format corpus, first batch (design doc §4.4 item 2, §7 stage 1a): a few name–value pairs,
 * written the way `.env`, YAML, INI, JSON, JSON inside a string, shell assignments and `--flag`s,
 * and PHP / Ruby `=>` write them. Each secret value's place is recorded as it is written (`spans`),
 * so what counts as shown is exactly the value's characters — quotes and escapes around it are not.
 *
 * Names are ones the name rules already know (`SECRET_NAMES`; `harness.test.ts` holds them to
 * `namesASecretValue`): this measures how a format is read, not which names are known — names are
 * design doc stage 2. Values are random; hosts are `example.invalid`.
 */

/** A secret's name, in the spelling a format uses it in. */
export const SECRET_NAMES = [
  'password',
  'db_password',
  'api_key',
  'token',
  'secret',
  'client_secret',
  'access_token',
  'auth_token',
  'secret_key',
  'private_token',
  'github_token',
  'redis_password',
];
const PLAIN_PAIRS: [string, (r: Rng) => string][] = [
  ['host', (r) => pick(r, ['db.example.invalid', 'cache.example.invalid', 'localhost'])],
  ['port', (r) => String(pick(r, [5432, 6379, 8080, 443]))],
  ['user', (r) => pick(r, ['app', 'admin', 'deploy', 'readonly'])],
  ['database', (r) => pick(r, ['orders', 'app_prod', 'analytics'])],
  ['region', (r) => pick(r, ['eu-west-1', 'us-east-2', 'ap-south-1'])],
  ['log_level', (r) => pick(r, ['info', 'debug', 'warn'])],
  ['timeout', (r) => `${between(r, 1, 60)}s`],
];

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const word = (r: Rng, from: number, to: number, extra = '') => {
  const chars = ALNUM + extra;
  let s = pick(r, [...ALNUM]);
  for (let i = between(r, from, to) - 1; i > 0; i -= 1) s += chars[int(r, chars.length)];
  return s;
};

/** What a value may hold, as one spelling of a format allows it. */
type Allows = 'word' | 'symbols' | 'spaces' | 'anything';
function secretValue(r: Rng, allows: Allows): string {
  switch (allows) {
    case 'word':
      return word(r, 12, 32);
    case 'symbols':
      return word(r, 12, 32, '-_.+/=!@%^*~');
    case 'spaces': {
      const n = between(r, 2, 4);
      return Array.from({ length: n }, () => word(r, 4, 10)).join(' ');
    }
    case 'anything':
      // Quotes and backslashes too: a JSON string escapes them.
      return word(r, 8, 20, '-_.+/=!@%^*~ "\\\'#:,;{}');
  }
}

/** Text being written, with the places of the secrets written into it. */
class Doc {
  t = '';
  readonly spans: [number, number][] = [];
  add(s: string): this {
    this.t += s;
    return this;
  }
  secret(value: string): this {
    const at = this.t.length;
    this.t += value;
    this.spans.push([at, this.t.length]);
    return this;
  }
  row(): Row {
    return { t: this.t, spans: this.spans };
  }
}

interface Pair {
  readonly name: string;
  readonly secret: boolean;
  /** The value for a spelling that allows `allows`. */
  value(allows: Allows): string;
}

/** 1–4 pairs, at least one a secret, each name once (a JSON object keeps the last of two). */
function pairs(r: Rng): Pair[] {
  const out: Pair[] = [];
  const used = new Set<string>();
  const fresh = <T>(items: readonly T[], nameOf: (item: T) => string): T => {
    for (;;) {
      const item = pick(r, items);
      if (!used.has(nameOf(item))) {
        used.add(nameOf(item));
        return item;
      }
    }
  };
  for (let i = int(r, 3); i > 0; i -= 1) {
    const [name, make] = fresh(PLAIN_PAIRS, ([n]) => n);
    const v = make(r);
    out.push({ name, secret: false, value: () => v });
  }
  for (let i = 1 + int(r, 2); i > 0; i -= 1) {
    const name = fresh(SECRET_NAMES, (n) => n);
    out.splice(int(r, out.length + 1), 0, {
      name,
      secret: true,
      value: (allows) => secretValue(r, allows),
    });
  }
  return out;
}

const upper = (name: string) => name.toUpperCase();
const kebab = (name: string) => name.replace(/_/g, '-');
const camel = (name: string) => name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

function write(doc: Doc, pair: Pair, value: string): void {
  if (pair.secret) doc.secret(value);
  else doc.add(value);
}

// ---- .env ---------------------------------------------------------------------------------------

function env(r: Rng): Row {
  const doc = new Doc();
  if (r() < 0.3) doc.add(pick(r, ['# app settings\n', '# generated\n']));
  pairs(r).forEach((pair, i) => {
    if (i > 0) doc.add('\n');
    doc.add(`${r() < 0.2 ? 'export ' : ''}${upper(pair.name)}=`);
    const form = int(r, 3);
    // Unquoted, a value runs to the end of its line, spaces and all (docker's env file, dotenv).
    if (form === 0) write(doc, pair, pair.value(pick(r, ['symbols', 'spaces'] as const)));
    else {
      const q = form === 1 ? '"' : "'";
      doc.add(q);
      write(doc, pair, pair.value(pick(r, ['symbols', 'spaces'] as const)));
      doc.add(q);
    }
    if (r() < 0.15) doc.add(pick(r, [' # rotate monthly', ' # do not commit']));
  });
  return doc.row();
}

// ---- YAML ---------------------------------------------------------------------------------------

function yaml(r: Rng): Row {
  const doc = new Doc();
  const nested = r() < 0.5;
  const indent = nested ? '  ' : '';
  if (nested) doc.add(`${pick(r, ['database', 'service', 'auth', 'production'])}:\n`);
  pairs(r).forEach((pair, i) => {
    if (i > 0) doc.add('\n');
    doc.add(`${indent}${r() < 0.3 ? camel(pair.name) : pair.name}: `);
    const form = int(r, 3);
    if (form === 0) write(doc, pair, pair.value(pick(r, ['word', 'spaces'] as const)));
    else {
      const q = form === 1 ? '"' : "'";
      doc.add(q);
      write(doc, pair, pair.value(pick(r, ['symbols', 'spaces'] as const)));
      doc.add(q);
    }
    if (r() < 0.1) doc.add(' # from vault');
  });
  return doc.row();
}

// ---- INI ----------------------------------------------------------------------------------------

function ini(r: Rng): Row {
  const doc = new Doc();
  if (r() < 0.7) doc.add(`[${pick(r, ['database', 'client', 'credentials', 'default'])}]\n`);
  pairs(r).forEach((pair, i) => {
    if (i > 0) doc.add('\n');
    doc.add(`${pair.name}${pick(r, [' = ', '=', ' =', '= '])}`);
    if (r() < 0.2) {
      doc.add('"');
      write(doc, pair, pair.value(pick(r, ['symbols', 'spaces'] as const)));
      doc.add('"');
    } else write(doc, pair, pair.value(pick(r, ['symbols', 'spaces'] as const)));
  });
  return doc.row();
}

// ---- JSON, and JSON inside a string --------------------------------------------------------------

/** `value` as a JSON string's characters (no quotes), the way `JSON.stringify` escapes them. */
const jsonChars = (value: string) => JSON.stringify(value).slice(1, -1);

function jsonDoc(r: Rng, pretty: boolean): Doc {
  const doc = new Doc();
  const ps = pairs(r);
  const wrap = r() < 0.3 ? pick(r, ['config', 'credentials', 'auth']) : undefined;
  const nl = (depth: number) => (pretty ? `\n${'  '.repeat(depth)}` : '');
  const depth = wrap ? 2 : 1;
  doc.add('{');
  if (wrap) doc.add(`${nl(1)}${JSON.stringify(wrap)}:${pretty ? ' ' : ''}{`);
  ps.forEach((pair, i) => {
    if (i > 0) doc.add(',');
    doc.add(
      `${nl(depth)}${JSON.stringify(r() < 0.3 ? camel(pair.name) : pair.name)}:${pretty ? ' ' : ''}"`,
    );
    const value = pair.value(pick(r, ['symbols', 'spaces', 'anything'] as const));
    if (pair.secret) doc.secret(jsonChars(value));
    else doc.add(jsonChars(value));
    doc.add('"');
  });
  if (wrap) doc.add(`${nl(1)}}`);
  doc.add(`${nl(0)}}`);
  return doc;
}

const json = (r: Rng): Row => jsonDoc(r, r() < 0.5).row();

/** `inner` written as a JSON string's characters, each span moved to where its characters went. */
function inString(inner: Doc): { chars: string; spans: [number, number][] } {
  const at: number[] = [];
  let chars = '';
  for (const c of inner.t) {
    at.push(chars.length);
    chars += jsonChars(c);
  }
  at.push(chars.length);
  // `for…of` walks code points; spans are in UTF-16 units. The corpus is ASCII.
  return { chars, spans: inner.spans.map(([s, e]) => [at[s] as number, at[e] as number]) };
}

function jsonInString(r: Rng): Row {
  const inner = jsonDoc(r, false);
  const { chars, spans } = inString(inner);
  const [before, after] = pick(r, [
    ['{"body":"', '"}'],
    ['{"cmd": "curl -d \'', '\' https://api.example.invalid/login"}'],
    ['request payload="', '" status=200'],
    ['{"level":"debug","msg":"sending","payload":"', '"}'],
  ] as const);
  return {
    t: before + chars + after,
    spans: spans.map(([s, e]) => [s + before.length, e + before.length] as [number, number]),
  };
}

// ---- shell: assignments and --flags ---------------------------------------------------------------

function shell(r: Rng): Row {
  const doc = new Doc();
  const cmd = pick(r, [
    'deploy --env prod',
    'psql -h db.example.invalid',
    './run.sh',
    'docker login registry.example.invalid',
    'node server.js',
    'curl https://api.example.invalid/v1',
  ]);
  const ps = pairs(r);
  const style = int(r, 3);
  if (style === 0) {
    // NAME=value NAME2=value2 cmd
    for (const pair of ps) {
      doc.add(`${upper(pair.name)}=`);
      if (r() < 0.4) {
        const q = pick(r, ['"', "'"]);
        doc.add(q);
        write(doc, pair, pair.value(pick(r, ['symbols', 'spaces'] as const)));
        doc.add(`${q} `);
      } else {
        write(doc, pair, pair.value('word'));
        doc.add(' ');
      }
    }
    doc.add(cmd);
  } else if (style === 1) {
    // export NAME="value" && cmd
    ps.forEach((pair, i) => {
      if (i > 0) doc.add(pick(r, ['; ', ' && ', '\n']));
      doc.add(`export ${upper(pair.name)}=`);
      const q = pick(r, ['"', "'", '']);
      doc.add(q);
      write(doc, pair, pair.value(q ? pick(r, ['symbols', 'spaces'] as const) : 'word'));
      doc.add(q);
    });
    doc.add(` && ${cmd}`);
  } else {
    // cmd --name value --name2=value2
    doc.add(cmd);
    for (const pair of ps) {
      doc.add(` --${kebab(pair.name)}${pick(r, [' ', '='])}`);
      const q = pick(r, ['', '', '"', "'"]);
      doc.add(q);
      write(doc, pair, pair.value(q ? pick(r, ['symbols', 'spaces'] as const) : 'word'));
      doc.add(q);
    }
  }
  return doc.row();
}

// ---- PHP and Ruby `=>` ------------------------------------------------------------------------------

function arrow(r: Rng): Row {
  const doc = new Doc();
  const php = r() < 0.6;
  doc.add(
    php
      ? pick(r, ['return [\n', '$config = array(\n', "'db' => [\n"])
      : pick(r, ['config = {\n', 'Settings = {\n']),
  );
  pairs(r).forEach((pair, i) => {
    if (i > 0) doc.add(',\n');
    const q = pick(r, ["'", '"']);
    const key = php || r() < 0.5 ? `${q}${pair.name}${q}` : `:${pair.name}`;
    doc.add(`    ${key} => ${q}`);
    write(
      doc,
      pair,
      pair.value(pick(r, ['word', 'symbols', 'spaces'] as const)).replace(/[\\'"]/g, ''),
    );
    doc.add(q);
  });
  doc.add(php ? pick(r, ['\n];', '\n);', ',\n]']) : '\n}');
  return doc.row();
}

const of =
  (line: (r: Rng) => Row): Generator =>
  (r, n) =>
    distinctRows(r, n, line);

export const REAL_FORMAT_GENERATORS: Record<string, Generator> = {
  'formats/env': of(env),
  'formats/yaml': of(yaml),
  'formats/ini': of(ini),
  'formats/json': of(json),
  'formats/json-in-string': of(jsonInString),
  'formats/shell': of(shell),
  'formats/arrow': of(arrow),
};
