import { type Page, expect, test } from '@playwright/test';
import { OWNER_API_KEY, loginAsOwner } from '../lib/auth.js';
import { MASK_SELECTORS, freezeClock, settleForCapture } from '../lib/determinism.js';
import { SURFACES, VIEWPORT_HEIGHT, WIDTHS, goToSurface } from './surfaces.js';

/**
 * e2e/00-gates/screenshot.spec.ts: F5's first CI gate — three-width screenshot regression
 * (development-tasks.md §5e F5) over every `Surface` (`surfaces.ts`) plus the two "key states"
 * item 1 of the W1-B task calls out by name: an approval pending, a chat with a reply.
 *
 * One test per surface/state — login once, settle once, then three `toHaveScreenshot` calls (one
 * per width in `WIDTHS`), `expect.soft` so a diff at one width doesn't hide diffs at the other two
 * in the same test's report.
 *
 * Ordering: the 'chats' surface must be captured with an empty chat list — true only *before* the
 * 'chat-with-reply' state below creates one. `00-gates/` already runs first among spec files
 * (directory prefix, see determinism.ts's doc comment); *inside* this file, `playwright.config.ts`'s
 * `workers: 1` + `fullyParallel: false` already run this describe block's tests one at a time, in
 * declaration order, with no config change needed here — that ordering guarantee does not require
 * `test.describe.configure({ mode: 'serial' })`. This file deliberately does *not* use serial mode
 * (S8 W1-A3 follow-up): serial mode's *other* effect — skip every remaining test once one fails —
 * turned a single real screenshot diff into "31 did not run" on a `--update-snapshots` baseline
 * regeneration run, when the whole point of that run is to get a fresh baseline for every surface
 * regardless of any one of them hiccuping. Default mode keeps the same run order and drops only
 * the cascade-skip.
 *
 * `maxDiffPixelRatio: 0.01` (playwright.config.ts's `expect.toHaveScreenshot` default): strict
 * enough to catch a real regression (a moved button, a wrong color token) while absorbing
 * anti-aliasing/font-hinting jitter between two runs on the same `ubuntu-latest` image — the
 * threshold this task's own risk note says to start strict and loosen only if evidence (a flaky
 * but visually-identical run) calls for it; none has yet, since this is the first CI run.
 */

const E2E_GATE_PENDING_SCOPE = 'e2e-gate-pending';
const SEED_ACTION_REQUESTS = process.env.WEB_E2E_SEED_ACTION_REQUESTS === '1';
const CHAT_FIXTURE_PROMPT =
  'S8 W1-B UX gate fixture message — do not edit, baseline depends on this exact text';

test.describe('S8 W1-B screenshot gate', () => {
  test.skip(
    !OWNER_API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY (and WEB_E2E_ADMIN_LOGIN/WEB_E2E_ADMIN_INITIAL_PASSWORD for the platform surfaces) to run this suite (see README.md)',
  );

  for (const surface of SURFACES) {
    test(surface.id, async ({ page }) => {
      test.slow();
      await freezeClock(page);
      await goToSurface(page, surface);
      await captureWidths(page, surface.id);
    });
  }

  test('state: chat with a reply', async ({ page }) => {
    test.slow();
    await freezeClock(page);
    await loginAsOwner(page);

    await page.locator('header').getByRole('button', { name: '新对话' }).click();
    await expect(page.getByRole('button', { name: '返回对话列表' })).toBeVisible();
    await page.getByPlaceholder('输入消息…').fill(CHAT_FIXTURE_PROMPT);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.turn-badge[data-status="completed"]')).toBeVisible({
      timeout: 15_000,
    });
    // S8 W1-A2: the assistant bubble renders through a lazy-loaded chunk
    // (components/chat/MessageBody.tsx's `Suspense`/`React.lazy` around `components/kit/
    // markdown.tsx`) — before it resolves, the same text shows through a plain `.pre-wrap`
    // fallback span. Waiting for the real `.markdown-body` root (react-markdown's own wrapper
    // class) rather than just `.message-text` avoids capturing the transitional fallback layout,
    // which has different DOM structure and (a few pixels of) block margin the loaded version
    // doesn't necessarily share.
    await expect(page.locator('.message-assistant .markdown-body')).toBeVisible({
      timeout: 15_000,
    });

    // The fake runtime's echoed reply embeds a random `turn_id` (chat.spec.ts's own doc comment) —
    // not covered by the base MASK_SELECTORS (it renders as plain bubble text, not a `<time>`/
    // `.copy-id`), so both message bubbles are masked here in addition to the base list.
    await captureWidths(page, 'state-chat-with-reply', [
      '.message-user .message-text',
      '.message-assistant .message-text',
    ]);

    // Archive this fixture chat immediately after capturing it. `application/linkage/
    // chat-targets.ts`'s `resolveDefaultChat` — "the most recently created Chat" — is what
    // `approvals.spec.ts` (unmodified, existing spec) relies on for its own seeded-ActionRequest
    // chat-card assertion. `listChats` excludes archived rows by default (`archived_at is null`),
    // same as the console's own default (non-已归档) chat list — archiving here keeps this fixture
    // chat from shadowing that lookup for every spec that runs after `00-gates/` in file order.
    // (`journeys/03-approve-action.spec.ts` no longer depends on "most recently created Chat" at
    // all — it reads ApprovalQueuePage's own 历史 History tab instead, see that file's own doc
    // comment for why — but `approvals.spec.ts` still does, so the archiving stays.)
    await page.getByRole('button', { name: '返回对话列表' }).click();
    const row = page.getByTestId('chat-row').filter({ hasText: CHAT_FIXTURE_PROMPT.slice(0, 20) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByTestId('chat-row-archive').click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
  });

  test('state: an approval pending', async ({ page }) => {
    test.skip(!SEED_ACTION_REQUESTS, 'set WEB_E2E_SEED_ACTION_REQUESTS=1 (see README.md)');
    test.slow();
    await freezeClock(page);
    await loginAsOwner(page);

    await page.goto('/#/work/approvals');
    const row = page
      .getByTestId('approval-row')
      .filter({ hasText: E2E_GATE_PENDING_SCOPE })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // `.press('Enter')`, not `.click()` — see journeys/03-approve-action.spec.ts's own comment on
    // this exact row type: `DataRow`'s onClick bails when the click lands on the row's own
    // `RefChip` copy button, which a narrow capture width can put under the default click point.
    await row.press('Enter');
    await expect(page.getByTestId('approval-drawer')).toBeVisible();

    await captureWidths(page, 'state-approval-pending');
  });
});

async function captureWidths(
  page: Page,
  id: string,
  extraMasks: readonly string[] = [],
): Promise<void> {
  await settleForCapture(page);
  const masks = [...MASK_SELECTORS, ...extraMasks].map((selector) => page.locator(selector));
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    // One frame so layout has actually reflowed at the new width before capture.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
    );
    await expect.soft(page).toHaveScreenshot(`${id}-${width}.png`, {
      mask: masks,
      animations: 'disabled',
      caret: 'hide',
    });
  }
}
