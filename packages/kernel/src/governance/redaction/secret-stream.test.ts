import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  STREAM_HOLD_MAX_CHARS,
  createSecretStreamScrubber,
  scrubSecretValues,
} from './index.js';

/** A Handle-shaped compact JWT (header `{"alg":"EdDSA"}`). Synthetic — `.gitleaks.toml` allows
 *  this signature segment, and `abcdefghijklmnopqrstuvwxyz` in `FAKE`. */
const HANDLE = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

/** Texts with a secret of every shape the scrub knows, at the start, middle and end. */
const TEXTS: readonly string[] = [
  `my Handle is ${HANDLE}, keep it safe`,
  `HOME=/workspace\nCAPABILITY_HANDLE=${HANDLE}\nKERNEL_URL=http://kernel:8080\n`,
  `token: ${HANDLE}`,
  `图里没有 depends_on 关系。我的 Handle 是${HANDLE}。请勿外传。`,
  'Authorization: Bearer abc.def-123456 and Basic dXNlcjpwYXNzd29yZA== done',
  'connect to postgres://nexttime:s3cret@db:5432/x now',
  '{"api_key": "abc 123 def", "n": 1, "note": "a \\"quoted\\" token"}',
  'before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\nAAAAC3Nza\n-----END OPENSSH PRIVATE KEY-----\nafter',
  'run PGPASSWORD=hunter2 psql and /login?user=a&password=hunter2&x=1',
  'nothing secret here: max_tokens=1024, the depends_on edge, tokenCount 3 — 普通的中文句子。',
  'export API_TOKEN="abcdefghijklmnopqrstuvwxyz 0123" && password: \'two words\' --password  x y',
  // A quoted value written inside a string (legacy 918): `\"…\"`.
  'sh -c "export API_TOKEN=\\"abcdefghijklmnopqrstuvwxyz 0123\\" && run" --password \\"a b\\" x',
  'I don\'t know; password: "correct horse battery" said the note. Cookie: a=1; b=2\nnext',
  'POSTGRES_PASSWORD: abcdefghijklmnopqrstuvwxyz\nX-Api-Key: abcdefghijklmnopqrstuvwxyz0123 end',
  // A platform API key's shape (legacy 168), and one character too long to be one.
  'key FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ, not FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZx',
  // Standard base64 is not one (legacy 168 review): 43 characters and `=`, a stretch between a `+`
  // and a `/`, and a key after a `/`.
  'PublicKey = FAKE0123456789abcdefghijklmnopqrstuvwxyzXYQ=\nQUJD+FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ/REVG /FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ key FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ',
  // A platform API key with its prefix (legacy 906): alone, after `_` and `/`, with more after it,
  // and after a letter (not one).
  'key ntk_FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ, call_ntk_FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ /ntk_FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZmore agentk_FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ',
  // In JSON text (review #493 on #1571): a key on its own line of a tool's output, after a
  // `\uXXXX` escape, after a URL-encoded `/`, and the bare shape after `\n`; after `%` and one
  // hex digit is not one.
  '{"stdout":"line1\\nntk_FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ\\n","stderr":"\\uff1antk_FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ"} keys%2Fntk_FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ a%2ntk_FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ old\\nFAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ',
  // A Handle and a vendor key the same way (review #501 on #1571), and a key whose body spells a
  // vendor key, hidden whole.
  `{"stdout":"a\\n${HANDLE}\\nsk_live_${FAKE}"} q=my%20${HANDLE} key ntk_FAKE-sk-abcdefghijklmnopqrstuvwxyz0123456XY.`,
];

/** Everything a scrubber emits for `pieces`, then its flush. */
function stream(pieces: readonly string[]): { text: string; redactedValues: number } {
  const scrubber = createSecretStreamScrubber();
  let text = '';
  let redactedValues = 0;
  for (const piece of [...pieces.map((p) => scrubber.push(p)), scrubber.flush()]) {
    text += piece.value;
    redactedValues += piece.redactedValues;
  }
  return { text, redactedValues };
}

