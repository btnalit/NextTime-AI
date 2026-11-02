import { expect, test } from '@playwright/test';
import { OWNER_API_KEY, loginAsOwner } from './lib/auth.js';
import {
  appendToChatHistory,
  expectNoSidewaysScroll,
  openNewChat,
  systemMessage,
  userMessage,
} from './lib/chat-stand-ins.js';

/**
 * e2e/chat-model-refused.spec.ts (legacy 589): a message whose every model call the platform
 * refused because the workspace's daily budget was spent — the Turn has no reply, and the chat
 * says why, which budget, and when it resets — in a real browser at the widths UX checks (1440,
 * 390). Nothing on the CI stack spends a budget (its agent runtime only echoes), so the person's
 * message and the kernel's `system.model_refused` are stand-ins appended to the real chat's
 * history (e2e/lib/chat-stand-ins.ts). Full-page captures land in `test-results/` for the UX
 * acceptance to read; they are not a screenshot gate.
 */

const TURN = '66000000-0000-4000-8000-000000000589';
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const SENT_AT = minutesAgo(5);
/** The next UTC midnight, as the kernel writes it. */
const RESETS_AT = (() => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
})();

test.describe('legacy 589: a message the platform refused (stand-in messages)', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  for (const width of [1440, 390] as const) {
    test(`the refusal reads as why there is no reply at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await appendToChatHistory(page, (last) => [
        userMessage(last + 1, SENT_AT, '帮我看看三台主机这周的磁盘用量，快满的列出来'),
        systemMessage(last + 2, SENT_AT, {
          kind: 'system.model_refused',
          text: `The platform refused the model calls for this message: the workspace's daily model cost budget is spent. It resets at ${RESETS_AT}, or an administrator can raise it.`,
          turnId: TURN,
          scope: 'workspace_daily_cost',
          resetsAt: RESETS_AT,
        }),
        // A budget this console does not know, without a reset time: still a whole sentence.
        userMessage(last + 3, SENT_AT, '再试一次'),
        {
          ...systemMessage(last + 4, SENT_AT, {
            kind: 'system.model_refused',
            text: 'The platform refused the model calls for this message.',
            turnId: TURN,
            scope: 'workspace_daily_tokens',
            resetsAt: RESETS_AT,
          }),
          content: {
            kind: 'system.model_refused',
            text: 'The platform refused the model calls for this message.',
            turnId: TURN,
            scope: 'workspace_monthly_tokens',
          },
        },
      ]);
      await loginAsOwner(page);
      await openNewChat(page);
      // The stand-ins ride on the history read a fresh subscription makes.
      await page.reload();

      const lines = page.locator(
        '[data-testid="system-status-line"][data-variant="model_refused"]',
      );
      await expect(lines).toHaveCount(2, { timeout: 15_000 });
      const [cost, unknown] = [lines.nth(0), lines.nth(1)];

      await expect(cost.getByTestId('system-status-failure')).toHaveText('模型调用被平台拒绝');
      await expect(cost).toContainText('工作区当天的模型费用预算用完了');
      await expect(cost).toContainText('所以没有回复');
      await expect(cost).toContainText(
        '工作区所有者也可以在「模型与配额」里调高「每工作区日成本」',
      );
      // In the reader's language, never the kernel's English, and nothing to open.
      await expect(cost).not.toContainText('The platform refused');
      await expect(cost.getByRole('button')).toHaveCount(0);

      // A budget this console does not know: no period, no setting.
      await expect(unknown).toContainText('工作区的模型预算用完了');
      await expect(unknown).toContainText('等预算重置，或者管理员调高它之后再发');
      await expect(unknown).not.toContainText('每天');
      await expect(unknown).not.toContainText('workspace_monthly_tokens');

      // UX acceptance of #910: the whole sentence is on the page — wrapped under the label, never
      // cut — at both widths (text in the DOM is not text a person can read).
      for (const text of await lines.locator('.system-status-text').all()) {
        expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await text.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('normal');
      }
      await expectNoSidewaysScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`chat-model-refused-${width}.png`),
        fullPage: true,
      });
    });
  }
});
