import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * substrate/redaction/tail-check.guard.test (pure, no DB) — redaction boundary stage 1b: the tail
 * check composes with the value patterns everywhere they read (`RedactSecretsOptions.tailCheck`
 * defaults to true), and the one reading without it is the scrub report's, which tells what the
 * check adds to a stored row («收尾未证明», application/platform/scrub-raw-secrets.ts). So:
 *
 *  1. `tailCheck` is named in production code only by the redactor that defines it and the few
 *     functions that pass it on unchanged, and by the scrub report.
 *  2. None of those passes it on as `false` of its own accord: only the scrub report writes the
 *     literal, or the variable it reads both ways with.
 *
 * A new reader without the check changes rule 1's list in review, with the reason.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Define the option, or pass the caller's on as it came. */
const FORWARDERS = [
  'substrate/redaction/secret-values.ts', // `RedactSecretsOptions.tailCheck`, `scrubSecretValues`
  'governance/redaction/credential-review.ts', // `SuspectedSecretsOptions`, `redactedForAudit`
  'governance/approval/execution.ts', // `resultAuditFields`, `reasonAuditFields`
  'substrate/graph/scrub-properties.ts', // `scrubGraphProperties`
];
/** Reads a stored row both with the check and without it. */
const SCRUB_REPORT = 'application/platform/scrub-raw-secrets.ts';

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const NAMES_IT = /\btailCheck\b/;
/** `tailCheck: false`, or `tailCheck` given a value that is not the caller's own option. */
const TURNS_IT_OFF = /\btailCheck\s*:\s*false\b|\btailCheck\s*=\s*false\b/;

describe('the tail check is turned off only by the scrub report', () => {
  const files = productionFiles(SRC).map((file) => ({
    rel: path.relative(SRC, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }));

  it('is named only where it is defined, passed on, or read both ways', () => {
    const naming = files.filter((file) => NAMES_IT.test(file.text)).map((file) => file.rel);
    expect(naming.sort()).toEqual([...FORWARDERS, SCRUB_REPORT].sort());
  });

  it('is turned off by the scrub report alone', () => {
    const off = files.filter((file) => TURNS_IT_OFF.test(file.text)).map((file) => file.rel);
    expect(off).toEqual([SCRUB_REPORT]);
  });
});
