import { type Rng, between, int, pick } from '../rng.js';
import { type Generator, type Row, distinctRows } from '../row.js';

/**
 * The credentials seat's (#501) generators, from its reviews of #1593–#1600 (the seat's own
 * description of each is kept beside it). Secrets are synthetic; a row requires the ones it placed
 * where a reader must hide them (`used`), not every one it holds.
 */

const SEC = [
  'FAKEsecONEabcdefghijkl',
  'FAKEsecTWOmnopqrstuvw',
  'FAKEsecTHRxyzabcdefgh',
  'FAKEsecFOUqrstuvwxyzab',
] as const;
const sec = (i: number) => SEC[i] as string;
const required = (used: readonly boolean[]) => SEC.filter((_, i) => used[i]);
const holding = (t: string) => SEC.filter((s) => t.includes(s));

// ---- dump95dv: six groups ---------------------------------------------------------------------

/** `parts`: 3–12 pieces from one list (names, quotes, escapes, a secret, newlines). */
function parts(r: Rng): Row {
  const F = sec(1);
  const PARTS = [
    'token=',
    'password: ',
    'TOKEN=',
    '--token ',
    'api_key=',
    'note: ',
    'I_TOKEN=',
    '"',
    '"',
    "'",
    "'",
    '\\"',
    '\\',
    ' ',
    '  ',
    ',',
    ';',
    'x',
    'a ',
    F,
    '":',
    '": ',
    '"password": ',
    '\\"api_key\\": ',
    "'\"'",
    '"\'"',
    '=',
    ':',
    "TOKEN='\"'",
    '\n',
    '\r',
  ];
  const k = 3 + int(r, 10);
  let t = '';
  for (let i = 0; i < k; i += 1) t += pick(r, PARTS);
  return { t, req: holding(t) };
}

/** `keys`: a first value, a stop, then a named value holding a secret (and maybe a second). */
function keys(r: Rng): Row {
  const FIRST = [
    'token=',
    'TOKEN=',
    'API_KEY=',
    '"token" = ',
    'token: ',
    '--token ',
    '--password=',
    'password = ',
    'apikey=',
    'x.secret=',
  ];
  const FIRSTVAL = ['x', 'a', '', 'S0', 'x"', 'a\\'];
  const STOP = [',', ';', '&', '|', ',,', ', ', '&&'];
  const NEXT = [
    'password: ',
    'password:  ',
    'token: ',
    'token=',
    'token = ',
    'TOKEN=',
    'I_TOKEN=',
    'API_KEY=',
    '--password ',
    '--api-key=',
    'secret: ',
    'apikey=',
    'password:',
    'note: ',
    'myPassword: ',
  ];
  const OPENQ = ['"', '"', '"', "'", '\\"'];
  const KEY = [
    'api_key',
    'password',
    'token',
    'secret',
    'myPassword',
    'note',
    'user',
    'apikey',
    'Secret',
    'x.api_key',
    'tok',
    'passwordx',
  ];
  const KCLOSE = ['"', '"', '\\"', "'", ''];
  const KSEP = [': ', ':', ' = ', '=', '  : ', '\t:\t', ' ', ''];
  const VOPEN = ['', '"', "'", '\\"', ''];
  const TAIL = ['', '', '"', "'", ' y', '"}', '\\"', ' ,k: v', '\'"', '"\''];
  const used = [false, false, false];
  let fv = pick(r, FIRSTVAL);
  if (fv === 'S0') {
    fv = sec(0);
    used[0] = true;
  }
  let t =
    pick(r, FIRST) +
    fv +
    pick(r, STOP) +
    pick(r, NEXT) +
    pick(r, OPENQ) +
    pick(r, KEY) +
    pick(r, KCLOSE) +
    pick(r, KSEP);
  t += pick(r, VOPEN) + sec(1) + pick(r, TAIL);
  used[1] = true;
  if (r() < 0.3) {
    t +=
      pick(r, STOP) +
      pick(r, NEXT) +
      pick(r, OPENQ) +
      pick(r, KEY) +
      pick(r, KCLOSE) +
      pick(r, KSEP) +
      pick(r, VOPEN) +
      sec(2) +
      pick(r, TAIL);
    used[2] = true;
  }
  return { t, req: required(used) };
}

