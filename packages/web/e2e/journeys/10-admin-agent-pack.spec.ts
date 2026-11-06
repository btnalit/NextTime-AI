import { type Page, expect, test } from '@playwright/test';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import {
  asAdmin,
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './helpers.js';

/**
 * Journey ⑩: 管理员智能体提议给一个工作区装能力包，所有者装上，又整条撤销（S11 AA5g，
 * docs/admin-agent-packs-design-2026-11-06.md）
 *
 * 步骤:
 *   1. 先有一个别人的常规工作区当目标（`createFreshWorkspace`）。平台管理员在「平台 → 管理员智能体」
 *      点「新建试验工作区」，填名称、创建；回到「管理员智能体」，在这张卡片上「选择目标工作区」，勾上
 *      目标并保存。
 *   2. 「打开管理员对话」，发一条带 CI 专用标记的消息（见下方「标记」）：这一轮完成，回复里是它用
 *      `propose_pack_install` 提出的管理员提案。
 *   3. 登出，以目标工作区所有者登入、切到自己的工作区：「能力目录 → 管理员提案」里有这份提案；打开它，
 *      写明它请求装哪个能力包的哪一版，「安装 vN…」审阅会改动什么（和在「能力包」页安装时同一个审阅），
 *      确认安装。这一部分记为已应用；「待确认」下已经没有它。
 *   4. 跟着它留下的「在「安装历史」查看」到这条安装记录，「撤销这条安装记录…」确认撤销：记录已撤销。
 *   5. 回到「管理员提案」，筛「全部」：这份提案的这一部分随之记为已撤销（同一个事务，rollback.ts），
 *      写明是应用后又撤销的。
 *   6. 登出，平台管理员再登入：「平台 → 管理员提案」里这份提案的工作区部分也是已撤销，写着请求的能力包。
 *
 * 标记: `FakeAgentRuntime`（`AGENT_RUNTIME=fake`）在管理员 Turn 的提示里看到
 *   `FAKE_ADMIN_PROPOSE_PACK_MARKER`，且内核的 `main()` 在 `FAKE_INVOKE_WORKER=1` 下接好了钩子时，
 *   不回显，而是脚本化地代表管理员智能体：用这一轮会话签发的管理员智能体 Handle 走真实的
 *   `agent_list_packs`，挑一个不要求系统、不依赖别的包的能力包（按名字排第一个），再走真实的
 *   `propose_pack_install` 分发（只许管理员智能体、试验工作区、已选目标、配额、审计），每个目标一个
 *   工作区部分；标题带这一轮 id 的一段，所以每次都是新的。之后的审阅、安装、安装记录和撤销全是真实
 *   代码路径。见 packages/kernel/src/fake-admin-propose.ts。和 ⑨ 的标记一样只有 fake 运行时认它，
 *   `scripts/guards/fake-markers.mjs`（`pnpm ci:guards`）守着。
 *
 * 状态覆盖:
 *   - 空: 装上之后，「管理员提案」默认的「待确认」筛选下已经没有它（`catalog-proposals-empty`）。
 *   - 错: 没有目标时提议会失败，已由 ⑨ 覆盖；这里覆盖的是终态——撤销之后这一部分不再提供「安装」，
 *     记录上也不再提供撤销。
 *   - 无权限: 平台面只看得到工作区部分的状态和请求的能力包，没有安装入口（步骤 6）；装不装由目标工作区
 *     的所有者在他自己的「能力目录」里决定（他不是平台管理员）。
 *   - 窄屏: 步骤 6 在 768px 下经抽屉导航到「管理员提案」，照样看得到这一部分已撤销。
 *
 * 成功判据:
 *   - 管理员智能体只能提议装包；包是目标工作区的所有者自己审阅后装上的，留下一条来源是这个能力包的
 *     安装记录。
 *   - 撤销那条安装记录，管理员提案的这一部分随之记为已撤销——提案和工作区里的实际状态不会各说各的。
 *   - 平台管理员在平台面看得到结果，看不到、也做不了工作区里的安装。
 *
 * 前提: 同 ⑨，CI 的 kernel.env 打开了 `ADMIN_AGENT_ENABLED`（`.github/workflows/e2e.yml`）。新代码
 *   只按角色 / 标签 / 文字操作（`scripts/guards/e2e-locators.mjs`）；test id 只用来圈范围和断言。
 */

// `packages/kernel/src/application/host-bridge/fake-runtime.ts`'s `FAKE_ADMIN_PROPOSE_PACK_MARKER`:
// a plain string, not imported across packages (as ⑨ keeps its marker), so searching the literal
// finds both sides of the contract.
const FAKE_ADMIN_PROPOSE_PACK_MARKER = '__nexttime_fake_admin_pack__';

/** `fake-admin-propose.ts`'s scripted reply: `propose_pack_install: proposed "<title>" (<id>), now <status>.` */
const PROPOSED_REPLY =
  /propose_pack_install: proposed "(CI pack install [a-z0-9]+)" \(([0-9a-f-]{36})\), now proposed\./;

/** 「平台 → 管理员智能体」上这个试验工作区的卡片。 */
async function trialCard(page: Page, trialName: string) {
  await goToByLabel(page, '管理员智能体');
  await expect(page.getByTestId('platform-admin-agent-page')).toBeVisible();
  const card = page.getByTestId('admin-agent-workspace').filter({ hasText: trialName });
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  return card;
}

test.describe('Journey ⑩: 管理员智能体提议装能力包，所有者装上又撤销', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('the admin agent proposes a pack install, the owner installs it, the install record rolls back and the part with it', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    // --- 1. 目标工作区；试验工作区；选目标 ------------------------------------------------------
    const {
      workspaceName: targetName,
      ownerLogin,
      ownerTemporaryPassword,
    } = await createFreshWorkspace(page);
    const trialName = `journey-pack-trial-${Date.now().toString(36)}`;
    await goToByLabel(page, '管理员智能体');
    await expect(page.getByTestId('platform-admin-agent-page')).toBeVisible();
    // 已有试验工作区时在页头，还没有时在空状态里；两处不会同时出现。
    await page.getByRole('link', { name: '新建试验工作区' }).click();
    const createDrawer = page.getByTestId('create-workspace-drawer');
    await expect(createDrawer.getByTestId('create-workspace-purpose')).toHaveValue('admin_trial');
    // By role, not `getByLabel`: `getByLabel` matches the label's text, aria-hidden included, so
    // `<Field required>`'s asterisk makes it 「名称*」; the accessible name (what a screen reader
    // reads, and `getByRole` computes) is 「名称」.
    await createDrawer.getByRole('textbox', { name: '名称', exact: true }).fill(trialName);
    await expect(createDrawer.getByTestId('create-workspace-owner')).toHaveValue(
      new RegExp(`^${ADMIN_LOGIN} — `),
      { timeout: 15_000 },
    );
    await createDrawer.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page).toHaveURL(/#\/platform\/admin-agent\/[^/]+$/, { timeout: 20_000 });

    const card = page.getByTestId('admin-agent-workspace').filter({ hasText: trialName });
    await expect(card).toHaveAttribute('data-focused', 'true', { timeout: 15_000 });
    await card.getByRole('button', { name: '选择目标工作区' }).click();
    const dialog = page.getByTestId('admin-agent-targets-dialog');
    await expect(dialog).toBeVisible();
    const targetBox = dialog.getByRole('checkbox', { name: targetName, exact: true });
    const search = dialog.getByLabel('按名称筛选工作区');
    // 常规工作区多于 8 个时才有筛选框（CI 栈里前面的 spec 已经建了不少）。
    await expect(targetBox.or(search).first()).toBeVisible({ timeout: 15_000 });
    if (await search.isVisible()) await search.fill(targetName);
    await targetBox.check();
    await dialog.getByRole('button', { name: '保存目标' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(
      card.getByTestId('admin-agent-target').filter({ hasText: targetName }),
    ).toHaveCount(1, { timeout: 15_000 });

    // --- 2. 管理员对话：让它提议装一个能力包 -----------------------------------------------------
    await card.getByRole('button', { name: '打开管理员对话' }).click();
    await expect(page.getByTestId('chat-header-admin-agent')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'connected');
    await page
      .getByPlaceholder('输入消息…')
      .fill(`${FAKE_ADMIN_PROPOSE_PACK_MARKER} 建议装一个能力包`);
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('.turn-badge[data-status="completed"]').last()).toBeVisible({
      timeout: 30_000,
    });
    const reply = page.locator('.message-assistant .message-text').last();
    await expect(reply).toHaveText(PROPOSED_REPLY);
    const matched = PROPOSED_REPLY.exec((await reply.textContent()) ?? '');
    const title = matched?.[1] ?? '';
    expect(matched?.[2] ?? '').not.toBe('');

    // --- 3. 目标工作区的所有者：审阅、安装 -------------------------------------------------------
    await page.getByRole('button', { name: '登出' }).click();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    await selectOwnedWorkspace(page);
    await expect(page.getByTestId('nav-catalog-badge')).toHaveText('1', { timeout: 15_000 });
    await goToByLabel(page, '能力目录');
    const proposalsTab = page.getByRole('tab', { name: /^管理员提案/ });
    await proposalsTab.click();
    await expect(proposalsTab).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: new RegExp(title) }).click();
    const segmentDetail = page.getByTestId('catalog-proposal-detail');
    await expect(segmentDetail.getByTestId('catalog-proposal-title')).toHaveText(title, {
      timeout: 15_000,
    });
    const review = segmentDetail.getByTestId('catalog-proposal-pack-review');
    await expect(review.getByTestId('catalog-proposal-pack-ask')).toContainText(
      '请求在本工作区安装能力包',
      {
        timeout: 15_000,
      },
    );
    await expect(review).toContainText('未安装');
    // 提议的是哪个包由内核按 `agent_list_packs` 挑（见文件头「标记」），这里从审阅上读出来。
    const packName = (
      (await review.getByTestId('catalog-proposal-pack-link').textContent()) ?? ''
    ).trim();
    expect(packName).not.toBe('');
    const installButton = review.getByRole('button', { name: /^安装 v[0-9]+…$/ });
    const version = /v([0-9]+)/.exec((await installButton.textContent()) ?? '')?.[1] ?? '';
    expect(version).not.toBe('');
    await installButton.click();
    const installConfirm = page.getByTestId('catalog-pack-install-confirm');
    await expect(installConfirm.getByTestId('catalog-pack-preview')).toBeVisible({
      timeout: 15_000,
    });
    await installConfirm.getByRole('button', { name: '安装', exact: true }).click();
    await expect(segmentDetail.getByTestId('catalog-proposal-status')).toHaveAttribute(
      'data-status',
      'applied',
      { timeout: 15_000 },
    );
    // 空：决定了，「待确认」下就没有它了，角标也没了。
    await expect(page.getByTestId('catalog-proposals-empty')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('nav-catalog-badge')).toHaveCount(0, { timeout: 15_000 });

    // --- 4. 安装记录：来源是这个能力包；整条撤销 -------------------------------------------------
    await segmentDetail
      .getByTestId('catalog-proposal-record')
      .getByRole('link', { name: '在「安装历史」查看' })
      .click();
    const change = page.getByTestId('catalog-change-detail');
    await expect(change).toContainText(`能力包 ${packName} v${version}`, { timeout: 15_000 });
    await change.getByRole('button', { name: '撤销这条安装记录…' }).click();
    const rollbackConfirm = page.getByTestId('catalog-change-rollback-confirm');
    await expect(rollbackConfirm.getByTestId('catalog-change-preview')).toBeVisible({
      timeout: 15_000,
    });
    await rollbackConfirm.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(change.getByTestId('catalog-change-status')).toHaveText('已撤销', {
      timeout: 15_000,
    });
    await expect(change.getByRole('button', { name: '撤销这条安装记录…' })).toHaveCount(0);

    // --- 5. 管理员提案的这一部分随之已撤销 -------------------------------------------------------
    await proposalsTab.click();
    await page.getByLabel('按状态筛选').selectOption('all');
    await page.getByRole('button', { name: new RegExp(title) }).click();
    const rolledBack = page.getByTestId('catalog-proposal-detail');
    await expect(rolledBack.getByTestId('catalog-proposal-status')).toHaveAttribute(
      'data-status',
      'rolled_back',
      { timeout: 15_000 },
    );
    await expect(rolledBack.getByTestId('catalog-proposal-record')).toContainText('应用后又撤销了');
    await expect(rolledBack.getByRole('button', { name: /^安装 v/ })).toHaveCount(0);

    // --- 6. 平台管理员（窄屏）：工作区部分已撤销，平台面没有安装入口 ----------------------------
    await page.getByRole('button', { name: '登出' }).click();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await asAdmin(page);
    await page.setViewportSize({ width: 768, height: 900 });
    await goToByLabel(page, '管理员提案');
    await page.getByRole('button', { name: new RegExp(title) }).click();
    const detail = page.getByTestId('platform-admin-proposal-detail');
    await expect(detail.getByTestId('platform-admin-proposal-title')).toHaveText(title, {
      timeout: 15_000,
    });
    const part = detail
      .getByTestId('platform-admin-proposal-workspace-parts')
      .getByTestId(/^platform-admin-proposal-workspace-part-[0-9]+$/)
      .filter({ hasText: targetName });
    await expect(part.locator('[data-status="rolled_back"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(part.getByTestId(/-pack$/)).toHaveText(`请求安装能力包 ${packName} v${version}`);
    await expect(detail.getByRole('button', { name: /^安装/ })).toHaveCount(0);

    // 试验工作区还在，目标照样列着（下一次提议不用重选）。
    await page.keyboard.press('Escape');
    const again = await trialCard(page, trialName);
    await expect(
      again.getByTestId('admin-agent-target').filter({ hasText: targetName }),
    ).toHaveCount(1);
  });
});
