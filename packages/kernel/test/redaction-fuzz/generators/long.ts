import { type Rng, between, int, pick } from '../rng.js';
import { type Generator, type Row, capped, distinctRows } from '../row.js';

/**
 * Long lines (review #493 on #1619): values as long as what the stream holds back, and longer —
 * around the tail check's reach (3,584 characters, the design doc's L), around the stream's bound
 * (`STREAM_HOLD_MAX_CHARS`, 4,096) and past it — after a head longer than the 8 characters the
 * stream looks back into (`CONTEXT_CHARS`), with quotes in it and without, the value quoted and
 * not; and PEM private keys, which the stream holds from `-----BEGIN` to `-----END`.
 *
 * A stream reading of one such row in the dense cuts (`cutsFor`) takes up to a second or two, so a
 * run reads only a few a seed (`capped`). The secret is the value, random each row.
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A random value of `length` characters, `FAKE` first. */
function value(r: Rng, length: number): string {
  let out = 'FAKE';
  while (out.length < length) out += BASE64.charAt(int(r, BASE64.length));
  return out;
}

/** Around L, around the stream's bound, and past it. */
const LENGTHS: readonly (readonly [number, number])[] = [
  [3_500, 3_700],
  [4_000, 4_200],
  [4_200, 6_000],
];

/** Heads longer than 8 characters: without quotes, and with a quote still open. */
const HEADS = [
  '2026-11-27T10:14:03Z INFO deploy: ',
  '[worker-3] step 4/7: ',
  'deploy.sh: line 12: ',
  'Step 3/9 : RUN ',
  'kubectl create secret generic app --from-literal=',
  '{"level":"info","msg":"',
  'log="starting with ',
  '"stdout": "',
  "echo 'config: ",
  '{\\"cmd\\": \\"run ',
];

/** A secret's name and separator, before a value that `quote` may wrap. */
const PAIRS = [
  'password=',
  'API_TOKEN=',
  'api_key: ',
  'client_secret = ',
  '--password ',
  '--token=',
  'Authorization: Bearer ',
];
const QUOTES = ['', '"', "'", '\\"'];
const TAILS = ['', ' done', ' && ./run', '"}', ' exit=0', '\n'];

function namedValue(r: Rng): Row {
  const [from, to] = pick(r, LENGTHS);
  const secret = value(r, between(r, from, to));
  const json = int(r, 5) === 0;
  const quote = pick(r, QUOTES);
  const pair = json ? `"api_key": "${secret}"` : `${pick(r, PAIRS)}${quote}${secret}${quote}`;
  return { t: `${pick(r, HEADS)}${pair}${pick(r, TAILS)}`, req: [secret] };
}

/** A PEM private key: its lines broken with a line break, CRLF, or `\n` written in a string. */
function pem(r: Rng): Row {
  const kind = pick(r, ['', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ']);
  const [from, to] = pick(r, [
    [1_600, 1_800],
    [3_100, 3_300],
    [4_200, 5_000],
  ] as const);
  const lines = value(r, between(r, from, to)).match(/.{1,64}/g) ?? [];
  const nl = pick(r, ['\n', '\r\n', '\\n']);
  const head = pick(r, [
    'cat ~/.ssh/id_rsa: ',
    '{"private_key": "',
    'tls.key: |\n  ',
    'private_key = """',
    '2026-11-27 10:14:03 loaded key ',
  ]);
  const open = `-----BEGIN ${kind}PRIVATE KEY-----${nl}`;
  const body = lines.join(nl);
  const t = `${head}${open}${body}${nl}-----END ${kind}PRIVATE KEY-----${pick(r, TAILS)}`;
  const start = head.length + open.length;
  return { t, spans: [[start, start + body.length]] };
}

export const LONG_GENERATORS: Record<string, Generator> = {
  'long/values': capped(6, (r, n) => distinctRows(r, n, namedValue)),
  'long/pem': capped(8, (r, n) => distinctRows(r, n, pem)),
};