/** `quotes`: 2–4 pairs in one of 18 key spellings, each value quoted, with fragments around it. */
function quotes(r: Rng): Row {
  const NAMEF: ((n: string) => string)[] = [
    (n) => `${n.toUpperCase()}=`,
    (n) => `${n}: `,
    (n) => `--${n.replace('_', '-')} `,
    (n) => `--${n.replace('_', '-')}=`,
    (n) => `"${n}": `,
    (n) => `"${n}" : `,
    (n) => `\\"${n}" : `,
    (n) => `${n} = `,
    (n) => `$env:${n.toUpperCase()}=`,
    (n) => `'${n}': `,
    (n) => `"${n}"\t:\t`,
    (n) => `\\"${n}" = `,
    (n) => `"${n}" = `,
    (n) => `.--${n.replace('_', '-')} `,
    (n) => `my.${n}=`,
    (n) => `\\"${n}\\": `,
    (n) => `\\"${n}\\" = `,
    (n) => `my${(n[0] as string).toUpperCase()}${n.slice(1)}: `,
  ];
  const OPEN: [string, string][] = [
    ['"', '"'],
    ['"', '"'],
    ["'", "'"],
    ['\\"', ''],
    ['\\"', '\\"'],
    ['', ''],
    ["'", "'"],
  ];
  const NAMES = ['password', 'api_key', 'token', 'secret'];
  const SEPS = [' ', ', ', '; ', '&', ' && ', '\t:\t', ' : ', '}', '|', '.', '\n', ','];
  const FRAGS = [
    '\\',
    '\\"',
    '"',
    "'",
    ' ',
    'C:',
    'note: ',
    'a',
    'x=',
    ' k: ',
    ',',
    '=',
    'token: ',
    'x"',
  ];
  const k = 2 + int(r, 3);
  let t = '';
  const used = [false, false, false, false];
  for (let j = 0; j < k; j += 1) {
    const f = pick(r, NAMEF);
    const [o, c0] = pick(r, OPEN);
    const name = pick(r, NAMES);
    let v = '';
    const a = int(r, 3);
    const b = int(r, 3);
    for (let q = 0; q < a; q += 1) v += pick(r, FRAGS);
    v += sec(j);
    used[j] = true;
    for (let q = 0; q < b; q += 1) v += pick(r, FRAGS);
    const c = r() < 0.2 ? pick(r, ['"', '\\"', '\\\\"', "'"]) : c0;
    if (j > 0) t += pick(r, SEPS);
    t += f(name) + o + v + c;
  }
  return { t, req: required(used) };
}

/** `escjson` (ejgen) and `plainjson` (pjgen): a first value, then one or two JSON-ish pairs,
 *  escaped (`\"`) or plain. 15% of the first pair's values are plain words. */
function jsonish(lists: {
  FIRST: string[];
  FOPEN: string[];
  FVAL: string[];
  FCLOSE: string[];
  KOPEN: string[];
  KEY: string[];
  KCLOSE: string[];
  KSEP: string[];
  VOPEN: string[];
  VPRE: string[];
  VPOST: string[];
  VCLOSE: string[];
  TAIL: string[];
}): (r: Rng) => Row {
  const L = lists;
  const pair = (r: Rng, value: string) =>
    pick(r, L.KOPEN) +
    pick(r, L.KEY) +
    pick(r, L.KCLOSE) +
    pick(r, L.KSEP) +
    pick(r, L.VOPEN) +
    pick(r, L.VPRE) +
    value +
    pick(r, L.VPOST) +
    pick(r, L.VCLOSE) +
    pick(r, L.TAIL);
  return (r) => {
    const used = [false, false, false];
    let fv = pick(r, L.FVAL);
    if (fv === 'S0') {
      fv = sec(0);
      used[0] = true;
    }
    const plain = r() < 0.15;
    let t = pick(r, L.FIRST) + pick(r, L.FOPEN) + fv + pick(r, L.FCLOSE);
    if (plain) t += pair(r, 'plainTWOvaluehijklmn');
    else {
      t += pair(r, sec(1));
      used[1] = true;
    }
    if (r() < 0.35) {
      t += pick(r, [', ', ' ', '&', '']) + pair(r, sec(2));
      used[2] = true;
    }
    return { t, req: required(used) };
  };
}