describe('createSecretStreamScrubber — a secret split across pieces is still scrubbed', () => {
  it.each(TEXTS.map((text) => [text.slice(0, 32), text]))(
    'split anywhere in two, the output is the whole text scrubbed: %s…',
    (_label, text) => {
      const whole = scrubSecretValues(text);
      for (let at = 0; at <= text.length; at += 1) {
        expect(stream([text.slice(0, at), text.slice(at)])).toEqual({
          text: whole.value,
          redactedValues: whole.redactedValues,
        });
      }
    },
  );

  it.each(TEXTS.map((text) => [text.slice(0, 32), text]))(
    'one character at a time, and in uneven pieces, the same: %s…',
    (_label, text) => {
      const whole = scrubSecretValues(text).value;
      expect(stream([...text]).text).toBe(whole);
      for (const size of [2, 3, 5, 7, 13]) {
        const pieces = [];
        for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
        expect(stream(pieces).text).toBe(whole);
      }
    },
  );

  it('never emits any part of a Handle, whatever was emitted so far', () => {
    const text = `我的 Handle 是 ${HANDLE} 。`;
    const scrubber = createSecretStreamScrubber();
    let emitted = '';
    for (const char of text) {
      emitted += scrubber.push(char).value;
      expect(emitted).not.toContain('eyJ');
    }
    emitted += scrubber.flush().value;
    expect(emitted).toBe(`我的 Handle 是 ${REDACTED} 。`);
  });

  it.each([
    `say "hi".--password "${FAKE} x" y`,
    `say "hi"_--password "${FAKE} x" y`,
    `say "hi".--password="a ${FAKE}" y`,
    `say "hi".--api-key  "a ${FAKE}" y`,
    `say "hi".API_TOKEN="a b ${FAKE}" y`,
    `say "hi"-API_TOKEN="a ${FAKE}" y`,
    `${'A'.repeat(90)}_TOKEN="a b ${FAKE}" y`,
  ])(
    'never emits the value of a flag or env name after a quote, a dot or a dash, cut anywhere (legacy 925): %s',
    (text) => {
      expect(scrubSecretValues(text).value).not.toContain(FAKE);
      for (let at = 1; at < text.length; at += 1) {
        expect(stream([text.slice(0, at), text.slice(at)]).text).not.toContain(FAKE);
      }
    },
  );

  it.each([
    `\\"password\\" = \\"${FAKE} x\\"`,
    `pwsh -c "Invoke-X -Body @{\\"Password\\" = \\"${FAKE}\\"}"`,
    `token: "a\\" --token 'x", ${FAKE}'`,
    `API_TOKEN=\\"a --token 'b\\" ${FAKE}'`,
  ])(
    'never emits the value after an escaped JSON key and `=`, nor that of a next pair a value read with escapes ends before, cut anywhere (review #501 on #1581, legacy 926): %s',
    (text) => {
      expect(scrubSecretValues(text).value).not.toContain(FAKE);
      for (let at = 1; at < text.length; at += 1) {
        expect(stream([text.slice(0, at), text.slice(at)]).text).not.toContain(FAKE);
      }
    },
  );

  it('holds an escaped JSON key and `=` back with its value (review #501 on #1581)', () => {
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push('x \\"password\\" = ').value).toBe('x ');
    expect(scrubber.push(`\\"${FAKE}`).value).toBe('');
    expect(scrubber.push('\\" y').value).toBe(`\\"password\\" = \\"${REDACTED}\\" `);
  });

  it('holds a secret JSON value back until it is closed, spaces and all', () => {
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push('{"password": "correct horse').value).toBe('{');
    expect(scrubber.push(' battery staple"}, ').value).toBe(`"password": "${REDACTED}"}, `);
    expect(scrubber.flush().value).toBe('');
  });
});

/** The secret names a `name<separator>value` pair is written with: each pattern's kind of name
 *  (last word, camelCase, env, header, quoted key, a key with a space). */
const PAIR_NAMES = [
  'token',
  'password',
  'api_key',
  'DB_PASSWORD',
  'aws_secret_access_key',
  'clientSecret',
  'X-Api-Key',
  'Authorization',
  'Cookie',
  'Set-Cookie',
  'CAPABILITY_HANDLE',
  'API_TOKEN',
  '"token"',
  "'password'",
  '"client secret"',
  // JSON text written inside one more string (review #501 on #1575).
  '\\"api_key\\"',
  '\\"client secret\\"',
];
/** Every separator the patterns take, with spaces on either side, before and after. */
const SEPARATORS = ['=', ':', ' = ', ' : ', ' =', ': ', '\t:\t', '  =  ', ' :'];
const PAIR_VALUES = [
  FAKE,
  `"${FAKE} two"`,
  `'${FAKE} two'`,
  HANDLE,
  `\\"${FAKE} two\\"`,
  `\\\\\\"${FAKE} two\\\\\\"`,
];

