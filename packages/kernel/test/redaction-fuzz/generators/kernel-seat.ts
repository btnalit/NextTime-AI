import { type Rng, between, pick } from '../rng.js';
import { type Generator, distinctRows, marked } from '../row.js';
import { pythonJsonObject as dumps } from './credentials-seat.js';

/**
 * The kernel seat's (#493) generators (`kvgenN.py`), from its reviews of #1593–#1600, ported from
 * Python to this file's seeded randomness: the same lists and shapes, not the same rows. The secret
 * is one marker (the seat wrote `<F>` and replaced it before reading).
 */

const F = 'FAKEabcdef';
const B = '\\';

/** `kv4` (#1593): a prefix value, one or two plain JSON keys, a value with names, separators and
 *  `\"` runs, a tail. */
function kv4(r: Rng): string {
  const pre = [
    '',
    'x ',
    'token=',
    'token=x,note:',
    'APIKEY=password:',
    'apikey=passwd:',
    'apikey=secret:',
    '--password=',
    '--token --token ',
    'token: "token: ',
    'token: ',
    '{\\"token\\": ',
    '{"a": "b", ',
    '"token": ',
    "token='",
    'password="',
    "--token '",
    'token:token:',
  ];
  const oq = ['', '"', "'", '\\"'];
  const key = [
    'passwordx',
    '_password',
    'apikeye',
    'dbPasswordHash',
    'tokenValue',
    'x passwordx',
    'x,password',
    "x'passwordx",
    'max_tokens--password',
    '--passwd x',
    'password:k',
    'a=passwordx',
    'api_key',
    'Api_key',
    'note',
    'token',
    `service_${'x'.repeat(50)}_password`,
    `${'a'.repeat(56)}passwordx`,
  ];
  const sep = [': ', ':', ' : ', '  :  ', '='];
  const vpart = [
    'a',
    'x',
    ' ',
    'token: ',
    'token:',
    "'apikey=",
    'apikey=x&',
    '\\"',
    '\\\\"',
    '\\\\\\"',
    '"',
    F,
    F,
    F,
    'password=',
    '--token ',
    'API_TOKEN=',
    'Secret:',
    'myToken": 1',
    "'",
    '|',
    ' b',
  ];
  const tail = ['', '"', '}', '"}', ', "next": 1', '\\"', ' z'];
  const parts = (from: number, to: number) => {
    let v = '';
    for (let i = between(r, from, to); i > 0; i -= 1) v += pick(r, vpart);
    return v;
  };
  let t = `${pick(r, pre)}${pick(r, oq)}"${pick(r, key)}"${pick(r, sep)}"`;
  let v = parts(1, 5);
  if (!v.includes(F)) v += F;
  t += v;
  if (r() < 0.3) t += `"${pick(r, sep)}"${pick(r, key)}"${pick(r, sep)}"${parts(0, 3)}`;
  return t + pick(r, tail);
}

/** `kv7` (#1597, legacy 937): a quoted value with text written right against its closing quote. */
function kv7(r: Rng): string | undefined {
  const pre = [
    'TOKEN=',
    'token=',
    'token: ',
    'token:',
    '--token ',
    '--token=',
    'api_key=',
    'API_TOKEN=',
    'password: ',
    '"password": ',
    '"token":',
    'Secret:',
    'apikey=x&apikey=',
    'export TOKEN=',
    'x TOKEN=',
    'APIKEY=\\"TOKEN=',
    'password=',
    'passwd = ',
    '"api_key" = ',
    "'token': ",
    'Authorization: Bearer ',
    'note=',
    'a: ',
  ];
  const q = ['"', "'", '"', "'", '\\"', '""'];
  const inner = [
    '',
    'x',
    F,
    'a b',
    'a\\"b',
    `x${F}`,
    '"',
    "'",
    'api_key=',
    `password: ${F}`,
    ' ',
    '，',
    '`',
  ];
  const glue = [
    F,
    `x${F}`,
    `${F}x`,
    `\`${F}`,
    '`',
    `，${F}`,
    `。${F}`,
    `：${F}`,
    `、${F}`,
    `）${F}`,
    `」${F}`,
    `:${F}`,
    `=${F}`,
    `\\${F}`,
    `"${F}`,
    `'${F}`,
    `.${F}`,
    `,${F}`,
    `;${F}`,
    `&${F}`,
    `|${F}`,
    `x"${F}`,
    `x'${F}`,
    `x": ${F}`,
    `x": "${F}"`,
    `x': '${F}'`,
    `x=${F}`,
    `api_key=${F}`,
    `password: ${F}`,
    `token=${F}`,
    `apikey:${F}`,
    `x,password=${F}`,
    `x;token: ${F}`,
    `写进配置${F}`,
    `${F}写进`,
    `x}{"password":"${F}"}`,
    `x,"password": "${F}"`,
    `x"password":"${F}"`,
    `\\"${F}`,
    `""${F}`,
    `"" ${F}`,
    `x\\"${F}`,
    `x\\\\${F}`,
    `x\`${F}`,
    `x，${F}`,
    `${F}\``,
    `${F}，然后`,
    `x)${F}`,
    `x]${F}`,
    `x<${F}`,
    `x>"${F}"`,
    `\${${F}}`,
    `${F}"`,
    `${F}'`,
    `${F}""`,
    `${F}:x`,
    `${F}=x`,
    `${F}": 1`,
  ];
  const tail = [
    '',
    '"',
    '""',
    ' y',
    '`',
    '\\"',
    "'",
    ` token: ${F}`,
    ` password=${F}`,
    '"\\"',
    '\'"',
    ' ',
    '，后面',
    '}',
    '"}',
    '\\"\\"\\"',
    ':',
    '=',
    '"":',
  ];
  const one = () => {
    const qq = pick(r, q);
    const open = qq !== '""' ? qq : '"';
    let v = pick(r, pre) + open + pick(r, inner) + qq + pick(r, glue);
    if (r() < 0.3) v += pick(r, glue);
    return v + pick(r, tail);
  };
  let t = one();
  const m = r();
  if (m < 0.15) t = `\`${t}\`${pick(r, ['', ' 然后', ' and x', '，'])}`;
  else if (m < 0.25) t = `把 ${t}${pick(r, ['', '，', '。', '）'])} 写进配置`;
  else if (m < 0.4) t = dumps('cmd', t);
  else if (m < 0.47) t = dumps('log', dumps('cmd', t));
  else if (m < 0.55) t = `${t} ${one()}`;
  else if (m < 0.6) t = `{"a": "${t}"}`;
  return t.includes(F) ? t : undefined;
}

