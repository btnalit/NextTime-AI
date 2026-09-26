import { test } from '@playwright/test';
import { OWNER_API_KEY } from '../lib/auth.js';
import { freezeClock, settleForCapture } from '../lib/determinism.js';
import { SURFACES, VIEWPORT_HEIGHT, goToSurface } from './surfaces.js';

/**
 * e2e/00-gates/review-capture.spec.ts: design-review captures, not a gate (design system v2,
 * `design-system/nexttime-ai-console/MASTER.md` pre-delivery checklist). The screenshot gate
 * (`screenshot.spec.ts`) pins the light theme at 1440 / 1280 / 768; a design review also needs the
 * dark theme and a phone width. These captures run only on the `update_baselines` dispatch
 * (`E2E_REVIEW_CAPTURE=1`, set by `.github/workflows/e2e.yml`), write plain PNGs under
 * `test-results/review/` (uploaded with the `playwright-report` artifact) and assert nothing —
 * nothing here can fail a PR.
 *
 * Runs before `screenshot.spec.ts` (file order inside `00-gates/`) and only navigates, so the
 * gate's "empty chat list" precondition for the `chats` surface is untouched.
 */

const REVIEW_CAPTURE = process.env.E2E_REVIEW_CAPTURE === '1';
const REVIEW_SURFACE_IDS = [
  'chats',
  'approvals',
  'agent',
  'systems',
  'members',
  'catalog-skills',
  'platform-overview',
  'platform-integrations',
] as const;
const VARIANTS = [
  { scheme: 'dark', width: 1440 },
  { scheme: 'dark', width: 390 },
  { scheme: 'light', width: 390 },
] as const;

test.describe('design review captures (dark theme, phone width) — artifacts only', () => {
  test.skip(
    !REVIEW_CAPTURE || !OWNER_API_KEY,
    'runs only on the update_baselines dispatch (E2E_REVIEW_CAPTURE=1)',
  );

  for (const id of REVIEW_SURFACE_IDS) {
    const surface = SURFACES.find((candidate) => candidate.id === id);
    if (!surface) continue;
    test(`review ${id}`, async ({ page }) => {
      test.slow();
      await freezeClock(page);
      await goToSurface(page, surface);
      await settleForCapture(page);
      for (const variant of VARIANTS) {
        await page.emulateMedia({ colorScheme: variant.scheme });
        await page.setViewportSize({ width: variant.width, height: VIEWPORT_HEIGHT });
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
        );
        await page.screenshot({
          path: `test-results/review/${id}-${variant.scheme}-${variant.width}.png`,
          animations: 'disabled',
          caret: 'hide',
        });
      }
      await page.emulateMedia({ colorScheme: 'light' });
    });
  }
});