/** Every other shape a secret is written in. */
const SHAPES = [
  `{"password" : "${FAKE} x"}`,
  '{"client secret":"a b"}',
  '{ "api_key" :  "v\\"q x" }',
  '{"note": "a \\"quoted\\" token", "token": "x y"}',
  '{"secret value": "x y"}',
  `{"api_key_id": "${FAKE}"}`,
  '{"token count" :  "a b"}',
  '{"a": "token": "x y"}',
  `{"note": "a", "handle": "${HANDLE}"}`,
  '{"capability_handle":"x\\"y z"}',
  '{"token":"a","password":"b c"}',
  '{"password": "[redacted]"}',
  '"api_key"   :   "v w"',
  `Authorization : Bearer ${FAKE}`,
  'Cookie  :  a=1; b=2',
  'Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==',
  `curl -H 'Authorization: Bearer ${FAKE}' x`,
  `Bearer  ${FAKE}`,
  'Basic\tdXNlcjpwYXNzd29yZA==',
  `Basic configuration then Bearer ${FAKE}`,
  `--password  "${FAKE} x"`,
  `--api-key=${FAKE}`,
  `--token\t${FAKE}`,
  `--user --password ${FAKE}`,
  'API_TOKEN="a b c"',
  'sh -c "export API_TOKEN=\\"a b\\" && run"',
  'command: "PGPASSWORD=\\"a b\\" psql"',
  'const s = "password: \\"x y\\"";',
  `--password \\"${FAKE} x\\"`,
  'API_KEY=\\"a b',
  'echo \\"hi\\" TOKEN=\\"a \\" b\\"',
  // Written inside a string twice over, and JSON text inside a string (review #501 on #1575).
  '"cmd": "export API_TOKEN=\\\\\\"a b\\\\\\" && run"',
  `--password \\\\\\"${FAKE} x\\\\\\"`,
  'password: \\\\\\"a b',
  // Longer than any JSON key: only the name before the run holds it back.
  `password: \\\\\\"${'x '.repeat(70)}\\\\\\" ok`,
  `payload={\\"password\\":\\"${FAKE}\\",\\"x\\":\\"y\\"}`,
  '{\\"client secret\\" : \\"a b\\\\\\"c d\\"}',
  '{\\"note\\": \\"say \\\\\\"hi\\\\\\"\\", \\"token\\": \\"x y\\"}',
  '{\\"password\\": \\"a \\\\\\\\ b\\"} tail',
  '{\\"password\\": \\"[redacted]\\"}',
  '"password":\\\\\\\\\\"[redacted]} and password: \\"x y\\"',
  "export PGPASSWORD='x y'",
  `X=PGPASSWORD=${FAKE}`,
  `note: password=${FAKE}`,
  `password: [redacted] and token: ${FAKE}`,
  `token=${FAKE}&password=${FAKE}`,
  `url: https://x/?token=${FAKE}&y=1`,
  'postgres://u:s3cret@db:5432/x',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
  `sk-ant-${FAKE}`,
  `ghp_${FAKE}`,
  HANDLE,
  `5" screen {"secret value": "x y"}`,
  `a\npassword: "x y"\nCookie: a=1\n{"token": "q r"}\n`,
  `密码是 password: ${FAKE}。`,
  `值 token = "${FAKE} 中文"`,
  `我的 Handle 是${HANDLE}。`,
  // A quoted value whose closing quote is not on its line (legacy 921).
  `export API_TOKEN="${FAKE} cut`,
  "password: 'a b",
  'API_TOKEN=\\"a b\nnext\\" x',
  'API_TOKEN=\\"a\r\\" b',
  'password="a b\r\n" c',
  '{"cmd":"PASSWORD=\\"a b","x":1}',
  '{"user":"bob","password": "a b',
  '{"session cookie": "a b\\',
  'payload={\\"session cookie\\":\\"a b',
  'log "{\\"session cookie\\":\\"a" x',
  `-e \\"API_TOKEN=${FAKE}\\" -e \\"DEBUG=1\\"`,
  `{"cmd":"PASSWORD=${FAKE}\\\\","x":1}`,
  'password="',
  // A space, then a backslash: a JSON string's value read so far ends before it, short of the end.
  '{"session cookie": "a \\"b \\\\ c"}',
  '{\\"password\\": \\"a \\\\\\"b \\\\\\\\ c\\"}',
  // A `"…"` value with escaped quotes inside it, to the quote no backslash escapes.
  `{"password": "a \\"b ${FAKE}"}`,
  `{"api_key":"x\\"${FAKE}","user":"bob"}`,
  `PASSWORD="a\\"b ${FAKE}" next`,
  'password="C:\\dir\\" x',
  'password: "a \\\\" b "c"',
  // One that ends with `\` before its quote, then the next pair: the first `"` closes it (#493 on
  // #1579). Then a quote no value can close at, a name right after it: never cut there.
  `--password "C:\\dir\\" --token "${FAKE}"`,
  `PASSWORD="C:\\dir\\" API_TOKEN="${FAKE}" x`,
  `password="a\\"b"token=${FAKE}`,
  `password="a\\"b"--token ${FAKE}`,
  'password="a\\"b"c d',
  // The same, in the writings review #501 on #1579 found.
  `run --password "C:\\k\\" --token "${FAKE}"`,
  `$env:GOOGLE_APPLICATION_CREDENTIALS="C:\\keys\\"; $env:API_TOKEN="${FAKE}"`,
  `export DB_PASSWORD="ab\\" API_TOKEN="${FAKE}"`,
  `password: "a\\" token: "${FAKE}"`,
  `<x password="C:\\d\\" token="${FAKE}">`,
  `user=bob password="p\\" api_key="${FAKE}" ok`,
  `API_TOKEN="a \\"b \\"password":${FAKE}`,
  // A bare value that ends with an escaped quote: the character read on after a cut there is part
  // of the value, so the text before is read on its own (#493 on #1579).
  '"password":\\\\\\""token: "\\\\\\"x',
  // A quote with spaces, then a colon, after it closes no value: it is a JSON key's (#501 on
  // #1579). Streamed apart from the whole text before, when the whole read on to it (#493).
  String.raw`{password="\"\"\" API_TOKEN=\"\\"\"api_key"${'\t'}:${'\t'}"\"\""`,
  `API_TOKEN="a \\"b \\"api_key" : "${FAKE}"`,
  // Never cut in the blanks after a quote, whose `:` decides whether it closes a value; held
  // while only blanks have come after it (#493 on #1581).
  String.raw`run token="\"" :'"x"}`,
  String.raw`run token="\""${'\t'}:'"x"}`,
  String.raw`{password="x y\"| " :"}`,
  String.raw`API_TOKEN: "x y\""  :\"x`,
  String.raw`"password": "a\"b"  : x`,
  `password="a\\"b"\t\t:${FAKE} y`,
  // Four blanks before the colon, and a key's closing quote before `=` (#501 on 05f9be71).
  String.raw`run token="\""    :'"x"}`,
  `API_TOKEN="a \\"b \\"api_key" = " ${FAKE}"`,
  `API_TOKEN="a \\"b \\"api_key"\t=\t" ${FAKE}"`,
  String.raw`run token="\"" ='"x"}`,
  // The names the value rules take before the next pair's opening quote, which ends the value
  // before them (legacy 924, #501 on 05f9be71): held from the name, as the whole text hides it.
  `PASSWORD="C:\\dir\\".API_TOKEN=" ${FAKE}"`,
  `password="C:\\dir\\" ${'A'.repeat(59)}_TOKEN=" ${FAKE}"`,
  `password="C:\\dir\\" ${'A'.repeat(122)}_TOKEN=" ${FAKE}"`,
  `password="C:\\dir\\".--token " ${FAKE}"`,
  `password="C:\\dir\\"_--token " ${FAKE}"`,
  `password="C:\\dir\\".--token=" ${FAKE}"`,
  // A flag or env name right after a quote, a dot, `_` or `-`, which the flag and env rules take
  // for one and the name rule does not (legacy 925): held from the name, as the whole text hides
  // the value.
  `say "hi".--password "${FAKE} x" y`,
  `say "hi"_--password "${FAKE} x" y`,
  `say "hi".--password="a ${FAKE}" y`,
  `say "hi".--api-key  "a ${FAKE}" y`,
  `say "hi".API_TOKEN="a b ${FAKE}" y`,
  `say "hi"-API_TOKEN="a ${FAKE}" y`,
  `${'A'.repeat(90)}_TOKEN="a b ${FAKE}" y`,
  // The name rule does not take a name after a dot, whole or streamed.
  `say "hi".password: "a ${FAKE}" y`,
  // A value read with escapes ends before the next pair whose '…' value holds the quote it would
  // have closed at, and reads on past one it covers (legacy 926, review #501 on #1581).
  `token: "a\\" --token 'x", ${FAKE}'`,
  `export PGPASSWORD="C:\\pg\\" API_TOKEN='x"; ${FAKE}'`,
  `API_TOKEN=\\"a --token 'b\\" ${FAKE}'`,
  `password=\\"abc --token 'x" ${FAKE}'`,
  `password="a\\" token='b' ${FAKE}"`,
  `password="C:\\dir\\" --PASSWORD 'x" ${FAKE}'`,
  `password="C:\\dir\\" myToken='x" ${FAKE}'`,
  `API_TOKEN=\\"a PGPASSWORD='x" ${FAKE}'`,
  // An escaped JSON key and `=` (review #501 on #1581).
  `\\"password\\" = \\"${FAKE} x\\"`,
  `pwsh -c "Invoke-X -Body @{\\"Password\\" = \\"${FAKE}\\"}"`,
  // The name rules read together, each on the text as it is written (legacy 928): a pair whose
  // closing quote the rule before it hid in a sequential read, pairs that cross — one match, never
  // cut apart — a bare value that stops before the next pair, and a secret key after `\"` (929).
  `--token='\\${FAKE}":api_key=\\"'\\"`,
  `note: API_TOKEN: '${FAKE}} .API_TOKEN=\\"x'`,
  `"api_key": "'.API_TOKEN="${FAKE}'"`,
  `--token "a API_TOKEN="${FAKE} b"`,
  `password='a API_TOKEN='${FAKE} b'`,
  `token=x,api_key="${FAKE} y"`,
  `--token x,--password "${FAKE} y"`,
  `token: \\"password": ${FAKE}`,
  `token: \\"password" = '${FAKE} x'`,
  `api_key = a}.--token '${FAKE} x'`,
  `password=|API_TOKEN=\\"${FAKE}\\" x`,
  // A next pair's name against a bare value; a pattern that reads on from where a match ended
  // before one crossed it, or before the last one did (review #493 on #1586).
  `--password=${FAKE}--api-key="abc"`,
  `token=;${FAKE}clientSecret--token : "x"`,
  `--token TOKEN='token':${FAKE}`,
  `token=--password="I_TOKEN="apikey:\\"${FAKE}`,
  // A bare value read on past a next pair whose value is a secret's key (review #501 on #1586),
  // and one that is not, which ends it.
  `token=x,password: "api_key": ${FAKE}`,
  `"token" = a,token:  "api_key": '${FAKE}'`,
  `token=x|password: "api_key" = ${FAKE}`,
  'token=x,password: "note": y',
  `API_KEY=x&secret: '${FAKE}'`,
  // Read after what was emitted: a cut after the `.` before a pair reads the pair as the whole
  // text does, here and when the text ends.
  `.API_TOKEN="a}api_key = \\"${FAKE} : `,
  `.--token=  \\\\";password="${FAKE}\\".`,
  `.API_TOKEN=" &api_key='\\\\" ${FAKE} "k"\t=\t'", `,
  // Quotes many deep that streamed apart from the whole until the held text was read after the
  // end of what was emitted (legacy 920, #493 on #1579).
  String.raw`run password='\\" , API_TOKEN="\a'""api_key": "' `,
  String.raw`echo "--password="\n\"password: '"\\'\"}"}`,
  // Held while a key and its quote can still come, to the bounds the whole text reads them to
  // (reviews #493 and #501 on #1589): eight blanks after the quote, a key of 64 characters, a key
  // that opens with a capital; and the next pair looked for after what was emitted.
  `token=x,password: "api_key"${' '.repeat(8)}: ${FAKE}`,
  `token=x,password: "${'a'.repeat(58)}_token": ${FAKE}`,
  `token=x,password: "Api_key": ${FAKE}`,
  `password = &token = "user${FAKE}"`,
  // A pair that starts inside a value and goes on past it, read on from where that value starts
  // (legacy 934); a value closed by a quote inside the value of a pair that crossed it (review
  // #501 on #1589); a secret's key and its quote, which is no value (legacy 930).
  `TOKEN=x,token="apikey:"${FAKE}"`,
  `apikey=x,apikey="Secret="${FAKE}"`,
  `TOKEN=x,I_TOKEN="password:\\"${FAKE}`,
  `password:"TOKEN='"'${FAKE}"`,
  `token='TOKEN="'"${FAKE}'`,
  `--apikey='password:"'"${FAKE}'`,
  `token: "password": ${FAKE}`,
  `token: \\"password\\": \\"${FAKE}\\"`,
  `"token": "password": "${FAKE}"`,
  // A pair at a value's first character; a pair after a value cut short, past blanks, which is
  // held with that value until what follows the blanks is known; a value that goes on to its own
  // quote, stopping at a secret's key but not at one whose opening quote is escaped (legacy 934).
  `--token \\"TOKEN='\\"'${FAKE}\\"`,
  `--token \\"xa TOKEN='\\"'${FAKE} y':`,
  `apikey=\\"a TOKEN='"'${FAKE}`,
  `TOKEN=\\";passwd=""${FAKE}`,
  `password:"a apikey:'"${FAKE}' : APIKEY="a --apikey=""${FAKE} y, `,
  `--token 'a TOKEN="'"x' : --apikey="xpassword:''"${FAKE} y'|`,
  `api_key: 'a TOKEN=\\"'x'\\", api_key: "password:''"${FAKE} y", `,
  `token="a a TOKEN='"${FAKE}"'\t:\tAPIKEY="Secret=\\""\\""${FAKE}\\"", `,
  `api_key: "xa TOKEN='"'${FAKE} y';`,
  `token='a password=\\"secret': "${FAKE}"`,
  `"password":\\"&token: "\\\\"\\\\\\" : \\"password\\": \\",${FAKE}\\"`,
  `--token "passwd='"'\\"secret"=""${FAKE}`,
  // A value that stopped at a quote inside the value of the pair that crossed it, going on; a
  // `"…"` value read on past a pair whose `'…'` value holds its quote; a pair at the first
  // character of a value inside another; a `"…"` value that is a secret's key and its quote, and
  // one inside another value; a value stopped where the value of the pair that crossed it opens;
  // a JSON value that is a secret's key and its quote; a "… not closed on its line after a key in
  // quotes; a value with an escaped quote that a pair crosses or follows (review #501, #493 on
  // #1591).
  `password:\\"TOKEN='"'${FAKE}`,
  `--token \\"TOKEN='"'${FAKE}\\"`,
  `password:"\\"a TOKEN='"'${FAKE}"`,
  `password:"\\"${FAKE} TOKEN='"'"`,
  `--token='token: \\"api_key="'${FAKE}"`,
  `token=x,password: "api_key": ${FAKE}`,
  `token="abc${FAKE}Secret" = 1`,
  `TOKEN=password:"TOKEN='"'${FAKE}`,
  `--token='x,api_key="api_key":'${FAKE}' :`,
  `apikey=\\"token=token='apikey="'\\"'${FAKE}`,
  `"TOKEN'":"passwd":"${FAKE}`,
  `token=password: "api_key": "${FAKE}`,
  `token: "password": "${FAKE} x`,
  `--password 'Password:\\"TOKEN='"'${FAKE}`,
  `--password "\\"secret:'"='${FAKE}"`,
  // A value that ends with a secret's name and its escaped quote; a secret's key and its escaped
  // quote, which that key's own pair crosses; a JSON value inside a string, stopped before a pair
  // in it; quotes many deep that streamed apart from the whole before (review #493 on #1591).
  String.raw`run _--token '", \"Password\"=\",${FAKE}', \"password\": \" ${FAKE}\"\"'}`,
  `password=\\"${FAKE}myToken\\": 1`,
  `token=\\"abc${FAKE}Secret\\" = 1`,
  `\\"password\\": \\"${FAKE}myToken\\": 1`,
  `{\\"token\\":\\"password\\":\\"${FAKE}\\"}`,
  `token: \\"password\\": \\"a\\\\\\"b${FAKE}\\"`,
  `token: \\"password\\": \\"${FAKE}\\"`,
  `\\"password\\": \\"token: apiKey' = \\"${FAKE}\\"`,
  `{\\"api_key=${FAKE}&token\\": \\"x\\"}`,
  `token: \\"_password\\": \\"${FAKE}\\"`,
  // A JSON key the name rule reads no name at the end of, read with the name rules where a value
  // before it reads it in; one with a `,`, a `'`, a blank or a `--` in it; a `--flag` and a blank
  // in a key; a key longer than 64 characters; a `\\\"` in an escaped JSON value and a `\"` in a
  // JSON value, a quote of its own, and an escaped one gone on to its close short of the next pair
  // (legacy 930, reviews #501 on #1591 and #1593, #493 on #1593).
  `apikey=passwd:"apikeye":"${FAKE}`,
  `APIKEY=password:"x,passwordx":"${FAKE}"`,
  `token: "token: "x passwordx": "${FAKE}"`,
  `token: "token: "x --passwordx": "${FAKE}"`,
  `token:\\"--passwd\\":\\"${FAKE}`,
  `token:"--passwd":"${FAKE}`,
  `{"x --token ${FAKE}": "x"}`,
  `{\\"token\\": \\"passwordx": "${FAKE}"`,
  `--token --token \\",passwd\\"=\\"${FAKE}`,
  `\\"password\\":\\" token:x"\\"'apikey\\":\\"${FAKE}`,
  `\\"token\\":\\"'apikey=x&\\\\\\"'${FAKE}`,
  `password=\\"\\"password\\"=\\"\\\\\\"${FAKE}Token:`,
  `token='\\"password\\": \\"x' ${FAKE}\\\\\\"`,
  `password='\\"token\\": \\"a TOKEN='x'\\\\\\" ${FAKE}\\" z`,
  `"passwordx": "a token: x\\" ${FAKE}"`,
  `token=""passwordx":"\\"${FAKE}Secret:`,
  `\\"token\\":\\"'token:${FAKE}\\"token\\":\\"\\"|${FAKE}`,
  `APIKEY=password:"${'a'.repeat(56)}passwordx": "${FAKE}"`,
  `"passwordx":"\\"token:x"${FAKE}`,
  `"passwordx":"\\\\"token:="tokenValue":"${FAKE}Secret:"`,
];

