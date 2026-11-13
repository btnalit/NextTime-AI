import type {
  EnableGateInstanceResultWire,
  OperationSummaryWire,
  PreviewGateInstanceEnableResultWire,
} from '@nexttime/shared';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import { type Page, expect, test } from '../lib/test.js';
import {
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './helpers.js';

/**
 * Journey ⑰: 一个 Operation 的去留——提议重分类、留下草稿不发布、丢弃这份草稿；弃用另一个 Operation
 * （遗留 657，缺口 G5：控制台写操作走真实内核）
 *
 * 步骤:
 *   1. 所有者在「系统与授权」打开「接入一个系统」，选「使用已接入的系统」里已在本工作区启用的 CI fixture
 *      门，直接到「能力与策略」；在「审核 Operation 分类」里给只读的那个 Operation 点「提议重分类」，把
 *      影响范围从低调到高，提交（`propose_operation`）。
 *   2. 内核答复这次改动收紧了治理，于是弹出「发布这次重分类」确认框、列出改动；所有者改了主意，点取消——
 *      页面说草稿已保留、未发布。
 *   3. 「能力目录 → Operation」里打开这份第 2 版草稿，写上丢弃原因，丢弃（`discard_operation_draft`）。
 *   4. 打开门的另一个、执行类的 Operation（已发布），弃用它（`deprecate_operation`）。
 * 状态覆盖:
 *   - 空: 跳过——空的能力目录与空的系统与授权由旅程 ② ⑮ 覆盖；这条旅程从一个已启用的门开始。
 *   - 错: 跳过——门自己的导入草稿未发布前重分类被拒（409）、门自己设置的参数、声明了"不存在"回答的草稿
 *     与丢弃被拒（草稿已变）由 OnboardingWizardReview / CatalogPage 的组件测试覆盖，内核一侧由
 *     repeat-call 与各 handler 的集成测试覆盖。
 *   - 无权限: 跳过——非构建者看不到「提议重分类」（`wizard-review-builder-only`）由组件测试覆盖；旅程 ⑧
 *     走过各角色打开这些页不出 403。
 *   - 窄屏: 跳过——`00-gates/` 的截图门槛在 768 宽度下截过能力目录与系统与授权。
 * 成功判据:
 *   - 三个动作都由真实内核答复：确认框里的改动是内核判定的「收紧」，取消后页面说「草稿已保留、未发布」；
 *     丢弃与弃用各有页面的提示（「名称 v2 已丢弃」「名称 已弃用」）。并从页面外读 `list_operations`
 *     确认真的变了：提议之后这个 Operation 有一份第 2 版、影响范围为高的草稿，在用的第 1 版没变；丢弃后
 *     草稿不再列出，在用的仍是影响范围为低的第 1 版；弃用后另一个 Operation 的第 1 版是已弃用。
 *
 * 准备工作在页面外做，不算控制台操作：启用 CI 的 fixture 门（旅程 ① ② 在控制台里走过；启用即导入并
 * 发布它公告的两个 Operation——门自己的导入草稿在发布前不能重分类，所以从已发布的版本开始）。只有页面发出
 * 的调用才算数（`lib/test.ts`），所以准备和核对都从 Node 调，三个动作都由页面发出。
 */

const GATE_ID = 'ci-fixture-mcp';
/** The fixture gate's two Operations (`.github/workflows/e2e.yml`'s announce step): an observe
 *  one at blast radius low, an execute one at medium. */
const OBSERVE_OP = 'list_things';
const EXECUTE_OP = 'restart_thing';

const RUN = Date.now().toString(36);
const DISCARD_REASON = `影响范围先不改，等评估完再说（${RUN}）`;

interface CapResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** A capability called as the signed-in owner from Node — setup and reads only. */
async function callCap<T>(page: Page, name: string, data: unknown): Promise<T> {
  const res = await page.request.post(`/api/cap/${name}`, {
    headers: { 'x-requested-with': 'nexttime' },
    data,
  });
  const body = (await res.json()) as CapResult;
  if (!body.ok) throw new Error(`capability ${name} failed: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/** Every listed version of one of the gate's Operations (`list_operations` leaves discarded drafts
 *  out, and lists published and deprecated versions alike). */
async function versionsOf(
  page: Page,
  gatekeeperId: string,
  name: string,
): Promise<OperationSummaryWire[]> {
  const { items } = await callCap<{ items: OperationSummaryWire[] }>(page, 'list_operations', {
    gatekeeperId,
  });
  return items.filter((op) => op.name === name);
}

test.describe('Journey ⑰: 一个 Operation 的去留', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('propose a reclassification, keep the draft at the confirm, discard it; deprecate another Operation', async ({
    page,
  }) => {
    test.setTimeout(150_000);

    // --- 0. 全新工作区 + 它的所有者；启用 fixture 门（页面外） ----------------------------------
    const { ownerLogin, ownerTemporaryPassword } = await createFreshWorkspace(page);
    await page.getByRole('button', { name: '登出', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true }).first()).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    await selectOwnedWorkspace(page);

    // Legacy 311: an enable names the manifest digest its preview showed.
    const { manifestDigest } = await callCap<PreviewGateInstanceEnableResultWire>(
      page,
      'preview_gate_instance_enable',
      { gateId: GATE_ID },
    );
    const { gatekeeperId } = await callCap<EnableGateInstanceResultWire>(
      page,
      'enable_gate_instance',
      { gateId: GATE_ID, manifestDigest },
    );
    expect(await versionsOf(page, gatekeeperId, OBSERVE_OP)).toEqual([
      expect.objectContaining({ status: 'published', version: 1, blastRadius: 'low' }),
    ]);
    expect(await versionsOf(page, gatekeeperId, EXECUTE_OP)).toEqual([
      expect.objectContaining({ status: 'published', version: 1 }),
    ]);

    // --- 1. 接入一个系统 → 已接入的 fixture 门 → 审核分类：把只读 Operation 的影响范围调高，提交 ---
    await goToByLabel(page, '系统与授权');
    await page.getByRole('button', { name: '接入一个系统', exact: true }).click();
    const drawer = page.getByTestId('connect-system-drawer');
    await drawer.getByRole('radio', { name: /CI fixture MCP/ }).click({ timeout: 15_000 });
    // An instance already enabled here skips straight to 能力与策略, the review under it.
    await expect(drawer.getByTestId('connect-system-launcher')).toHaveAttribute('data-step', '2', {
      timeout: 15_000,
    });
    await expect(drawer.getByTestId('launcher-workspace-linked')).toBeVisible({ timeout: 15_000 });

    const reviewRow = drawer.getByTestId('wizard-review-row').filter({ hasText: OBSERVE_OP });
    await reviewRow
      .getByRole('button', { name: '提议重分类', exact: true })
      .click({ timeout: 15_000 });
    const reclassify = drawer.getByTestId('wizard-review-reclassify-form');
    const blastRadius = reclassify.getByRole('combobox', { name: '影响范围', exact: true });
    await expect(blastRadius).toHaveValue('low');
    await blastRadius.selectOption('high');
    await reclassify.getByRole('button', { name: '提交', exact: true }).click();

    // --- 2. 内核说这次改动收紧了治理：确认框列出改动；取消，草稿留着、不发布 -------------------------
    // The confirm is a popover opened inside the launcher drawer; found by its test id, its title
    // checked by name.
    const confirm = page.getByTestId('wizard-review-reclassify-confirm');
    await expect(confirm).toBeVisible({ timeout: 15_000 });
    await expect(confirm).toHaveAccessibleName('发布这次重分类');
    await expect(confirm.getByTestId('governance-diff-list-item')).toHaveAttribute(
      'data-direction',
      'tightened',
    );
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(reclassify.getByTestId('wizard-review-draft-kept')).toContainText(
      '草稿已保留、未发布',
    );

    const proposed = await versionsOf(page, gatekeeperId, OBSERVE_OP);
    const draft = proposed.find((op) => op.status === 'draft');
    expect(draft).toMatchObject({
      blastRadius: 'high',
      governanceChange: { direction: 'tightened' },
    });
    expect(proposed.filter((op) => op.status === 'published')).toEqual([
      expect.objectContaining({ version: 1, blastRadius: 'low' }),
    ]);
    const draftVersion = (draft as OperationSummaryWire).version;
    expect(draftVersion).toBeGreaterThan(1);
    const draftLabel = `${OBSERVE_OP} v${draftVersion}`;

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // --- 3. 能力目录 → Operation：打开这份草稿，写上原因，丢弃 --------------------------------------
    await goToByLabel(page, '能力目录');
    await page
      .getByRole('tablist', { name: 'Catalog section' })
      .getByRole('tab', { name: 'Operation', exact: true })
      .click();
    const operations = page.getByRole('list', { name: 'Operations', exact: true });
    const observeRows = operations.getByRole('button', { name: new RegExp(OBSERVE_OP) });
    await observeRows.filter({ hasText: `v${draftVersion}` }).click({ timeout: 15_000 });
    const detail = page.getByTestId('catalog-detail');
    await detail.getByRole('button', { name: '丢弃', exact: true }).click();
    const discard = page.getByRole('dialog', { name: `丢弃 ${draftLabel}` });
    await discard.getByRole('textbox', { name: '丢弃原因', exact: true }).fill(DISCARD_REASON);
    await discard.getByRole('button', { name: '丢弃', exact: true }).click();
    await expect(page.getByText(`${draftLabel} 已丢弃`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(observeRows).toHaveCount(1, { timeout: 15_000 });

    expect(await versionsOf(page, gatekeeperId, OBSERVE_OP)).toEqual([
      expect.objectContaining({ status: 'published', version: 1, blastRadius: 'low' }),
    ]);

    // --- 4. 门的执行类 Operation：已发布，弃用 -------------------------------------------------------
    const executeRow = operations.getByRole('button', { name: new RegExp(EXECUTE_OP) });
    await executeRow.click({ timeout: 15_000 });
    await detail.getByRole('button', { name: '弃用', exact: true }).click();
    const deprecate = page.getByRole('dialog', { name: `弃用 ${EXECUTE_OP}` });
    await deprecate.getByRole('button', { name: '弃用', exact: true }).click();
    await expect(page.getByText(`${EXECUTE_OP} 已弃用`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // The detail follows the version it deprecated and says there is no way back.
    await expect(detail.getByTestId('operation-deprecated-note')).toBeVisible({ timeout: 15_000 });
    await expect(executeRow).toContainText('已弃用', { timeout: 15_000 });

    expect(await versionsOf(page, gatekeeperId, EXECUTE_OP)).toEqual([
      expect.objectContaining({ status: 'deprecated', version: 1 }),
    ]);
  });
});
