import type { Page } from '@playwright/test';

/**
 * e2e/lib/determinism.ts: the measures `00-gates/screenshot.spec.ts` (and, for the clock/caret
 * part, `00-gates/content.spec.ts`) takes to make a rendered page reproducible across CI runs —
 * development-tasks.md §5e 风险③ ("固定字体、时间与数据种子"). Three different kinds of
 * non-determinism, three different fixes:
 *
 * 1. Client-side "now" (`formatRelative`'s `Date.now()` default, lib/format.ts) — frozen with
 *    `page.clock.setFixedTime`, called before navigation. This does NOT make an entity's absolute
 *    `createdAt` timestamp stable (that is real wall-clock time from whenever the CI job actually
 *    ran) — it only removes *within-a-test* jitter (a relative-time label flipping from "just now"
 *    to "1m ago" between page load and screenshot capture). Every `<time>` element is masked
 *    regardless (see `MASK_SELECTORS`) — that is what actually absorbs the real per-run
 *    variation.
 * 2. CSS animation/transition/caret — `reducedMotion: 'reduce'` (playwright.config.ts's `use`)
 *    covers everything that already respects `@media (prefers-reduced-motion: reduce)`
 *    (styles/base.css has exactly one such block); `injectMotionKillSwitch` below is the
 *    belt-and-suspenders override for anything that does not.
 * 3. Fonts — `document.fonts.ready` before the first screenshot of a page (self-hosted
 *    `@fontsource/*` packages, no external network fetch to race).
 *
 * What is NOT solved here (documented, not silently ignored): list-length drift from other spec
 * files' fixtures. `00-gates/` is prefixed `00-` so it is the first directory Playwright discovers
 * under `testDir: './e2e'` (alphabetical file discovery — see playwright.config.ts's own doc
 * comment on why file order is load-bearing elsewhere in this suite) and every gate test is
 * read-only against pre-existing fixtures (the two/four ActionRequests and the one announced gate
 * instance `.github/workflows/e2e.yml` seeds *before* the Playwright step) plus whatever each gate
 * test creates for its own "state" screenshot — so at the point gates run, no other spec file has
 * touched the shared `ci-e2e` workspace yet. A retried gate test, or a future spec inserted before
 * `00-gates/` alphabetically, can still perturb this — the mitigation is the `maxDiffPixelRatio`
 * slack on `toHaveScreenshot` (see screenshot.spec.ts's own comment for the current value and why)
 * plus a fixed, non-scrolling viewport height (`fullPage` left at its default `false`) so a longer
 * list only ever grows *below* the captured frame instead of stretching the image.
 */

/** Any fixed instant works — chosen once, must never change (a different value only churns the
 *  baseline images for entities whose absolute timestamp isn't masked, if one is ever missed). */
export const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/** Selectors masked in every `toHaveScreenshot` call — content whose exact text is either real
 *  wall-clock time (survives freezing `page.clock`, see this file's own doc comment) or otherwise
 *  run-dependent. Prefer a stable existing selector/class over a bespoke one per page:
 *  - `time`: every date/relative-time display in this codebase renders inside a `<time>` element
 *    (`lib/format.ts`'s `formatDateTime`/`formatRelative`, verified by grep across `src/` — every
 *    call site wraps its result in `<time>` except two `.mono`/`.text-small` spans, covered below).
 *  - `.copy-id`: `components/ui/CopyId.tsx` — every id-with-copy-button control.
 *  - `[data-testid="kernel-version"]` / `[data-testid="current-user"]`: Sidebar footer — the
 *    running kernel's version string and the signed-in display name are both stable *within* one
 *    CI run but not worth pinning across baseline regenerations.
 *  - `.mono.text-small`: the two audit-timeline rows (PlatformAuditPage.tsx,
 *    PlatformStatusPage.tsx) that format a timestamp directly into a `<span>` instead of `<time>`.
 *  - `[data-volatile]`: the convention for any other per-run value (a chat's short id in the
 *    composer, a kit RefChip's unresolved short-id fallback) — mark the element, not this list.
 */
export const MASK_SELECTORS = [
  'time',
  '.copy-id',
  '[data-volatile]',
  '[data-testid="kernel-version"]',
  '[data-testid="current-user"]',
  '.mono.text-small',
] as const;

/** Freezes `Date`/`performance.now()` at `FIXED_NOW` — call before the first `page.goto`, so every
 *  render (including the login screen itself) sees the same instant throughout the test.
 *  `setFixedTime` (unlike `install`) leaves real timers alone — the WS reconnect/polling logic
 *  this app relies on keeps working normally. */
export async function freezeClock(page: Page): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW);
}

/** Belt-and-suspenders animation/transition/caret kill-switch, on top of the context-level
 *  `reducedMotion: 'reduce'` (playwright.config.ts) — call once per navigation, after the page has
 *  loaded. Idempotent to call more than once (a fresh `<style>` tag each time, all equivalent). */
export async function injectMotionKillSwitch(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
        caret-color: transparent !important;
      }
    `,
  });
}

/** Waits for every `@fontsource/*` face this app loads to finish rasterising — `toHaveScreenshot`
 *  right after a navigation can otherwise catch a fallback-font layout for one frame. */
export async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

/** The three steps above, in the order that makes them meaningful (clock before anything renders,
 *  fonts/motion once the page has settled) — call after the page has reached its "ready" signal
 *  (the surface's own heading/testid), immediately before capturing. */
export async function settleForCapture(page: Page): Promise<void> {
  await waitForFonts(page);
  await injectMotionKillSwitch(page);
}