const escjson = jsonish({
  FIRST: [
    'token: ',
    'token=',
    'password = ',
    '--token ',
    '--password=',
    'TOKEN=',
    'API_KEY=',
    '"token": ',
    '\\"token\\": ',
    'note: ',
    '{',
    'x=',
    '"cmd": "',
    '',
  ],
  FOPEN: ['\\"', '\\"', '"', "'", '', '\\\\\\"'],
  FVAL: ['', '', 'x', 'S0', 'a b', 'C:\\dir\\'],
  FCLOSE: ['', '', '\\"', '"', ', ', '; '],
  KOPEN: ['\\"', '\\"', '\\"', '"', '\\\\\\"', "'"],
  KEY: [
    'password',
    'token',
    'api_key',
    'x.api_key',
    'api-key',
    'Secret',
    'myToken',
    'passwordx',
    'tokenValue',
    '_password',
    '9token',
    'token1',
    'api key',
    '$token',
    'token:x',
    'a=token',
    'note',
    'user',
    'api_key=x&token',
    'TOKEN',
    'my token',
    'p@ssword',
    'tok',
  ],
  KCLOSE: ['\\"', '\\"', '\\"', '"', '', '\\\\\\"'],
  KSEP: [': ', ':', ' = ', '=', '  :  ', ' ', ''],
  VOPEN: ['\\"', '\\"', '"', '', "'", '\\\\\\"'],
  VPRE: [
    '',
    '',
    '',
    'a\\\\\\"b',
    'token: ',
    'apiKey\' = \\"',
    'x ',
    'password=',
    '--token ',
    'API_TOKEN=',
    'note: ',
    'a, ',
  ],
  VPOST: ['', '', '', 'myToken', 'Secret', 'password', ' token: x', '_key'],
  VCLOSE: ['\\"', '\\"', '"', '', "'", '\\\\\\"'],
  TAIL: ['', '', ': 1', '\\": 1', '}', '\\"}', ', \\"x\\": 1', ' y', '"', "'"],
});

const plainjson = jsonish({
  FIRST: [
    'token: ',
    'token=',
    'password = ',
    '--token ',
    '--password=',
    'TOKEN=',
    'API_KEY=',
    '"token": ',
    '\\"token\\": ',
    'note: ',
    '{',
    'x=',
    '"cmd": "',
    '',
    "token='",
    'apikey=passwd:',
  ],
  FOPEN: ['"', '"', "'", '\\"', '', '\\\\\\"'],
  FVAL: ['', '', 'x', 'S0', 'a b', 'token="', '\'"'],
  FCLOSE: ['', '', '"', "'", ', ', '; ', '&'],
  KOPEN: ['"', '"', '"', '\\"', "'", ''],
  KEY: [
    'passwordx',
    '_password',
    'apikeye',
    'tokenValue',
    'dbPasswordHash',
    'x passwordx',
    'x,password',
    'x,passwordx',
    "it's passwordx",
    'max_tokens--password',
    '--passwd',
    '--passwd x',
    'a --token b',
    'x\t--token',
    'api_key=x&tokenx',
    'password',
    'token',
    'api_key',
    'apikey',
    'note',
    'user',
    'token1',
    '9token',
    'passwd',
    'a b c token',
    `service_${'x'.repeat(50)}_password`,
    `svc_${'x'.repeat(44)}_password`,
  ],
  KCLOSE: ['"', '"', '"', '\\"', '', "'"],
  KSEP: [': ', ':', ' : ', '  :  ', ' = ', '=', ''],
  VOPEN: ['"', '"', '', "'", '\\"'],
  VPRE: [
    '',
    '',
    'token: ',
    'x ',
    'password=',
    '--token ',
    'API_TOKEN=',
    'note: ',
    'a, ',
    'apiKey\' = \\"',
    '\\"',
    'a\\"b',
  ],
  VPOST: ['', '', 'myToken', 'Secret', ' token: x', '"'],
  VCLOSE: ['"', '"', '', "'", '\\"', '"}'],
  TAIL: ['', '', ', "x": 1', '}', ' y', ': 1', '"', "'"],
});

// ---- dump95pj: heavier plain JSON --------------------------------------------------------------

/** `pjh` (#1593): a first value, then one or two plain JSON pairs — keys the name rule does not
 *  read, keys holding `:` or `=`, long keys — values with up to two name-and-separator pieces, `\"`
 *  `\\"` `\\\"` escapes, and legacy 929's endings. */
