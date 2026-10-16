import { expect, test } from '@playwright/test';
import { OWNER_API_KEY, loginAsOwner } from './lib/auth.js';

/**
 * e2e/approval-failure-reason.spec.ts — legacy 339, UX acceptance of #614 (MUST-1): a long failure
 * reason starts folded to a few lines and 「展开全部」 really unfolds it. The unit tests could only
 * see the class name (jsdom computes no layout); the fold silently did nothing because the
 * `line-clamp-4` utility was outside Tailwind's scanned sources, so this measures the rendered
 * height at the phone width UX checks (390).
 *
 * No failed request with a long reason exists on the CI stack (its gates never fail one), so the
 * request is a stand-in: `get_action` is answered in the browser (`page.route`, as
 * journeys/02-connect-system.spec.ts does for its preview) with a failed row whose reason is the
 * longest the kernel sends (1000 code points, `failureReasonTruncated`). Everything else on the
 * page is the real stack.
 */

const ID = '33900000-0000-4000-8000-000000000339';
const GATE = '33900000-0000-4000-8000-0000000003a9';
const REASON = `apply_timeout: ${Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the gate's diagnostic output`).join('\n')}`;

test.describe('legacy 339: a long failure reason folds and unfolds', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  test('at 390 the folded reason is much shorter than the unfolded one', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/cap/get_action', async (route) => {
      const now = new Date().toISOString();
      await route.fulfill({
        json: {
          ok: true,
          result: {
            id: ID,
            status: 'failed',
            gatekeeperId: GATE,
            actionKindTag: 'e2e.legacy_339',
            resourceScope: null,
            blastRadius: 'medium',
            policyDecision: 'require_approval',
            approvalDecisionId: null,
            awaitDecision: true,
            onBehalfOf: '33900000-0000-4000-8000-0000000003b9',
            parentWorkerRunId: null,
            actorRuntime: 'pi',
            params: {},
            requestedAt: now,
            executingAt: now,
            executedAt: null,
            failedAt: now,
            failureKind: 'outcome_unknown',
            requesterCanApprove: false,
            decisionReason: null,
            decidedBy: null,
            decidedAt: null,
            outcomeInDoubt: null,
            queuedBehind: null,
            failureReason: `${REASON.slice(0, 999)}…`,
            failureReasonTruncated: true,
          },
        },
      });
    });

    await loginAsOwner(page);
    await page.goto(`/#/work/approvals/${ID}`);

    const text = page.getByTestId('approval-failure-reason-text');
    await expect(text).toBeVisible({ timeout: 15_000 });
    await expect(text).toHaveAttribute('data-folded', '');
    const folded = (await text.boundingBox())?.height ?? 0;

    await page.getByTestId('approval-failure-reason-toggle').click();
    await expect(text).not.toHaveAttribute('data-folded', '');
    const unfolded = (await text.boundingBox())?.height ?? 0;

    // Four lines of the reason (plus its lead-in) against forty: folded must be a small fraction.
    expect(folded).toBeGreaterThan(0);
    expect(folded * 3).toBeLessThan(unfolded);
    await expect(page.getByTestId('approval-failure-reason-truncated')).toBeVisible();

    await page.getByTestId('approval-failure-reason-toggle').click();
    await expect(text).toHaveAttribute('data-folded', '');
    expect((await text.boundingBox())?.height ?? 0).toBeCloseTo(folded, 0);
  });
});