/** What surrounds a shape: nothing; prose; CJK and a newline; an apostrophe, an unclosed quote,
 *  and a JSON string before it — the quotes a stream cannot pair up. */
const CONTEXTS: readonly (readonly [string, string])[] = [
  ['', ''],
  ['see ', ' ok'],
  ['说：', '\nnext'],
  ["I don't know: ", ', ok'],
  ['he said "', '" twice'],
  ['{"note": "', '"}'],
  ["it's '", "' done"],
];

/** `text` split at `cuts`, streamed, and flushed — with how many values were replaced. */
function streamedAt(text: string, cuts: readonly number[]): string {
  const pieces: string[] = [];
  let from = 0;
  for (const at of cuts) {
    pieces.push(text.slice(from, at));
    from = at;
  }
  pieces.push(text.slice(from));
  const out = stream(pieces);
  return `${out.text} (${out.redactedValues})`;
}

/** The first split of `text` — in two at every offset, and with `inThree` in three at every pair of
 *  offsets — whose streamed output is not the whole text scrubbed; `undefined` when there is none. */
function firstMismatch(text: string, inThree: boolean): string | undefined {
  const scrubbed = scrubSecretValues(text);
  const whole = `${scrubbed.value} (${scrubbed.redactedValues})`;
  for (let first = 0; first <= text.length; first += 1) {
    if (streamedAt(text, [first]) !== whole) return `${JSON.stringify(text)} split at ${first}`;
    for (let second = first; inThree && second <= text.length; second += 1) {
      if (streamedAt(text, [first, second]) !== whole) {
        return `${JSON.stringify(text)} split at ${first}, ${second}`;
      }
    }
  }
  return undefined;
}

