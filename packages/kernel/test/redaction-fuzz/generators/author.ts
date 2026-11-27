import { type Rng, int, pick } from '../rng.js';
import { type Generator, distinctRows, marked } from '../row.js';

/**
 * The kernel author's generators, used to accept #1597 and #1600 (release.md §3.220, §3.221: 引号嵌套
 * `nest`, 偏重键名 `keys`, 偏重引号 `mix`, 偏重普通 JSON 键 `pjson`, 值里接名字 `first`). Random
 * concatenation of names, separators, quotes and escapes; the secret is one marker, wherever it lands.
 */

const B = '\\';
const MARK = 'Qz9xKp2mWv7';
const NAMES = [
  'password=',
  'API_TOKEN=',
  '"api_key": ',
  'password: ',
  '--password=',
  'token: ',
  '--token ',
  'api_key=',
  '"password":',
  ".'token' = ",
  '.--token ',
  "x'--token ",
  '$env:API_TOKEN=',
  '"API_TOKEN = ',
  'my.token=',
  'token = ',
  '_k: ',
  'x--k ',
  '_API=',
  '.API_TOKEN=',
  '"api_key" = ',
  'api_key = ',
  '\\"api_key\\" = ',
  '\\"Password\\"=',
  '\\"password\\": ',
  '\\"secret" = ',
  `${'A'.repeat(60)}_TOKEN=`,
  `.${'B'.repeat(100)}_TOKEN=`,
  '_--token ',
  '.--token=',
  '"k"\t=\t',
];
const QUOTES = ['"', '"', "'", `${B}"`, `${B}${B}"`, B, `${B}${B}`];
const DELIM = [' ', ', ', '\t:\t', ' : ', '}', '|', ';', '&', '.', '\n', ':', ''];
const WORDS = [
  'a',
  'x',
  'C:',
  ' ',
  MARK,
  ` ${MARK}`,
  `,${MARK}`,
  `${MARK}'`,
  'note: ',
  ` ${MARK}${B}`,
];
const KEYS = [
  'api_key',
  'password',
  'note',
  'apiKey',
  'x',
  'token',
  'secret',
  'API_TOKEN',
  'clientSecret',
];
const SEPS = [',', ';', '&', '|', ',,', ' ', ''];
const LEAD = ['run ', 'echo ', '{', 'x '];

const lead = (r: Rng, from = LEAD) => (int(r, 3) === 0 ? pick(r, from) : '');

function keyLine(r: Rng): string {
  let s = lead(r);
  const k = 1 + int(r, 3);
  for (let i = 0; i < k; i += 1) {
    s += pick(r, NAMES);
    s += pick(r, ['', '', '"', "'"]);
    s += pick(r, ['x', 'a', MARK, 'C:', '']);
    s += pick(r, ['', '', '"', "'"]);
    s += pick(r, SEPS);
    s += pick(r, NAMES);
    s += pick(r, ['"', '"', `${B}"`, "'", '']);
    s += pick(r, KEYS);
    s += pick(r, ['"', '"', "'", `${B}"`, '']);
    s += pick(r, ['', ' ', '\t', '  ']);
    s += pick(r, [':', '=', ': ', ' = ', '']);
    s += pick(r, [MARK, `"${MARK}"`, `'${MARK}'`, `"${MARK} y"`, `${B}"${MARK}${B}"`, 'x']);
    s += pick(r, DELIM);
  }
  return s;
}

const OUTER = [
  'password:',
  'token=',
  '--apikey=',
  'TOKEN=',
  'APIKEY=',
  '--token ',
  'api_key: ',
  'x',
  '"api_key": ',
  'note: ',
  'token=x,',
];
const INNER = [
  'TOKEN=',
  'password:',
  'token=',
  'api_key: ',
  '--token ',
  'apikey:',
  'note:',
  'x ',
  'a TOKEN=',
  '--apikey=',
  'Secret=',
];
const NQ = ['"', "'", `${B}"`, '"', "'"];

function nestLine(r: Rng): string {
  let s = lead(r);
  const k = 1 + int(r, 2);
  for (let i = 0; i < k; i += 1) {
    s += pick(r, OUTER);
    const q1 = pick(r, NQ);
    s += q1;
    s += pick(r, ['', '', 'a ', 'x']);
    s += pick(r, INNER);
    const q2 = pick(r, NQ);
    s += q2;
    s += pick(r, [q1, q2, '', q1 + q2, q2 + q1, `${q1}${q2}${q1}`]);
    s += pick(r, [MARK, `${MARK} y`, 'x', `${MARK}${q2}`]);
    s += pick(r, [q1, q2, '', q1 + q2, q2 + q1]);
    s += pick(r, DELIM);
  }
  return s;
}

