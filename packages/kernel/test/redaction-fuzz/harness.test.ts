import { describe, expect, it } from 'vitest';
import { namesASecretValue } from '../../src/substrate/redaction/secret-values.js';
import { CORPUS, GENERATORS } from './generators/index.js';
import { SECRET_NAMES } from './generators/real-formats.js';
import { MASK, type Reader, compare, cutsFor, keptChars, shown, shownThrough } from './measure.js';
import { mulberry32 } from './rng.js';
import { type Row, secretPlaces } from './row.js';

/** The acceptance run's own machinery: what it counts as shown, and what the generators write. */

const kept = (input: string, output: string) => {
  const at = keptChars(input, output);
  return at === undefined ? undefined : [...at];
};
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe('keptChars: which characters of the input an output kept', () => {
  it('reads an output with no mask as the input kept whole, or as not lined up', () => {
    expect(kept('abc', 'abc')).toEqual([0, 1, 2]);
    expect(kept('abc', 'abd')).toBeUndefined();
  });

  it('places each kept piece after the masks before it', () => {
    expect(kept('token=abc def', `token=${MASK} def`)).toEqual([
      ...range(0, 6),
      -1,
      -1,
      -1,
      ...range(16, 20),
    ]);
    expect(kept('a=x b=y', `a=${MASK} b=${MASK}`)).toEqual([0, 1, -1, 12, 13, 14, -1]);
    expect(kept('secret', MASK)).toEqual([-1, -1, -1, -1, -1, -1]);
  });

  it('lets a mask stand for nothing: an empty quoted value', () => {
    // `x=""y` written `x="[redacted]"[redacted]`: the first mask hides the empty value.
    expect(kept('x=""y', `x="${MASK}"${MASK}`)).toEqual([0, 1, 2, 13, -1]);
  });

  it('is undefined for an output that is not its input with stretches masked', () => {
    expect(kept('x="y"', `x=\\"${MASK}\\"`)).toBeUndefined();
    expect(kept('ab cd', `cd ${MASK}`)).toBeUndefined();
    expect(kept('ab', `ab${MASK}c`)).toBeUndefined();
  });

  it('reads a mask the input already held, kept, as a mask', () => {
    expect(kept(`a ${MASK} b`, `a ${MASK} b`)).toEqual([0, 1, ...Array(10).fill(-1), 12, 13]);
  });
});

describe('shown: the secret characters an output kept', () => {
  const row: Row = { t: 'token=abc def', spans: [[6, 9]] };
  const places = secretPlaces(row);

  it('counts the secret characters kept, and no others', () => {
    expect([...shown(row, places, `token=${MASK} def`)].filter((x) => x).length).toBe(0);
    expect([...shown(row, places, `token=a${MASK} def`)].filter((x) => x).length).toBe(1);
    expect([...shown(row, places, `${MASK}=abc def`)].filter((x) => x).length).toBe(3);
  });

  it('counts every one shown where the output cannot be lined up with its input', () => {
    expect([...shown(row, places, 'something else')].filter((x) => x).length).toBe(3);
  });

  it('through two outputs: shown where both kept it', () => {
    const through = (first: string, second: string) =>
      [...shownThrough(row, places, first, second)].filter((x) => x).length;
    expect(through('token=abc def', `token=${MASK} def`)).toBe(0);
    expect(through(`token=ab${MASK} def`, `token=ab${MASK} def`)).toBe(2);
    expect(through(`token=ab${MASK} def`, `token=${MASK}${MASK} def`)).toBe(0);
  });

  it('places secrets at every occurrence of each req, and at each span', () => {
    expect([...secretPlaces({ t: 'xSyS', req: ['S'], spans: [[0, 1]] })]).toEqual([1, 1, 0, 1]);
  });
});

