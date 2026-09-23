import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ADMIN_LOGIN, OWNER_API_KEY } from '../lib/auth.js';
import { allPatterns } from './copy-patterns.js';
import { UPDATE_BASELINE, loadJson, saveJson } from './ratchet.js';
import { SURFACES, VIEWPORT_HEIGHT, visitSurface } from './surfaces.js';

/**
 * e2e/00-gates/content.spec.ts: F5's second and third CI gates — axe (serious/critical
 * accessibility violations) and the copy guard (leaked ids/enums/codenames/env vars/runbook
 * paths) — one test per `Surface` (`surfaces.ts`), both checks sharing the single login+navigate
 * each surface needs rather than two separate spec files paying that cost twice (see
 * `determinism.ts`'s own note on keeping `00-gates/` fast). `test.step` keeps the two checks
 * separately named in the report even though they share a test; `expect.soft` lets a copy-guard
 * failure still show the axe result (and vice versa) instead of the first `expect` aborting the
 * test.
 *
 * Ratchet baselines: `axe-baseline.json` (surfaceId -> ruleId -> {count, note}), `copy-guard-
 * baseline.json` (surfaceId -> patternId -> {count} for `uuid`, `{samples}` for every other
 * pattern — see copy-patterns.ts's own doc comment for why `uuid` alone is count-only: a UUID's
 * literal text is different on every CI run, so sample-matching it would never stay green).
 * `E2E_GATE_UPDATE_BASELINE=1` switches every test from "compare, fail on new" to "overwrite this
 * surface's entry with what is on screen right now" — see ratchet.ts's own doc comment and
 * docs/runbooks/web-console.md "UX 门槛基线" for the regenerate-and-commit procedure.
 */

const AXE_BASELINE_PATH = fileURLToPath(new URL('./axe-baseline.json', import.meta.url));
const COPY_BASELINE_PATH = fileURLToPath(new URL('./copy-guard-baseline.json', import.meta.url));

interface AxeRuleEntry {
  readonly count: number;
  readonly note?: string;
}
type AxeBaseline = Record<string, Record<string, AxeRuleEntry>>;

interface CopyPatternEntry {
  readonly count?: number; // 'uuid' only
  readonly samples?: readonly string[]; // every other pattern
}
type CopyBaseline = Record<string, Record<string, CopyPatternEntry>>;

test.describe('S8 W1-B content gates: axe + copy guard', () => {
  test.skip(
    !OWNER_API_KEY || !ADMIN_LOGIN,
    'set WEB_E2E_API_KEY, WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD to run this suite (see README.md)',
  );

  for (const surface of SURFACES) {
    test(surface.id, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });
      await visitSurface(page, surface);

      await test.step('axe: serious/critical violations vs ratchet baseline', async () => {
        const baseline = loadJson<AxeBaseline>(AXE_BASELINE_PATH, {});
        const results = await new AxeBuilder({ page })
          .include('body')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        const serious = results.violations.filter(
          (v: (typeof results.violations)[number]) =>
            v.impact === 'serious' || v.impact === 'critical',
        );
        const current: Record<string, AxeRuleEntry> = {};
        for (const v of serious) {
          current[v.id] = { count: v.nodes.length };
        }

        if (UPDATE_BASELINE) {
          const fresh = loadJson<AxeBaseline>(AXE_BASELINE_PATH, {});
          fresh[surface.id] = current;
          saveJson(AXE_BASELINE_PATH, sortedBaseline(fresh));
          return;
        }

        const known = baseline[surface.id] ?? {};
        const newRules: string[] = [];
        for (const [ruleId, entry] of Object.entries(current)) {
          const base = known[ruleId];
          if (base === undefined || entry.count > base.count) {
            newRules.push(
              `${ruleId} (${entry.count} node${entry.count === 1 ? '' : 's'}, baseline ${base?.count ?? 0})`,
            );
          }
        }
        expect
          .soft(
            newRules,
            `new/grown serious+critical axe violations on ${surface.id}: ${newRules.join('; ')}`,
          )
          .toHaveLength(0);
      });

      await test.step('copy guard: leaked ids/enums/codenames/env-vars/runbook paths vs ratchet baseline', async () => {
        const baseline = loadJson<CopyBaseline>(COPY_BASELINE_PATH, {});
        const text = await page.evaluate(() => document.body.innerText);
        const current: Record<string, CopyPatternEntry> = {};
        for (const pattern of allPatterns()) {
          const matches = [...text.matchAll(pattern.regex)].map((m) => m[0]);
          if (matches.length === 0) continue;
          if (pattern.id === 'uuid') {
            current[pattern.id] = { count: matches.length };
          } else {
            const existing = current[pattern.id]?.samples ?? [];
            const samples = [...new Set([...existing, ...matches])].sort();
            current[pattern.id] = { samples };
          }
        }

        if (UPDATE_BASELINE) {
          const fresh = loadJson<CopyBaseline>(COPY_BASELINE_PATH, {});
          fresh[surface.id] = current;
          saveJson(COPY_BASELINE_PATH, sortedBaseline(fresh));
          return;
        }

        const known = baseline[surface.id] ?? {};
        const newHits: string[] = [];
        for (const [patternId, entry] of Object.entries(current)) {
          const base = known[patternId];
          if (patternId === 'uuid') {
            const baseCount = base?.count ?? 0;
            if ((entry.count ?? 0) > baseCount) {
              newHits.push(`uuid (${entry.count} matches, baseline ${baseCount})`);
            }
            continue;
          }
          const baseSamples = new Set(base?.samples ?? []);
          const fresh = (entry.samples ?? []).filter((s) => !baseSamples.has(s));
          if (fresh.length > 0) {
            newHits.push(`${patternId}: ${fresh.join(', ')}`);
          }
        }
        expect
          .soft(newHits, `new copy-guard hits on ${surface.id}: ${newHits.join(' | ')}`)
          .toHaveLength(0);
      });
    });
  }
});

/** Stable key order so a regenerated baseline's git diff is reviewable (only real content
 *  changes, no incidental key reordering). */
function sortedBaseline<T extends Record<string, Record<string, unknown>>>(data: T): T {
  const out: Record<string, Record<string, unknown>> = {};
  for (const surfaceId of Object.keys(data).sort()) {
    const inner = data[surfaceId] ?? {};
    const sortedInner: Record<string, unknown> = {};
    for (const key of Object.keys(inner).sort()) sortedInner[key] = inner[key];
    out[surfaceId] = sortedInner;
  }
  return out as T;
}
