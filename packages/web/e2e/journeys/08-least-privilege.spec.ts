import { type Page, type Request, expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from '../auth-helpers.js';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import {
  expectNoHalfEnglish,
  watchForbiddenCapabilityCalls,
  watchLocalRefusals,
} from '../lib/ux-lint.js';
import { OWNER_API_KEY, asAdmin, asOwner, createPlatformUser, goToByLabel } from './helpers.js';

/**
 * Journey ⑧: 非所有者角色走一遍（console UX audit §3.2；#541 验收必修 2 的回归）
 *
 * 步骤（operator、builder、member、auditor 各走一次）:
 *   1. （平台管理员）新建一个平台用户。
 *   2. （工作区 owner）在 成员与授权 页把这个用户加进来，选这一轮的角色。
 *   3. 这个人用临时密码登录、改密，切到这个工作区。
 *   4. 依次打开侧栏「使用」和「治理」里这个角色看得到的每一页。
 *   5. 每页上的"下一步"提示：给了链接的，跟着点过去；没给链接的，说清楚该找谁。
 * 状态覆盖:
 *   - 空: 新成员第一次进来，我的智能体、系统与授权里自己的那一行都还是空的——就是本旅程看的状态。
 *   - 错: 本旅程的"错"就是越权——这个角色打开任何一页、点任何一个提示，内核都不应回 403。
 *   - 无权限: 这条旅程本身：角色拿不到的页不出现在侧栏，拿不到的数据不去要，改不了的地方说找谁。
 *   - 窄屏: 不单独重跑（`00-gates/` 的截图覆盖布局）。
 * 成功判据:
 *   - 整条走下来没有一个 `/api/cap/*` 请求被拒（403），也没有一个被控制台自己按角色拦下——页面没有
 *     替这个角色去要它拿不到的东西（`lib/http-client.ts` 的 `roleGate` 拦下时发
 *     `nexttime:capability-refused-locally`，这里逐页数；#541 审查 M1：本地拦截不走网络，只看 403
 *     会漏）；
 *   - 侧栏里的每一项都通向有内容的页：页上没有一块"你的角色不能看"的空态（`[data-state="empty"]`
 *     且 testid 以 `-forbidden` 结尾）——那样的页不该出现在这个角色的侧栏里；
 *   - 每个"下一步"提示要么这个角色点得动（点过去也不 403），要么写明该找工作区所有者 / 平台管理员 /
 *     这位成员自己。
 */

const ROLES = ['operator', 'builder', 'member', 'auditor'] as const;

/** Who a hint without a link must name (`components/readiness/readiness-copy.ts`'s `askFor`). */
const NAMES_WHOM_TO_ASK = /工作区所有者|平台管理员|这位成员自己|builder/;

/** Resolves once no `/api/cap/*` request is still in flight — the page's own reads are what the
 *  403 watcher judges, so they must have answered before the next page is opened. */
function trackCapabilityCalls(page: Page): () => Promise<void> {
  const inFlight = new Set<Request>();
  const isCap = (request: Request) => new URL(request.url()).pathname.startsWith('/api/cap/');
  page.on('request', (request) => {
    if (isCap(request)) inFlight.add(request);
  });
  const done = (request: Request) => inFlight.delete(request);
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return async () => {
    await expect.poll(() => inFlight.size, { timeout: 15_000 }).toBe(0);
  };
}

/** The 使用 and 治理 nav items this role is shown (the Explorer link opens another app). */
async function visibleNavItems(page: Page): Promise<string[]> {
  const items = page.locator(
    '[data-testid="nav-section-use"] [data-testid^="nav-"], [data-testid="nav-section-govern"] [data-testid^="nav-"]',
  );
  const ids = await items.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-testid') ?? ''),
  );
  return ids.filter((id) => id !== 'nav-explorer' && !id.startsWith('nav-section'));
}

