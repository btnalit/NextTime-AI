import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, GENERATORS } from './generators/index.js';

/** What one run reads: which generators, with which seeds, how many rows each, against which
 *  release. `run.mjs` passes them as `FUZZ_*`; unset, they are CI's sample (design doc §7 stage 1a:
 *  2,000 rows each, two seeds, against the last release). */
export interface Settings {
  readonly tag: string;
  readonly generators: readonly string[];
  readonly seeds: readonly number[];
  readonly rows: number;
  /** Stream cut sets per row. */
  readonly cutSets: number;
  /** A directory to write the run's report into, as JSON, one file a group of generators. */
  readonly report?: string;
}

export const CI_SAMPLE = { seeds: [7, 8], rows: 2_000, cutSets: 2 } as const;

/** With no `FUZZ_TAG` (Vitest run by hand): the version release-please last wrote, as its tag.
 *  `run.mjs` passes the newest release tag not newer than that, which a release PR needs. */
export function lastRelease(): string {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../../.release-please-manifest.json'), 'utf8'),
  ) as Record<string, string>;
  const version = manifest['.'];
  if (version === undefined) throw new Error('.release-please-manifest.json has no "." version');
  return `v${version}`;
}

const list = (value: string | undefined): string[] | undefined =>
  value === undefined || value.trim() === ''
    ? undefined
    : value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');

export function settings(env: NodeJS.ProcessEnv = process.env): Settings {
  const generators = list(env.FUZZ_GENERATORS) ?? Object.keys(GENERATORS);
  for (const name of generators) {
    if (!(name in GENERATORS)) throw new Error(`no generator ${name}`);
  }
  const seeds = list(env.FUZZ_SEEDS)?.map(Number) ?? [...CI_SAMPLE.seeds];
  if (seeds.some((seed) => !Number.isInteger(seed))) throw new Error('FUZZ_SEEDS: whole numbers');
  const rows = env.FUZZ_ROWS === undefined ? CI_SAMPLE.rows : Number(env.FUZZ_ROWS);
  if (!Number.isInteger(rows) || rows < 1) throw new Error('FUZZ_ROWS: a whole number above 0');
  const cutSets = env.FUZZ_CUT_SETS === undefined ? CI_SAMPLE.cutSets : Number(env.FUZZ_CUT_SETS);
  if (!Number.isInteger(cutSets) || cutSets < 0) throw new Error('FUZZ_CUT_SETS: 0 or more');
  return {
    tag: env.FUZZ_TAG?.trim() || lastRelease(),
    generators,
    seeds,
    rows,
    cutSets,
    report: env.FUZZ_REPORT?.trim() || undefined,
  };
}

/** Whether a run reads CI's sample of the corpus, which the corpus baseline was taken on. */
export const readsCiSample = (s: Settings): boolean =>
  s.rows === CI_SAMPLE.rows &&
  s.cutSets === CI_SAMPLE.cutSets &&
  s.seeds.length === CI_SAMPLE.seeds.length &&
  s.seeds.every((seed, i) => seed === CI_SAMPLE.seeds[i]);

export { CORPUS };
