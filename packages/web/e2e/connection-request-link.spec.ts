import {
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './journeys/helpers.js';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from './lib/auth.js';
import { expect, test } from './lib/test.js';

/**
 * S11 AA5b: the admin chat's 「在 系统与授权 完成这个连接」 link (`hrefs.completeConnectionRequest`,
 * `#/govern/systems?complete=<request id>`) — the one console entry AA5b adds that a fake-runtime
 * journey cannot reach (the AA5 plan's F8 (a): CI e2e adds assertions for AA5b's new entries, not a
 * whole journey ⑩). The chat row that carries the link is covered by `ToolCallRowView.test.tsx`;
 * here the link itself is followed in the real console against the real kernel:
 *
 *   1. A fresh workspace's owner raises a connection request on 系统与授权 (the request's id comes
 *      from `request_connection`'s own answer, as the chat reads it from the tool call's result).
 *   2. From another page, following the link opens that request's 完成连接 drawer, prefilled with
 *      its address; the query is dropped from the address bar once read.
 *   3. The owner cancels the request; the same link now says it was cancelled and nothing was
 *      connected, and lists every request so the cancelled one is in view.
 *   4. A link to a request this workspace does not have says it may be in another workspace.
 */

const TARGET = 'https://tickets.example.com';
const UNKNOWN_REQUEST = '00000000-0000-4000-8000-000000000000';

test.describe('S11 AA5b: 系统与授权 opened on one connection request', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('the link opens the request’s 完成连接 drawer, and says so when it is gone', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const { ownerLogin, ownerTemporaryPassword } = await createFreshWorkspace(page);
    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    await selectOwnedWorkspace(page);

    // --- 1. Raise a connection request -----------------------------------------------------------
    await goToByLabel(page, '系统与授权');
    await page.getByTestId('requests-empty').getByRole('button', { name: '申请连接' }).click();
    const requestDrawer = page.getByTestId('request-connection-drawer');
    await requestDrawer.locator('#rc-kind').selectOption('http');
    await requestDrawer.locator('#rc-target').fill(TARGET);
    const requested = page.waitForResponse(
      (response) => response.url().endsWith('/api/cap/request_connection') && response.ok(),
    );
    await requestDrawer.getByRole('button', { name: '申请连接' }).click();
    const body = (await (await requested).json()) as { result?: { id?: string } };
    const requestId = body.result?.id ?? '';
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(requestDrawer).toBeHidden();
    await expect(page.getByTestId('request-row')).toHaveCount(1);

    // --- 2. Follow the link from another page --------------------------------------------------
    await goToByLabel(page, '对话');
    await page.evaluate((id) => {
      window.location.hash = `#/govern/systems?complete=${encodeURIComponent(id)}`;
    }, requestId);
    const completeDrawer = page.getByTestId('complete-connection-drawer');
    await expect(completeDrawer).toBeVisible({ timeout: 15_000 });
    await expect(completeDrawer.getByRole('heading', { name: '完成连接' })).toBeVisible();
    await expect(completeDrawer.locator('#cc-target')).toHaveValue(TARGET);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/govern/systems');
    await page.keyboard.press('Escape');
    await expect(completeDrawer).toBeHidden();
    await expect(page.getByTestId('linked-request-note')).toHaveCount(0);

    // --- 3. Cancelled: the link says so --------------------------------------------------------
    await page.getByTestId(`cancel-request-${requestId}`).click();
    await page
      .getByTestId('cancel-request-confirm')
      .getByRole('button', { name: '取消申请' })
      .click();
    await expect(page.getByTestId('request-row')).toHaveCount(0);
    await page.evaluate((id) => {
      window.location.hash = `#/govern/systems?complete=${encodeURIComponent(id)}`;
    }, requestId);
    const note = page.getByTestId('linked-request-note');
    await expect(note).toContainText('已经取消了，什么也没有接入');
    await expect(page.getByTestId('request-row')).toHaveCount(1);
    await expect(completeDrawer).toBeHidden();

    // --- 4. A request this workspace does not have ---------------------------------------------
    await page.evaluate((id) => {
      window.location.hash = `#/govern/systems?complete=${id}`;
    }, UNKNOWN_REQUEST);
    await expect(note).toContainText('可能是在另一个工作区里提出的');
    await expect(completeDrawer).toBeHidden();
  });
});