test.describe('Journey ⑧: 非所有者角色走一遍', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD || !OWNER_API_KEY,
    'set WEB_E2E_ADMIN_LOGIN, WEB_E2E_ADMIN_INITIAL_PASSWORD and WEB_E2E_API_KEY (see README.md)',
  );

  for (const role of ROLES) {
    test(`${role}: every page they can see opens with no refused call, and every hint is actionable`, async ({
      page,
    }) => {
      test.slow();
      const localRefusals = await watchLocalRefusals(page);
      const suffix = Date.now().toString(36);
      const displayName = `Journey ${role} ${suffix}`;

      // Step 1: admin creates the platform user.
      await asAdmin(page);
      const { login, temporaryPassword } = await createPlatformUser(page, displayName);
      await page.getByTestId('sign-out').click();
      await expect(page.getByTestId('login-submit')).toBeVisible();

      // Step 2: owner adds them with this round's role.
      await asOwner(page);
      await goToByLabel(page, '成员与授权');
      await page.getByRole('button', { name: /添加成员/ }).click();
      const addDrawer = page.getByTestId('add-member-drawer');
      await expect(addDrawer).toBeVisible();
      await addDrawer.locator('#am-login').fill(login);
      await addDrawer.locator('#am-role').selectOption(role);
      await addDrawer.getByRole('button', { name: '添加' }).click();
      await expect(addDrawer).toBeHidden({ timeout: 15_000 });
      await expect(page.getByTestId('member-row').filter({ hasText: displayName })).toBeVisible({
        timeout: 15_000,
      });

      // Step 3: sign in as them (the owner's apiKey session cleared first — journey ⑥'s note),
      // change the temporary password, switch to this workspace.
      await page.goto('/');
      if ((await reachLoginForm(page)) === 'shell') {
        await page.getByRole('button', { name: '清除密钥' }).click();
        await reachLoginForm(page);
      }
      await loginWithPassword(page, login, temporaryPassword);
      await expect(page.getByTestId('change-password-title')).toBeVisible({ timeout: 15_000 });
      const newPassword = `${temporaryPassword}-changed`;
      await page.locator('#cp-current-password').fill(temporaryPassword);
      await page.locator('#cp-new-password').fill(newPassword);
      await page.locator('#cp-confirm-password').fill(newPassword);
      await page.getByTestId('change-password-submit').click();
      const switcher = page.getByTestId('workspace-switcher');
      await expect(switcher).toBeVisible({ timeout: 15_000 });
      const workspaceId = await switcher
        .locator('option', { hasText: 'ci-e2e' })
        .getAttribute('value');
      // Judged from the switch on: the pages this role opens in this workspace.
      const expectNoForbiddenCalls = watchForbiddenCapabilityCalls(page);
      const settled = trackCapabilityCalls(page);
      await switcher.selectOption(workspaceId as string);
      await expect(switcher).toHaveValue(workspaceId as string, { timeout: 15_000 });
      await expect(page.getByTestId('role-badge')).toHaveAttribute('title', `Role: ${role}`, {
        timeout: 15_000,
      });

      // Steps 4–5: every page; collect the hints' links, check the hints without one name someone.
      await settled();
      expect(await localRefusals.take(), 'asked for on switching to the workspace').toEqual([]);
      const fixLinks = new Set<string>();
      const navItems = await visibleNavItems(page);
      expect(navItems.length).toBeGreaterThan(0);
      test.info().annotations.push({ type: 'pages', description: navItems.join(' ') });
      for (const navTestId of navItems) {
        await page.getByTestId(navTestId).click();
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
        await settled();
        expect(
          await localRefusals.take(),
          `${navTestId}: asked for what this role cannot have`,
        ).toEqual([]);
        const main = page.locator('main');
        // A nav entry leads to a page with content, never to one that only says "not your role".
        const deadEnds = await main
          .locator('[data-state="empty"][data-testid$="-forbidden"]:visible')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
        expect(deadEnds, `${navTestId}: a section this role can never see`).toEqual([]);
        await expectNoHalfEnglish(main);
        // A role refusal is said as what this role can do, never as a 「无法加载」 with a 重试.
        const refusals = await main
          .locator('[data-error-code="forbidden"]:visible')
          .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').slice(0, 80)));
        expect(refusals, `${navTestId}: a refusal shown as a load error`).toEqual([]);
        for (const href of await main
          .getByTestId('execution-readiness-fix')
          .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))) {
          if (href) fixLinks.add(href);
        }
        for (const ask of await main.getByTestId('execution-readiness-ask').allInnerTexts()) {
          expect(ask, `a hint on ${navTestId} with no link must say whom to ask`).toMatch(
            NAMES_WHOM_TO_ASK,
          );
        }
      }
      for (const href of fixLinks) {
        await page.goto(`/${href}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
        await settled();
        expect(
          await localRefusals.take(),
          `${href}: a hint led to what this role cannot have`,
        ).toEqual([]);
      }

      expectNoForbiddenCalls();
    });
  }
});
