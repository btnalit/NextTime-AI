import { readFileSync, writeFileSync } from 'node:fs';

/**
 * e2e/00-gates/ratchet.ts: the shrink-only baseline mechanism `content.spec.ts` uses for both the
 * axe gate and the copy guard (F5, development-tasks.md §5e: "已有问题进 baseline … baseline 只收紧
 * 不放宽"). Two JSON files, one shape each (see their own header comments) — this module only
 * knows how to load/save/diff either one generically:
 *
 * - `UPDATE_BASELINE=1` (env — set by `.github/workflows/e2e.yml`'s `workflow_dispatch` "update
 *   baselines" path): every gate test *writes* its current findings into the file instead of
 *   comparing, so a maintainer reviewing a regenerated baseline sees the real, current state of
 *   the console rather than a hand-typed guess.
 * - otherwise: compare current findings against the committed file. A finding not already present
 *   (a genuinely new key, or an existing key's count grown past its baseline) fails the test with
 *   a message naming exactly what is new. A finding that is *absent* from what the baseline
 *   recorded (fixed, or the count shrank) never fails — the baseline only shrinks from here, via a
 *   deliberate re-run of the update path once a fix lands (see docs/runbooks/web-console.md "UX 门
 *   槛基线" for the exact procedure).
 */

export const UPDATE_BASELINE = process.env.E2E_GATE_UPDATE_BASELINE === '1';

export function loadJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
