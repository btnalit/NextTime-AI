import { expect, test } from '@playwright/test';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import { createFreshWorkspace, goToByLabel } from './helpers.js';

/**
 * Journey ⑤: 清理验收残留 (development-tasks.md §5e F4, W3 波次; closed out S8 W4-C)
 *
 * 步骤:
 *   1. 一次验收/试用之后，工作区里留下了不再需要的对象：过期的临时工作区、已停用超过保留期的工作区、
 *      入口容器、残留的 Gatekeeper/Worker 定义草稿。
 *   2. 在相应页面找到"清理/残留"入口 — 平台 · 验收残留页（`PlatformResiduePage`, S8 W4-C）现在把
 *      三类残留放在一起：工作区（链到 平台 · 工作区 的"仅看残留"预设）、草稿定义（只显示数量，不显示
 *      内容 — I16 只对提议者本人可见）、已退出的入口容器（`runtime_inventory`，只读 — 运行层还没有
 *      回收它们的写能力，见页面自身的说明）。
 *   3. 预览将被清除的内容（dry run：数量、原因），不是直接删除 —— 工作区这一类沿用
 *      `PlatformWorkspacesPage`/`PurgeWorkspaceDrawer` 已有的预览 → 确认流程（workspaces.spec.ts 的
 *      S6-A A1 场景已端到端覆盖那条路径本身，这里不重复）。
 *   4. 确认（重新输入名称 + 勾选确认，§5.9 原则 4 的不可逆操作模式），执行 —— 同上，复用既有能力。
 *   5. 残留列表里这一项消失，有可审计的记录 —— 同上。
 * 状态覆盖:
 *   - 空: 没有残留——三个卡片各自的空态（`residue-workspaces-empty` / 容器同理）说清楚"当前没有可
 *     清理的"，不是一片空白；草稿卡片没有空态（数字本身就是 0）。
 *   - 错: 三个读各自独立失败时各显示自己的错误横幅，不会互相拖垮（`PlatformResiduePage` 每个卡片
 *     用自己的 `useCapability`/`useCapabilityList`）——本旅程不逐一注入失败去验证，读模型失败的
 *     通用行为已由 `ErrorBanner` 自身的单测覆盖。
 *   - 无权限: 非平台管理员在 Sidebar 上看不到"验收残留"（`PLATFORM_NAV` 只对 `platformRole==='admin'`
 *     渲染 —— 同一条件已经是 `AppShell.test.tsx`"non-admin user: no 平台"用例覆盖的既有规则，本旅程
 *     不重复）。
 *   - 窄屏: 本旅程不单独在 768px 重跑 —— `00-gates/` 的三档截图会覆盖这一页的窄屏布局；这里的价值是
 *     流程能不能走完。
 * 成功判据:
 *   - 一次验收后，一个人能在一个页面上看到三类残留分别有多少、是什么，工作区这一类能直接点进已有的
 *     清理入口；不用 SQL/CLI。
 *
 * 今天能做到哪一步：CI 栈能通过既有能力真造出工作区残留（建一个工作区、停用它 —— `isResidueWorkspace`
 * 不看停用满不满 7 天，停用即算残留），这条旅程因此对工作区一类做真实断言。草稿与入口容器两类，CI 的
 * `AGENT_RUNTIME=fake` 栈造不出真实草稿（需要 agent 走 `propose_worker_definition`，遗留 83 同一个
 * "CI 栈触发不了真实委派"的限制）或已退出的入口容器（需要一个真的 supervisor 生命周期）——这两个
 * 卡片只做结构性断言（渲染、不报错），不断言具体数字，并在下面写清楚这个界限。
 */

test.describe('Journey ⑤: 清理验收残留', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN/WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('admin disables a workspace, then finds it (and the other two residue categories) on 验收残留', async ({
    page,
  }) => {
    test.slow();

    // --- fixture: a fresh workspace, then disabled — `isResidueWorkspace` counts a disabled
    // workspace as residue immediately (no 7-day wait; that wait only gates *purgeable*, a
    // stricter condition this journey does not need). `createFreshWorkspace` leaves the admin
    // signed in, on 平台 · 工作区, with no drawer open.
    const { workspaceName } = await createFreshWorkspace(page);

    const row = page
      .getByTestId('platform-workspaces-table')
      .locator('tbody tr')
      .filter({ hasText: workspaceName });
    await expect(row).toHaveCount(1);
    await row.click();
    const drawer = page.getByTestId('workspace-drawer');
    await expect(drawer.getByTestId('workspace-detail')).toBeVisible({ timeout: 15_000 });
    await drawer.getByTestId('workspace-status-toggle').click();
    await expect(drawer.getByTestId('workspace-disable-confirm')).toBeVisible();
    await drawer.getByRole('button', { name: /确认停用/ }).click();
    await expect(row.getByTestId('workspace-status')).toHaveAttribute('data-status', 'disabled', {
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // --- step 2: find the "清理/残留" entry — 验收残留 in the Sidebar.
    await goToByLabel(page, '验收残留');
    await expect(page.getByTestId('platform-residue-page')).toBeVisible({ timeout: 15_000 });

    // 工作区: the just-disabled workspace is in the list (真实断言).
    const workspacesList = page.getByTestId('residue-workspaces-list');
    await expect(workspacesList).toBeVisible({ timeout: 15_000 });
    await expect(workspacesList).toContainText(workspaceName);

    // step 2/3: the link into the existing preview → confirm → execute flow.
    const cleanupLink = page.getByTestId('residue-open-workspaces');
    await expect(cleanupLink).toHaveAttribute('href', '#/platform/workspaces?residue=1');
    await cleanupLink.click();
    await expect(page.getByTestId('platform-workspaces-residue-only')).toBeChecked({
      timeout: 15_000,
    });
    const residueRow = page
      .getByTestId('platform-workspaces-table')
      .locator('tbody tr')
      .filter({ hasText: workspaceName });
    await expect(residueRow).toHaveCount(1);
    // The purge flow itself (preview → retype name → executed) is workspaces.spec.ts's own S6-A A1
    // coverage — not repeated here (this file's own doc comment explains why).

    // --- 草稿定义 / 已退出的入口容器: structural only (see this file's doc comment for the CI-stack
    // limits) — the cards render without an error banner, and never leak a draft's own content or
    // an internal tracking number into visible text.
    await goToByLabel(page, '验收残留');
    const draftsCard = page.getByTestId('residue-drafts-card');
    await expect(draftsCard).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('residue-drafts-counts')).toBeVisible();
    await expect(page.getByTestId('residue-drafts-error')).toHaveCount(0);

    const containersCard = page.getByTestId('residue-containers-card');
    await expect(containersCard).toBeVisible();
    await expect(page.getByTestId('residue-containers-error')).toHaveCount(0);
    await expect(containersCard).not.toContainText('遗留');
  });
});
