import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as stream from '../../src/governance/redaction/secret-stream.js';
import * as values from '../../src/substrate/redaction/secret-values.js';
import { type Reader, type StreamModule, type ValuesModule, readerOf } from './measure.js';

/** This checkout's reader. */
export const current: Reader = readerOf(values, stream);

/** Where a release's sources are put to read it (`run.mjs` puts them there; gitignored). */
export const BASELINE_ROOT = join(import.meta.dirname, '.baseline');

/** The two modules' paths inside a release's sources. */
const VALUES = 'packages/kernel/src/substrate/redaction/secret-values.ts';
const STREAM = 'packages/kernel/src/governance/redaction/secret-stream.ts';

/** Where `tag`'s sources are, and whether they are there. */
export function baselineAt(tag: string): { dir: string; present: boolean } {
  const dir = join(BASELINE_ROOT, tag);
  return { dir, present: existsSync(join(dir, VALUES)) && existsSync(join(dir, STREAM)) };
}

/** The reader of the release `tag`, from its sources under `BASELINE_ROOT` — its kernel modules
 *  with its own `@nexttime/shared` (vitest.config.ts sends that import there). */
export async function released(tag: string): Promise<Reader> {
  const { dir, present } = baselineAt(tag);
  if (!present)
    throw new Error(`no sources of ${tag} under ${dir}: run test/redaction-fuzz/run.mjs`);
  const v = (await import(join(dir, VALUES))) as ValuesModule;
  const s = (await import(join(dir, STREAM))) as StreamModule;
  return readerOf(v, s);
}
