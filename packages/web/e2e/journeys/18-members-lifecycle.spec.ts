import type {
  CreateUserResultWire,
  PrincipalWire,
  UserMembershipWire,
  WorkspaceWire,
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
 * Journey ⑱: 成员资格与服务凭证的一生——平台管理员把一个用户加进工作区、改角色、移出；所有者给一个服务
 * 凭证改角色、轮换 API key、停用它（遗留 657，缺口 G5：控制台写操作走真实内核）
 *
 * 步骤:
 *   1. 平台管理员在「用户」里找到一个还不属于任何工作区的用户，点「管理 → 管理成员资格」，把他加入这条
 *      旅程的全新工作区，角色保持默认的成员（`add_membership`）。
 *   2. 在这一条成员资格上把角色改成运维（`set_membership_role`）。
 *   3. 点「移出」再「确认移出」（`remove_membership`）——成员资格留着、标为已停用。
 *   4. 工作区所有者在「成员与授权」打开一个服务凭证，把角色从成员改成运维、保存（`set_principal_role`）。
 *   5. 「轮换 API key」，新 key 只显示一次（`rotate_api_key`）。
 *   6. 「停用成员」再「确认停用」（`disable_principal`）。
 * 状态覆盖:
 *   - 空: 第 1 步之前——这个用户的成员资格抽屉说还不属于任何工作区。
 *   - 错: 跳过——重复加入（already_member）、移出或降级唯一的所有者（last_owner）、给人签发 API key、
 *     停用自己由 UserMembershipsPanel / PrincipalDetail 的组件测试覆盖，内核一侧由 repeat-call 与各
 *     handler 的集成测试覆盖。
 *   - 无权限: 跳过——旅程 ⑧ 走过各角色打开成员与授权不出 403；非所有者看不到编辑区由组件测试覆盖。
 *   - 窄屏: 跳过——`00-gates/` 的截图门槛在 768 宽度下截过成员与授权和用户页。
 * 成功判据:
 *   - 六个动作都由真实内核答复，页面跟着变（新的成员资格一行、已停用的标记、轮换后的新 key、状态「已停用」），
 *     并从页面外读内核状态确认真的变了：`list_user_memberships` 先是成员、再是运维、最后已停用；
 *     `list_principals` 里服务凭证的角色是运维、停用时间有了；轮换后新 key 能以这个服务凭证的身份调用
 *     `get_workspace`，旧 key 被拒（401）。
 *
 * 准备工作在页面外做，不算控制台操作：平台管理员建一个不加入任何工作区的用户（`create_user`，旅程 ⑥ 与
 * `createPlatformUser` 在控制台里走过），所有者建一个成员角色的服务凭证（`create_principal`，旅程 ⑮ 同样在
 * 页面外建）。这条旅程只动自己建的用户、工作区和服务凭证，不碰平台管理员和共享的用户。只有页面发出的调用才
 * 算数（`lib/test.ts`），所以准备和核对都从 Node 调，六个动作都由页面发出。
 */

const RUN = Date.now().toString(36);
const MEMBER_LOGIN = `j18member${RUN}`;
const MEMBER_NAME = `旅程⑱ 成员 ${RUN}`;
const SERVICE_NAME = `旅程⑱ 服务凭证 ${RUN}`;

interface CapResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

async function capResult<T>(name: string, res: { json(): Promise<unknown> }): Promise<T> {
  const body = (await res.json()) as CapResult;
  if (!body.ok) throw new Error(`capability ${name} failed: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/** A capability called as the signed-in user (cookie) from Node — setup and reads only. */
async function callCap<T>(page: Page, name: string, data: unknown): Promise<T> {
  const res = await page.request.post(`/api/cap/${name}`, {
    headers: { 'x-requested-with': 'nexttime' },
    data,
  });
  return capResult<T>(name, res);
}

/** `get_workspace` with an API key from Node — the raw response, so a refused key can be read.
 *  `page.request` also sends the owner's session cookie; the kernel resolves the Bearer key first
 *  and refuses a bad one with 401 rather than falling back to the cookie, which is what lets a
 *  401 here mean "this key is refused". */
function getWorkspaceWithKey(page: Page, apiKey: string) {
  return page.request.post('/api/cap/get_workspace', {
    headers: { authorization: `Bearer ${apiKey}` },
    data: {},
  });
}

/** The user's membership in the journey's workspace, as the kernel lists it (disabled included). */
async function membershipIn(
  page: Page,
  userId: string,
  workspaceName: string,
): Promise<UserMembershipWire | undefined> {
  const { items } = await callCap<{ items: UserMembershipWire[] }>(page, 'list_user_memberships', {
    userId,
  });
  return items.find((membership) => membership.workspaceName === workspaceName);
}

async function listedPrincipal(page: Page, id: string): Promise<PrincipalWire | undefined> {
  const { items } = await callCap<{ items: PrincipalWire[] }>(page, 'list_principals', {});
  return items.find((row) => row.id === id);
}

test.describe('Journey ⑱: 成员资格与服务凭证的一生', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('add a user to a workspace, re-role and remove them; re-role, re-key and disable a service credential', async ({
    page,
  }) => {
    test.setTimeout(150_000);

    // --- 0. 全新工作区 + 它的所有者；一个不属于任何工作区的用户（页面外） -------------------------
    const { workspaceName, ownerLogin, ownerTemporaryPassword } = await createFreshWorkspace(page);
    const { user } = await callCap<CreateUserResultWire>(page, 'create_user', {
      login: MEMBER_LOGIN,
      displayName: MEMBER_NAME,
      workspaceId: null,
    });
    expect(user.memberships).toEqual([]);

    // --- 1. 用户 → 管理 → 管理成员资格：加入这条旅程的工作区，角色保持成员 --------------------------
    await goToByLabel(page, '用户');
    await page.getByRole('textbox', { name: '搜索', exact: true }).fill(MEMBER_LOGIN);
    await page.getByRole('button', { name: '应用', exact: true }).click();
    const userRow = page.getByTestId('platform-user-row').filter({ hasText: MEMBER_LOGIN });
    await userRow.getByRole('button', { name: '管理', exact: true }).click({ timeout: 15_000 });
    await page
      .getByTestId('user-drawer')
      .getByRole('button', { name: /管理成员资格/ })
      .click();
    const memberships = page.getByTestId('user-memberships-drawer');
    await expect(memberships.getByTestId('user-memberships-empty')).toBeVisible();
    await memberships
      .getByRole('combobox', { name: '加入工作区', exact: true })
      .selectOption({ label: workspaceName }, { timeout: 15_000 });
    await memberships.getByRole('button', { name: '加入', exact: true }).click();
    const membershipRow = memberships
      .getByTestId('user-membership-row')
      .filter({ hasText: workspaceName });
    await expect(membershipRow).toBeVisible({ timeout: 15_000 });

    expect(await membershipIn(page, user.id, workspaceName)).toMatchObject({
      role: 'member',
      disabled: false,
    });

    // --- 2. 这一条成员资格：角色改成运维（选中即保存） ---------------------------------------------
    const membershipRole = membershipRow.getByRole('combobox', { name: '角色', exact: true });
    await expect(membershipRole).toHaveValue('member');
    await membershipRole.selectOption('operator');
    await expect
      .poll(async () => (await membershipIn(page, user.id, workspaceName))?.role, {
        timeout: 15_000,
      })
      .toBe('operator');
    await expect(membershipRole).toBeEnabled();

    // --- 3. 移出 → 确认移出：成员资格留着、标为已停用 ----------------------------------------------
    await membershipRow.getByRole('button', { name: '移出', exact: true }).click();
    await membershipRow.getByRole('button', { name: '确认移出', exact: true }).click();
    await expect(membershipRow.getByText('已停用', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(await membershipIn(page, user.id, workspaceName)).toMatchObject({
      role: 'operator',
      disabled: true,
    });

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawer-overlay')).toHaveCount(0);

    // --- 4. 所有者：成员与授权里的服务凭证，角色从成员改成运维 ---------------------------------------
    await page.getByRole('button', { name: '登出', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true }).first()).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    await selectOwnedWorkspace(page);

    const service = await callCap<{ principal: PrincipalWire; apiKey: string }>(
      page,
      'create_principal',
      { role: 'member', displayName: SERVICE_NAME },
    );
    const oldKey = service.apiKey;

    await goToByLabel(page, '成员与授权');
    await page
      .getByRole('list', { name: 'Members', exact: true })
      .getByRole('button')
      .filter({ hasText: SERVICE_NAME })
      .click({ timeout: 15_000 });
    const drawer = page.getByTestId('principal-drawer');
    const role = drawer.getByRole('combobox', { name: '角色', exact: true });
    await expect(role).toHaveValue('member');
    await role.selectOption('operator');
    const save = drawer.getByRole('button', { name: '保存', exact: true });
    await save.click();
    // Saved: the picked role is the principal's role now, so 保存 has nothing left to save.
    await expect(save).toBeDisabled({ timeout: 15_000 });
    expect(await listedPrincipal(page, service.principal.id)).toMatchObject({
      role: 'operator',
      disabledAt: null,
    });

    // --- 5. 轮换 API key：新 key 只显示一次，旧 key 立即失效 ---------------------------------------
    await drawer.getByRole('button', { name: '轮换 API key', exact: true }).click();
    const rotated = drawer.getByTestId('rotated-api-key');
    await expect(rotated).toBeVisible({ timeout: 15_000 });
    // The key is the only `.mono` text in the shown-once box (`PrincipalDetail`); it has no test id.
    const newKey = ((await rotated.locator('.mono').textContent()) ?? '').trim();
    expect(newKey).not.toBe('');
    // Compared as a boolean: a failing matcher would print both keys into the public CI log.
    expect(newKey === oldKey, 'the rotated key differs from the old one').toBe(false);
    const asNewKey = await capResult<WorkspaceWire>(
      'get_workspace',
      await getWorkspaceWithKey(page, newKey),
    );
    expect(asNewKey.caller).toMatchObject({ id: service.principal.id, role: 'operator' });
    expect((await getWorkspaceWithKey(page, oldKey)).status()).toBe(401);
    await drawer.getByRole('button', { name: '我已复制', exact: true }).click();
    await expect(rotated).toBeHidden();

    // --- 6. 停用成员 → 确认停用 ------------------------------------------------------------------
    await drawer.getByRole('button', { name: '停用成员', exact: true }).click();
    await drawer.getByRole('button', { name: '确认停用', exact: true }).click();
    await expect(drawer.getByTestId('principal-status')).toHaveAttribute(
      'data-status',
      'disabled',
      { timeout: 15_000 },
    );
    const disabled = await listedPrincipal(page, service.principal.id);
    expect(disabled?.disabledAt ?? null).not.toBeNull();
    // What disabling guarantees: the credential no longer works. The key that worked in step 5 is
    // now refused like the rotated-out one (the kernel resolves keys of active Principals only).
    expect((await getWorkspaceWithKey(page, newKey)).status()).toBe(401);
  });
});
