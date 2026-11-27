import { describe, expect, it } from 'vitest';
import {
  LINE_START,
  TAIL_VALUE_MAX_CHARS,
  TailMasker,
  TailReader,
  readLine,
  tailChecked,
  tailMarks,
} from './tail-check.js';

/**
 * The tail check alone (`T` of docs/redaction-boundary-design-2026-11-27.md §4.2, class legacy
 * 962): each form of value, each entry of the two boundary tables, each bound, and the stream
 * reading the whole text reads (§8, I-R3 a). FAKE values only.
 */
const R = '[redacted]';
const FAKE = 'FAKEabcdefghijklmnopqrstuvwxyz';

/** What the check alone shows of `text`. */
const shown = (text: string): string => tailChecked(text).value;

describe('tailChecked — the forms of a value, closed cleanly or not', () => {
  it.each([
    // A mask the value rules wrote: nothing more to hide when it closes cleanly.
    ['a mask', `run token: ${R} ok`, `run token: ${R} ok`],
    ['a mask, text against it', `run token: ${R}x ok`, `run token: ${R}`],
    // A quoted value: its text is hidden, its quotes kept.
    ['a quoted value', `run password: "a b" ok`, `run password: "${R}" ok`],
    ['a single-quoted value', `run password: 'a b', next`, `run password: '${R}', next`],
    ['an empty quoted value', 'run password: "" ok', 'run password: "" ok'],
    ['a quoted mask', `run password: "${R}" ok`, `run password: "${R}" ok`],
    ['a quoted value, text against it', `run password: "a b"x ok`, `run password: ${R}`],
    ['a quoted value never closed', 'run password: "a b ok', `run password: ${R}`],
    ['a quoted value with a mask and text', `run password: "a ${R} b" ok`, `run password: ${R}`],
    ['a quoted value holding a pair', 'run password: "x token=y" ok', `run password: ${R}`],
    ['a quoted value with an escaped quote', 'run password: "a\\"b" ok', `run password: "${R}" ok`],
    // A quoted value written inside a string: `\"…\"`, up to seven backslashes.
    ['an escaped JSON pair', `{\\"password\\": \\"${FAKE}\\"}`, `{\\"password\\": \\"${R}\\"}`],
    [
      'seven backslashes',
      `run A_TOKEN=\\\\\\\\\\\\\\"${FAKE}\\\\\\\\\\\\\\" ok`,
      `run A_TOKEN=\\\\\\\\\\\\\\"${R}\\\\\\\\\\\\\\" ok`,
    ],
    ['eight backslashes', `run A_TOKEN=\\\\\\\\\\\\\\\\"${FAKE}" ok`, `run A_TOKEN=${R}`],
    ['an escaped quote closed by a bare one', `run A_TOKEN=\\"${FAKE}" ok`, `run A_TOKEN=${R}`],
    ['backslashes and no quote', `run A_TOKEN=\\${FAKE} ok`, `run A_TOKEN=${R}`],
    // A container closed on its line, its strings read whole.
    [
      'a container',
      '{"name": "db-1", "credentials": {"user": "bob", "pin": 1234}} ok',
      `{"name": "db-1", "credentials": ${R}} ok`,
    ],
    ['an array', 'run "tokens": ["a", "b"], next', `run "tokens": ${R}, next`],
    ['an empty container', 'run "credentials": {} ok', 'run "credentials": {} ok'],
    ['a container never closed', 'run "credentials": {"user": "bob"', `run "credentials": ${R}`],
    [
      'a container closed wrong',
      'run "credentials": {"user": "bob"] ok',
      `run "credentials": ${R}`,
    ],
    ['a container opened at the end of its line', 'run "credentials": {', 'run "credentials": {'],
    [
      'a container with a backslash outside its strings',
      'run "credentials": {\\x} ok',
      `run "credentials": ${R}`,
    ],
    // A JSON scalar before `,` `}` `]`: the value rules hide it, nothing here.
    ['a JSON number', '{"password": 1234, "n": 1}', '{"password": 1234, "n": 1}'],
    ['a JSON literal', '{"password": null}', '{"password": null}'],
    // A bare value.
    ['a bare value', `run token=${FAKE} ok`, `run token=${R} ok`],
    ['a bare value at the end', `run token=${FAKE}`, `run token=${R}`],
    ['a bare value, `,` after it', `run token=${FAKE},x`, `run token=${R}`],
    ['a bare value with a mask in it', `run token=a${R}b ok`, `run token=${R}`],
    ['a bare value holding a pair', `run token=a:password=${FAKE} ok`, `run token=${R}`],
    ['no value', 'run token=', 'run token='],
    ['no value but a blank', 'run token= ', 'run token= '],
    ['a value that is no value', 'run token=… ok', 'run token=… ok'],
    // A variable is not a value.
    ['a $VAR', 'run token=$HOME ok', 'run token=$HOME ok'],
    ['a ${VAR}', 'run token=${HOME} ok', 'run token=${HOME} ok'],
    // A name the check does not take a value with.
    ['a name that is no secret', 'run color="a b"x ok', 'run color="a b"x ok'],
  ])('%s', (_label, text, expected) => {
    expect(shown(text)).toBe(expected);
  });
});

