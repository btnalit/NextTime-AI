import { type Page, expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/workspaces.spec.ts: the P-A2 acceptance flow (docs/development-tasks.md "### P-A2" 完成标准,
 * design §9) — the administrator creates a second workspace W2 for a department, gives it an entry
 * model and an allow-list of exactly one model, delegates it to a freshly created user as its
 * owner; that owner logs in and sees, under 管理, only W2's own 工作区配置 pages (no 用户 /
 * 平台设置 / 概览 / 平台审计 / 工作区), and 我的智能体's model picker offers only the allowed model.
 * Finally the administrator disables and re-enables W2. Opt-in only, same convention as every
 * other spec in this directory.
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_ADMIN_LOGIN`/`WEB_E2E_ADMIN_INITIAL_PASSWORD` (the
 * pre-created platform administrator and its random temporary password — see login.spec.ts's own
 * doc comment and docs/runbooks/web-console.md's "CI（Playwright）" section) and a model catalog
 * with both `fake/fake-echo` and `fake/fake-echo-alt` in it
 * (`config/llm-providers.fake.example.yaml`, which the e2e workflow copies into
 * `${NEXTTIME_DATA}/config/llm-providers.yaml`) — one model cannot show an allow-list *narrowing*
 * anything. No new environment variable: every user, workspace and password this file needs it
 * creates itself.
 *
 * **Runs before login.spec.ts, and that ordering is load-bearing**: login.spec.ts's last test
 * deliberately locks the `admin` account for `LOGIN_LOCK_MINUTES` (5) minutes, and this file signs
 * in as `admin` twice. Playwright discovers spec files alphabetically (`workspaces` > `login`), so
 * the order is pinned in playwright.config.ts instead — a `chromium` project that ignores
 * login.spec.ts plus a `chromium-login` project that `dependencies`-waits for it.
 *
 * Idempotent for a CI retry in the strong sense: every name is suffixed with a per-run value
 * generated in the *first* test, and the group runs in `serial` mode, so Playwright retries all
 * four tests together and the retry creates its own user and its own workspace rather than
 * colliding with the leftovers of the attempt that failed. The administrator's own password is
 * handled the way login.spec.ts handles it (initial, or `-changed` from an earlier attempt).
 */

const ADMIN_LOGIN = process.env.WEB_E2E_ADMIN_LOGIN;
const ADMIN_INITIAL_PASSWORD = process.env.WEB_E2E_ADMIN_INITIAL_PASSWORD;

const BAD_CREDENTIALS_MESSAGE = '登录名或密码不正确';
/** The two models `config/llm-providers.fake.example.yaml` puts in the CI stack's catalog. */
const ALLOWED_MODEL = 'fake/fake-echo';
const EXCLUDED_MODEL = 'fake/fake-echo-alt';

/** Assigned by the first test of the serial group below and read by the three after it — a retry
 *  re-runs the whole group, so these are always written before they are read. */
let ownerLogin = '';
let ownerTemporaryPassword = '';
let workspaceName = '';

/**
 * Signs `admin` in through the password form, tolerating both states the account can be in: still
 * on its initial temporary password (a fresh stack) or already on the deterministic
 * `${initial}-changed` one (this file's own earlier test, or a retried run). Deliberately a local
 * helper rather than one in `auth-helpers.ts`: that file holds only the steps that are
 * byte-identical everywhere (see its doc comment), and this one — like every spec's own `login()`
 * wrapper — differs in what it asserts around them.
 */
async function signInAsAdmin(page: Page): Promise<void> {
  const login = ADMIN_LOGIN as string;
  const initialPassword = ADMIN_INITIAL_PASSWORD as string;
  const changedPassword = `${initialPassword}-changed`;

  const changePasswordHeading = page.getByRole('heading', { name: /Password change required/ });
  // The platform 工作区 nav item: rendered by `Sidebar` for `platformRole === 'admin'` whatever
  // route the admin lands on (including the platform-only session an admin with zero workspace
  // memberships gets), so it is the one "we are past the login screen" signal that always holds.
  const shell = page.getByTestId('nav-platformWorkspaces');
  const badCredentials = page.getByText(BAD_CREDENTIALS_MESSAGE);

  await page.goto('/');
  await reachLoginForm(page);
  await loginWithPassword(page, login, initialPassword);
  await expect(changePasswordHeading.or(shell).or(badCredentials).first()).toBeVisible({
    timeout: 15_000,
  });

  if (await badCredentials.isVisible().catch(() => false)) {
    // A previous (retried) run already changed the password away from the initial one — try the
    // deterministic changed password instead, exactly as login.spec.ts does.
    await page.getByLabel(/密码 Password/).fill(changedPassword);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(changePasswordHeading.or(shell).first()).toBeVisible({ timeout: 15_000 });
  }

  if (await changePasswordHeading.isVisible().catch(() => false)) {
    await page.getByLabel(/当前密码 Current password/).fill(initialPassword);
    await page.getByLabel(/新密码 New password/).fill(changedPassword);
    await page.getByLabel(/确认新密码 Confirm new password/).fill(changedPassword);
    await page.getByRole('button', { name: /Change password/ }).click();
  }

  await expect(shell).toBeVisible({ timeout: 15_000 });
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /登出 Sign out/ }).click();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
}

/** The 工作区 list's `<tr>` for the workspace named `name`. */
function workspaceRow(page: Page, name: string) {
  return page
    .getByTestId('platform-workspaces-table')
    .locator('tbody tr')
    .filter({ hasText: name });
}

test.describe('P-A2 acceptance: a second workspace, delegated to its own owner', () => {
  // Serial, not merely ordered: every test after the first reads the login/password/name the first
  // one generated, so a mid-group failure has to retry the *group* (with a fresh suffix) rather
  // than one test against state that no longer exists.
  test.describe.configure({ mode: 'serial' });

  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_BASE_URL, WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD to run this suite (see README.md)',
  );

  test('admin: create the user who will own the second workspace', async ({ page }) => {
    test.slow();
    // Base36 keeps the suffix short and inside the kernel's own login pattern (lowercase
    // alphanumerics). Generated here, not at module scope: a serial-group retry re-runs this test
    // first, so the retry gets a fresh user even if Playwright reused the worker process.
    const suffix = Date.now().toString(36);
    ownerLogin = `w2owner${suffix}`;
    workspaceName = `dept-${suffix}`;

    await signInAsAdmin(page);

    await page.getByTestId('nav-platformUsers').click();
    await expect(page.getByRole('heading', { name: '用户 Users', exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: /新建用户 Create user/ }).click();
    const drawer = page.getByTestId('create-user-drawer');
    await expect(drawer.getByTestId('create-user-form')).toBeVisible();
    await drawer.locator('#cu-login').fill(ownerLogin);
    await drawer.locator('#cu-display-name').fill(`W2 owner ${suffix}`);
    // 工作区 is left at 默认工作区 (`create_user` with no `workspaceId`): the user joins the
    // platform default workspace as a `member`, which is what puts the workspace switcher on
    // screen for them in the third test once they also own the new workspace.
    await drawer.getByRole('button', { name: /创建 Create/ }).click();

    // Shown exactly once (TemporaryPasswordDialog.tsx) — capture it before the dialog is closed.
    const password = page.getByTestId('temporary-password-value');
    await expect(password).toBeVisible({ timeout: 15_000 });
    ownerTemporaryPassword = (await password.textContent())?.trim() ?? '';
    expect(ownerTemporaryPassword.length).toBeGreaterThan(0);

    await page.getByRole('button', { name: /我已保存 I have saved it/ }).click();
    await expect(page.getByTestId('temporary-password-dialog')).toBeHidden();
  });

  test('admin: the default workspace cannot be disabled; create W2 and delegate it', async ({
    page,
  }) => {
    test.slow();
    await signInAsAdmin(page);

    await page.getByTestId('nav-platformWorkspaces').click();
    await expect(page.getByTestId('platform-workspaces-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('platform-workspaces-table')).toBeVisible({ timeout: 15_000 });

    // The platform default workspace: badged in the list, and its 停用 button is disabled with the
    // reason spelled out, rather than offered as something that could only fail with
    // `default_workspace`.
    const defaultRow = page
      .getByTestId('platform-workspaces-table')
      .locator('tbody tr')
      .filter({ has: page.getByTestId('workspace-default-badge') });
    await expect(defaultRow).toHaveCount(1);
    await defaultRow.click();
    const defaultDrawer = page.getByTestId('workspace-drawer');
    await expect(defaultDrawer.getByTestId('workspace-detail')).toBeVisible({ timeout: 15_000 });
    await expect(defaultDrawer.getByTestId('workspace-status-toggle')).toBeDisabled();
    await expect(defaultDrawer.getByTestId('workspace-default-undisablable')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(defaultDrawer).toBeHidden();

    // --- 新建工作区 -------------------------------------------------------------------------
    await page.getByTestId('new-workspace').click();
    const createDrawer = page.getByTestId('create-workspace-drawer');
    await expect(createDrawer.getByTestId('create-workspace-form')).toBeVisible();
    await createDrawer.locator('#cw-name').fill(workspaceName);

    // UserPicker searches on a button press, never per keystroke, and disables its `<select>`
    // while `list_users` is in flight — so wait for the select before reading its options.
    await createDrawer.locator('#cw-owner-query').fill(ownerLogin);
    await createDrawer.getByRole('button', { name: /搜索 Search/ }).click();
    const ownerSelect = createDrawer.getByTestId('create-workspace-owner');
    await expect(ownerSelect).toBeEnabled();
    const ownerOption = ownerSelect.locator('option', { hasText: ownerLogin });
    await expect(ownerOption).toHaveCount(1);
    // The option's label is `<login> — <displayName>`, so the owner is picked by value (the
    // platform user id) rather than by an exact label this test would have to reconstruct.
    const ownerUserId = await ownerOption.getAttribute('value');
    expect(ownerUserId ?? '').not.toBe('');
    await ownerSelect.selectOption(ownerUserId as string);

    // Allow-list first, entry model second: CreateWorkspaceForm narrows the entry-model options to
    // the ticked models, so this order also proves that narrowing.
    const allowed = createDrawer.getByTestId('workspace-allowed-models');
    await expect(allowed.getByRole('checkbox')).toHaveCount(2);
    await allowed.getByLabel(ALLOWED_MODEL, { exact: true }).check();
    const entryModel = createDrawer.getByTestId('workspace-entry-model');
    await expect(entryModel.locator('option')).toHaveCount(2); // 平台默认 + the one ticked model
    await entryModel.selectOption(ALLOWED_MODEL);

    await createDrawer.getByRole('button', { name: /创建 Create/ }).click();
    await expect(createDrawer).toBeHidden({ timeout: 20_000 });

    // PlatformWorkspacesPage opens the new workspace's own drawer as soon as `create_workspace`
    // answers.
    const drawer = page.getByTestId('workspace-drawer');
    await expect(drawer.getByTestId('workspace-detail')).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByTestId('workspace-entry-model')).toHaveValue(ALLOWED_MODEL);
    await expect(
      drawer.getByTestId('workspace-allowed-models').getByRole('checkbox', { checked: true }),
    ).toHaveCount(1);
    await expect(
      drawer.getByTestId('workspace-owners').getByTestId('workspace-owner-chip'),
    ).toHaveText(ownerLogin);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    const row = workspaceRow(page, workspaceName);
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('workspace-owner-chip')).toHaveText(ownerLogin);
    await expect(row.getByTestId('workspace-status')).toHaveText('active');

    await signOut(page);
  });

  test('owner: temporary password -> forced change -> only W2 under 管理, narrowed model picker', async ({
    page,
  }) => {
    test.slow();
    const newPassword = `${ownerTemporaryPassword}-changed`;

    const wsStatus = page.getByTestId('ws-status');
    const changePasswordHeading = page.getByRole('heading', { name: /Password change required/ });
    const badCredentials = page.getByText(BAD_CREDENTIALS_MESSAGE);

    await page.goto('/');
    await reachLoginForm(page);
    await loginWithPassword(page, ownerLogin, ownerTemporaryPassword);
    await expect(changePasswordHeading.or(wsStatus).or(badCredentials)).toBeVisible({
      timeout: 15_000,
    });

    if (await badCredentials.isVisible().catch(() => false)) {
      // A previous (retried) run already changed the password away from the temporary one — try
      // the deterministic new one instead, exactly as login.spec.ts does.
      await page.getByLabel(/密码 Password/).fill(newPassword);
      await page.getByRole('button', { name: 'Log in' }).click();
      await expect(changePasswordHeading.or(wsStatus)).toBeVisible({ timeout: 15_000 });
    }

    if (await changePasswordHeading.isVisible().catch(() => false)) {
      await page.getByLabel(/当前密码 Current password/).fill(ownerTemporaryPassword);
      await page.getByLabel(/新密码 New password/).fill(newPassword);
      await page.getByLabel(/确认新密码 Confirm new password/).fill(newPassword);
      await page.getByRole('button', { name: /Change password/ }).click();
    }
    await expect(wsStatus).toHaveText('Connected', { timeout: 15_000 });

    // This user is a `member` of the platform default workspace *and* the owner of W2, so the
    // Sidebar renders its switcher and the session may have opened on either one. 管理 is hidden
    // outright for a proven member, so W2 has to be the workspace in scope before anything below
    // means what it says.
    const switcher = page.getByTestId('workspace-switcher');
    if (await switcher.isVisible().catch(() => false)) {
      const option = switcher.locator('option', { hasText: workspaceName });
      await expect(option).toHaveCount(1);
      const workspaceId = await option.getAttribute('value');
      expect(workspaceId ?? '').not.toBe('');
      await switcher.selectOption(workspaceId as string);
      // The switcher itself is the only reliable completion signal. `ws-status` is not: App.tsx
      // hands the live socket over to the new session rather than closing it, so it can stay
      // "Connected" throughout. Nor is `nav-members`: the role is `unknown` until `get_workspace`
      // answers, and 管理 is shown for an unknown role — so it can be on screen for the *default*
      // workspace for a moment. The `<select>`'s value comes from the published session's
      // `selectedWorkspaceId`, and it stays disabled (`switchingWorkspace`) until the switch,
      // including its own `navigate(#/work/chats)`, has finished — which is what must not land on
      // top of the 我的智能体 page below.
      await expect(switcher).toHaveValue(workspaceId as string, { timeout: 15_000 });
      await expect(switcher).toBeEnabled();
    }

    // 管理 → 工作区配置 for W2 …
    await expect(page.getByTestId('nav-members')).toBeVisible({ timeout: 15_000 });
    // … and nothing from the platform plane: no 工作区 list, no 用户/平台设置, no 维护 group.
    for (const platformNav of [
      'nav-platformWorkspaces',
      'nav-platformUsers',
      'nav-platformSettings',
      'nav-platformOverview',
      'nav-platformAudit',
    ]) {
      await expect(page.getByTestId(platformNav)).toHaveCount(0);
    }

    await page.getByTestId('nav-agent').click();
    await expect(page.getByTestId('agent-profile-effective')).toBeVisible({ timeout: 15_000 });
    const modelSelect = page.locator('#ap-model');
    await expect(modelSelect).toBeVisible();
    // The total is asserted first on purpose: `#ap-model` renders as soon as `list_models` answers,
    // which can be before `get_agent_policy` supplies the allow-list it is narrowed by — a bare
    // "alt has count 0" would pass against that intermediate state as happily as against the
    // narrowed one. 继承工作区默认 + `fake/fake-echo`, and nothing else.
    await expect(modelSelect.locator('option')).toHaveCount(2);
    await expect(modelSelect.locator(`option[value="${ALLOWED_MODEL}"]`)).toHaveCount(1);
    await expect(modelSelect.locator(`option[value="${EXCLUDED_MODEL}"]`)).toHaveCount(0);

    await signOut(page);
  });

  test('admin: disable W2, then re-enable it', async ({ page }) => {
    test.slow();
    await signInAsAdmin(page);

    await page.getByTestId('nav-platformWorkspaces').click();
    await expect(page.getByTestId('platform-workspaces-page')).toBeVisible({ timeout: 15_000 });
    const row = workspaceRow(page, workspaceName);
    await expect(row).toHaveCount(1);
    await row.click();

    const drawer = page.getByTestId('workspace-drawer');
    await expect(drawer.getByTestId('workspace-detail')).toBeVisible({ timeout: 15_000 });
    await drawer.getByTestId('workspace-status-toggle').click();
    await expect(drawer.getByTestId('workspace-disable-confirm')).toBeVisible();
    await drawer.getByRole('button', { name: /确认停用 Confirm disable/ }).click();
    await expect(row.getByTestId('workspace-status')).toHaveText('disabled', { timeout: 15_000 });

    // Back to `active` before this test ends — the same toggle, now labelled 启用 Enable. A CI
    // retry of this group creates its own workspace, but re-enabling keeps the one this attempt
    // made usable (and its owner able to sign in) for anyone reading the stack afterwards.
    await drawer.getByTestId('workspace-status-toggle').click();
    await expect(row.getByTestId('workspace-status')).toHaveText('active', { timeout: 15_000 });

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await signOut(page);
  });
});
