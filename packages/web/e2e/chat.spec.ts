import { expect, test } from '@playwright/test';
import { loginWithApiKey, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/chat.spec.ts: the S1.8 acceptance flow (docs/development-tasks.md S1.8: "Playwright：登录 →
 * 新对话 → 发消息 → 看到流式回复 → 刷新后历史完整"). Opt-in only — `pnpm --filter @nexttime/web e2e`
 * (never `pnpm test`/CI, which has no browser and no kernel; see README.md). Requires a kernel
 * reachable through `WEB_E2E_BASE_URL` started with `AGENT_RUNTIME=fake`
 * (packages/kernel/src/application/host-bridge/fake-runtime.ts echoes back whatever prompt it is
 * handed, deterministically) and a valid `WEB_E2E_API_KEY` for that kernel's workspace.
 *
 * The echoed reply is `echo: <prompt as the runtime received it>`, not `echo: <prompt as typed>`:
 * `application/host-bridge/turn-started-consumer.ts` unconditionally prefixes every prompt with a
 * `<!--nexttime:turn_id=<id>-->\n` marker before calling `startTurn` (that module's own doc
 * comment — the real pi extension strips it back off; `FakeAgentRuntime` has no such extension and
 * echoes it as-is). Verified against a live kernel via `.github/workflows/e2e.yml`.
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('S1.8 acceptance: login -> new chat -> send -> streamed reply -> reload -> full history', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite against a running kernel (see README.md)',
  );

  test('the full flow', async ({ page }) => {
    const apiKey = API_KEY as string; // guarded by test.skip above

    // --- login ---
    await page.goto('/');
    await reachLoginForm(page);
    await loginWithApiKey(page, apiKey);

    // --- chat list: new chat ---
    await expect(page.getByRole('heading', { name: '对话' })).toBeVisible();
    // Scoped to the page `<header>` (components/ui/PageHeader.tsx): a fresh workspace with zero
    // chats also renders a second, identical "New chat" button inside the `chats-empty` state
    // (ChatListPage.tsx reuses the same button element in both places) — an unscoped
    // `getByRole('button', { name: '新对话' })` matches both and Playwright's strict mode
    // rejects the ambiguity.
    await page.locator('header').getByRole('button', { name: '新对话' }).click();

    // --- chat page: send a message (the header's back control is an icon button) ---
    await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible();
    const prompt = `e2e-${Date.now()}`;
    await page.getByPlaceholder('Message…').fill(prompt);
    await page.getByRole('button', { name: 'Send' }).click();

    // --- the product shell is up: sidebar connection indicator reads Connected ---
    await expect(page.getByTestId('ws-status')).toHaveText('Connected');

    // --- see the streamed reply settle (fake runtime: "echo: <prompt as the runtime received
    //     it>" — see this file's own doc comment for the turn_id marker prefix) ---
    const expectedReply = new RegExp(
      `^echo: <!--nexttime:turn_id=[^>]+-->\\n${escapeRegExp(prompt)}$`,
    );
    // B4 bilingual label ("本轮完成 Turn completed") — match the English half.
    await expect(page.locator('.turn-badge')).toHaveText(/Turn completed/, { timeout: 15_000 });
    // `.message-user .message-text` / `.message-assistant .message-text`: the bubble element
    // carries both classes (components/ChatPage.tsx `renderMessage`) — stable across the redesign.
    // The user's own displayed message is the prompt as typed — the marker is only ever added to
    // what the runtime receives, never to the persisted/rendered user message.
    await expect(page.locator('.message-user .message-text')).toHaveText(prompt);
    await expect(page.locator('.message-assistant .message-text')).toHaveText(expectedReply);

    // --- reload: full history restored ---
    await page.reload();
    await expect(page.locator('.message-user .message-text')).toHaveText(prompt);
    await expect(page.locator('.message-assistant .message-text')).toHaveText(expectedReply);
  });

  /**
   * S8 W1-A2 (audit C2): assistant replies render as Markdown. The screenshot gate masks chat
   * bubbles (the fake runtime's echo carries a random turn marker), so this asserts the rendered
   * elements directly: the fake runtime echoes the prompt, and an ATX heading line may interrupt
   * the preceding `echo: …` paragraph, so the prompt's `##` and `**` must come back as elements.
   */
  test('assistant replies render Markdown, not raw syntax', async ({ page }) => {
    const apiKey = API_KEY as string; // guarded by test.skip above
    await page.goto('/');
    await reachLoginForm(page);
    await loginWithApiKey(page, apiKey);
    await page.locator('header').getByRole('button', { name: '新对话' }).click();
    await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible();

    const marker = `md-${Date.now()}`;
    await page.getByPlaceholder('Message…').fill(`## 标题 ${marker}\n\n**粗体 ${marker}**`);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.turn-badge')).toHaveText(/Turn completed/, { timeout: 15_000 });

    const reply = page.locator('.message-assistant .message-text');
    await expect(reply.locator('h2')).toHaveText(`标题 ${marker}`, { timeout: 15_000 });
    await expect(reply.locator('strong')).toHaveText(`粗体 ${marker}`);
    await expect(reply).not.toContainText('## ');
    await expect(reply).not.toContainText('**');
  });

  /**
   * S6-A W1 (docs/console-completion-plan.md §5.1 "归档与改名"): auto-title on the first message,
   * rename from the header, archive from the list with undo, the 已归档 tab, and restore. Written
   * with the kernel contract in hand (archive_chat / unarchive_chat / rename_chat return the
   * updated ChatWire; auto-title = first 40 code points of the first user message) but NOT yet
   * run against a live kernel — the lane that wrote it had no e2e stack. First run: the S6-A
   * host acceptance (`.github/workflows/e2e.yml`).
   */
  test('auto-title, rename, archive with undo, archived tab, restore', async ({ page }) => {
    const apiKey = API_KEY as string;
    await page.goto('/');
    await reachLoginForm(page);
    await loginWithApiKey(page, apiKey);
    await expect(page.getByRole('heading', { name: /对话/ })).toBeVisible();
    await page
      .locator('header')
      .getByRole('button', { name: /新对话/ })
      .click();
    await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible();

    // A brand-new chat reads as the placeholder until the first message lands …
    await expect(page.getByTestId('chat-title')).toHaveText('新对话');
    const prompt = `e2e-title-${Date.now()}`;
    await page.getByPlaceholder('Message…').fill(prompt);
    await page.getByRole('button', { name: 'Send' }).click();
    // … then the `chat.metadata {title}` push (the first 40 code points of the message) names it.
    await expect(page.getByTestId('chat-title')).toHaveText(prompt, { timeout: 15_000 });
    await expect(page.locator('.turn-badge')).toHaveText(/Turn completed/, { timeout: 15_000 });

    // Rename from the header; a rename is never overwritten by a later auto-title. S8 W1-A3
    // (audit C3): rename/archive moved into the header's overflow menu — open it first.
    const renamed = `${prompt}-renamed`;
    await page.getByTestId('chat-header-menu').click();
    await page.getByTestId('chat-header-rename').click();
    await page.getByTestId('chat-rename-input').fill(renamed);
    await page.getByTestId('chat-rename-input').press('Enter');
    await expect(page.getByTestId('chat-title')).toHaveText(renamed);

    // The 模式 · 模型 · 来源 line is up and the switcher is enabled between Turns.
    await expect(page.getByTestId('chat-model-line')).toContainText('模式 Mode');
    await expect(page.getByTestId('chat-model-select')).toBeEnabled();

    // Back to the list: the row carries the new title; archive it from the row (tier low → toast
    // with 撤销 Undo), undo, then archive again and find it under 已归档.
    await page.getByRole('button', { name: 'Back to chats' }).click();
    const row = page.getByTestId('chat-row').filter({ hasText: renamed });
    await expect(row).toBeVisible();
    await row.getByTestId('chat-row-archive').click();
    await expect(row).toHaveCount(0);
    const toast = page.getByTestId('toast').filter({ hasText: renamed });
    await expect(toast).toContainText('已归档');
    await toast.getByRole('button', { name: '撤销' }).click();
    await expect(page.getByTestId('chat-row').filter({ hasText: renamed })).toBeVisible();

    await page
      .getByTestId('chat-row')
      .filter({ hasText: renamed })
      .getByTestId('chat-row-archive')
      .click();
    await expect(page.getByTestId('chat-row').filter({ hasText: renamed })).toHaveCount(0);
    await page.getByTestId('chats-tab-archived').click();
    const archivedRow = page.getByTestId('chat-row').filter({ hasText: renamed });
    await expect(archivedRow).toBeVisible();
    await expect(archivedRow.getByTestId('chat-archived-chip')).toHaveText('已归档');

    // Opening an archived chat is read-only; 恢复 from the composer note re-enables it.
    await archivedRow.click();
    await expect(page.getByTestId('chat-archived-notice')).toBeVisible();
    await expect(page.getByPlaceholder('已归档')).toBeDisabled();
    await page.getByTestId('chat-composer-restore').click();
    await expect(page.getByTestId('chat-archived-notice')).toHaveCount(0);
    await expect(page.getByPlaceholder('Message…')).toBeEnabled();

    // Reload: the lifecycle survived (list_chats reflects the restore and the rename).
    await page.reload();
    await expect(page.getByTestId('chat-title')).toHaveText(renamed);
  });
});
