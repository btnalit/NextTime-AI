import { expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from '../auth-helpers.js';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import { OWNER_API_KEY, asAdmin, asOwner, createPlatformUser, goToByLabel } from './helpers.js';

/**
 * Journey ⑥: 添加成员并让其可用 (development-tasks.md §5e F4)
 *
 * 步骤:
 *   1. （平台管理员）新建一个平台用户（不预先绑定到任何工作区）。
 *   2. （工作区 owner）在 成员与授权 页"添加成员"，按该用户的登录名把它加入这个工作区，给一个角色。
 *   3. 新成员用平台账户的临时密码登录，被强制改密。
 *   4. 新成员切到这个工作区，确认"可用"：能看到 使用 分组（对话/待我审批/任务/图谱/我的智能体/我的
 *      账户），看不到 治理 分组（member 角色，§5.9 "治理只对非 member 可见"）。
 * 状态覆盖:
 *   - 空: 本旅程覆盖的就是"从零添加"这个空态本身。
 *   - 错: 用一个不存在的登录名添加——`add_member` 的 `user_not_found` 应该给出行内错误，不是通用
 *     错误横幅（`AddMemberForm.tsx` 的既有行为——见下方 `test.fixme`）。
 *   - 无权限: builder 以下角色看不到"添加成员"按钮（`MembersPage.tsx` 的 `canManage` 判断）——不在
 *     本旅程覆盖范围（governance.spec.ts 已用同一个工作区的 owner 覆盖了"能看到"这一半）。
 *   - 窄屏: 本旅程不单独在 768px 重跑——`00-gates/`的三档截图已经覆盖 成员与授权 页在 768px 下的
 *     布局；这里的价值是流程能不能走完，不是像素级布局，两者不重复。
 * 成功判据:
 *   - 一个人（工作区 owner）能把一个已存在的平台用户加进这个工作区，这个人能用自己的账户登录、进入
 *     这个工作区、开始使用（不需要 owner 手动分发 API key）。
 *
 * 今天可以整条走通：`add_member{login, role}`（P-A1）与 `AddMemberForm.tsx` 已经是稳定能力——不是
 * W2/W3 才补的东西。与 journey③ 一样，这是"如果可行就做成真实通过"的一条。
 */

test.describe('Journey ⑥: 添加成员并让其可用', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD || !OWNER_API_KEY,
    'set WEB_E2E_ADMIN_LOGIN, WEB_E2E_ADMIN_INITIAL_PASSWORD and WEB_E2E_API_KEY (see README.md)',
  );

  test('add an existing platform user to this workspace by login, they can sign in and use it', async ({
    page,
  }) => {
    test.slow();
    const suffix = Date.now().toString(36);

    // Step 1: admin creates the platform user, uninvolved with any workspace yet.
    await asAdmin(page);
    const { login: memberLogin, temporaryPassword } = await createPlatformUser(
      page,
      `Journey member ${suffix}`,
    );
    await page.getByRole('button', { name: /登出/ }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();

    // Step 2: owner adds them by login, from 成员与授权's own "添加成员" entry point.
    await asOwner(page);
    await goToByLabel(page, '成员与授权');
    await page.getByRole('button', { name: /添加成员/ }).click();
    const addDrawer = page.getByTestId('add-member-drawer');
    await expect(addDrawer).toBeVisible();
    await addDrawer.locator('#am-login').fill(memberLogin);
    // Role left at its default (`member`) — AddMemberForm.tsx's own initial state.
    await addDrawer.getByRole('button', { name: '添加' }).click();
    await expect(addDrawer).toBeHidden({ timeout: 15_000 });
    await expect(
      page.getByTestId('member-row').filter({ hasText: `Journey member ${suffix}` }),
    ).toBeVisible({ timeout: 15_000 });

    // Step 3: the new member signs in with their temporary password, forced through a change.
    // `page.goto('/')` alone would land back in the still-authenticated owner shell (apiKey
    // sessions survive in sessionStorage and auto-reconnect — auth-helpers.ts's own doc comment),
    // so sign the owner out first the same way approvals.spec.ts's `login()` helper does.
    await page.goto('/');
    if ((await reachLoginForm(page)) === 'shell') {
      await page.getByRole('button', { name: '清除密钥' }).click();
      await reachLoginForm(page);
    }
    await loginWithPassword(page, memberLogin, temporaryPassword);
    await expect(page.getByRole('heading', { name: /需要更改密码/ })).toBeVisible({
      timeout: 15_000,
    });
    const newPassword = `${temporaryPassword}-changed`;
    await page.locator('#cp-current-password').fill(temporaryPassword);
    await page.locator('#cp-new-password').fill(newPassword);
    await page.locator('#cp-confirm-password').fill(newPassword);
    await page.getByRole('button', { name: /更改密码/ }).click();

    // Step 4: switch to this workspace (the new member also belongs to the platform default
    // workspace from account creation — `createPlatformUser`'s own doc comment) and confirm 使用
    // is usable while 治理 stays hidden (member role, §5.9).
    const switcher = page.getByTestId('workspace-switcher');
    await expect(switcher).toBeVisible({ timeout: 15_000 });
    const ciE2eOption = switcher.locator('option', { hasText: 'ci-e2e' });
    await expect(ciE2eOption).toHaveCount(1);
    const workspaceId = await ciE2eOption.getAttribute('value');
    await switcher.selectOption(workspaceId as string);
    await expect(switcher).toHaveValue(workspaceId as string, { timeout: 15_000 });

    await expect(page.getByTestId('nav-chats')).toBeVisible();
    await expect(page.getByTestId('nav-section-govern')).toHaveCount(0);
    await page.getByTestId('nav-chats').click();
    await expect(page.getByRole('heading', { name: '对话' })).toBeVisible();
  });

  test.fixme(
    "error state: adding an unknown login shows AddMemberForm's inline user_not_found message",
    async () => {
      // Real product behaviour (AddMemberForm.tsx's own doc comment: "user_not_found (404) ... a
      // typo ... gets its own bilingual line"), not yet scripted here — left for whoever picks
      // this up to pair with a concrete expected message string read from that component rather
      // than guessed.
    },
  );
});
