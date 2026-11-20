import { loginWithPassword, reachLoginForm } from '../auth-helpers.js';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import { type Page, type Request, expect, test } from '../lib/test.js';
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
 *   6. 在「系统与授权 → 接入一个系统」里选 CI 的备用门实例（`ci-spare-mcp`，平台已启用、没有工作区
 *      启用过它），走到「在本工作区启用」这一步：这个角色看到的是「申请启用」或「由工作区所有者完成」，
 *      不是一个点了会被拒的按钮（遗留 260）。不点申请——申请的一生由 integrations.spec.ts 走。
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
 *   - 「在本工作区启用」这一步没有替这个角色去要它拿不到的东西，也没有给它启用按钮。
 *
 * 准备工作在页面外做：平台管理员把 `ci-spare-mcp` 在平台上启用、把它的连接器设为平台预置
 * （`update_gate_instance`、`set_connector_mode`，平台侧由 integrations.spec.ts 在控制台里走过）。
 * 这个实例只有本旅程用，任何 spec 都不在工作区里启用它，所以每个角色走到这一步时它都还没启用。
 */

/** The CI stack's second announced instance (`.github/workflows/e2e.yml`, "Seed a discovered gate
 *  instance"): same connector as `ci-fixture-mcp`, never enabled in a workspace. */
const SPARE_GATE_ID = 'ci-spare-mcp';
const SPARE_CONNECTOR = 'fixture-mcp';

/** A platform capability as the signed-in administrator, from Node — setup only. */
async function adminCap(page: Page, name: string, data: unknown): Promise<void> {
  const res = await page.request.post(`/api/cap/${name}`, {
    headers: { 'x-requested-with': 'nexttime' },
    data,
  });
  const body = (await res.json()) as { ok: boolean; error?: unknown };
  if (!body.ok) throw new Error(`capability ${name} failed: ${JSON.stringify(body.error)}`);
}

const ROLES = ['operator', 'builder', 'member', 'auditor'] as const;

/** Who a hint without a link must name (`components/readiness/readiness-copy.ts`'s `askFor`). */
const NAMES_WHOM_TO_ASK = /工作区所有者|平台管理员|这位成员自己|构建者/;

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

/** The sections on the page that only say "this role cannot see this" — a dead end. */
async function deadEnds(page: Page): Promise<(string | null)[]> {
  return page
    .locator('main [data-state="empty"][data-testid$="-forbidden"]:visible')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
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

      // Step 1: admin creates the platform user (and makes the spare instance available to
      // workspaces — step 6's setup; both calls leave an already-enabled instance as it is).
      await asAdmin(page);
      await adminCap(page, 'update_gate_instance', { gateId: SPARE_GATE_ID, status: 'enabled' });
      await adminCap(page, 'set_connector_mode', {
        name: SPARE_CONNECTOR,
        mode: 'platform_preset',
      });
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
      // The tooltip names the role in words (legacy sweep, 2026-10-16); the raw role is on
      // `data-role`.
      await expect(page.getByTestId('role-badge')).toHaveAttribute('data-role', role, {
        timeout: 15_000,
      });

      // Steps 4–5: every page; collect the hints' links, check the hints without one name someone.
      await settled();
      expect(await localRefusals.take(), 'asked for on switching to the workspace').toEqual([]);
      const fixLinks = new Set<string>();
      const pageLinks = new Set<string>();
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
        expect(await deadEnds(page), `${navTestId}: a section this role can never see`).toEqual([]);
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
        // #541 review N2: every in-app link on the page is followed below.
        for (const href of await main
          .locator('a[href^="#/"]:visible')
          .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))) {
          if (href) pageLinks.add(href);
        }
        // #541 review N1: 接入一个系统 opens for every role that sees it, asking for nothing
        // this role cannot have.
        const connect = main.getByTestId('connect-system-button');
        if (navTestId === 'nav-systems' && (await connect.isVisible())) {
          await connect.click();
          await expect(page.getByTestId('connect-system-drawer')).toBeVisible({ timeout: 15_000 });
          await settled();
          expect(
            await localRefusals.take(),
            '接入一个系统: asked for what this role cannot have',
          ).toEqual([]);
          // Step 6 (legacy 260): an instance still waiting for 在本工作区启用 — the step asks this
          // role for nothing it cannot have, and offers it no enable button.
          const drawer = page.getByTestId('connect-system-drawer');
          await drawer.getByRole('radio', { name: /CI spare MCP/ }).check({ timeout: 15_000 });
          const enableStep = drawer.getByTestId('launcher-workspace-enable');
          await expect(enableStep).toBeVisible({ timeout: 15_000 });
          await expect(
            enableStep
              .getByTestId('launcher-workspace-enable-request')
              .or(enableStep.getByTestId('launcher-workspace-enable-owner-only'))
              .first(),
          ).toBeVisible({ timeout: 15_000 });
          await expect(enableStep.getByTestId('launcher-workspace-enable-button')).toHaveCount(0);
          await settled();
          expect(
            await localRefusals.take(),
            '在本工作区启用: asked for what this role cannot have',
          ).toEqual([]);
          await page.keyboard.press('Escape');
          await expect(page.getByTestId('connect-system-drawer')).toBeHidden({ timeout: 15_000 });
        }
      }
      // Every hint's link and every in-app link a page offered this role leads to a page with
      // content: nothing refused on the way, no section that only says "not your role".
      for (const href of new Set([...fixLinks, ...pageLinks])) {
        await page.goto(`/${href}`);
        // Legacy 669 put a chat's link on the audit page an auditor follows; an open chat's one h1
        // is its own title (legacy 668: the list pane beside it is an h2).
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({
          timeout: 15_000,
        });
        await settled();
        expect(
          await localRefusals.take(),
          `${href}: a link led to what this role cannot have`,
        ).toEqual([]);
        expect(await deadEnds(page), `${href}: a link led to a page this role cannot see`).toEqual(
          [],
        );
      }

      expectNoForbiddenCalls();
    });
  }
});
