import { describe, expect, it } from 'vitest';
import { STREAM_HOLD_MAX_CHARS } from '../../src/governance/redaction/secret-stream.js';
import { namesASecretValue } from '../../src/substrate/redaction/secret-values.js';
import { CORPUS, GENERATORS } from './generators/index.js';
import { SECRET_NAMES } from './generators/real-formats.js';
import {
  DENSE_STEP_MAX,
  MASK,
  type Reader,
  compare,
  cutsFor,
  keptChars,
  shown,
  shownInRuns,
  shownThrough,
} from './measure.js';
import { mulberry32 } from './rng.js';
import { type Generator, type Row, secretPlaces } from './row.js';

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

describe('shownInRuns: the secret characters an output holds, read without lining it up', () => {
  const secret = 'FAKEabcdefghijklmnop';
  const row: Row = { t: `API_TOKEN=${MASK}"${secret}\\"`, req: [secret], stored: true };
  const places = secretPlaces(row);
  const count = (output: string) => [...shownInRuns(row, places, output)].filter((x) => x).length;

  it('counts none where no run of 8 of the secret is in the output, however it was rewritten', () => {
    expect(count(`API_TOKEN=\\"${MASK}\\"`)).toBe(0);
    expect(count(`API_TOKEN=${MASK}"FAKEabc${MASK}`)).toBe(0);
  });

  it('counts the characters of each run of 8 the output holds', () => {
    expect(count(row.t)).toBe(secret.length);
    expect(count(`x ${secret.slice(0, 8)} y`)).toBe(8);
    expect(count(`${secret.slice(0, 8)}${MASK}${secret.slice(-8)}`)).toBe(16);
  });

  it('reads a secret shorter than 8 whole', () => {
    const short: Row = { t: 'k=FAKEx', req: ['FAKEx'], stored: true };
    expect([...shownInRuns(short, secretPlaces(short), 'k=FAKEx')].filter((x) => x).length).toBe(5);
    expect([...shownInRuns(short, secretPlaces(short), 'k=FAKE')].filter((x) => x).length).toBe(0);
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
    return {
      whole: read,
      stream: (text) => hide(text),
      stored: read,
      record: hide,
      recordRewrite: read,
      recordUnproven: () => false,
    };
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

  it('counts rows whose stream is not their whole text, a stream that hides more included', () => {
    const plain = masking('FAKEone');
    const hidingMore: Reader = {
      ...plain,
      stream: (text, cuts) => plain.stream(text, cuts).replace('note', MASK),
    };
    const result = compare(rows, hidingMore, plain, { seed: 1 });
    expect(result.showsMore).toEqual({ whole: 0, stream: 0, stored: 0, reread: 0 });
    expect(result.streamDiffers).toEqual({ now: 1, before: 0 });
    expect(result.examples.streamNotWhole?.[0]?.now).toBe(`token=${MASK} ${MASK}`);
    expect(compare(rows, plain, hidingMore, { seed: 1 }).streamDiffers).toEqual({
      now: 0,
      before: 1,
    });
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

  it('cuts a row densely once more, every 1–4 characters, as textDeltas come', () => {
    const text = 'token=FAKEone note, and a longer tail after it';
    expect(cutsFor(3, text, 0)).toEqual([]);
    const sets = cutsFor(3, text, 2);
    expect(sets.length).toBe(3);
    const dense = sets[2] as number[];
    const steps = [...dense, text.length].map(
      (cut, i) => cut - (i === 0 ? 0 : (dense[i - 1] as number)),
    );
    for (const step of steps.slice(0, -1)) expect(step).toBeGreaterThanOrEqual(1);
    for (const step of steps) expect(step).toBeLessThanOrEqual(DENSE_STEP_MAX);
    expect(new Set(steps.slice(0, -1)).size).toBeGreaterThan(1);
  });

  it('reads a stored row with the stored reading alone, from the row itself', () => {
    const stored: Row = { t: `password=${MASK}"FAKEthree\\" x`, req: ['FAKEthree'], stored: true };
    const repairing: Reader = {
      whole: () => {
        throw new Error('a stored row is not read whole');
      },
      stream: () => {
        throw new Error('a stored row is not streamed');
      },
      stored: (text) => ({ value: text.replace('"FAKEthree\\"', ''), redactedValues: 1 }),
      record: () => {
        throw new Error('a stored row is not a record');
      },
      recordRewrite: () => {
        throw new Error('a stored row is not a record');
      },
      recordUnproven: () => {
        throw new Error('a stored row is not a record');
      },
    };
    const asWritten: Reader = {
      ...repairing,
      stored: (text) => ({ value: text, redactedValues: 0 }),
    };
    const worse = compare([stored], asWritten, repairing, { seed: 1 });
    expect(worse.showsMore).toEqual({ whole: 0, stream: 0, stored: 1, reread: 0 });
    expect(worse.info.showing).toEqual({ now: 1, before: 0 });
    const same = compare([stored], repairing, repairing, { seed: 1 });
    expect(same.showsMore).toEqual({ whole: 0, stream: 0, stored: 0, reread: 0 });
  });

  it('reads the upgrade rewrite of what the release wrote by runs where it does not line up (review #501 on #1639)', () => {
    // The release kept the value after a mask, then its rewrite on upgrade wrote it whole
    // (`[redacted]"…\"` to `\"[redacted]\"`), which is not what it read with stretches masked.
    const row: Row = { t: 'run --password x"FAKEfourVALUE\\" done', req: ['FAKEfourVALUE'] };
    const reader = (whole: (text: string) => string, stored: (text: string) => string): Reader => {
      const read = (f: (text: string) => string) => (text: string) => {
        const value = f(text);
        return { value, redactedValues: value === text ? 0 : 1 };
      };
      return {
        whole: read(whole),
        stream: whole,
        stored: read(stored),
        record: whole,
        recordRewrite: read(whole),
        recordUnproven: () => false,
      };
    };
    const release = reader(
      (text) => text.replace('x"', `${MASK}"`),
      (text) => text.replace(`${MASK}"FAKEfourVALUE\\"`, `\\"${MASK}\\"`),
    );
    const leaving = reader(
      (text) => text.replace('x"FAKEfourVALUE\\" done', MASK),
      (text) => text,
    );
    const worse = compare([row], leaving, release, { seed: 1 });
    expect(worse.showsMore).toEqual({ whole: 0, stream: 0, stored: 1, reread: 0 });
    const same = compare([row], release, release, { seed: 1 });
    expect(same.showsMore).toEqual({ whole: 0, stream: 0, stored: 0, reread: 0 });
  });

  it('reads a record row as records, holding the rewrite on upgrade to its rules (review #501 on #1629)', () => {
    const row: Row = { t: '{"stdout": "token=FAKEfour more', req: ['FAKEfour'], record: true };
    const unread = () => {
      throw new Error('a record row is read as a record');
    };
    const hide = (text: string) => text.replace('FAKEfour', MASK);
    const keep = (text: string) => ({ value: text, redactedValues: 0 });
    const rewrite = (to: (text: string) => string) => (text: string) => {
      const value = to(text);
      return { value, redactedValues: value === text ? 0 : 1 };
    };
    // The release: its record keeps the secret, and so does its rewrite.
    const release: Reader = {
      whole: unread,
      stream: unread,
      stored: unread,
      record: (text) => text,
      recordRewrite: keep,
      recordUnproven: () => false,
    };
    // Stores it hidden, and rewrites the release's record to hide it.
    const fixed: Reader = { ...release, record: hide, recordRewrite: rewrite(hide) };
    const better = compare([row], fixed, release, { seed: 1 });
    expect(better.showsMore).toEqual({ whole: 0, stream: 0, stored: 0, reread: 0 });
    expect(better.records).toEqual({ twice: 0, needless: 0, left: 0 });
    expect(better.info.rewrites).toEqual({ now: 1, before: 0 });
    expect(better.info.hidesMore).toBe(1);
    const at = (now: Reader, before: Reader, rows = [row]) =>
      compare(rows, now, before, { seed: 1 });
    // Its rewrite showing what the release's rewrite hid: the stored gate.
    const hiding: Reader = { ...release, recordRewrite: rewrite(hide) };
    expect(at({ ...fixed, recordRewrite: keep }, hiding).showsMore.stored).toBe(1);
    // The record it stores showing what the release's record hid: the whole gate.
    expect(
      at({ ...fixed, record: (text) => text }, { ...release, record: hide }).showsMore.whole,
    ).toBe(1);
    // A rewrite that changes what it wrote, on every upgrade again.
    const growing: Reader = { ...fixed, recordRewrite: rewrite((text) => `${text}.`) };
    expect(at(growing, release).records.twice).toBe(1);
    // A rewrite that changes a record and hides nothing of the secret.
    const other = rewrite((text) => text.replace(' more', ' [x]'));
    const elsewhere: Reader = { ...fixed, record: (text) => hide(text).replace(' more', ' [x]') };
    expect(at({ ...elsewhere, recordRewrite: other }, release).records.needless).toBe(1);
    // One that hides it and the cut's note with it.
    const cut: Row = {
      t: `${row.t}\n\n[... 3 more characters omitted — the full result is not shown ...]`,
      req: ['FAKEfour'],
      record: true,
    };
    const toTheEnd = (text: string) => text.replace(/FAKEfour[\s\S]*$/, MASK);
    const eating: Reader = { ...fixed, record: toTheEnd, recordRewrite: rewrite(toTheEnd) };
    expect(at(eating, release, [cut]).records).toEqual({ twice: 0, needless: 1, left: 0 });
    // A record still showing a secret once rewritten: counted as 收尾未证明 or not.
    expect(at(release, release).records.left).toBe(1);
    const counted = at({ ...release, recordUnproven: () => true }, release);
    expect(counted.records.left).toBe(1);
    expect(counted.info.recordsUnproven).toBe(1);
  });
});

describe('the generators', () => {
  for (const [name, generator] of Object.entries(GENERATORS)) {
    // Some seats' generators hold a secret in a fifth of their rows (`credentials/parts`).
    it(`${name}: the same distinct rows for a seed, a tenth or more holding a secret`, () => {
      const rows = generator(mulberry32(7), 200);
      expect(generator(mulberry32(7), 200)).toEqual(rows);
      expect(rows.length).toBe(Math.min(200, generator.maxRows ?? 200));
      expect(new Set(rows.map((row) => row.t)).size).toBe(rows.length);
      const holding = rows.filter((row) => secretPlaces(row).includes(1)).length;
      expect(holding).toBeGreaterThanOrEqual(rows.length / 10);
    });
  }
});

describe('the stored rows', () => {
  const storedNames = Object.keys(GENERATORS).filter(
    (key) => key.startsWith('stored/') && !key.startsWith('stored/records-'),
  );
  for (const name of storedNames) {
    it(`${name}: every row stored, a mask in it, its secret after the mask`, () => {
      for (const row of (GENERATORS[name] as (typeof GENERATORS)[string])(mulberry32(7), 300)) {
        expect(row.stored).toBe(true);
        expect(row.t).toContain(MASK);
        for (const secret of row.req ?? []) {
          expect(row.t.indexOf(secret)).toBeGreaterThan(row.t.indexOf(MASK));
        }
      }
    });
  }

  it('none outside stored/', () => {
    for (const [name, generator] of Object.entries(GENERATORS)) {
      if (name.startsWith('stored/')) continue;
      expect(
        generator(mulberry32(7), 50).some((row) => row.stored === true || row.record === true),
        name,
      ).toBe(false);
    }
  });
});

describe('the record rows (review #501 on #1629)', () => {
  const NOTE =
    /\n\n\[\.\.\. (\d+) more characters omitted — the full result is not shown \.\.\.\]$/;
  const rows = (name: string) => (GENERATORS[name] as Generator)(mulberry32(7), 300);
  /** The text before the note, the note's count, and whether the cut left a string open. */
  const cutOf = (t: string) => {
    const note = NOTE.exec(t);
    const head = note === null ? t : t.slice(0, note.index);
    let open = false;
    for (let i = 0; i < head.length; i += 1) {
      if (head[i] === '\\' && open) i += 1;
      else if (head[i] === '"') open = !open;
    }
    return { head, omitted: note === null ? 0 : Number(note[1]), open };
  };

  it('cut-after-value: cut inside the string, the secret whole and closed before the cut', () => {
    for (const row of rows('stored/records-cut-after-value')) {
      expect(row.record).toBe(true);
      const { head, omitted, open } = cutOf(row.t);
      const secret = row.req?.[0] as string;
      expect(omitted).toBeGreaterThan(0);
      expect(open).toBe(true);
      expect(head).toContain(secret);
      expect(head).not.toContain(MASK);
    }
  });

  it('cut-in-value: cut inside the value, 8 or more of its characters kept', () => {
    for (const row of rows('stored/records-cut-in-value')) {
      const { head, omitted, open } = cutOf(row.t);
      const kept = row.req?.[0] as string;
      expect(omitted).toBeGreaterThan(0);
      expect(open).toBe(true);
      expect(kept.length).toBeGreaterThanOrEqual(8);
      expect(head.endsWith(kept) || head.endsWith(`${kept}\\`)).toBe(true);
    }
  });

  it('cut-elsewhere: not cut, cut with the string closed, or cut before the value', () => {
    const kinds = new Set<string>();
    for (const row of rows('stored/records-cut-elsewhere')) {
      const { head, omitted } = cutOf(row.t);
      if (omitted === 0) {
        kinds.add('whole');
        expect(() => JSON.parse(row.t)).not.toThrow();
      } else if ((row.req ?? []).length === 0) {
        kinds.add('before');
        expect(head).not.toContain('FAKE');
      } else {
        kinds.add('closed');
        // The string the secret is in closes before the cut.
        const secret = row.req?.[0] as string;
        let at = head.indexOf(secret) + secret.length;
        while (at < head.length && head[at] !== '"') at += head[at] === '\\' ? 2 : 1;
        expect(at).toBeLessThan(head.length);
      }
    }
    expect([...kinds].sort()).toEqual(['before', 'closed', 'whole']);
  });

  it('open-control: not JSON as written, its last string open, a raw tab or line break in it', () => {
    const kinds = new Set<string>();
    for (const row of rows('stored/records-open-control')) {
      expect(row.record).toBe(true);
      const { head, open } = cutOf(row.t);
      expect(row.t.startsWith('{"')).toBe(true);
      expect(() => JSON.parse(row.t)).toThrow();
      expect(open).toBe(true);
      expect(head).toMatch(/[\t\n\r]/);
      for (const secret of row.req ?? []) expect(head).toContain(secret);
      kinds.add(head.includes('-----BEGIN') ? 'block' : /[\n\r]more/.test(head) ? 'line' : 'pair');
    }
    expect([...kinds].sort()).toEqual(['block', 'line', 'pair']);
  });
});

describe('the long rows and the neighbors (reviews on #1619)', () => {
  const rows = (name: string, n = 2_000) => (GENERATORS[name] as Generator)(mulberry32(7), n);

  it('long/values: a value of 3,500 characters or more, after a head longer than 8', () => {
    const long = rows('long/values');
    expect(long.length).toBe(6);
    for (const row of long) {
      const [secret] = row.req ?? [];
      expect(secret?.length).toBeGreaterThanOrEqual(3_500);
      expect(row.t.indexOf(secret as string)).toBeGreaterThan(8);
    }
    // Past the stream's bound as well, in the rows a run reads.
    const lengths = [7, 8].flatMap((seed) =>
      (GENERATORS['long/values'] as Generator)(mulberry32(seed), 6).map(
        (row) => row.req?.[0]?.length ?? 0,
      ),
    );
    expect(Math.max(...lengths)).toBeGreaterThan(STREAM_HOLD_MAX_CHARS);
  });

  it('long/pem: a key body of 1,600 characters or more, from BEGIN to END', () => {
    for (const row of rows('long/pem')) {
      const [[start, end]] = row.spans as [[number, number]];
      expect(end - start).toBeGreaterThanOrEqual(1_600);
      expect(row.t.lastIndexOf('-----BEGIN', start)).toBeGreaterThanOrEqual(0);
      expect(row.t.indexOf('-----END', end)).toBeGreaterThan(end - 1);
    }
  });

  it('credentials/neighbors: what an edit left of a secret counts, 6 characters or more', () => {
    const neighbors = rows('credentials/neighbors');
    for (const row of neighbors) {
      for (const fragment of row.req ?? []) {
        expect(fragment.length).toBeGreaterThanOrEqual(6);
        expect(row.t).toContain(fragment);
      }
    }
    // Only whole secrets counted left more than half the rows measuring nothing (review on #1619).
    const empty = neighbors.filter((row) => (row.req ?? []).length === 0).length;
    expect(empty / neighbors.length).toBeLessThan(0.1);
  });
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