describe('tailChecked — a line whose first pair has a bare value is read to its end', () => {
  it.each([
    [`PGPASSWORD=${FAKE} psql`, `PGPASSWORD=${R}`],
    [`export API_TOKEN=${FAKE} rest`, `export API_TOKEN=${R}`],
    [`  password: ${FAKE} (old)`, `  password: ${R}`],
    [`- password: ${FAKE} more`, `- password: ${R}`],
    [`\t- password: ${FAKE} more`, `\t- password: ${R}`],
  ])('%s', (text, expected) => {
    expect(tailChecked(text)).toEqual({
      value: expected,
      redactedValues: 1,
      tails: 1,
      tailChars: text.length - expected.length + R.length,
    });
  });

  it.each([
    [`PGPASSWORD=${FAKE}`, `PGPASSWORD=${R}`],
    [`PGPASSWORD=${FAKE}  `, `PGPASSWORD=${R}  `],
    [`exports API_TOKEN=${FAKE} rest`, `exports API_TOKEN=${R} rest`],
    [`x API_TOKEN=${FAKE} rest`, `x API_TOKEN=${R} rest`],
    [`--password ${FAKE} rest`, `--password ${R} rest`],
    [`PGPASSWORD="${FAKE}" psql`, `PGPASSWORD="${R}" psql`],
  ])('not when it ends there, is not its first pair, or is not bare: %s', (text, expected) => {
    expect(tailChecked(text)).toEqual({
      value: expected,
      redactedValues: 1,
      tails: 0,
      tailChars: 0,
    });
  });
});

describe('tailChecked — the boundary tables', () => {
  // After a quoted value, a container or a mask.
  const AFTER_QUOTED = [...',;&|)]}>.`', ...'，。、；：！？）」』】》'];
  it.each(AFTER_QUOTED)('a quoted value may be followed by %s', (char) => {
    expect(shown(`run password="a b"${char}z`)).toBe(`run password="${R}"${char}z`);
    expect(shown(`run token: ${R}${char}z`)).toBe(`run token: ${R}${char}z`);
    expect(shown(`run "x_token": {"a": 1}${char}z`)).toBe(`run "x_token": ${R}${char}z`);
  });
  it.each([' ', '\t', '　'])('a quoted value may be followed by whitespace %j', (char) => {
    expect(shown(`run password="a b"${char}z`)).toBe(`run password="${R}"${char}z`);
  });
  it.each(['x', '-', '+', '(', '[', '{', '<', '/', '#', '!', '?', '@', '$', '%', '*', '~', '^'])(
    'and by nothing else: %s',
    (char) => {
      expect(shown(`run password="a b"${char}z`)).toBe(`run password=${R}`);
    },
  );

  // After a bare value: it runs to a blank, a quote, a backslash, `&` or a backtick.
  it.each(['&', '`', ' ', '\t'])('a bare value may be followed by %j', (char) => {
    expect(shown(`run token=${FAKE}${char}z`)).toBe(`run token=${R}${char}z`);
  });
  it.each([',', ';', '|', '(', ')', ']', '}', '<', '>', '.', '!', ':', '='])(
    'and reads %s into itself',
    (char) => {
      expect(shown(`run token=${FAKE}${char}z ok`)).toBe(`run token=${R} ok`);
    },
  );
  it.each(['"', "'", '\\'])(
    'and hides the rest of the line from a %s against it, outside a string the line opened',
    (char) => {
      expect(shown(`run token=${FAKE}${char}z ok`)).toBe(`run token=${R}`);
    },
  );

  it('takes a `:` or `=` within eight blanks after a value for the next key, not a boundary', () => {
    expect(shown('run password="a" : z')).toBe(`run password=${R}`);
    expect(shown(`run password="a"${' '.repeat(8)}= z`)).toBe(`run password=${R}`);
    expect(shown(`run password="a"${' '.repeat(9)}= z`)).toBe(
      `run password="${R}"${' '.repeat(9)}= z`,
    );
  });

  it('reads up to four masks the value rules wrote after a value, and not a fifth', () => {
    for (const n of [1, 2, 3, 4]) {
      const masks = R.repeat(n);
      expect(shown(`run password="a"${masks} y`)).toBe(`run password="${R}"${masks} y`);
      expect(shown(`run password="a"${`"${R}"`.repeat(n)} y`)).toBe(
        `run password="${R}"${`"${R}"`.repeat(n)} y`,
      );
    }
    expect(shown(`run password="a"${R.repeat(5)} y`)).toBe(`run password=${R}`);
    // As the value rules write one they read on past its quote (design §4.3).
    expect(shown(`TOKEN=\\"${R}\\"${R} y`)).toBe(`TOKEN=\\"${R}\\"${R} y`);
    expect(shown(`run x='${R}'${R} y`)).toBe(`run x='${R}'${R} y`);
  });

  it("takes an outer string's closing quote after a value only where the line opened that string", () => {
    expect(shown(`say "token=${FAKE}" ok`)).toBe(`say "token=${R}" ok`);
    expect(shown(`say 'token=${FAKE}' ok`)).toBe(`say 'token=${R}' ok`);
    expect(shown(`sh -c \\"token=${FAKE}\\" ok`)).toBe(`sh -c \\"token=${R}\\" ok`);
    // No string opened before it.
    expect(shown(`say token=${FAKE}" ok`)).toBe(`say token=${R}`);
    // Opened and closed again before it.
    expect(shown(`say "a" token=${FAKE}" ok`)).toBe(`say "a" token=${R}`);
    // Its quote and the one after the value differ.
    expect(shown(`say 'token=${FAKE}" ok`)).toBe(`say 'token=${R}`);
  });
});