function pjh(r: Rng): Row {
  const FIRST = [
    'token: ',
    'token=',
    'password = ',
    '--token ',
    'TOKEN=',
    'API_KEY=',
    '"token": ',
    '\\"token\\": ',
    'note: ',
    '{',
    'x=',
    '"cmd": "',
    '',
    "token='",
    'apikey=passwd:',
  ];
  const FOPEN = ['"', '"', "'", '\\"', '', ''];
  const FVAL = ['', '', 'x', 'S0', 'a b', 'token="'];
  const FCLOSE = ['', '', '"', "'", ', ', '; '];
  const LONG = `service_${'x'.repeat(50)}_password`;
  const KEY = [
    'passwordx',
    '_password',
    'apikeye',
    'dbPasswordHash',
    'x passwordx',
    'x,password',
    "it's passwordx",
    'max_tokens--password',
    '--passwd x',
    'a --token b',
    'password:k',
    'a=passwordx',
    'x:token',
    'api_key=x&tokenx',
    LONG,
    'password',
    'token',
    'apikey',
    'note',
    'user',
    '9token',
  ];
  const KSEP = [': ', ':', ' : ', ': '];
  const PIECE = [
    '',
    '',
    '',
    'a ',
    'token: ',
    'x token=',
    'password=',
    '--token ',
    'API_TOKEN=',
    'note: ',
    ' token: x',
    'a, ',
  ];
  const ESC = ['', '', '', '\\"', '\\\\"', '\\\\\\"'];
  const POST = [
    '',
    '',
    '',
    'myToken',
    'Secret',
    'Token:',
    'Secret:',
    'myToken": 1',
    '-password"=',
    ' token: x',
  ];
  const VCLOSE = ['"', '"', '"', '', '\\"'];
  const SEP = [', ', ',', ' ', '', ', '];
  const TAIL = ['', '', '}', ' y', ': 1', '"'];
  const pair = (s: string) =>
    `"${pick(r, KEY)}"${pick(r, KSEP)}"${pick(r, PIECE)}${pick(r, ESC)}${pick(r, PIECE)}${s}${pick(r, POST)}${pick(r, ESC)}${pick(r, PIECE)}${pick(r, VCLOSE)}`;
  const used = [false, true, false];
  let fv = pick(r, FVAL);
  if (fv === 'S0') {
    fv = sec(0);
    used[0] = true;
  }
  let t = pick(r, FIRST) + pick(r, FOPEN) + fv + pick(r, FCLOSE) + pair(sec(1));
  if (r() < 0.5) {
    t += pick(r, SEP) + pair(sec(2));
    used[2] = true;
  }
  t += pick(r, TAIL);
  return { t, req: required(used) };
}

// ---- dump97w: a quoted value closed right against more of its word (legacy 937) ----------------

/** `g97m<mode>` (#1597): a name and separator, a `"…"` or `'…'` value, then text right against its
 *  closing quote (a secret, a word, a key, a next pair, a backtick, full-width punctuation, an
 *  escaped quote) — in plain text (mode 0), in JSON built with `JSON.stringify` (1), written in a
 *  string once more (2), one line holding two objects (3), and keys of 1–130 characters (4).
 *  Required: a secret right against the closing quote of a named value (up to a blank), right after
 *  a name and separator, or a secret-named key's value. */