/** `kv8` (#1600, legacy 948): escaped-quote values (`\"…\"`, `"…\"…"`, closed by `\"`) with text
 *  right against the close. */
function kv8(r: Rng): string | undefined {
  const pre = [
    'TOKEN=',
    'token=',
    'token: ',
    'token:',
    '--token ',
    '--token=',
    'api_key=',
    'API_TOKEN=',
    'password: ',
    'password=',
    '"password": ',
    '\\"password\\": ',
    '\\"token\\":',
    'Secret:',
    'apikey=x&apikey=',
    'export TOKEN=',
    'x TOKEN=',
    'APIKEY=\\"TOKEN=',
    'passwd = ',
    'note=',
    'a: ',
    '--passwd ',
  ];
  const qs: [string, string][] = [
    ['\\"', '\\"'],
    ['\\\\\\"', '\\\\\\"'],
    ['"', '"'],
    ['"', '\\"'],
    ["'", "'"],
    ["'", "\\'"],
    ['\\"', '"'],
    ['"', '\\\\"'],
  ];
  const inner = [
    '',
    'x',
    F,
    'a b',
    'a\\"b',
    `x${F}`,
    '\\"',
    'api_key=',
    `password: ${F}`,
    ' ',
    '，',
    '`',
    'a\\\\',
    "TOKEN='\\\"'",
    'token: \\"a',
    '"',
    "'",
  ];
  const glue = [
    F,
    `x${F}`,
    `${F}x`,
    `\`${F}`,
    `，${F}`,
    `:${F}`,
    `=${F}`,
    `\\${F}`,
    `\\"${F}`,
    `"${F}`,
    `'${F}`,
    `.${F}`,
    `,${F}`,
    `&${F}`,
    `x"${F}`,
    `x\\"${F}`,
    `x": ${F}`,
    `x\\": ${F}`,
    `x\\": \\"${F}\\"`,
    `x=${F}`,
    `api_key=${F}`,
    `password: ${F}`,
    `token=${F}`,
    `x,password=${F}`,
    `x;token: ${F}`,
    `${F}\\"`,
    `${F}"`,
    `${F}\\\\"`,
    `${F}\\": 1`,
    `${F}": 1`,
    `x}{\\"password\\":\\"${F}\\"}`,
    `x,\\"password\\": \\"${F}\\"`,
    `\\\\${F}`,
    `\\n${F}`,
    `${F}\\nx`,
  ];
  const tail = [
    '',
    '"',
    '\\"',
    ' y',
    '`',
    "'",
    ` token: ${F}`,
    ` password=${F}`,
    '"\\"',
    '\\"\\"',
    '}',
    '"}',
    '\\"}',
    ':',
    '=',
    '\\":',
    '\\" y',
  ];
  const one = () => {
    const [o, c] = pick(r, qs);
    let v = pick(r, pre) + o + pick(r, inner) + c + pick(r, glue);
    if (r() < 0.3) v += pick(r, glue);
    return v + pick(r, tail);
  };
  let t = one();
  const m = r();
  if (m < 0.12) t = `\`${t}\``;
  else if (m < 0.3) t = dumps('cmd', t);
  else if (m < 0.4) t = dumps('log', dumps('cmd', t));
  else if (m < 0.5) t = `${t} ${one()}`;
  else if (m < 0.58) t = `{"a": "${t}"}`;
  else if (m < 0.63) t = `把 ${t} 写进配置`;
  return t.includes(F) ? t : undefined;
}

