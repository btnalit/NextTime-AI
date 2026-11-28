import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as records from '../../src/application/chat/tool-call-record.js';
import * as stream from '../../src/governance/redaction/secret-stream.js';
import * as values from '../../src/substrate/redaction/secret-values.js';
import {
  type Reader,
  type RecordModule,
  type StreamModule,
  type ValuesModule,
  readerOf,
} from './measure.js';

/** This checkout's reader. */
export const current: Reader = readerOf(values, stream, records as RecordModule);

/** Where a release's sources are put to read it (`run.mjs` puts them there; gitignored). */
export const BASELINE_ROOT = join(import.meta.dirname, '.baseline');

/** The two modules' paths inside a release's sources. */
const VALUES = 'packages/kernel/src/substrate/redaction/secret-values.ts';
const STREAM = 'packages/kernel/src/governance/redaction/secret-stream.ts';
const RECORDS = 'packages/kernel/src/application/chat/tool-call-record.ts';

/** Where `tag`'s sources are, and whether they are there. */
export function baselineAt(tag: string): { dir: string; present: boolean } {
  const dir = join(BASELINE_ROOT, tag);
  return {
    dir,
    present: [VALUES, STREAM, RECORDS].every((path) => existsSync(join(dir, path))),
  };
}

/** The reader of the release `tag`, from its sources under `BASELINE_ROOT` — its kernel modules
 *  (the tool-call record's too) with its own `@nexttime/shared` (vitest.config.ts sends that
 *  import there). */
export async function released(tag: string): Promise<Reader> {
  const { dir, present } = baselineAt(tag);
  if (!present)
    throw new Error(`no sources of ${tag} under ${dir}: run test/redaction-fuzz/run.mjs`);
  const v = (await import(join(dir, VALUES))) as ValuesModule;
  const s = (await import(join(dir, STREAM))) as StreamModule;
  const r = (await import(join(dir, RECORDS))) as RecordModule;
  return readerOf(v, s, r);
}