function g97(mode: number): (r: Rng) => Row | undefined {
  const NAME = [
    'TOKEN=',
    'token=',
    'token: ',
    'API_TOKEN=',
    '--token ',
    '--password=',
    'password=',
    'apikey: ',
    'secret = ',
    'x.token=',
    'APIKEY=\\"TOKEN=',
  ];
  const Q = ['"', '"', "'"];
  const INNER = ['', '', 'x', 'a b', 'note:', 'password', 'x\\"y', 'token: x', '[redacted]'];
  const longKey = (k: number) => `${'x'.repeat(k)}_password`;
  const KEYS = [
    'passwordx',
    'apiKey',
    'note',
    'cmd',
    'description',
    'token',
    'x,passwordx',
    longKey(50),
    longKey(56),
    longKey(60),
    longKey(70),
    longKey(119),
  ];
  const AFTER = (s: string): [string, boolean][] => [
    [s, true],
    [`x${s}`, true],
    [`${s}y`, true],
    [`x${s}"`, true],
    [`${s}&b=1`, true],
    [`${s},`, true],
    ['', false],
    ['x', false],
    ['`', false],
    ['，然后', false],
    ['：', false],
    [')', false],
    [',', false],
    ['&', false],
    ['.', false],
    [`api_key: ${s}`, true],
    [`API_TOKEN=${s}`, true],
    [`x,passwordx": "${s}`, true],
    [`x,"passwordx": "${s}`, true],
    [`"${s}`, false],
    [`'${s}`, false],
    [`\\"${s}`, false],
    [`\`${s}`, false],
    [`，${s}`, false],
    [`x${s}\``, true],
    [`a--password ${s}`, false],
    [`写进配置${s}`, true],
  ];
  const TAIL = [
    '',
    '',
    ' y',
    '"',
    '""',
    "'",
    '\\"',
    ' token: x',
    '"}',
    ' && run',
    '`',
    '，',
    '\\',
    ': 1',
  ];
  return (r) => {
    const piece = (si: number): [string, string[]] => {
      const s = sec(si);
      const q = pick(r, Q);
      const [after, req] = pick(r, AFTER(s));
      return [pick(r, NAME) + q + pick(r, INNER) + q + after + pick(r, TAIL), req ? [s] : []];
    };
    const n = 1 + int(r, 2);
    let req: string[] = [];
    let t = '';
    if (mode === 0) {
      const ps: string[] = [];
      for (let j = 0; j < n; j += 1) {
        const [p, q] = piece(j);
        ps.push(pick(r, ['', 'run ', 'x ', '`', '配置 ']) + p);
        req = req.concat(q);
      }
      t = ps.join(pick(r, [' ', '; ', ' && ', '\n', '']));
    } else {
      const mem: string[] = [];
      for (let j = 0; j < n + 1; j += 1) {
        const key =
          mode === 4
            ? r() < 0.5
              ? `${'x'.repeat(int(r, 125))}_password`
              : pick(r, KEYS)
            : pick(r, KEYS);
        if (j === n) {
          const s = sec(3);
          mem.push(`${JSON.stringify(key)}: ${JSON.stringify(pick(r, ['', 'a ']) + s)}`);
          if (/password|token|apikey/i.test(key) && !/^x,/.test(key) && key.length <= 128)
            req.push(s);
          continue;
        }
        const [p, q] = piece(j);
        mem.push(`${JSON.stringify(key)}: ${JSON.stringify(pick(r, ['', 'a ', 'cmd ']) + p)}`);
        req = req.concat(q);
      }
      t = `{${mem.join(pick(r, [', ', ',', ',\n  ']))}}`;
      if (mode === 2) t = `body: ${JSON.stringify(t)}`;
      if (mode === 3) {
        const k = Math.floor(mem.length / 2) || 1;
        t = `{${mem.slice(0, k).join(', ')}} {${mem.slice(k).join(', ')}}`;
      }
    }
    req = [...new Set(req)];
    return req.length === 0 ? undefined : { t, req };
  };
}

// ---- gen100: token soup around escaped-quote values (#1600) ------------------------------------

