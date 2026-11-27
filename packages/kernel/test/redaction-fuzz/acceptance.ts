import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GENERATORS } from './generators/index.js';
import { type Comparison, compare } from './measure.js';
import { baselineAt, current, released } from './readers.js';
import { mulberry32 } from './rng.js';
import { CORPUS, readsCiSample, settings } from './settings.js';

/**
 * The redaction acceptance run (design doc `docs/redaction-boundary-design-2026-11-27.md` §4.4,
 * §7 stage 1a, §8), for one group of generators — `acceptance-<group>.test.ts`, one file a group,
 * so that Vitest reads the groups side by side:
 *
 * 1. Not more shown than the last release (I-R1): on every generator's rows, no secret character
 *    this checkout shows that the release hid — whole text, live stream at the same cuts, rows the
 *    release stored rewritten on upgrade, and the whole reading read again. Threshold 0.
 * 2. The real-format corpus (I-R5): what this checkout shows of the values the formats wrote, held
 *    to `corpus-baseline.json` — no more rows and no more characters than when it was taken. The
 *    design's threshold, 0 characters, is where stage 1b and stage 2 take it; each lowers the file.
 *
 * Run by `run.mjs` (README.md), which puts the release's sources where `readers.ts` reads them.
 */

export interface Result extends Comparison {
  readonly generator: string;
  readonly seed: number;
}

/** `corpus-baseline.json`: per format, on CI's sample, what this checkout's whole reading showed. */
interface CorpusBaseline {
  readonly note: string;
  readonly formats: Record<string, { readonly rowsShowing: number; readonly shownChars: number }>;
}

const examplesOf = (comparison: Comparison): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(comparison.examples).filter(([, examples]) => examples.length > 0),
    ),
    null,
    2,
  );

const COLUMNS: [string, number, (r: Result) => string][] = [
  ['generator', -28, (r) => r.generator],
  ['seed', 6, (r) => String(r.seed)],
  ['rows', 6, (r) => String(r.rows)],
  ['w/s/st/rr', 10, (r) => Object.values(r.showsMore).join('/')],
  ['show n:b', 11, (r) => `${r.info.showing.now}:${r.info.showing.before}`],
  ['hides', 6, (r) => String(r.info.hidesMore)],
  ['differ', 7, (r) => String(r.info.differs)],
  [
    'str>w',
    8,
    (r) => `${r.info.streamShowsMoreThanWhole.now}:${r.info.streamShowsMoreThanWhole.before}`,
  ],
  ['reread', 8, (r) => `${r.info.rereadChanges.now}:${r.info.rereadChanges.before}`],
  ['st-own', 8, (r) => `${r.info.storedChangesOwn.now}:${r.info.storedChangesOwn.before}`],
  ['count', 6, (r) => String(r.info.countDisagrees)],
  ['unal', 5, (r) => String(r.info.unaligned)],
];
const cell = (text: string, width: number) =>
  width < 0 ? text.padEnd(-width) : text.padStart(width);

/** The table a run prints: gated columns first, then what it reports. */
export function table(tag: string, results: readonly Result[]): string {
  return [
    `against ${tag}: w/s/st/rr = rows shown now, hidden then (whole/stream/stored/reread), gated at 0.`,
    'Reported: rows showing a secret now:then; hiding more now; whole output differs; stream showing',
    'more than its own whole reading now:then; reread changing; stored rewrite changing its own;',
    'count and text disagreeing; outputs not lined up with their input (counted as showing all).',
    COLUMNS.map(([name, width]) => cell(name, width)).join(' '),
    ...results.map((r) => COLUMNS.map(([, width, value]) => cell(value(r), width)).join(' ')),
  ].join('\n');
}

/** `part` of `parts`: every `parts`-th of the group's generators from the `part`-th, for a group
 *  long enough to read in more than one file. */
export async function acceptance(group: string, part = 1, parts = 1): Promise<void> {
  const run = settings();
  const names = run.generators
    .filter((name) => name.startsWith(`${group}/`))
    .filter((_name, i) => i % parts === part - 1);
  const label = parts === 1 ? group : `${group} ${part}/${parts}`;
  const { present } = baselineAt(run.tag);
  const before = present ? await released(run.tag) : undefined;
  const results: Result[] = [];

  describe(`${label}: not more shown than ${run.tag} (I-R1)`, () => {
    it(`has ${run.tag}'s sources to read`, () => {
      expect(present, `run test/redaction-fuzz/run.mjs to put ${run.tag}'s sources in place`).toBe(
        true,
      );
    });
    for (const name of names) {
      it.skipIf(before === undefined)(name, () => {
        const generator = GENERATORS[name];
        if (generator === undefined || before === undefined) throw new Error(`no ${name}`);
        for (const seed of run.seeds) {
          const rows = generator(mulberry32(seed), run.rows);
          const comparison = compare(rows, current, before, { seed, cutSets: run.cutSets });
          results.push({ generator: name, seed, ...comparison });
          expect
            .soft(
              comparison.showsMore,
              `${name}, seed ${seed}, shown now and hidden in ${run.tag}:\n${examplesOf(comparison)}`,
            )
            .toEqual({ whole: 0, stream: 0, stored: 0, reread: 0 });
        }
      });
    }
  });

  const corpus = names.filter((name) => CORPUS.includes(name));
  if (corpus.length > 0) {
    const recorded = (
      JSON.parse(
        readFileSync(join(import.meta.dirname, 'corpus-baseline.json'), 'utf8'),
      ) as CorpusBaseline
    ).formats;
    describe(`${label}: values the formats wrote (I-R5), held to corpus-baseline.json`, () => {
      for (const name of corpus) {
        it.skipIf(before === undefined || !readsCiSample(run))(name, () => {
          const mine = results.filter((result) => result.generator === name);
          const rowsShowing = mine.reduce((n, result) => n + result.info.showing.now, 0);
          const shownChars = mine.reduce((n, result) => n + result.info.shownChars.now, 0);
          const line = recorded[name];
          expect(line, `${name} has no line in corpus-baseline.json`).toBeDefined();
          expect
            .soft(rowsShowing, `${name}: rows showing a value`)
            .toBeLessThanOrEqual(line?.rowsShowing ?? 0);
          expect
            .soft(shownChars, `${name}: value characters shown`)
            .toBeLessThanOrEqual(line?.shownChars ?? 0);
        });
      }
    });
  }

  afterAll(() => {
    if (results.length === 0) return;
    console.log(table(run.tag, results));
    if (run.report !== undefined) {
      mkdirSync(run.report, { recursive: true });
      writeFileSync(
        join(run.report, `${parts === 1 ? group : `${group}-${part}`}.json`),
        `${JSON.stringify({ settings: run, results }, null, 2)}\n`,
      );
    }
  });
}