/** `kv9` (#1600): backslash runs in the word right after a quoted or escaped-quoted value's close,
 *  and escapes before a next pair's name. */
function kv9(r: Rng): string | undefined {
  const pre = [
    'TOKEN=',
    'token=',
    'token:',
    'token: ',
    '--token ',
    'api_key=',
    'password=',
    '"password": ',
    '\\"password\\":',
    'APIKEY=TOKEN=',
    'apikey=',
    'x TOKEN=',
  ];
  const qs: [string, string][] = [
    ['\\"', '\\"'],
    ['\\\\\\"', '\\\\\\"'],
    ['"', '"'],
    ['"', '\\"'],
    ["'", "'"],
    ['\\"', '"'],
  ];
  const bs = () => B.repeat(between(r, 1, 6));
  const word = () => {
    let w = '';
    for (let i = between(r, 1, 4); i > 0; i -= 1) {
      w += pick(r, [
        'x',
        F,
        'y',
        bs(),
        `${bs()}"`,
        `${bs()}"${F}`,
        `${bs()}'`,
        `${bs()}n`,
        `${bs()}${F}`,
        "password='",
        'TOKEN=\'\\"\'"',
        'token: ',
      ]);
    }
    return w;
  };
  const inner = [
    '',
    'x',
    'a\\"b',
    '\\',
    '\\\\',
    "\\password='\\\"'\"n'",
    "C:\\TOKEN='\\\"'\"x'",
    'TOKEN=\\"\\"y',
    F,
  ];
  const one = () => {
    const [o, c] = pick(r, qs);
    return (
      pick(r, pre) +
      o +
      pick(r, inner) +
      c +
      word() +
      pick(r, ['', '"', '\\"', ' y', '\\\\\\"', F, "'"])
    );
  };
  let t = one();
  const m = r();
  if (m < 0.3) t = dumps('cmd', t);
  else if (m < 0.45) t = dumps('log', dumps('cmd', t));
  else if (m < 0.55) t = `\\"password\\":\\"${t}\\"`;
  else if (m < 0.65) t = `${t} ${one()}`;
  return t.includes(F) ? t : undefined;
}

/** `kv10` (#1600): `"…"` values with an escaped quote, then a secret's name or an escaped key inside,
 *  then what follows the close. */
function kv10(r: Rng): string | undefined {
  const pre = [
    'TOKEN=',
    'token=',
    'token:',
    'token: ',
    '--token ',
    'api_key=',
    'api_key: ',
    'password=',
    '"password": ',
    '"token": ',
    '\\"password\\":',
    'APIKEY=TOKEN=',
    'apikey=',
    'x TOKEN=',
    '--passwd ',
  ];
  const names = [
    'apikey',
    'token',
    'api-key',
    'api_key',
    'TOKEN',
    'secret',
    'password',
    'note',
    'x',
    'secretx',
    'passwd',
    'Authorization',
  ];
  const seps = [
    ':',
    '=',
    ',',
    '\\":',
    '\\"=',
    '\\" = \\"',
    '\\": \\"',
    ': ',
    '=\\"',
    '\\"',
    '":',
    '"=',
    ' ',
  ];
  const inside = [
    'x',
    'y',
    F,
    ' ',
    '\\"',
    '\\',
    '\\\\',
    'a b',
    'e',
    "'",
    '&',
    ',',
    'TOKEN\\"',
    '\\x',
    '=',
  ];
  const after = [
    '',
    'x',
    F,
    ` ${F}`,
    `x ${F}`,
    `"x ${F}`,
    `\\"${F}`,
    ` y token: x, "TOKEN\\""x ${F}`,
    `'${F}`,
    `&${F}`,
    `\\\\\\"${F}`,
    ' z',
  ];
  const body = () => {
    let b = '';
    for (let i = between(r, 1, 6); i > 0; i -= 1)
      b += r() < 0.35 ? pick(r, names) + pick(r, seps) : pick(r, inside);
    return b;
  };
  const one = () => `${pick(r, pre)}"${body()}"${pick(r, after)}`;
  let t = one();
  const m = r();
  if (m < 0.25) t = dumps('cmd', t);
  else if (m < 0.4) t = dumps('log', dumps('cmd', t));
  else if (m < 0.5) t = `${t} ${one()}`;
  return t.includes(F) ? t : undefined;
}

const of =
  (line: (r: Rng) => string | undefined): Generator =>
  (r, n) =>
    distinctRows(r, n, (rr) => {
      const t = line(rr);
      return t === undefined ? undefined : marked(t, F);
    });

export const KERNEL_SEAT_GENERATORS: Record<string, Generator> = {
  'kernel/kv4': of(kv4),
  'kernel/kv7': of(kv7),
  'kernel/kv8': of(kv8),
  'kernel/kv9': of(kv9),
  'kernel/kv10': of(kv10),
};