describe('compare: rows now shows a secret character of that before hid', () => {
  /** A reader that masks every occurrence of `words`. */
  const masking = (...words: string[]): Reader => {
    const hide = (text: string) => {
      let out = text;
      for (const word of words) out = out.split(word).join(MASK);
      return out;
    };
    const read = (text: string) => {
      const value = hide(text);
      return { value, redactedValues: value === text ? 0 : 1 };
    };
    return { whole: read, stream: (text) => hide(text), stored: read };
  };
  const rows: Row[] = [
    { t: 'token=FAKEone note', req: ['FAKEone'] },
    { t: 'token=FAKEtwo', req: ['FAKEtwo'] },
  ];

  it('counts each reading where now shows more', () => {
    const result = compare(rows, masking('FAKEone'), masking('FAKEone', 'FAKEtwo'), { seed: 1 });
    expect(result.showsMore).toEqual({ whole: 1, stream: 1, stored: 0, reread: 1 });
    expect(result.info.showing).toEqual({ now: 1, before: 0 });
    expect(result.info.shownChars).toEqual({ now: 7, before: 0 });
    expect(result.examples.whole?.[0]?.t).toBe('token=FAKEtwo');
  });

  it('counts nothing where now hides as much, and reports where it hides more', () => {
    const result = compare(rows, masking('FAKEone', 'FAKEtwo'), masking('FAKEone'), { seed: 1 });
    expect(result.showsMore).toEqual({ whole: 0, stream: 0, stored: 0, reread: 0 });
    expect(result.info.hidesMore).toBe(1);
  });

  it('cuts a row the same way for the same seed, inside its text', () => {
    const text = 'token=FAKEone note';
    expect(cutsFor(3, text, 2)).toEqual(cutsFor(3, text, 2));
    for (const cuts of cutsFor(3, text, 4)) {
      expect(cuts).toEqual([...cuts].sort((a, b) => a - b));
      for (const cut of cuts) expect(cut).toBeGreaterThanOrEqual(0);
      for (const cut of cuts) expect(cut).toBeLessThanOrEqual(text.length);
    }
  });
});

describe('the generators', () => {
  for (const [name, generator] of Object.entries(GENERATORS)) {
    // Some seats' generators hold a secret in a fifth of their rows (`credentials/parts`).
    it(`${name}: the same distinct rows for a seed, a tenth or more holding a secret`, () => {
      const rows = generator(mulberry32(7), 200);
      expect(generator(mulberry32(7), 200)).toEqual(rows);
      expect(rows.length).toBe(200);
      expect(new Set(rows.map((row) => row.t)).size).toBe(rows.length);
      const holding = rows.filter((row) => secretPlaces(row).includes(1)).length;
      expect(holding).toBeGreaterThanOrEqual(rows.length / 10);
    });
  }
});

/** Every string a JSON value holds, at any depth. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(strings);
}
const jsonUnescape = (chars: string): string => JSON.parse(`"${chars}"`) as string;

/** The JSON document `formats/json-in-string` wrote inside its string. */
function innerDocument(t: string): unknown {
  const payload = /^request payload="(.*)" status=200$/s.exec(t);
  const outer = payload
    ? jsonUnescape(payload[1] as string)
    : (strings(JSON.parse(t)).find((s) => s.includes('{')) as string);
  return JSON.parse(outer.slice(outer.indexOf('{'), outer.lastIndexOf('}') + 1));
}

describe('the real-format corpus', () => {
  const rowsOf = (name: string) =>
    (GENERATORS[name] as (typeof GENERATORS)[string])(mulberry32(7), 300);

  for (const name of CORPUS) {
    it(`${name}: spans in order, apart, inside the text, on one line`, () => {
      for (const row of rowsOf(name)) {
        const spans = row.spans ?? [];
        expect(spans.length).toBeGreaterThan(0);
        let end = 0;
        for (const [start, stop] of spans) {
          expect(start).toBeGreaterThanOrEqual(end);
          expect(stop).toBeGreaterThan(start);
          expect(stop).toBeLessThanOrEqual(row.t.length);
          expect(row.t.slice(start, stop)).not.toContain('\n');
          end = stop;
        }
      }
    });
  }

  it('formats/json: each span is a value of the document, as JSON writes it', () => {
    for (const row of rowsOf('formats/json')) {
      const values = strings(JSON.parse(row.t));
      for (const [start, stop] of row.spans ?? []) {
        expect(values).toContain(jsonUnescape(row.t.slice(start, stop)));
      }
    }
  });

  it('formats/json-in-string: each span is a value of the document inside the string', () => {
    for (const row of rowsOf('formats/json-in-string')) {
      const values = strings(innerDocument(row.t));
      for (const [start, stop] of row.spans ?? []) {
        expect(values).toContain(jsonUnescape(jsonUnescape(row.t.slice(start, stop))));
      }
    }
  });

  it('names its secrets with names the name rules know, in every spelling it writes', () => {
    for (const name of SECRET_NAMES) {
      const camel = name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      for (const spelling of [name, name.toUpperCase(), name.replace(/_/g, '-'), camel]) {
        expect(namesASecretValue(spelling), spelling).toBe(true);
      }
    }
  });
});
