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
 * e2e/chat-agent-reconnecting.spec.ts (legacy 168): a message whose last model call llm-proxy
 * refused while the platform reconnects the entry agent (no Handle bound to its container's
 * address yet) — the Turn ends without a complete answer, and the chat says to send it again, in
 * a real browser at the widths UX checks (1440, 390). Reconnecting an agent cannot be staged on
 * the CI stack, so the person's message and the kernel's `system.agent_reconnecting` are stand-ins
 * appended to the real chat's history (e2e/lib/chat-stand-ins.ts). Full-page captures land in
 * `test-results/` for the UX acceptance to read; they are not a screenshot gate.
 */

const TURN = '66000000-0000-4000-8000-000000000168';
const SENT_AT = new Date(Date.now() - 5 * 60_000).toISOString();

test.describe('legacy 168: a message cut short while the platform reconnects the agent (stand-in messages)', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  for (const width of [1440, 390] as const) {
    test(`the line says to send the message again at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await appendToChatHistory(page, (last) => [
        userMessage(last + 1, SENT_AT, '帮我看看三台主机这周的磁盘用量，快满的列出来'),
        systemMessage(last + 2, SENT_AT, {
          kind: 'system.agent_reconnecting',
          text: 'The agent could not finish this message: the platform is reconnecting it. Send the message again in a moment.',
          turnId: TURN,
        }),
      ]);
      await loginAsOwner(page);
      await openNewChat(page);
      // The stand-ins ride on the history read a fresh subscription makes.
      await page.reload();

      const line = page.locator(
        '[data-testid="system-status-line"][data-variant="agent_reconnecting"]',
      );
      await expect(line).toHaveCount(1, { timeout: 15_000 });
      await expect(line.getByTestId('system-status-failure')).toHaveText('智能体正在重新连接平台');
      await expect(line).toContainText('这条消息没有处理完，请稍后再发一次。');

      // In the reader's language, never the kernel's English, and nothing to open.
      await expect(line.filter({ hasText: 'could not finish' })).toHaveCount(0);
      await expect(line.getByRole('button')).toHaveCount(0);

      // The whole sentence is on the page — wrapped under the label, never cut — at both widths.
      const text = line.locator('.system-status-text');
      expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await text.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('normal');
      await expectNoSidewaysScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`chat-agent-reconnecting-${width}.png`),
        fullPage: true,
      });
    });
  }
});