describe('tailChecked — the bounds', () => {
  const L = TAIL_VALUE_MAX_CHARS;

  it(`reads a bare value of up to ${L} characters, and hides the rest of the line past it`, () => {
    expect(shown(`run token=${'a'.repeat(L)} ok`)).toBe(`run token=${R} ok`);
    expect(shown(`run token=${'a'.repeat(L + 1)} ok`)).toBe(`run token=${R}`);
  });

  it(`reads a quoted value closed within ${L} characters of its opening quote`, () => {
    expect(shown(`run token="${'a'.repeat(L - 1)}" ok`)).toBe(`run token="${R}" ok`);
    expect(shown(`run token="${'a'.repeat(L)}" ok`)).toBe(`run token=${R}`);
    expect(shown(`run token=\\"${'a'.repeat(L - 2)}\\" ok`)).toBe(`run token=\\"${R}\\" ok`);
    expect(shown(`run token=\\"${'a'.repeat(L)}\\" ok`)).toBe(`run token=${R}`);
  });

  it(`reads a container closed within ${L} characters`, () => {
    const inner = (n: number) => `{"a": "${'a'.repeat(n)}"}`;
    expect(shown(`run "x_token": ${inner(L - 10)} ok`)).toBe(`run "x_token": ${R} ok`);
    expect(shown(`run "x_token": ${inner(L)} ok`)).toBe(`run "x_token": ${R}`);
  });

  it('takes a name with up to eight blanks around its separator', () => {
    const blanks = ' '.repeat(8);
    expect(shown(`run password${blanks}=${blanks}"a" ok`)).toBe(
      `run password${blanks}=${blanks}"${R}" ok`,
    );
    // Nine blanks before the separator: no pair this check reads.
    expect(shown(`run password${blanks} = "a"x`)).toBe(`run password${blanks} = "a"x`);
  });

  it('takes a `--flag` and one to eight blanks', () => {
    expect(shown(`x --password${' '.repeat(8)}${FAKE} y`)).toBe(
      `x --password${' '.repeat(8)}${R} y`,
    );
    expect(shown(`x --password=${FAKE} y`)).toBe(`x --password=${R} y`);
  });

  it('takes a name of up to 128 characters', () => {
    const name = (n: number) => `${'A'.repeat(n - 6)}_TOKEN`;
    expect(shown(`run ${name(128)}="a"x`)).toBe(`run ${name(128)}=${R}`);
    // One more: no name starts where a name character stands before it.
    expect(shown(`run ${name(129)}="a"x`)).toBe(`run ${name(129)}="a"x`);
  });
});