describe('createSecretStreamScrubber — split anywhere, the output is the whole text scrubbed', () => {
  it.each(PAIR_NAMES)(
    '%s with every separator and value: in two at every offset, in three at every pair',
    (name) => {
      const mismatches = SEPARATORS.flatMap((separator, index) =>
        PAIR_VALUES.map((value, valueIndex) =>
          firstMismatch(
            `see ${name}${separator}${value} ok`,
            valueIndex === index % PAIR_VALUES.length,
          ),
        ),
      );
      expect(mismatches.filter((found) => found !== undefined)).toEqual([]);
    },
  );

  it.each(SHAPES.map((shape, index) => [shape.slice(0, 40), index]))(
    '%s… in every context: in two at every offset, in one context in three at every pair',
    (_label, index) => {
      const shape = SHAPES[index as number] ?? '';
      const mismatches = CONTEXTS.map(([before, after], contextIndex) =>
        firstMismatch(
          `${before}${shape}${after}`,
          contextIndex === (index as number) % CONTEXTS.length,
        ),
      );
      expect(mismatches.filter((found) => found !== undefined)).toEqual([]);
    },
  );

  it('in up to nine uneven pieces, cut at random', () => {
    // mulberry32: the product of the 31-bit generator used before passed 2^53, lost its low bits
    // and fell into a short cycle, so most texts were cut the same few ways.
    let seed = 7;
    const random = (below: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * below);
    };
    const texts = [
      ...PAIR_NAMES.flatMap((name) =>
        SEPARATORS.map(
          (separator, index) =>
            `see ${name}${separator}${PAIR_VALUES[index % PAIR_VALUES.length]} ok`,
        ),
      ),
      ...SHAPES.flatMap((shape) => CONTEXTS.map(([before, after]) => `${before}${shape}${after}`)),
    ];
    const mismatches: string[] = [];
    for (const text of texts) {
      const scrubbed = scrubSecretValues(text);
      const whole = `${scrubbed.value} (${scrubbed.redactedValues})`;
      for (let round = 0; round < 20; round += 1) {
        const cuts = Array.from({ length: 1 + random(8) }, () => random(text.length + 1));
        cuts.sort((a, b) => a - b);
        if (streamedAt(text, cuts) !== whole) {
          mismatches.push(`${JSON.stringify(text)} split at ${cuts.join(', ')}`);
          break;
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  const TAB = '\t';
  // Known limit, as legacy 920: where one rule's mask changes how a later rule reads the text
  // (quotes three or four deep on a line), the cut is found on the text as it came and can fall
  // inside a value only the whole text reads. Pinned so that a change to it shows (#493 on #1579;
  // release.md §3.214, §3.216, §3.217): main streamed this one apart too; the two main pinned, and
  // the other one pinned here before, stream as the whole text now (`SHAPES`).
  it.each([
    [
      String.raw`run x--k \"\\\\, API_TOKEN=""note: a"}token: \x\\"${TAB}:${TAB}"API_TOKEN = 'C:,${FAKE}${TAB}:${TAB}`,
      String.raw`run x--k \"\\\\, API_TOKEN="${REDACTED}"note: a"}token: ${REDACTED}"${TAB}:${TAB}"${REDACTED}`,
      String.raw`run x--k \"\\\\, API_TOKEN="${REDACTED}"note: a"}token: ${REDACTED}"${TAB}:${TAB}"API_TOKEN = 'C:,${FAKE}${TAB}:${TAB}`,
    ],
  ])(
    'quotes many deep on a line can still stream apart from the whole: %s',
    (text, whole, streamed) => {
      expect(scrubSecretValues(text).value).toBe(whole);
      expect(stream([text]).text).toBe(streamed);
    },
  );
});

describe('createSecretStreamScrubber — the stream stays live', () => {
  it('emits Chinese prose as it arrives — no spaces does not mean held back', () => {
    const scrubber = createSecretStreamScrubber();
    for (const char of '图里没有这类关系。') expect(scrubber.push(char).value).toBe(char);
  });

  it('holds back a quote opened after a name no rule hides from the quote, not from the name (#493 on #1581)', () => {
    expect(createSecretStreamScrubber().push('x --color "a b ').value).toBe('x --color ');
    expect(createSecretStreamScrubber().push('x COLOR="a b ').value).toBe('x COLOR=');
    // After a dot, where only the --flag and env-line rules take a name (legacy 926).
    expect(createSecretStreamScrubber().push('x.--verbose "a b ').value).toBe('x.--verbose ');
    expect(createSecretStreamScrubber().push('x.DEBUG=" a').value).toBe('x.DEBUG=');
  });

  it('holds a bare value back at a `,` only while the key after the next quote can still decide where it ends (review #501 on #1586)', () => {
    // A secret's key, whole: the value before it read on past the `,`, and the key's pair, whose
    // value has not come, crossing both (review #493 on #1591) — held whole.
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push('token=x,password: "api_key": ').value).toBe('');
    expect(scrubber.flush().value).toBe(`token=${REDACTED} "${REDACTED}": `);
    // A key no rule hides: the value before it ends at the `,`.
    expect(createSecretStreamScrubber().push('token=x,password: "note": ').value).toBe(
      `token=${REDACTED}`,
    );
  });

  it('lets a value still open go once more than blanks follows it (legacy 934)', () => {
    // A pair after it, past blanks, may be read as inside it; one on the next line is not.
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push('TOKEN=\\"abc"\nnext line ').value).toBe(
      `TOKEN=\\"${REDACTED}"\nnext line `,
    );
    expect(scrubber.flush().value).toBe('');
  });

  it('holds back only the word being written', () => {
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push('hello wor').value).toBe('hello ');
    expect(scrubber.push('ld and').value).toBe('world ');
    expect(scrubber.flush().value).toBe('and');
  });

  it('of a run of quotes and blanks holds back only the last, however many came (#493 on e301108f)', () => {
    expect(createSecretStreamScrubber().push('" '.repeat(100)).value).toBe('" '.repeat(99));
    for (const unit of ['" ', '"\t', `"${' '.repeat(8)}`]) {
      const text = unit.repeat(Math.ceil((2 * STREAM_HOLD_MAX_CHARS) / unit.length));
      const scrubber = createSecretStreamScrubber();
      let out = '';
      for (let at = 0; at < text.length; at += 7) {
        const piece = scrubber.push(text.slice(at, at + 7));
        expect(piece.paused).toBeUndefined();
        out += piece.value;
      }
      expect(out + scrubber.flush().value).toBe(scrubSecretValues(text).value);
    }
  });

  it('past its bound it drops what it held and emits nothing more until flushed', () => {
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push(`start ${'A'.repeat(STREAM_HOLD_MAX_CHARS + 1)}`)).toEqual({
      value: `start ${REDACTED}`,
      redactedValues: 1,
      paused: true,
    });
    // Legacy 162: only the piece that dropped says it paused — not the empty ones after it.
    expect(scrubber.push(' more text ')).toEqual({ value: '', redactedValues: 0 });
    expect(scrubber.flush().value).toBe('');
    expect(scrubber.push('next ')).toEqual({ value: 'next ', redactedValues: 0 });
  });

  it('a value scrubbed at the end of the text is no pause (legacy 162)', () => {
    // The text ends on a secret, then a tool call flushes it: the live text ends in `[redacted]`
    // though nothing was dropped — the case a console reading the text alone took for a pause.
    const scrubber = createSecretStreamScrubber();
    const pushed = scrubber.push(`token: ${HANDLE}`);
    expect(pushed).toEqual({ value: '', redactedValues: 0 });
    expect(scrubber.flush()).toEqual({ value: `token: ${REDACTED}`, redactedValues: 1 });
  });

  it('a piece that drops part-way through says it paused, after what it emitted before (legacy 162)', () => {
    const scrubber = createSecretStreamScrubber();
    // Released words, then a run with no break longer than the bound: one piece, one pause.
    const out = scrubber.push(`first words ${'B'.repeat(STREAM_HOLD_MAX_CHARS * 5)}`);
    expect(out).toEqual({ value: `first words ${REDACTED}`, redactedValues: 1, paused: true });
  });

  it.each(['token=', 'TOKEN=', '--token ', 'password: '])(
    'after a flush reads the text as a new one, nothing before it to look back into: %s (review #501 on #1586)',
    (name) => {
      // The `" ` held back is emitted by the flush; what was emitted before it ends in `a`, a
      // letter a name may not be written against.
      const scrubber = createSecretStreamScrubber();
      expect(scrubber.push('x a" ').value).toBe('x a');
      expect(scrubber.flush().value).toBe('" ');
      const out = scrubber.push(`${name}${FAKE}`).value + scrubber.flush().value;
      expect(out).toBe(`${name}${REDACTED}`);
    },
  );
});
