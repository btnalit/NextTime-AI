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

/** The modules' paths inside a release's sources: the three it is read with, and its frozen copy
 *  of v0.70.0's rules, which it reads every text with as well (its floor). */
const VALUES = 'packages/kernel/src/substrate/redaction/secret-values.ts';
const FROZEN = 'packages/kernel/src/substrate/redaction/secret-values-v0.70.0.ts';
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

/** The lists a release's rules are read from, in its file and in its frozen v0.70.0 copy. */
const RULE_LISTS = ['SECRET_VALUE_PATTERNS', 'STORED_REWRITE_SECRET_PATTERNS'] as const;

/** A rule's expression, as a release's file has it: a bare `RegExp`, or a rule object's
 *  `pattern`; none for any other kind of rule. */
const expressionOf = (rule: unknown): RegExp | undefined => {
  if (rule instanceof RegExp) return rule;
  const pattern = (rule as { pattern?: unknown } | null)?.pattern;
  return pattern instanceof RegExp ? pattern : undefined;
};

/** Whether `rule` is one of this checkout's floor exceptions: the same expression, flags and all. */
const isException = (rule: unknown): boolean => {
  const expression = expressionOf(rule);
  return (
    expression !== undefined &&
    values.FLOOR_EXCEPTIONS.some(
      (exception) =>
        exception.pattern.source === expression.source &&
        exception.pattern.flags === expression.flags,
    )
  );
};

/**
 * Takes this checkout's floor exceptions (`FLOOR_EXCEPTIONS`, secret-values.ts) out of `module`'s
 * rule lists, in place, and says how many it took from each. A floor exception is a rule this
 * checkout no longer holds itself to, each a decision of its own (legacy 906 step 2: the bare
 * shape of a platform API key minted before the prefix): what the release hid only by it, this
 * checkout may show. So the release is read without it — in its own lists and in its floor's — and
 * held to the rest as before. In place, because the release's functions read the lists they were
 * written with; its lists are built when its file loads, and are read only after.
 */
export function withoutFloorExceptions(module: object, file: string): Record<string, number> {
  const taken: Record<string, number> = {};
  for (const name of RULE_LISTS) {
    const list = (module as Record<string, unknown>)[name];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((rule) => !isException(rule));
    if (kept.length === list.length) continue;
    taken[`${file} ${name}`] = list.length - kept.length;
    list.splice(0, list.length, ...kept);
  }
  return taken;
}

/** What `released` took out of the releases it read (`withoutFloorExceptions`), per file and
 *  list: printed with the run's table, and pinned by harness.test.ts. */
export const releaseLessExceptions = new Map<string, number>();

/** The reader of the release `tag`, from its sources under `BASELINE_ROOT` — its kernel modules
 *  (the tool-call record's too) with its own `@nexttime/shared` (vitest.config.ts sends that
 *  import there) — read without this checkout's floor exceptions (`withoutFloorExceptions`). */
export async function released(tag: string): Promise<Reader> {
  const { dir, present } = baselineAt(tag);
  if (!present)
    throw new Error(`no sources of ${tag} under ${dir}: run test/redaction-fuzz/run.mjs`);
  const v = (await import(join(dir, VALUES))) as ValuesModule;
  const s = (await import(join(dir, STREAM))) as StreamModule;
  const r = (await import(join(dir, RECORDS))) as RecordModule;
  // A release before the floor (v0.70.0 itself) has no frozen copy: only its own lists.
  const frozen = existsSync(join(dir, FROZEN)) ? ((await import(join(dir, FROZEN))) as object) : {};
  for (const [list, count] of Object.entries({
    ...withoutFloorExceptions(v, 'secret-values.ts'),
    ...withoutFloorExceptions(frozen, 'secret-values-v0.70.0.ts'),
  }))
    releaseLessExceptions.set(`${tag} ${list}`, count);
  return readerOf(v, s, r);
}