describe('tailChecked — counts, and a second reading', () => {
  it('counts each tail once with the characters it hid, and each value hidden', () => {
    const text = `run token=${FAKE}"x\nok\nrun password="a"b c\r\nlast token=${FAKE},x y`;
    const checked = tailChecked(text);
    expect(checked.value).toBe(`run token=${R}\nok\nrun password=${R}\r\nlast token=${R} y`);
    expect(checked.tails).toBe(2);
    expect(checked.tailChars).toBe(`${FAKE}"x`.length + '"a"b c'.length);
    expect(checked.redactedValues).toBe(3);
  });

  it('changes nothing it wrote, read again', () => {
    const lines = [
      `run token=${FAKE},x`,
      `PGPASSWORD=${FAKE} psql`,
      `{"password": "a", "credentials": {"a": [1, "b"]}, "n": 1}`,
      `say "token=${FAKE}" ok; password='a'.`,
      `TOKEN=\\"${FAKE}\\" && run --password ${FAKE} -x`,
      `run password="a"${R}${R} y`,
      `- password: ${FAKE} more`,
    ];
    for (const line of lines) {
      const once = shown(line);
      expect(tailChecked(once)).toEqual({ value: once, redactedValues: 0, tails: 0, tailChars: 0 });
    }
  });

  it('reads each line on its own: `\\n` and `\\r\\n` end one, a lone `\\r` does not', () => {
    expect(tailMarks('run token="a"x\nnext').marks).toEqual([
      { start: 'run token='.length, end: 'run token="a"x'.length, tail: true },
    ]);
    expect(shown('run token="a"x\r\nnext')).toBe(`run token=${R}\r\nnext`);
    expect(shown('run token="a"x\rnext')).toBe(`run token=${R}`);
  });
});

/** The stream's reading of `text` cut at `cuts`: the composition with nothing else kept, as
 *  `tailChecked` composes a whole text. */
function streamed(text: string, cuts: readonly number[]): string {
  const reader = new TailReader();
  const masker = new TailMasker();
  let from = 0;
  let out = '';
  for (const cut of [...cuts, text.length]) {
    const piece = text.slice(from, cut);
    reader.push(piece);
    masker.add([{ at: from, text: piece }]);
    out += masker.compose(reader.safe, reader.marksFrom(masker.done));
    from = cut;
  }
  reader.end();
  out += masker.compose(Number.POSITIVE_INFINITY, reader.marksFrom(masker.done)) + masker.finish();
  return `${out} (${masker.redactedValues}; ${reader.tails}, ${reader.tailChars})`;
}

function wholly(text: string): string {
  const checked = tailChecked(text);
  return `${checked.value} (${checked.redactedValues}; ${checked.tails}, ${checked.tailChars})`;
}