const FIRSTS = [
  'FIRST=',
  'token=',
  'password:',
  'x.secret=',
  '--password ',
  "--password '",
  '--apikey=',
  "--apikey='",
  '--password "',
  'api_key: ',
  'API_TOKEN=',
  'note=',
  '"token": ',
];
const FV = ['val', 'x', MARK, '"a"', "'a'", `${B}"a`, '', `${B}"`, '"', "'"];
const N2 = [
  'password:',
  'Password:',
  'TOKEN=',
  'token=',
  'apikey:',
  'x.apikey:',
  'secret:',
  '--token ',
  'api_key = ',
  'note:',
  'API_TOKEN=',
];
const FQ = ['"', "'", `${B}"`, '', `'"'`, `"'`, `'"`];

function firstLine(r: Rng): string {
  let s = lead(r);
  s += pick(r, FIRSTS) + pick(r, FV) + pick(r, ['', '', ',', ';', '&', '|']);
  s += pick(r, N2) + pick(r, FQ) + pick(r, KEYS) + pick(r, ['"', "'", `${B}"`, '']);
  s += pick(r, ['', ' ', '\t', '  ']) + pick(r, [':', '=', ': ', ' = ', '']);
  s += pick(r, [
    MARK,
    `"${MARK}`,
    `'${MARK}`,
    `"${MARK}"`,
    `'${MARK}'`,
    `${B}"${MARK}`,
    `${MARK} y`,
    `"'${MARK}`,
    `'"'${MARK}`,
  ]);
  s += pick(r, ['', '', '"', "'", `${B}"`, ' x', '\n']);
  return s;
}

const PJ_PRE = [
  '',
  '',
  'token=',
  'password:',
  '--password=',
  '--token ',
  'apikey=passwd:',
  'token: ',
  'APIKEY=password:',
  'token=x,',
  'note: ',
  '"token": ',
  'token:token:',
  'api_key: ',
  'TOKEN=',
];
const PJ_OPEN = ['', '"', "'", `${B}"`, '"', '""'];
const PJ_KEYS = [
  'passwordx',
  '_password',
  'apikeye',
  'dbPasswordHash',
  'x,passwordx',
  "x'apikey",
  'x passwordx',
  'max_tokens--passwd',
  '--passwd',
  'api_key',
  'password',
  'token',
  'note',
  `service_${'x'.repeat(50)}_password`,
  'password:k',
  'a=passwordx',
  'x,apikey',
];
const PJ_SEP = [':', ': ', ' : ', ':  ', '\t:'];
const PJ_V = [
  'a',
  'x',
  'a token: x',
  "'apikey=x&",
  ' token:x',
  '',
  'token=',
  'a TOKEN=',
  'myToken',
  'x Secret',
  'note: ',
  "'",
  'a ',
];
const PJ_ESC = [`${B}"`, `${B}${B}"`, `${B}${B}${B}"`, '', '"', "'", `${B}"'`, `${B}" `];
const PJ_END = [
  MARK,
  ` ${MARK}`,
  `${MARK}Secret:`,
  `${MARK}"`,
  `${MARK} y"`,
  `'${MARK}`,
  `${MARK}myToken": 1`,
  `${MARK}${B}"`,
];
const PJ_TAIL = [
  '',
  '',
  '"',
  ' z',
  `, "password": "${MARK}"`,
  ` token=${MARK}`,
  '}',
  '|x',
  `${B}"`,
];

function pjsonLine(r: Rng): string {
  let s = lead(r);
  const k = 1 + (int(r, 3) === 0 ? 1 : 0);
  for (let i = 0; i < k; i += 1) {
    s += pick(r, PJ_PRE) + pick(r, PJ_OPEN) + pick(r, ['', '', 'x', 'a ']);
    s += `"${pick(r, PJ_KEYS)}"${pick(r, PJ_SEP)}${pick(r, ['"', '"', '"', '', "'"])}`;
    s += pick(r, PJ_V) + pick(r, PJ_ESC);
    if (int(r, 3) === 0) s += pick(r, PJ_V) + pick(r, PJ_ESC);
    s += pick(r, PJ_END) + pick(r, PJ_TAIL);
  }
  return s;
}

function mixLine(r: Rng): string {
  let s = lead(r, ['run ', 'echo ', '{']);
  const k = 2 + int(r, 3);
  for (let i = 0; i < k; i += 1) {
    s += pick(r, NAMES);
    s += pick(r, ['"', '"', '"', "'", `${B}"`, '']);
    const m = int(r, 4);
    for (let j = 0; j < m; j += 1) s += int(r, 2) === 0 ? pick(r, WORDS) : pick(r, QUOTES);
    s += pick(r, ['"', '"', `${B}"`, `${B}${B}"`, "'", '']);
    s += pick(r, DELIM);
  }
  return s;
}

const of =
  (line: (r: Rng) => string): Generator =>
  (r, n) =>
    distinctRows(r, n, (rr) => marked(line(rr), MARK));

export const AUTHOR_GENERATORS: Record<string, Generator> = {
  'author/nest': of(nestLine),
  'author/keys': of(keyLine),
  'author/mix': of(mixLine),
  'author/pjson': of(pjsonLine),
  'author/first': of(firstLine),
};
