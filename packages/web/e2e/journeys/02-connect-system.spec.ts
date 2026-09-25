import { expect, test } from '@playwright/test';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import {
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './helpers.js';

/**
 * Journey ②: 接入一个新系统 (development-tasks.md §5e F4; 系统接入页收敛 SY1–SY4/U5/L4, W3 波次)
 *
 * 步骤:
 *   1. 系统接入 → 新建（"接入一个系统" 主按钮，`ConnectSystemLauncher` — 系统接入页§5.9 原则 1
 *      "一个墨色主按钮"下的当前路径；页面自身的旧 "接入向导" `OnboardingWizard` 走
 *      `CompleteConnectionForm`/`create_connection` 直连注册，与本旅程可用的 fixture（见下）不是
 *      同一条机制，本旅程走当前主路径）→ 选择接入方式。
 *   2. 填写连接信息，测试连通。
 *   3. 门注册成功后，看到它发现/声明的 Operation 列表。
 *   4. 挑选要发布的 Operation，逐个或批量发布。
 *   5. 回到 系统接入 列表，确认这个门状态健康、Operation 数量正确。
 * 状态覆盖:
 *   - 空: `createFreshWorkspace` 给一个全新工作区（同 01-entry-agent.spec.ts 的"空"覆盖）——第 1 步
 *     之前断言 系统接入 的空态（`gatekeepers-empty`）与"接入一个系统"主按钮都可见。
 *   - 错: 连接信息错误/端点不可达——测试连通要给出具体原因，不是泛化的"失败"（本旅程没有走到这一
 *     步，见下方"今天能做到哪一步"；ConnectSystemLauncher.test.tsx 与 EnableGateConfirm 自己的失败
 *     态由组件测试覆盖）。
 *   - 无权限: 跳过——governance.spec.ts 已经覆盖"builder 以下角色看不到治理分组"的同类断言，本旅程
 *     不重复建号。
 *   - 窄屏: 跳过——W1-B 的截图/axe 门槛与批量设计评审已覆盖向导多步表单在 768px 下的可用性，本旅程
 *     只加一次真实端到端跑通。
 * 成功判据:
 *   - 一个人从"系统接入"空态开始，不碰 SQL/CLI，把一个系统的至少一个 Operation 发布出来，且这个
 *     Operation 出现在 能力目录 · Operation 里。
 *
 * 今天能做到哪一步（S8 W4-D，读代码后的结论，不是猜测）：steps 2-5 曾经 `test.fixme`，理由是"fake
 * 栈上没有可用的真实门可接"——但 `ConnectSystemLauncher` 本身就是 gate-host.spec.ts（P-B2a）与
 * integrations.spec.ts（P-B1）已经证明可达的同一条 fixture 的**工作区侧**半程：`ci-fixture-mcp`
 * （connector `fixture-mcp`）由 `.github/workflows/e2e.yml` 的 CI 种子步骤宣告为 `discovered`，
 * `integrations.spec.ts` 的第一个测试把它拨到平台 `enabled` + 接入包 `platform_preset`（按文件名
 * 排序 i < j，`playwright.config.ts` 的 `workers: 1`/`fullyParallel: false` 让整个套件顺序跑——
 * `01-entry-agent.spec.ts` 自己的 doc comment 已经依赖同一个事实）。到这一步为止，`ci-fixture-mcp`
 * 已经是"平台已提供的系统"（J5），`ConnectSystemLauncher` 的向导第一屏会在"使用已接入的系统"里列出
 * 它——选中它直接跳到"能力与策略"步，跳过的正是"填写连接信息、测试连通"这一段真人对着一个全新目标
 * 网络地址走的连接过程（这一段仍然需要真实网络/docker socket，fake 栈没有，留给以后一个专门的 W3
 * fixture 系统去补，不在这里假装接了一个真实系统）；从"能力与策略"步开始——看到它声明的 Operation
 * 列表、点"启用"发布——到"系统接入"列表与"能力目录"确认，是本次新增打通的部分，与
 * `ConnectSystemLauncher.test.tsx`（组件级，scripted http）的
 * "hosted path from the workspace page (non-admin owner)" 用例走的是同一段真实组件代码。
 *
 * `01-entry-agent.spec.ts` 已经用同一个 `ci-fixture-mcp` 做过"工作区自己启用"，但走的是 系统接入
 * 列表页自己的内联启用按钮（`AvailableGateInstancesSection`），不是这条旅程要证明的向导本身
 * （`ConnectSystemLauncher`）——两条旅程各自的 `createFreshWorkspace` 互不干扰，这里不是重复覆盖。
 */

const GATE_ID = 'ci-fixture-mcp';
const GATE_DISPLAY_NAME = 'CI fixture MCP';
const OBSERVE_OP = 'list_things';
const EXECUTE_OP = 'restart_thing';

test.describe('Journey ②: 接入一个新系统', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('end to end: from the systems empty state, use the launcher to publish a discovered system’s Operations', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // --- 0. 全新工作区 + 登入自己的 owner（"空"状态覆盖：见本文件顶部说明） -------------------
    const { ownerLogin, ownerTemporaryPassword } = await createFreshWorkspace(page);
    await page.getByRole('button', { name: /登出/ }).click();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    await selectOwnedWorkspace(page);
    await expect(page.getByTestId('nav-chats')).toBeVisible();

    // --- 空: 系统接入还没有任何门，"接入一个系统"主按钮是唯一入口 -----------------------------
    await goToByLabel(page, '系统接入');
    await expect(page.getByTestId('gatekeepers-empty')).toBeVisible();
    const connectButton = page.getByTestId('connect-system-button');
    await expect(connectButton).toBeVisible();

    // --- 1. 打开向导，选择"使用已接入的系统"里已经平台侧就绪的 ci-fixture-mcp -----------------
    await connectButton.click();
    const drawer = page.getByTestId('connect-system-drawer');
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    const launcher = drawer.getByTestId('connect-system-launcher');
    await expect(launcher).toBeVisible();

    const availableInstance = drawer.getByTestId(`launcher-available-instance-${GATE_ID}`);
    await expect(availableInstance).toBeVisible({ timeout: 15_000 });
    await availableInstance.click();

    // 选中"已接入的系统"直接跳到步骤③"能力与策略"（J5），跳过步骤②的连接表单——见本文件顶部说明。
    await expect(launcher).toHaveAttribute('data-step', '2', { timeout: 15_000 });

    // --- 3. 门注册成功后，看到它声明的 Operation 列表 -----------------------------------------
    const policyBody = drawer.getByTestId('launcher-step-policy-body');
    await expect(policyBody).toBeVisible();
    const announcedOperations = policyBody.getByTestId('launcher-announced-operations');
    await expect(announcedOperations).toBeVisible({ timeout: 15_000 });
    await expect(announcedOperations).toContainText(OBSERVE_OP);
    await expect(announcedOperations).toContainText(EXECUTE_OP);

    // --- 4. 挑选要发布的 Operation：enable_gate_instance 一次性发布全部声明的 Operation --------
    const workspaceSide = policyBody.getByTestId('launcher-workspace-enable');
    await expect(workspaceSide).toBeVisible();
    const enableButton = workspaceSide.getByTestId('launcher-workspace-enable-button');
    await expect(enableButton).toBeVisible({ timeout: 15_000 });
    await enableButton.click();
    const enableConfirm = workspaceSide.getByTestId('launcher-workspace-enable-button-confirm');
    await expect(enableConfirm).toBeVisible({ timeout: 15_000 });
    await enableConfirm.getByTestId('confirm-button').click();

    const linked = workspaceSide.getByTestId('launcher-workspace-linked');
    await expect(linked).toBeVisible({ timeout: 15_000 });
    await expect(linked).toContainText('已发布');
    await expect(linked.getByTestId('launcher-gatekeeper-chip')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // --- 5. 回到 系统接入 列表，确认门已注册、状态健康 -----------------------------------------
    await expect(
      page.getByTestId('gatekeeper-card').filter({ hasText: GATE_DISPLAY_NAME }),
    ).toHaveCount(1, { timeout: 15_000 });

    // --- 成功判据: 发布的 Operation 出现在 能力目录 · Operation 里 ----------------------------
    await goToByLabel(page, '能力目录');
    const catalogList = page.getByTestId('catalog-list');
    await expect(catalogList.or(page.getByTestId('catalog-empty'))).toBeVisible({
      timeout: 15_000,
    });
    await expect(catalogList.getByText(OBSERVE_OP, { exact: true })).toHaveCount(1);
    await expect(catalogList.getByText(EXECUTE_OP, { exact: true })).toHaveCount(1);
  });
});