describe('TailReader — a stream read as the whole text is (design §8, I-R3 a)', () => {
  /** A line's head longer than the eight characters a stream's value rules look back on, quoted
   *  and not, so a cut falls well before the name. */
  const HEADS = ['', 'a long head of prose: ', 'she said "the line is ', "it's an open 'quote "];
  const PAIRS = [
    `token=${FAKE}`,
    `token=${FAKE},x`,
    `password: "a b" ok`,
    `password: "a b"x`,
    `{\\"password\\": \\"a\\"} y`,
    '"credentials": {"a": "b\\"c", "d": [1]} ok',
    '"credentials": {"a": 1',
    `--password ${FAKE} -h`,
    `password="a"${R}${R} y`,
    `token=${FAKE}" end`,
    'api_key=$HOME&x=1',
  ];
  const texts = [
    ...HEADS.flatMap((head) => PAIRS.map((pair) => `${head}${pair}`)),
    ...PAIRS.map((pair) => `PGPASSWORD=x\n${pair}\r\n${pair}`),
  ];

  it.each(texts.map((text) => [text]))(
    'in two at every offset, in three at every pair: %s',
    (text) => {
      const whole = wholly(text);
      for (let first = 0; first <= text.length; first += 1) {
        expect(streamed(text, [first])).toBe(whole);
        for (let second = first; second <= text.length; second += 1) {
          const got = streamed(text, [first, second]);
          if (got !== whole)
            expect({ text, first, second, got }).toEqual({ text, first, second, got: whole });
        }
      }
    },
  );

  it('one character at a time, values longer than the bound included', () => {
    for (const text of [
      `run token=${'a'.repeat(TAIL_VALUE_MAX_CHARS + 5)} ok\nnext`,
      `run token="${'a'.repeat(TAIL_VALUE_MAX_CHARS - 1)}" ok`,
      `run "x_token": {"a": "${'b'.repeat(TAIL_VALUE_MAX_CHARS)}"} ok`,
      `${'p'.repeat(300)} password="a"x\n${'q'.repeat(200)}token=${FAKE} y`,
    ]) {
      const cuts = Array.from({ length: text.length }, (_, i) => i);
      expect(streamed(text, cuts)).toBe(wholly(text));
    }
  });

  it('the long lines the acceptance run reads only a few of (long/), in two at every offset', () => {
    // The acceptance run's long/ generators read six and eight rows a seed (a stream reading of
    // one takes a second or two), so the check alone is cut at every offset of each kind here
    // (review #493 on #1619): values around the bound L, around the stream's 4,096 and past it,
    // bare and quoted, after a head longer than eight characters, and PEM keys broken with a
    // line break, CRLF and `\n` written in a string.
    const value = (length: number) => `FAKE${'aB3+/'.repeat(length)}`.slice(0, length);
    const lines = (length: number) => value(length).match(/.{1,64}/g) ?? [];
    const texts = [
      ...[TAIL_VALUE_MAX_CHARS, TAIL_VALUE_MAX_CHARS + 1, 4_096, 5_000].map(
        (length) => `2026-11-27T10:14:03Z INFO deploy: password=${value(length)} done`,
      ),
      // An escaped quote's close at the bound and past it, one and three backslashes deep, in a
      // value and in a string of a container: cut inside the close, the text has not yet said
      // whether it starts within the bound.
      ...[-4, -3, -2, -1, 0].flatMap((d) => [
        `log="starting with API_TOKEN=\\"${value(TAIL_VALUE_MAX_CHARS + d)}\\" exit=0"`,
        String.raw`echo 'config: password=\\\"${value(TAIL_VALUE_MAX_CHARS + d)}\\\" ok'`,
        String.raw`{\"cmd\": \"run \"api_key\": {\"a\": \"${value(TAIL_VALUE_MAX_CHARS - 6 + d)}\"}} ok`,
      ]),
      `{"level":"info","msg":"api_key: '${value(4_100)}'"} ok`,
      `[worker-3] step 4/7: --password ${value(4_200)}\nnext token=${FAKE}`,
      ...['\n', '\r\n', '\\n'].map(
        (nl) =>
          `{"private_key": "-----BEGIN PRIVATE KEY-----${nl}${lines(4_200).join(nl)}${nl}-----END PRIVATE KEY-----"} ok`,
      ),
    ];
    for (const text of texts) {
      const whole = wholly(text);
      for (let at = 0; at <= text.length; at += 1) {
        const got = streamed(text, [at]);
        if (got !== whole) expect({ at, got }).toEqual({ at, got: whole });
      }
    }
  }, 60_000);

  it('keeps at most a pending pair of a long line, and nothing of an open tail but a trailing \\r', () => {
    // Kept whole, a line with an open tail grew with every piece and was copied each time it was
    // read: 400,000 characters in pieces of seven took 5 s in the reader alone, against 4 ms now.
    const B = '\\';
    const bound = TAIL_VALUE_MAX_CHARS + 256;
    for (const unit of [
      `token=${B}"x${B}"y `,
      `password: '${B}'a `,
      'password: "a b ',
      `password: "${'a'.repeat(3_500)}" `,
      `{"api_key": "${'b'.repeat(3_000)}", `,
      `password="a${B}"b"`,
      'token: x\n',
    ]) {
      const text = unit.repeat(Math.ceil(30_000 / unit.length)).slice(0, 30_000);
      const reader = new TailReader();
      let most = 0;
      for (let at = 0; at < text.length; at += 7) {
        reader.push(text.slice(at, at + 7));
        most = Math.max(most, reader.held);
      }
      expect({ unit, most: most <= bound }).toEqual({ unit, most: true });
    }

    const tailed = new TailReader();
    tailed.push('run token="a"x');
    for (let i = 0; i < 5_000; i += 1) {
      tailed.push(i % 2 === 0 ? 'abcdefg' : 'abcdef\r');
      expect(tailed.held).toBe(i % 2 === 0 ? 0 : 1);
    }
    tailed.push('\nnext');
    tailed.end();
    expect(tailed.marksFrom(0)).toEqual([
      { start: 'run token='.length, end: 'run token="a"x'.length + 5_000 * 7 - 1, tail: true },
    ]);
    expect([tailed.tails, tailed.tailChars]).toEqual([1, 5_000 * 7 - 1 + 4]);
  });

  it('readLine read in parts gives the marks of the line read whole', () => {
    const line = `say "token=${FAKE}" and password: 'a'.`;
    const whole = readLine(line, 0, LINE_START, true);
    const part = readLine(line.slice(0, 20), 0, LINE_START, false);
    const rest = readLine(line, part.resume, part.state, true);
    expect([...part.hide.filter(([, end]) => end <= part.safe), ...rest.hide]).toEqual(whole.hide);
    expect(rest.tailAt).toBe(whole.tailAt);
  });
});
