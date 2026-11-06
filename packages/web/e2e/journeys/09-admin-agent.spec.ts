import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import { type Page, expect, test } from '../lib/test.js';
import {
  asAdmin,
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './helpers.js';

/**
 * Journey ⑨: 管理员智能体提一份管理员提案，平台和工作区各自决定（S11 AA4d，AA4 方案 F9）
 *
 * 步骤:
 *   1. 先有一个别人的常规工作区当目标（`createFreshWorkspace`：新用户 + 他拥有的工作区）。平台
 *      管理员在「平台 → 管理员智能体」点「新建试验工作区」（页头，或还没有试验工作区时的空状态），
 *      新建工作区的表单开在「试验」上，所有者默认就是自己；建好后回到「管理员智能体」，这张卡片
 *      标着（S11 AA4e）。
 *   2. 卡片上「打开管理员对话」——切到试验工作区，「对话」里打开（没有就新建）一个管理员对话；还没
 *      选目标工作区，输入框上方提示这件事（S11 AA4e）。
 *   3. 发一条带 CI 专用标记的消息（见下方「标记」）。还没选目标工作区：这一轮以失败结束，回复里
 *      说没有选目标（错状态）。
 *   4. 点那条提示里的「去选择」：回到「管理员智能体」这张卡片，「选择目标工作区」已经打开；勾上步骤
 *      1 的目标工作区并保存。再「打开管理员对话」（打开的是同一个，提示不在了），重发标记：这一轮
 *      完成，回复里是它提出的管理员提案，工具调用下面有到这份提案的链接（S11 AA4e）。
 *   5. 跟着那条链接到「平台 → 管理员提案」里这份提案：工作区部分只有状态，看不到它会在工作区里改
 *      什么（没有逐项的差异，也没有 Skill 的名字和正文）；平台部分（新建一个门宿主实例）勾选确认后
 *      应用。
 *   6. 登出，以目标工作区所有者登入，切到自己的工作区：侧栏「能力目录」上有角标 1，「待我审批」里
 *      提示另有 1 份管理员提案（S11 AA4e）；跟着提示到「能力目录 → 管理员提案」（页签上也是 1），
 *      审阅并应用工作区部分，角标随之消失；跟着它留下的链接到「安装历史」，看到这条安装记录（来源
 *      是这份管理员提案）。
 *   7. 登出，平台管理员再登入：「管理员提案」里这份提案的平台部分已应用，跟着链接到「平台变更记录」，
 *      撤销按钮不可用，写明这份提案有工作区部分已经应用、要先由所有者撤销，并列出那个工作区。
 *
 * 标记: `FakeAgentRuntime`（`AGENT_RUNTIME=fake`）在管理员 Turn 的提示里看到
 *   `FAKE_ADMIN_PROPOSE_MARKER`，且内核的 `main()` 在 `FAKE_INVOKE_WORKER=1` 下接好了钩子时，不回显，
 *   而是脚本化地代表管理员智能体「决定调用 propose_admin_proposal」：用这一轮会话签发的管理员智能体
 *   Handle、像容器里那样出示，读目标、走真实的 `propose_admin_proposal` 分发（只许管理员智能体、
 *   上限、试验工作区 I-A6、已选目标、配额、凭据与内容检查、审计）。提议的内容是固定的：每个目标一个
 *   工作区部分（一个 Skill 的下一版），加一个平台部分（按部署带的第一个接入预设新建门宿主实例，地址
 *   解析不到）；名字带这一轮 id 的一段，所以每次都是新的。之后的审阅、应用、安装记录和撤销检查全是
 *   真实代码路径。见 packages/kernel/src/fake-admin-propose.ts。只有 fake 运行时认这个标记：
 *   `scripts/guards/fake-markers.mjs`（`pnpm ci:guards`）守着真 pi、platform-extension、
 *   agent-host 和生产镜像都不出现它，钩子只在 `FAKE_INVOKE_WORKER` 这一个 CI 开关后面。
 *
 * 状态覆盖:
 *   - 空: 新试验工作区的卡片上「还没有选目标工作区」（`admin-agent-no-targets`），管理员对话的
 *     输入框上方同样提示（`chat-admin-agent-no-targets`）。
 *   - 错: 没选目标就让它提议——这一轮 `failed`，回复里写明没有选目标（步骤 3）。
 *   - 无权限: 平台面看不到工作区部分的差异（步骤 5）；目标所有者在自己的「能力目录」里决定，不进
 *     平台面（步骤 6，他不是平台管理员）。平台管理员撤销不了有已应用工作区部分的平台变更（步骤 7）。
 *   - 窄屏: 768px 下经抽屉导航回到「管理员智能体」，卡片上照样列出选好的目标。
 *
 * 成功判据:
 *   - 一个平台管理员只在控制台里，从建试验工作区到拿到一份管理员提案，每一步都有到下一步的入口；
 *     平台部分在平台面应用，工作区部分只能由目标工作区的所有者在他的工作区里应用，并留下安装记录。
 *   - 目标工作区的所有者不用别人转告：登入就在控制台自己的待办里看到有提案在等他。
 *   - 平台面不展示工作区部分会改什么；平台变更记录在工作区部分已应用时不能撤销，并说清为什么。
 *
 * 前提: CI 的 kernel.env 打开了 `ADMIN_AGENT_ENABLED`（`.github/workflows/e2e.yml`）。本旅程让
 *   平台管理员成为一个试验工作区的所有者；排在它后面、以管理员登入的 spec 都按侧栏 testid 走平台
 *   页，不依赖管理员没有工作区。
 */

// `packages/kernel/src/application/host-bridge/fake-runtime.ts`'s `FAKE_ADMIN_PROPOSE_MARKER`: a
// plain string, not imported across packages (as `01-entry-agent.spec.ts` keeps its delegate
// marker), so searching the literal finds both sides of the contract.
const FAKE_ADMIN_PROPOSE_MARKER = '__nexttime_fake_admin_propose__';

/** `fake-admin-propose.ts`'s scripted reply: `propose_admin_proposal: proposed "<title>" (<id>), now <status>.` */
const PROPOSED_REPLY =
  /propose_admin_proposal: proposed "(CI admin proposal ([a-z0-9]+))" \(([0-9a-f-]{36})\), now proposed\./;

async function sendInChat(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder('输入消息…').fill(text);
  await page.getByRole('button', { name: '发送' }).click();
}

/** 「平台 → 管理员智能体」上这个试验工作区的卡片。 */
async function trialCard(page: Page, trialName: string) {
  await goToByLabel(page, '管理员智能体');
  await expect(page.getByTestId('platform-admin-agent-page')).toBeVisible();
  const card = page.getByTestId('admin-agent-workspace').filter({ hasText: trialName });
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  return card;
}

/** 卡片上「打开管理员对话」：切到试验工作区，打开它的管理员对话。 */
async function openAdminChat(page: Page, trialName: string): Promise<void> {
  const card = await trialCard(page, trialName);
  await card.getByTestId('admin-agent-open-chat').click();
  await expect(page.getByTestId('chat-header-admin-agent')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'connected');
}

test.describe('Journey ⑨: 管理员智能体提一份管理员提案', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('a trial workspace, a target, the marker, the platform part on the platform, the workspace part by its owner, the rollback refused', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    // --- 1. 目标工作区（别人的常规工作区）；从「管理员智能体」建平台管理员自己的试验工作区 --------
    const {
      workspaceName: targetName,
      ownerLogin,
      ownerTemporaryPassword,
    } = await createFreshWorkspace(page);
    const trialName = `journey-trial-${Date.now().toString(36)}`;
    await goToByLabel(page, '管理员智能体');
    await expect(page.getByTestId('platform-admin-agent-page')).toBeVisible();
    // 已有试验工作区时在页头，还没有时在空状态里；两处不会同时出现。
    await page
      .getByTestId('admin-agent-header-create-trial')
      .or(page.getByTestId('admin-agent-create-trial'))
      .click();
    const createDrawer = page.getByTestId('create-workspace-drawer');
    await expect(createDrawer.getByTestId('create-workspace-form')).toBeVisible();
    await expect(createDrawer.getByTestId('create-workspace-purpose')).toHaveValue('admin_trial');
    await createDrawer.locator('#cw-name').fill(trialName);
    // 所有者默认是正在操作的平台管理员自己。
    await expect(createDrawer.getByTestId('create-workspace-owner')).toHaveValue(
      new RegExp(`^${ADMIN_LOGIN} — `),
      { timeout: 15_000 },
    );
    await createDrawer.getByTestId('create-workspace-submit').click();

    // --- 2. 回到管理员智能体：这张卡片标着、空状态，然后打开管理员对话 ----------------------------
    await expect(page).toHaveURL(/#\/platform\/admin-agent\/[^/]+$/, { timeout: 20_000 });
    const card = page.getByTestId('admin-agent-workspace').filter({ hasText: trialName });
    await expect(card).toHaveAttribute('data-focused', 'true', { timeout: 15_000 });
    await expect(card.getByTestId('admin-agent-no-targets')).toBeVisible();
    await openAdminChat(page, trialName);
    await expect(page.getByTestId('chat-admin-agent-no-targets')).toBeVisible({ timeout: 15_000 });

    // --- 3. 错：没选目标就让它提议 ------------------------------------------------------------
    await sendInChat(page, `${FAKE_ADMIN_PROPOSE_MARKER} 提一份管理员提案`);
    await expect(page.locator('.turn-badge[data-status="failed"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('.message-assistant .message-text').last()).toContainText(
      'no proposal targets chosen',
    );

    // --- 4. 从提示去选目标工作区，回到同一个管理员对话，再让它提议 -------------------------------
    await page.getByTestId('chat-admin-agent-choose-targets').click();
    await expect(page).toHaveURL(/#\/platform\/admin-agent\/[^/]+\/targets$/, { timeout: 15_000 });
    const cardAgain = page.getByTestId('admin-agent-workspace').filter({ hasText: trialName });
    await expect(cardAgain).toHaveAttribute('data-focused', 'true', { timeout: 15_000 });
    const dialog = page.getByTestId('admin-agent-targets-dialog');
    await expect(dialog).toBeVisible();
    const option = dialog.getByTestId('admin-agent-target-option').filter({ hasText: targetName });
    const search = dialog.getByTestId('admin-agent-targets-search');
    // 常规工作区多于 8 个时才有筛选框（CI 栈里前面的 spec 已经建了不少）。
    await expect(option.or(search).first()).toBeVisible({ timeout: 15_000 });
    if (await search.isVisible()) await search.fill(targetName);
    await expect(option).toHaveCount(1);
    await option.locator('input[type="checkbox"]').check();
    await expect(dialog.getByTestId('admin-agent-targets-diff')).toContainText(targetName);
    await dialog.getByTestId('admin-agent-targets-save').click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(
      cardAgain.getByTestId('admin-agent-target').filter({ hasText: targetName }),
    ).toHaveCount(1, { timeout: 15_000 });

    await openAdminChat(page, trialName);
    // 打开的是步骤 3 那个对话（最近一个未归档的管理员对话），它的那一轮还在；选了目标，提示不在了。
    await expect(page.locator('.message-user .message-text').first()).toContainText(
      FAKE_ADMIN_PROPOSE_MARKER,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('chat-admin-agent-no-targets')).toHaveCount(0);
    await sendInChat(page, `${FAKE_ADMIN_PROPOSE_MARKER} 提一份管理员提案`);
    await expect(page.locator('.turn-badge[data-status="completed"]').last()).toBeVisible({
      timeout: 30_000,
    });
    const reply = page.locator('.message-assistant .message-text').last();
    await expect(reply).toHaveText(PROPOSED_REPLY);
    const matched = PROPOSED_REPLY.exec((await reply.textContent()) ?? '');
    const title = matched?.[1] ?? '';
    const suffix = matched?.[2] ?? '';
    const proposalId = matched?.[3] ?? '';
    expect(proposalId).not.toBe('');
    const skillName = `ci-admin-check-${suffix}`;
    // 工具调用下面（折起时在折叠行之外，进行中时在那一行上）有到这份提案的链接，读的是调用自己的结果。
    const proposalLink = page
      .locator(
        '[data-testid="tool-call-group-admin-proposal-link"]:visible, [data-testid="tool-call-admin-proposal-link"]:visible',
      )
      .last();
    await expect(proposalLink).toHaveAttribute('href', `#/platform/admin-proposals/${proposalId}`, {
      timeout: 15_000,
    });

    // --- 5. 跟着链接到平台面：看不到工作区部分的差异；应用平台部分 --------------------------------
    await proposalLink.click();
    const detail = page.getByTestId('platform-admin-proposal-detail');
    await expect(detail.getByTestId('platform-admin-proposal-title')).toHaveText(title, {
      timeout: 15_000,
    });
    const workspaceParts = detail.getByTestId('platform-admin-proposal-workspace-parts');
    await expect(workspaceParts).toContainText(targetName);
    await expect(workspaceParts.locator('input')).toHaveCount(0);
    await expect(workspaceParts.locator('[data-testid*="-item-"]')).toHaveCount(0);
    await expect(detail).not.toContainText(skillName);
    await expect(detail).not.toContainText('Compare the answer with the passages');

    const review = detail.getByTestId('platform-segment-review');
    await expect(review.getByTestId('platform-segment-items')).toBeVisible({ timeout: 15_000 });
    await review.getByTestId('platform-segment-item-1-confirm').check();
    await review.getByTestId('platform-segment-apply-trigger').click();
    await page.getByTestId('platform-segment-apply-confirm').getByTestId('confirm-button').click();
    await expect(detail.getByTestId('platform-admin-proposal-platform-status')).toHaveAttribute(
      'data-status',
      'applied',
      { timeout: 15_000 },
    );
    await expect(detail).not.toContainText(skillName);

    // --- 6. 目标工作区的所有者在自己的「能力目录」里应用工作区部分 --------------------------------
    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    await selectOwnedWorkspace(page);
    // 有一份提案在等他：侧栏「能力目录」上的角标，「待我审批」里的提示，「管理员提案」页签上的数字
    // ——内核按他这个所有者的范围数出来的。
    await expect(page.getByTestId('nav-catalog-badge')).toHaveText('1', { timeout: 15_000 });
    await goToByLabel(page, '待我审批');
    await expect(page.getByTestId('approvals-admin-proposals')).toContainText(
      '另有 1 份管理员提案',
      { timeout: 15_000 },
    );
    await page.getByTestId('approvals-admin-proposals-link').click();
    const proposalsTab = page.getByRole('tab', { name: /^管理员提案/ });
    await expect(proposalsTab).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    await expect(proposalsTab).toHaveText(/^管理员提案\s*1$/);
    await page.locator('[data-testid^="catalog-proposal-row-"]').filter({ hasText: title }).click();
    const segmentDetail = page.getByTestId('catalog-proposal-detail');
    await expect(segmentDetail.getByTestId('catalog-proposal-title')).toHaveText(title, {
      timeout: 15_000,
    });
    const items = segmentDetail.getByTestId('catalog-proposal-items');
    await expect(items).toContainText(skillName, { timeout: 15_000 });
    const ticks = items.locator('input[type="checkbox"]');
    for (let index = 0; index < (await ticks.count()); index += 1) await ticks.nth(index).check();
    await segmentDetail.getByTestId('catalog-proposal-apply-trigger').click();
    await page.getByTestId('catalog-proposal-apply-confirm').getByTestId('confirm-button').click();
    await expect(segmentDetail.getByTestId('catalog-proposal-status')).toHaveAttribute(
      'data-status',
      'applied',
      { timeout: 15_000 },
    );
    // 决定了，就不再等他：角标和页签上的数字都没了。
    await expect(page.getByTestId('nav-catalog-badge')).toHaveCount(0, { timeout: 15_000 });
    await expect(proposalsTab).toHaveText(/^管理员提案$/);
    await segmentDetail.getByTestId('catalog-proposal-record').getByRole('link').click();
    const change = page.getByTestId('catalog-change-detail');
    await expect(change).toBeVisible({ timeout: 15_000 });
    await expect(change.getByTestId('catalog-change-proposal')).toContainText(title);
    await expect(change.getByTestId('catalog-change-items')).toContainText(skillName);

    // --- 7. 平台管理员：平台变更记录撤销不了，因为有已应用的工作区部分 ----------------------------
    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await asAdmin(page);
    await goToByLabel(page, '管理员提案');
    await page.getByTestId(`platform-admin-proposal-row-${proposalId}`).click();
    const appliedDetail = page.getByTestId('platform-admin-proposal-detail');
    await expect(
      appliedDetail.getByTestId('platform-admin-proposal-platform-status'),
    ).toHaveAttribute('data-status', 'applied', { timeout: 15_000 });
    await appliedDetail.getByRole('link', { name: '在「平台变更记录」查看' }).click();
    await expect(page.getByTestId('admin-proposals-tab-records')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const record = page.getByTestId('platform-change-record-detail');
    await expect(record.getByTestId('platform-change-record-dependents')).toContainText(
      targetName,
      {
        timeout: 15_000,
      },
    );
    await expect(record.getByTestId('platform-change-record-rollback-trigger')).toBeDisabled();
    await expect(record.getByTestId('platform-change-record-rollback-missing-steps')).toContainText(
      '个工作区部分已经应用',
    );

    // --- 窄屏：768px 下经抽屉回到「管理员智能体」，选好的目标照样列着 -----------------------------
    await page.setViewportSize({ width: 768, height: 900 });
    // 窄屏下打开着的变更记录是一个抽屉，挡着导航：先关掉。
    const recordDrawer = page
      .getByRole('dialog')
      .filter({ has: page.getByTestId('platform-change-record-detail') });
    await expect(recordDrawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(recordDrawer).toBeHidden();
    const narrowCard = await trialCard(page, trialName);
    await expect(
      narrowCard.getByTestId('admin-agent-target').filter({ hasText: targetName }),
    ).toHaveCount(1);
  });
});
