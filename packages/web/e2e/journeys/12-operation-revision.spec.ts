import type { EnableGateInstanceResultWire, OperationSummaryWire } from '@nexttime/shared';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import { type Page, expect, test } from '../lib/test.js';
import {
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './helpers.js';

/**
 * Journey ⑫: 发布一个 Operation 的修订，再与门的公告对齐（遗留 657，缺口 G5：控制台写操作走真实内核）
 *
 * 步骤:
 *   1. 所有者在「能力目录」打开一个 Operation 的修订草稿（它比在用的版本收紧了影响级），看清确认框里
 *      改了哪些治理字段，发布它（`publish_operation`）。
 *   2. 「系统与授权」里这个门的那一行随即说：已部署的 Operation 分类与平台最新清单不一致。所有者点
 *      「对齐」，看清确认框列出的改动，确认（`refresh_operation_governance`）。
 * 状态覆盖:
 *   - 空: `createFreshWorkspace` 给一个全新工作区，只启用了 CI 的 fixture 门。
 *   - 错: 跳过——门的定义变了、平台还没采用新清单这两种情况在旅程 ② 里覆盖（替身，原因见那个文件的
 *     头注释）；发布被拒（草稿已变、门自己设置的参数）由 CatalogPage 的组件测试覆盖。
 *   - 无权限: 跳过——非所有者看不到「对齐」，由 SystemAccessCard / GovernanceDriftNotice 的组件测试
 *     覆盖；旅程 ⑧ 走过各角色打开这些页不出 403。
 *   - 窄屏: 跳过——`00-gates/` 的截图门槛在 768 宽度下截过能力目录与系统与授权。
 * 成功判据:
 *   - 两步都由真实内核答复：页面说出结果（「已发布 v2」的提示；门那一行的「已对齐 1 个 Operation 的
 *     分类」），从页面外读 `list_operations` 看到在用的是第 2 版，影响级先是收紧后的「高」，对齐后回到
 *     门公告的「中」——对齐是就地改写，不产生新版本。
 *
 * 准备工作在页面外做，不算控制台操作：启用 fixture 门（旅程 ① ② 在控制台里走过），再以所有者本人提议
 * 一个修订草稿——控制台的入口是「接入一个系统」里的「提议重分类」（旅程 ⑯ 走过），这条旅程要看的是发布与对齐。
 * 草稿的定义与门公告的完全相同（`.github/workflows/e2e.yml` 的公告步骤），只把影响级从 medium 收紧到
 * high：定义没变，对齐时只改治理字段、不另开修订；平台门的放宽就地生效（自接入的门才要等发布）。
 */

const GATE_ID = 'ci-fixture-mcp';
const GATE_DISPLAY_NAME = 'CI fixture MCP';
const EXECUTE_OP = 'restart_thing';

/** `restart_thing` exactly as the CI step announces it, but with its blast radius tightened. */
const TIGHTENED = {
  name: EXECUTE_OP,
  binding: { kind: 'mcp', tool_name: EXECUTE_OP },
  params_schema: { type: 'object', properties: {} },
  mode: 'execute',
  blast_radius: 'high',
  reversibility: false,
  auto_approvable: false,
  await_decision: true,
  reads: [],
  writes: [],
  destructive_hint: false,
  idempotent_hint: true,
};

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

async function publishedOperation(page: Page, gatekeeperId: string): Promise<OperationSummaryWire> {
  const { items } = await callCap<{ items: OperationSummaryWire[] }>(page, 'list_operations', {
    gatekeeperId,
  });
  const published = items.filter((op) => op.name === EXECUTE_OP && op.status === 'published');
  expect(published).toHaveLength(1);
  return published[0] as OperationSummaryWire;
}

test.describe('Journey ⑫: 发布 Operation 修订，再与门的公告对齐', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('publish a tightened revision, then align it back to the gate’s announcement', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // --- 0. 全新工作区 + 它的所有者；fixture 门启用、修订草稿提议（页面外） ---------------------
    const { ownerLogin, ownerTemporaryPassword } = await createFreshWorkspace(page);
    await page.getByRole('button', { name: '登出', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true }).first()).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    await selectOwnedWorkspace(page);

    const { gatekeeperId } = await callCap<EnableGateInstanceResultWire>(
      page,
      'enable_gate_instance',
      { gateId: GATE_ID },
    );
    const before = await publishedOperation(page, gatekeeperId);
    expect(before).toMatchObject({ version: 1, blastRadius: 'medium' });
    await callCap(page, 'propose_operation', { gatekeeperId, operation: TIGHTENED });

    // --- 1. 能力目录：打开修订草稿，看清收紧了什么，发布 -----------------------------------------
    await goToByLabel(page, '能力目录');
    const catalog = page.getByRole('list', { name: /Operation/ });
    const draftRow = catalog
      .getByRole('button', { name: new RegExp(EXECUTE_OP) })
      .filter({ hasText: 'v2' });
    await draftRow.click({ timeout: 15_000 });
    await page.getByRole('button', { name: '发布', exact: true }).click();
    const publish = page.getByRole('dialog', { name: '发布这个 Operation' });
    await expect(publish).toContainText(EXECUTE_OP);
    await expect(publish).toContainText('中影响→高影响');
    await publish.getByRole('button', { name: '发布', exact: true }).click();
    await expect(page.getByText(/已发布 v2$/)).toBeVisible({ timeout: 15_000 });

    const published = await publishedOperation(page, gatekeeperId);
    expect(published).toMatchObject({ version: 2, blastRadius: 'high', autoApprovable: false });

    // --- 2. 系统与授权：门那一行说分类不一致，对齐回门公告的值 -----------------------------------
    await goToByLabel(page, '系统与授权');
    const gateRow = page.getByTestId('gatekeeper-card').filter({ hasText: GATE_DISPLAY_NAME });
    await expect(gateRow).toContainText('分类与平台最新清单不一致', { timeout: 15_000 });
    await expect(gateRow).toContainText(EXECUTE_OP);
    await gateRow.getByRole('button', { name: '对齐', exact: true }).click();
    const align = page.getByRole('dialog', { name: '与门公告对齐' });
    await expect(align).toContainText(EXECUTE_OP);
    await align.getByRole('button', { name: '对齐', exact: true }).click();
    await expect(gateRow).toContainText('已对齐 1 个 Operation 的分类', { timeout: 15_000 });
    await expect(gateRow).not.toContainText('分类与平台最新清单不一致');

    const aligned = await publishedOperation(page, gatekeeperId);
    // Review of #1043 (#501): aligning loosened only the blast radius — still needs approval.
    expect(aligned).toMatchObject({ version: 2, blastRadius: 'medium', autoApprovable: false });
  });
});
