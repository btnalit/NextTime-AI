import { OWNER_API_KEY, loginAsOwner } from './lib/auth.js';
import {
  appendToChatHistory,
  expectNoSidewaysScroll,
  openNewChat,
  systemMessage,
  userMessage,
} from './lib/chat-stand-ins.js';
import { expect, test } from './lib/test.js';

/**
 * e2e/chat-turn-not-started.spec.ts (legacy 515): a message the evaluation seal kept the entry
 * agent from answering — what the agent would read carries content reserved for evaluation, or
 * the seal has paused the agents acting for the person — so the Turn has no reply, and the chat
 * says why and who can change it, in a real browser at the widths UX checks (1440, 390). Nothing
 * on the CI stack holds an evaluation suite, so the person's messages and the kernel's
 * `system.turn_not_started` are stand-ins appended to the real chat's history
 * (e2e/lib/chat-stand-ins.ts). Full-page captures land in `test-results/` for the UX acceptance to
 * read; they are not a screenshot gate.
 */

const TURN = '66000000-0000-4000-8000-000000000515';
const SENT_AT = new Date(Date.now() - 5 * 60_000).toISOString();

test.describe('legacy 515: a message the evaluation seal kept from an agent (stand-in messages)', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  for (const width of [1440, 390] as const) {
    test(`the line reads as why there is no reply at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await appendToChatHistory(page, (last) => [
        userMessage(last + 1, SENT_AT, '帮我看看三台主机这周的磁盘用量，快满的列出来'),
        systemMessage(last + 2, SENT_AT, {
          kind: 'system.turn_not_started',
          text: 'The agent was not started for this message: the evaluation seal has paused the agents acting for you. A workspace owner can review and release the pause under Govern → Evaluation.',
          turnId: TURN,
          reason: 'evaluation_paused',
        }),
        userMessage(last + 3, SENT_AT, '再试一次'),
        systemMessage(last + 4, SENT_AT, {
          kind: 'system.turn_not_started',
          text: 'The agent was not started for this message: what it starts with (its system prompt or a Skill it mounts) carries content reserved for evaluation. Your own prompt addendum and the Skills you exclude are yours to change under My Agent; for anything else, ask a workspace owner or builder.',
          turnId: TURN,
          reason: 'evaluation_withheld',
        }),
      ]);
      await loginAsOwner(page);
      await openNewChat(page);
      // The stand-ins ride on the history read a fresh subscription makes.
      await page.reload();

      const lines = page.locator(
        '[data-testid="system-status-line"][data-variant="turn_not_started"]',
      );
      await expect(lines).toHaveCount(2, { timeout: 15_000 });
      const [paused, withheld] = [lines.nth(0), lines.nth(1)];

      await expect(paused.getByTestId('system-status-failure')).toHaveText('智能体已暂停');
      await expect(paused).toContainText('评测防泄漏暂停了代你行动的智能体');
      await expect(paused).toContainText('所以没有回复');
      await expect(paused).toContainText('工作区所有者在「治理 → 评测」查看后可以解除');

      await expect(withheld.getByTestId('system-status-failure')).toHaveText('含评测保留的内容');
      await expect(withheld).toContainText('有评测用例集留作测试的部分');
      await expect(withheld).toContainText('到「我的智能体」里修改');
      await expect(withheld).toContainText('其他的请找工作区所有者或构建者');

      // In the reader's language, never the kernel's English, and nothing to open.
      await expect(lines.filter({ hasText: 'The agent was not started' })).toHaveCount(0);
      await expect(lines.getByRole('button')).toHaveCount(0);

      // UX acceptance of #1498: the whole sentence is on the page — wrapped under the label, never
      // cut — at both widths (text in the DOM is not text a person can read).
      for (const text of await lines.locator('.system-status-text').all()) {
        expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await text.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('normal');
      }
      await expectNoSidewaysScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`chat-turn-not-started-${width}.png`),
        fullPage: true,
      });
    });
  }
});