/** `json.dumps({'cmd': t})` as Python writes it: `": "` between key and value, non-ASCII escaped. */
export function pythonJsonObject(key: string, value: string): string {
  const ascii = (s: string) =>
    JSON.stringify(s).replace(
      /[\u0080-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  return `{${ascii(key)}: ${ascii(value)}}`;
}

const G100_NAMES = [
  'token=',
  'password=',
  'password: ',
  'api_key: ',
  '--token ',
  '--passwd ',
  'API_TOKEN=',
  'TOKEN=',
  'apikey=',
  'apikey:',
  '"password": ',
  '\\"password\\": ',
  '"token":',
  '\\"token\\":\\"',
  'secret:',
  'Token:',
  'myToken": ',
  'x token=',
  'passwordx": ',
  '\\\\\\"password\\\\\\": ',
  "'password': ",
  'Secret ',
  'I_TOKEN=',
  '"api_key" : ',
];
const G100_QUOTES = ['"', "'", '\\"', '\\\\\\"', "\\'", '\\\\', '\\', '\\\\"', '""', '\\"\\"'];
const G100_WORDS = [
  'x',
  'a',
  'b c',
  'y',
  'note',
  'x,',
  ',',
  ' ',
  '  ',
  ':',
  '=',
  '}',
  '{',
  '&',
  ';',
  '\\n',
  '`',
  '，',
  'a b',
  '"}',
  '","',
  '\\",\\"',
  'run ',
  ' y',
  'z9',
  '-',
  '.',
  ')',
];

function g100Token(r: Rng): string {
  const x = r();
  if (x < 0.22) return pick(r, G100_NAMES);
  if (x < 0.52) return pick(r, G100_QUOTES);
  if (x < 0.62) return pick(r, SEC);
  return pick(r, G100_WORDS);
}
const tokens = (r: Rng, from: number, to: number) => {
  let t = '';
  for (let i = between(r, from, to); i > 0; i -= 1) t += g100Token(r);
  return t;
};

/** `g100/soup`: 4–14 tokens of names, quotes, secrets and words. */
const soup = (r: Rng): Row => {
  const t = tokens(r, 4, 14);
  return { t, req: holding(t) };
};
/** `g100/soupjson`: 3–10 tokens written in a JSON string, with or without the braces. */
const soupjson = (r: Rng): Row => {
  const inner = tokens(r, 3, 10);
  const json = pythonJsonObject('cmd', inner);
  const t = r() < 0.5 ? json.slice(1, -1) : json;
  return { t, req: holding(t) };
};
/** `g100/esc`: a name, an escaped or plain quoted value holding escapes, a glued word, more pairs. */
const esc = (r: Rng): Row => {
  const q = pick(r, ['"', '\\"', '\\\\\\"', "'"]);
  let inner = '';
  for (let i = between(r, 0, 5); i > 0; i -= 1)
    inner += pick(r, ['x', 'a', '\\"', "\\'", ' ', 'b', '\\\\', pick(r, G100_NAMES), "'", '"']);
  let glue = '';
  for (let i = between(r, 1, 4); i > 0; i -= 1)
    glue += pick(r, [
      'y',
      pick(r, SEC),
      'a',
      '\\',
      '"',
      "'",
      ':',
      '=',
      ',',
      ' ',
      pick(r, G100_NAMES),
    ]);
  const t = pick(r, G100_NAMES) + q + inner + q + glue + tokens(r, 0, 6);
  return { t, req: holding(t) };
};

// ---- nb1600s: one to three edits around #1600's hard rows ---------------------------------------

const F = sec(0);
const G = sec(1);
const NB_SEEDS = [
  `apikey="TOKEN='\\"'"x'${F}`,
  `token:"password='\\"'"n'${F}`,
  `--passwd "\\"a,TOKEN='"TOKEN:'"'${F}`,
  `apikey:'token=\\"' password:'TOKEN="'\\"'${F}`,
  `{password:\\"x--apikey='${F}, api_key: \\"a --apikey="\\""\\"${G}""\\"|`,
  `run APIKEY="api_key: '${F}':token=\\"a token=""\\"${G}" : `,
  `{"cmd":"APIKEY=\\"TOKEN=\\"\\"${F}\\"\\"\\""}`,
  `token=\\"x\\"${F} y`,
  `password="a\\"b"${F} y`,
  `password="a\\"${F} y`,
  `password: '\\'a${F} y`,
  `token=\\"x\\"x,passwordx\\": \\"${F}\\"`,
  `password="a\\"b token='c"d'"${F} y`,
  `token:"TOKEN=\\"${F}`,
  `--token "TOKEN=\\",${F}`,
  String.raw`--passwd \"TOKEN='\\\"'x\\\"'${F} y`,
  String.raw`\"password\":\"APIKEY=TOKEN=\\\"\\\"y\\\"${F}`,
  String.raw`"password":\"'}my.token="--token "x\\",${F}', y`,
  String.raw`api_key = \"x', --password=""C:\\"' "${F}.`,
  String.raw`token:"\password='\"'"n'${F}`,
  String.raw`token:"\"apikey\"=\" token:="e ${F}`,
  String.raw`token:"\"apikey\"=\" token:N\""x ${F}`,
  String.raw`"api_key": "token=\\\"a\\\"${F}`,
  String.raw`token='x'\\\"y${F} y`,
  String.raw`--passwd 'a b'\\\"x${F} y`,
  String.raw`password="\"api_key\": \"a b\""${F} y`,
  String.raw`api_key: "apikey:\""${F} y`,
];
const NB_ALPHA = [
  '"',
  "'",
  '\\',
  ' ',
  'x',
  ':',
  '=',
  ',',
  '\\"',
  'token=',
  'TOKEN=',
  '--apikey=',
  'password: ',
  G,
  '}',
  '&',
  '\\\\',
  '\\\\\\"',
  "'x'",
  '"x"',
  'api_key\\": ',
];

/** The shortest stretch of a secret an edit left that still counts as the secret shown. */
const NB_FRAGMENT_MIN = 6;

/** `neighbors`: one of #1600's hard rows with one to three inserts, deletes or replacements from a
 *  small alphabet; a quarter written in a JSON string, a tenth in two. An edit often lands inside a
 *  secret, where the rows probe hardest (the quote right against it): what is left of it counts —
 *  each stretch of at least `NB_FRAGMENT_MIN` of its characters still in order, tracked through the
 *  edits beside the text (review on #1619: only whole secrets counted left half the rows unread). */
const neighbors = (r: Rng): Row => {
  const seed = pick(r, NB_SEEDS);
  // Beside each character: which secret it is of (0 for none) and its place in it.
  let chars = [...seed];
  let marks: [number, number][] = chars.map(() => [0, 0]);
  [F, G].forEach((secret, k) => {
    for (let at = seed.indexOf(secret); at >= 0; at = seed.indexOf(secret, at + 1)) {
      for (let i = 0; i < secret.length; i += 1) marks[at + i] = [k + 1, i];
    }
  });
  for (let k = 1 + int(r, 3); k > 0; k -= 1) {
    const at = int(r, chars.length + 1);
    const x = r();
    const take = x < 0.45 ? 0 : 1;
    const token = x < 0.45 || x >= 0.7 ? pick(r, NB_ALPHA) : '';
    const put = [...token];
    chars = [...chars.slice(0, at), ...put, ...chars.slice(at + take)];
    // An inserted G is a secret like the seed's own: tracked through later edits, so the whole of
    // it, or what of it is left, counts (#501 on #1619: 104 / 120 rows of seeds 7 / 8 showed it
    // whole and required none of it).
    marks = [
      ...marks.slice(0, at),
      ...put.map((_, i): [number, number] => (token === G ? [2, i] : [0, 0])),
      ...marks.slice(at + take),
    ];
  }
  const fragments = new Set<string>();
  for (let i = 0; i < chars.length; ) {
    const [secret, place] = marks[i] as [number, number];
    let j = i + 1;
    while (
      secret !== 0 &&
      j < chars.length &&
      marks[j]?.[0] === secret &&
      marks[j]?.[1] === place + (j - i)
    ) {
      j += 1;
    }
    if (secret !== 0 && j - i >= NB_FRAGMENT_MIN) fragments.add(chars.slice(i, j).join(''));
    i = j;
  }
  let t = chars.join('');
  const w = r();
  if (w < 0.25) t = `{"cmd": ${JSON.stringify(t)}}`;
  else if (w < 0.35) t = `{"body": ${JSON.stringify(`{"cmd": ${JSON.stringify(t)}}`)}}`;
  return { t, req: [...fragments] };
};

const of =
  (line: (r: Rng) => Row | undefined): Generator =>
  (r, n) =>
    distinctRows(r, n, line);

export const CREDENTIALS_SEAT_GENERATORS: Record<string, Generator> = {
  'credentials/parts': of(parts),
  'credentials/keys': of(keys),
  'credentials/quotes': of(quotes),
  'credentials/escjson': of(escjson),
  'credentials/plainjson': of(plainjson),
  'credentials/pjh': of(pjh),
  'credentials/g97m0': of(g97(0)),
  'credentials/g97m1': of(g97(1)),
  'credentials/g97m2': of(g97(2)),
  'credentials/g97m3': of(g97(3)),
  'credentials/g97m4': of(g97(4)),
  'credentials/g100soup': of(soup),
  'credentials/g100soupjson': of(soupjson),
  'credentials/g100esc': of(esc),
  'credentials/neighbors': of(neighbors),
};
