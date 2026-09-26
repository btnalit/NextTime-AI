import { type Page, expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/integrations.spec.ts: the P-B1 acceptance flow (docs/development-tasks.md "### P-B" →
 * 实现说明 P-B1, design §6.3 集成) over the one discovered gate instance
 * `.github/workflows/e2e.yml`'s "Seed a discovered gate instance" step announces before this suite
 * runs: `gateId: ci-fixture-mcp`, `connector: fixture-mcp`, `transportKind: mcp`, displayName
 * "CI fixture MCP", endpoint `http://127.0.0.1:1` (nothing listens there — health reads
 * "unreachable", the truth about that endpoint; the fake-MCP end-to-end path is P-B2, not this
 * file), operations `list_things` (observe) and `restart_thing` (execute).
 *
 * Four tests, `serial`, in an order that is also a real dependency, not just convention: the
 * platform admin must flip the gate instance from `discovered` to `enabled` (test 1) before any
 * workspace can `enable_gate_instance` on it (`gate-instance-handlers.ts`'s own `requireAvailable`
 * refuses a not-yet-enabled instance with `gate_not_enabled`) — test 2. Test 3's connector deny
 * list and test 4's service Handle/external runtime are independent of 1-2 in principle, but stay
 * in the same serial group for the same reason `workspaces.spec.ts` gives: one administrator
 * session, reused rather than re-authenticated four times over.
 *
 * Idempotent for a CI retry in the strong sense workspaces.spec.ts also aims for: every assertion
 * is against an end state (enabled / vetted / present-in-catalog / absent-from-catalog / row-gone),
 * never against a bare "click and assume it was off before" transition — a retry that lands on an
 * instance a previous attempt already enabled, or a deny list a previous attempt already restored,
 * passes exactly the same way a fresh run does. Test 3 additionally restores the deny list to empty
 * before it ends, so a later retry (or a human poking at the same stack afterwards) starts clean.
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_ADMIN_LOGIN`/`WEB_E2E_ADMIN_INITIAL_PASSWORD` — the same
 * pre-created platform administrator `workspaces.spec.ts` uses (see that file's own doc comment).
 * The admin is assumed to be the owner of the platform default workspace (true on a fresh stack:
 * `ensureDefaultWorkspace` creates it with the earliest administrator as owner) — every 管理 page
 * this file visits (系统接入/成员与授权/能力目录) needs a workspace in scope, and this file
 * creates no workspace of its own the way `workspaces.spec.ts` does.
 */

const ADMIN_LOGIN = process.env.WEB_E2E_ADMIN_LOGIN;
const ADMIN_INITIAL_PASSWORD = process.env.WEB_E2E_ADMIN_INITIAL_PASSWORD;

const BAD_CREDENTIALS_MESSAGE = '登录名或密码不正确';
const GATE_ID = 'ci-fixture-mcp';
const CONNECTOR = 'fixture-mcp';
const DISPLAY_NAME = 'CI fixture MCP';
const OBSERVE_OP = 'list_things';
const EXECUTE_OP = 'restart_thing';

/**
 * Signs `admin` in through the password form, tolerating both states the account can be in: still
 * on its initial temporary password (a fresh stack) or already on the deterministic
 * `${initial}-changed` one (an earlier attempt of this file, or of `workspaces.spec.ts` — whichever
 * of the two alphabetically-ordered specs runs first does the one forced change every subsequent
 * sign-in of either file has to tolerate). A local copy rather than a shared helper for the same
 * reason `workspaces.spec.ts`'s own copy gives: `auth-helpers.ts` holds only the byte-identical
 * steps, and what a caller asserts around them differs per spec.
 */
async function signInAsAdmin(page: Page): Promise<void> {
  const login = ADMIN_LOGIN as string;
  const initialPassword = ADMIN_INITIAL_PASSWORD as string;
  const changedPassword = `${initialPassword}-changed`;

  const changePasswordHeading = page.getByRole('heading', { name: /需要更改密码/ });
  // The platform 工作区 nav item: rendered by `Sidebar` for `platformRole === 'admin'` whatever
  // route the admin lands on, so it is the one "we are past the login screen" signal that always
  // holds (same reasoning as `workspaces.spec.ts`'s own copy of this helper).
  const shell = page.getByTestId('nav-platformWorkspaces');
  const badCredentials = page.getByText(BAD_CREDENTIALS_MESSAGE);

  await page.goto('/');
  await reachLoginForm(page);
  await loginWithPassword(page, login, initialPassword);
  await expect(changePasswordHeading.or(shell).or(badCredentials).first()).toBeVisible({
    timeout: 15_000,
  });

  if (await badCredentials.isVisible().catch(() => false)) {
    await page.locator('#login-password').fill(changedPassword);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(changePasswordHeading.or(shell).first()).toBeVisible({ timeout: 15_000 });
  }

  if (await changePasswordHeading.isVisible().catch(() => false)) {
    await page.locator('#cp-current-password').fill(initialPassword);
    await page.locator('#cp-new-password').fill(changedPassword);
    await page.locator('#cp-confirm-password').fill(changedPassword);
    await page.getByRole('button', { name: /更改密码/ }).click();
  }

  await expect(shell).toBeVisible({ timeout: 15_000 });
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /登出/ }).click();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
}

/** `Sidebar`'s workspace switcher only renders for a cookie session with more than one active
 *  membership (`showSwitcher`) — never expected for this file's admin (owner of the default
 *  workspace only, and this file creates no other workspace), but guarded the same defensive way
 *  `workspaces.spec.ts`'s third test guards it, in case an earlier spec in the shared CI stack ever
 *  adds a second membership. Picks the admin's `owner` membership specifically, since a default
 *  workspace's name is site-configured (`ensureDefaultWorkspace`), not a fixed string this file can
 *  match on. */
async function ensureOwnedWorkspaceSelected(page: Page): Promise<void> {
  const switcher = page.getByTestId('workspace-switcher');
  if (!(await switcher.isVisible().catch(() => false))) return;
  // S8 W1-A10: the switcher's role suffix is bilingual now (lib/labels.ts roleLabel); default
  // zh-CN renders '(所有者)'.
  const option = switcher.locator('option', { hasText: '(所有者)' });
  await expect(option).toHaveCount(1);
  const workspaceId = await option.getAttribute('value');
  expect(workspaceId ?? '').not.toBe('');
  await switcher.selectOption(workspaceId as string);
  await expect(switcher).toHaveValue(workspaceId as string, { timeout: 15_000 });
  await expect(switcher).toBeEnabled();
}

/** Ticks/unticks one Operation name in a connector's deny-list checklist (`ConnectorDenyList`) and
 *  saves, but only when it is not already in the requested state — the idempotency this whole file
 *  aims for, applied to a single checkbox. Assumes the connector's row is already expanded. */
async function setOperationDisabled(
  page: Page,
  connectorName: string,
  operationName: string,
  disabled: boolean,
): Promise<void> {
  const list = page.getByTestId(`connector-disabled-ops-${connectorName}`);
  await expect(list).toBeVisible({ timeout: 15_000 });
  const checkbox = list.getByLabel(operationName, { exact: true });
  await expect(checkbox).toBeVisible({ timeout: 15_000 });
  const alreadyThere = await checkbox.isChecked();
  if (alreadyThere === disabled) return;
  await checkbox.click();
  await list.getByRole('button', { name: /保存/ }).click();
  await expect(checkbox).toBeChecked({ checked: disabled, timeout: 15_000 });
}

test.describe('P-B1 acceptance: the platform gate-instance catalog', () => {
  // Serial: test 2 depends on test 1 having flipped the gate instance to `enabled` (see the file
  // doc comment), and every test reuses the same signed-in-as-admin pattern rather than
  // re-authenticating from scratch in a way that risks racing `login.spec.ts`'s own lockout.
  test.describe.configure({ mode: 'serial' });

  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_BASE_URL, WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD to run this suite (see README.md)',
  );

  test('admin: connector catalog, then enable/test/vet the seeded gate instance', async ({
    page,
  }) => {
    test.slow();
    await signInAsAdmin(page);

    await page.getByTestId('nav-platformIntegrations').click();
    await expect(page.getByTestId('platform-integrations-page')).toBeVisible({ timeout: 15_000 });

    // --- 接入包 Connectors (default tab) -----------------------------------------------------
    const fixtureRow = page.getByTestId(`connector-row-${CONNECTOR}`);
    await expect(fixtureRow).toBeVisible({ timeout: 15_000 });
    await expect(fixtureRow).toContainText('预置');
    await expect(page.getByTestId(`connector-mode-${CONNECTOR}`)).toHaveValue('platform_preset');
    await expect(page.getByTestId('connector-row-http')).toBeVisible();

    // --- 门实例 Gate instances -----------------------------------------------------------------
    await page.getByTestId('integrations-tab-instances').click();
    await expect(page.getByTestId('gate-instances-table')).toBeVisible({ timeout: 15_000 });
    const instanceRow = page.getByTestId(`gate-instance-row-${GATE_ID}`);
    await expect(instanceRow).toContainText(DISPLAY_NAME);
    await instanceRow.click();

    const drawer = page.getByTestId('gate-instance-drawer');
    await expect(drawer.getByTestId('gate-instance-detail')).toBeVisible({ timeout: 15_000 });

    const statusToggle = drawer.getByTestId('gate-instance-status-toggle');
    const statusLabel = (await statusToggle.textContent())?.trim();
    if (statusLabel !== '禁用') {
      await statusToggle.click();
    }
    await expect(statusToggle).toHaveText('禁用', { timeout: 15_000 });

    // Asserted on `data-status` (the raw wire value `StatusChip` always carries), not the chip's
    // Chinese label text, which S8 W4-C stopped leaving as the raw enum.
    await drawer.getByTestId('gate-instance-test').click();
    await expect(drawer.getByTestId('gate-instance-test-health')).toHaveAttribute(
      'data-status',
      'unreachable',
      { timeout: 15_000 },
    );

    const trustToggle = drawer.getByTestId('gate-instance-trust-toggle');
    const trustLabel = (await trustToggle.textContent())?.trim();
    if (trustLabel !== '撤销 vetted') {
      await trustToggle.click();
    }
    await expect(trustToggle).toHaveText('撤销 vetted', { timeout: 15_000 });

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await signOut(page);
  });

  test('admin: enable the instance from the workspace catalog; it registers a Gatekeeper', async ({
    page,
  }) => {
    test.slow();
    await signInAsAdmin(page);
    await ensureOwnedWorkspaceSelected(page);

    await page.getByTestId('nav-systems').click();
    await expect(page.getByRole('heading', { name: '系统接入' })).toBeVisible({
      timeout: 15_000,
    });

    const availableRow = page.getByTestId(`available-gate-${GATE_ID}`);
    await expect(availableRow).toBeVisible({ timeout: 15_000 });
    const enableButton = availableRow.getByTestId(`enable-gate-${GATE_ID}`);
    if (await enableButton.isVisible().catch(() => false)) {
      // S8 W2-U1 (audit J3): 在本工作区启用 now opens a preview confirm before it calls
      // enable_gate_instance — click the trigger, wait for the popover, then confirm.
      await enableButton.click();
      const confirm = page.getByTestId(`enable-gate-${GATE_ID}-confirm`);
      await expect(confirm).toBeVisible({ timeout: 15_000 });
      await confirm.getByTestId('confirm-button').click();
    }
    await expect(availableRow.getByRole('link', { name: /已启用/ })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId('gatekeeper-card').filter({ hasText: DISPLAY_NAME })).toHaveCount(
      1,
      { timeout: 15_000 },
    );

    await signOut(page);
  });

  test('admin: connector deny list hides an Operation from the catalog, then restores it', async ({
    page,
  }) => {
    test.slow();
    await signInAsAdmin(page);
    await ensureOwnedWorkspaceSelected(page);

    async function expandFixtureDenyList(): Promise<void> {
      await page.getByTestId('nav-platformIntegrations').click();
      await expect(page.getByTestId('platform-integrations-page')).toBeVisible({
        timeout: 15_000,
      });
      // `integrations-tab-connectors` is the tab's default state, but click it explicitly — this
      // is a fresh page mount, and a retry could in principle land here after some other state.
      await page.getByTestId('integrations-tab-connectors').click();
      const row = page.getByTestId(`connector-row-${CONNECTOR}`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      // Fresh mount ⇒ always collapsed — expand it.
      await row.getByRole('button', { name: /展开/ }).click();
    }

    async function catalogHasOperation(name: string): Promise<boolean> {
      await page.getByTestId('nav-catalog').click();
      await expect(page.getByRole('heading', { name: '能力目录' })).toBeVisible({
        timeout: 15_000,
      });
      const list = page.getByTestId('catalog-list');
      await expect(list.or(page.getByTestId('catalog-empty'))).toBeVisible({ timeout: 15_000 });
      return (await list.getByText(name, { exact: true }).count()) > 0;
    }

    // --- disable restart_thing, and it drops out of the catalog while list_things stays --------
    // `setOperationDisabled`'s own `toBeChecked` wait only resolves once `set_connector_mode` has
    // answered, so `list_operations` on the next navigation already reflects it — no polling
    // needed here.
    await expandFixtureDenyList();
    await setOperationDisabled(page, CONNECTOR, EXECUTE_OP, true);

    // Polled: the catalog can render from the previous load before the deny-list change is
    // reflected, and `count()` does not retry — a one-shot read raced (seen failing in CI).
    await expect.poll(() => catalogHasOperation(EXECUTE_OP), { timeout: 20_000 }).toBe(false);
    await expect.poll(() => catalogHasOperation(OBSERVE_OP), { timeout: 20_000 }).toBe(true);

    // --- restore: re-enable it so a later retry (or a human) finds a clean deny list -----------
    await expandFixtureDenyList();
    await setOperationDisabled(page, CONNECTOR, EXECUTE_OP, false);

    await expect.poll(() => catalogHasOperation(EXECUTE_OP), { timeout: 20_000 }).toBe(true);

    await signOut(page);
  });

  // S6-C (docs/console-completion-plan.md §5.6): the same "接入一个系统" launcher opens from both
  // pages. On 集成 an http kind offers the hosted-instance form; on 系统接入 an ssh kind shows the
  // packaged-gate checklist (the page never pretends to create a packaged gate). Read-only: it
  // creates nothing, so it is safe on a retry. The seeded mcp instance is also pickable from the
  // launcher's list on 系统接入 (test 2 enabled it there), with no 启用 button left (B7).
  test('admin: the "接入一个系统" launcher opens from 集成 and 系统接入 with the right step-2 body', async ({
    page,
  }) => {
    test.slow();
    await signInAsAdmin(page);

    await page.getByTestId('nav-platformIntegrations').click();
    await expect(page.getByTestId('platform-integrations-page')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('connect-system-button').click();
    const platformDrawer = page.getByTestId('connect-system-drawer');
    const platformLauncher = platformDrawer.getByTestId('connect-system-launcher');
    await expect(platformLauncher).toBeVisible({ timeout: 15_000 });
    await platformLauncher.getByTestId('launcher-kind-http').check();
    await platformLauncher.getByTestId('launcher-next').click();
    // S8 W2-U1 (audit J5): 选择已有实例 renders first now — the create form is opt-in.
    await expect(platformLauncher.getByTestId('launcher-existing-gates')).toBeVisible({
      timeout: 15_000,
    });
    await platformLauncher.getByRole('button', { name: /新建实例/ }).click();
    await expect(platformLauncher.getByTestId('create-gate-instance-form')).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');
    await expect(platformDrawer).toBeHidden();

    await ensureOwnedWorkspaceSelected(page);
    await page.getByTestId('nav-systems').click();
    await expect(page.getByRole('heading', { name: '系统接入' })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('connect-system-button').click();
    const workspaceDrawer = page.getByTestId('connect-system-drawer');
    const workspaceLauncher = workspaceDrawer.getByTestId('connect-system-launcher');
    await expect(workspaceLauncher).toBeVisible({ timeout: 15_000 });
    await workspaceLauncher.getByTestId('launcher-kind-ssh').check();
    await workspaceLauncher.getByTestId('launcher-next').click();
    await expect(workspaceLauncher.getByTestId('launcher-packaged-checklist')).toBeVisible({
      timeout: 15_000,
    });
    await expect(workspaceLauncher.getByTestId('packaged-gate-compose')).toContainText(
      'GATE_TRANSPORT_KIND: ssh',
    );
    await workspaceLauncher.getByTestId('launcher-back').click();
    await workspaceLauncher.getByTestId('launcher-kind-mcp').check();
    await workspaceLauncher.getByTestId('launcher-next').click();
    await workspaceLauncher.getByTestId(`launcher-gate-${GATE_ID}`).check({ timeout: 15_000 });
    await workspaceLauncher.getByTestId('launcher-next').click();
    // Enabled on the platform in test 1 and linked here in test 2: nothing left to enable (B7) —
    // whether the platform half renders in place (routes.tsx passes `platformAdmin`) or as the
    // "需要管理员" notice, there is no 启用 button, and the workspace half shows the link.
    await expect(workspaceLauncher.getByTestId('launcher-workspace-linked')).toBeVisible({
      timeout: 15_000,
    });
    await expect(workspaceLauncher.getByTestId('launcher-platform-enable-button')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(workspaceDrawer).toBeHidden();
    await signOut(page);
  });

  test('admin: issue a service Handle, then revoke the resulting external runtime', async ({
    page,
  }) => {
    test.slow();
    await signInAsAdmin(page);
    await ensureOwnedWorkspaceSelected(page);

    // D3 (docs/console-redesign-plan-2026-09-25.md §7): the service-Handle section moved from 访问
    // Access to 成员与授权 Members, alongside `create_principal` — both owner-only writes for a
    // service Principal now live on the one page. Screenshot review of #305: the full form was too
    // heavy to render inline under the member list, so it now opens from a header button into its
    // own `Drawer` (same one `MembersPage` uses for 添加成员/服务凭证/成员详情).
    await page.getByTestId('nav-members').click();
    await expect(page.getByRole('heading', { name: '成员与授权', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('issue-service-handle-trigger').click();
    const handleDrawer = page.getByTestId('issue-service-handle-drawer');
    await expect(handleDrawer).toBeVisible({ timeout: 15_000 });

    // No service Principal yet ⇒ create one right here first (`CreatePrincipalForm` — always
    // `kind: 'service'`, docs/platform-admin-design.md §6.3's "外部运行时" flow). `MembersPage` owns
    // one drawer at a time, but `handleDrawer`'s own full-viewport overlay still covers the header
    // buttons while it is open — close it explicitly (Esc) and wait for it to be hidden before
    // clicking 服务凭证, or Playwright can never hit-test through the overlay to the real button
    // and retries until its own timeout. Reopen 签发外部运行时凭证 once the principal exists.
    if (
      await handleDrawer
        .getByTestId('issue-service-handle-no-principal')
        .isVisible()
        .catch(() => false)
    ) {
      const suffix = Date.now().toString(36);
      await page.keyboard.press('Escape');
      await expect(handleDrawer).toBeHidden();

      await page.getByRole('button', { name: /服务凭证/ }).click();
      const createDrawer = page.getByTestId('create-principal-drawer');
      await expect(createDrawer.getByTestId('create-principal-form')).toBeVisible({
        timeout: 15_000,
      });
      await createDrawer.locator('#cp-name').fill(`ci-fixture-svc-${suffix}`);
      await createDrawer.getByRole('button', { name: '创建' }).click();
      await expect(createDrawer.getByTestId('create-principal-key')).toBeVisible({
        timeout: 15_000,
      });
      await createDrawer.getByRole('button', { name: /我已复制/ }).click();
      await expect(createDrawer).toBeHidden();

      await page.getByTestId('issue-service-handle-trigger').click();
      await expect(handleDrawer).toBeVisible({ timeout: 15_000 });
    }

    const form = handleDrawer.getByTestId('issue-service-handle-form');
    await expect(form).toBeVisible();
    const principalSelect = form.locator('#ish-principal');
    const firstPrincipalOption = principalSelect.locator('option:not([value=""])').first();
    await expect(firstPrincipalOption).toHaveCount(1);
    const principalId = await firstPrincipalOption.getAttribute('value');
    expect(principalId ?? '').not.toBe('');
    await principalSelect.selectOption(principalId as string);
    await form.locator('#ish-scope').fill('get_task');
    await form.getByRole('button', { name: /签发/ }).click();

    // The issued result swaps into this same drawer (no second, nested `Drawer`) — still
    // `handleDrawer`, just its content moved from the form to the one-time reveal.
    const issuedPanel = handleDrawer.getByTestId('issued-handle-dialog');
    await expect(issuedPanel).toBeVisible({ timeout: 15_000 });
    const token = issuedPanel.getByTestId('issued-handle-token');
    await expect(token).toBeVisible();
    expect(((await token.textContent()) ?? '').trim().length).toBeGreaterThan(0);
    // Read the session id here (rather than filtering the runtimes table by principal, which a
    // leftover session from a failed earlier attempt could make ambiguous) so the row/revoke
    // lookup below is unambiguous.
    const sessionId = (
      (await issuedPanel.getByTestId('issued-handle-session-id').textContent()) ?? ''
    ).trim();
    expect(sessionId.length).toBeGreaterThan(0);
    await issuedPanel.getByRole('button', { name: /我已保存/ }).click();
    await expect(handleDrawer).toBeHidden();

    // --- 集成 → 外部运行时: the new session shows up, then gets revoked -------------------------
    await page.getByTestId('nav-platformIntegrations').click();
    await expect(page.getByTestId('platform-integrations-page')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('integrations-tab-runtimes').click();
    await expect(page.getByTestId('external-runtimes-table')).toBeVisible({ timeout: 15_000 });

    const runtimeRow = page.getByTestId(`external-runtime-row-${sessionId}`);
    await expect(runtimeRow).toBeVisible({ timeout: 15_000 });
    await runtimeRow.getByTestId(`external-runtime-revoke-${sessionId}`).click();
    await runtimeRow.getByRole('button', { name: /确认吊销/ }).click();
    await expect(runtimeRow).toBeHidden({ timeout: 15_000 });

    await signOut(page);
  });
});
