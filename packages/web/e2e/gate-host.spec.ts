import { type Page, expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/gate-host.spec.ts: the P-B2a acceptance flow (docs/development-tasks.md P-B 决定 ⑥–⑬,
 * design §6.3 "通用门宿主") — an administrator creates a generic `mcp` gate-host instance pointed
 * at `.github/workflows/e2e.yml`'s `fixture-mcp` service, the gate host (`deploy/ci/
 * docker-compose.ci.yml`'s `gate-host` service, already running against the same kernel) pulls it
 * on its own poll loop and takes it over, the administrator enters its shared credential and
 * proves the connection, then a workspace owner enables it from the platform catalog and its two
 * fixture tools (`deploy/accept-s2/mcp/server.mjs`: `accept_s2_mcp_echo` observe,
 * `accept_s2_mcp_note` execute) show up in 能力目录; finally the instance is marked `vetted` and
 * one of its Operations is disabled from the catalog via the connector's deny list.
 *
 * Four tests, `serial`, in an order that is also a real dependency: test 2's credential/test-
 * connection needs the instance the gate host has already taken over from test 1 (`gate-instance-
 * test`'s health probe hits the gate host, not the kernel); test 3's `enable_gate_instance` needs
 * the connector already in `platform_preset` mode from that same test; test 4's catalog assertions
 * need test 3's `enable_gate_instance` to have published the two Operations in the first place.
 * Every test reuses the same signed-in-as-admin pattern `integrations.spec.ts`/`workspaces.spec.ts`
 * use rather than sharing a page across tests — no dependency on Playwright test isolation beyond
 * what those files already rely on.
 *
 * Idempotent for a CI retry the same way `integrations.spec.ts` is: every assertion is against an
 * end state, and a fixed (never suffixed) `gateId` means a retry's `create_gate_instance` gets the
 * platform's own `gate_id_taken` 409 back — tolerated by finding the row that already exists
 * instead of failing. Test 4 restores the deny list to empty before it ends, same convention
 * `integrations.spec.ts`'s own connector-deny-list test follows.
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_ADMIN_LOGIN`/`WEB_E2E_ADMIN_INITIAL_PASSWORD` — the same
 * pre-created platform administrator `integrations.spec.ts`/`workspaces.spec.ts` use. The admin is
 * assumed to be the owner of the platform default workspace (true on a fresh stack), same
 * assumption `integrations.spec.ts` makes for its own workspace-catalog tests. No other env var:
 * `fixture-mcp` and `gate-host` are unconditionally part of the CI stack
 * (`deploy/ci/docker-compose.ci.yml`), not gated behind a seed step the way P-B1's packaged
 * `ci-fixture-mcp` instance is.
 */

const ADMIN_LOGIN = process.env.WEB_E2E_ADMIN_LOGIN;
const ADMIN_INITIAL_PASSWORD = process.env.WEB_E2E_ADMIN_INITIAL_PASSWORD;

const BAD_CREDENTIALS_MESSAGE = '登录名或密码不正确';
const GATE_ID = 'e2e-hosted-mcp';
const DISPLAY_NAME = 'E2E hosted MCP';
const TARGET = 'http://fixture-mcp:8080/';
/** `createHostedGateInstance` (application/gates/store.ts) sets `connector = transportKind` for a
 *  hosted instance — this is the generic `mcp` connector every migration seeds from the start
 *  (`self_serve` by default), not a packaged one. */
const CONNECTOR = 'mcp';
const OBSERVE_OP = 'accept_s2_mcp_echo';
const EXECUTE_OP = 'accept_s2_mcp_note';
const SHARED_TOKEN = 'e2e-secret';

/**
 * Signs `admin` in through the password form, tolerating both states the account can be in: still
 * on its initial temporary password (a fresh stack) or already on the deterministic
 * `${initial}-changed` one (an earlier attempt of this file, or of `integrations.spec.ts`/
 * `workspaces.spec.ts` — whichever alphabetically-ordered spec runs first does the one forced
 * change every subsequent sign-in of any of them has to tolerate). A local copy rather than a
 * shared helper for the same reason those files' own copies give: `auth-helpers.ts` holds only the
 * byte-identical steps, and what a caller asserts around them differs per spec.
 */
async function signInAsAdmin(page: Page): Promise<void> {
  const login = ADMIN_LOGIN as string;
  const initialPassword = ADMIN_INITIAL_PASSWORD as string;
  const changedPassword = `${initialPassword}-changed`;

  const changePasswordHeading = page.getByRole('heading', { name: /Password change required/ });
  // The platform 工作区 nav item: rendered by `Sidebar` for `platformRole === 'admin'` whatever
  // route the admin lands on, so it is the one "we are past the login screen" signal that always
  // holds (same reasoning as `integrations.spec.ts`'s own copy of this helper).
  const shell = page.getByTestId('nav-platformWorkspaces');
  const badCredentials = page.getByText(BAD_CREDENTIALS_MESSAGE);

  await page.goto('/');
  await reachLoginForm(page);
  await loginWithPassword(page, login, initialPassword);
  await expect(changePasswordHeading.or(shell).or(badCredentials).first()).toBeVisible({
    timeout: 15_000,
  });

  if (await badCredentials.isVisible().catch(() => false)) {
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

/** Same guard `integrations.spec.ts` uses before any workspace-scope page: the switcher only
 *  renders for a cookie session with more than one active membership, never expected for this
 *  file's admin, but harmless to check in case a shared CI stack ever grows a second one. */
async function ensureOwnedWorkspaceSelected(page: Page): Promise<void> {
  const switcher = page.getByTestId('workspace-switcher');
  if (!(await switcher.isVisible().catch(() => false))) return;
  const option = switcher.locator('option', { hasText: '(owner)' });
  await expect(option).toHaveCount(1);
  const workspaceId = await option.getAttribute('value');
  expect(workspaceId ?? '').not.toBe('');
  await switcher.selectOption(workspaceId as string);
  await expect(switcher).toHaveValue(workspaceId as string, { timeout: 15_000 });
  await expect(switcher).toBeEnabled();
}

/** Ticks/unticks one Operation name in a connector's deny-list checklist (`ConnectorDenyList`) and
 *  saves, but only when it is not already in the requested state — copied byte-for-byte from
 *  `integrations.spec.ts`'s own helper of the same name and shape. Assumes the connector's row is
 *  already expanded. */
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
  await list.getByRole('button', { name: /保存 Save/ }).click();
  await expect(checkbox).toBeChecked({ checked: disabled, timeout: 15_000 });
}

/**
 * Polls `get_gate_instance` directly via `page.request` — the same cookie session the admin's
 * password login installed, so this needs the CSRF header every cookie-authenticated `/api/cap/*`
 * call requires (`capability-route.ts`, `CSRF_HEADER`/`CSRF_HEADER_VALUE`), never a workspace
 * header (`get_gate_instance` is `scope: 'platform'`). Bounded at 90s: `host.ts`'s own doc comment
 * says the gate host's first pull happens at its own startup — before this test's instance exists
 * — so the take-over lands on its *next* scheduled tick, up to `GATE_ANNOUNCE_INTERVAL_SEC`
 * (default 60s) later.
 */
async function waitForGateTakeover(page: Page, gateId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.post('/api/cap/get_gate_instance', {
          headers: { 'x-requested-with': 'nexttime' },
          data: { gateId },
        });
        if (!res.ok()) return false;
        const body = await res.json();
        return body.result.lastSeenAt !== null && body.result.operationCount === 2;
      },
      { timeout: 90_000, intervals: [3_000] },
    )
    .toBe(true);
}

/** Opens the 门实例 drawer for `GATE_ID` if it already exists (an earlier attempt of this test, or
 *  of a CI retry) — otherwise fills and submits `CreateGateInstanceForm` for it. Tolerates the one
 *  409 that means "already there and nothing is wrong", `gate_id_taken`, the same way
 *  `integrations.spec.ts`'s own tests tolerate landing on state a previous attempt already
 *  produced. Returns whether this call is the one that actually created the row — only then is
 *  "等待宿主接管" guaranteed to still be showing (see the caller). */
async function ensureHostedInstanceExists(page: Page): Promise<{ readonly justCreated: boolean }> {
  const row = page.getByTestId(`gate-instance-row-${GATE_ID}`);
  if (await row.isVisible().catch(() => false)) {
    return { justCreated: false };
  }

  await page.getByTestId('new-gate-instance').click();
  const createDrawer = page.getByTestId('create-gate-instance-drawer');
  const form = createDrawer.getByTestId('create-gate-instance-form');
  await expect(form).toBeVisible({ timeout: 15_000 });
  await form.locator('#cgi-gate-id').fill(GATE_ID);
  await form.locator('#cgi-display-name').fill(DISPLAY_NAME);
  await form.locator('input[name="transportKind"][value="mcp"]').check();
  await form.locator('#cgi-target').fill(TARGET);
  // Credential mode is left at its default, `shared` — exactly the "one credential, entered by an
  // administrator" mode the next test's `GateCredentialEntry` step needs.
  await form.getByTestId('create-gate-instance-submit').click();

  const createError = createDrawer.getByTestId('create-gate-instance-error');
  const detailDrawer = page.getByTestId('gate-instance-drawer');
  await expect(createError.or(detailDrawer.getByTestId('gate-instance-detail'))).toBeVisible({
    timeout: 15_000,
  });

  if (await createError.isVisible().catch(() => false)) {
    await expect(createError).toHaveAttribute('data-error-code', 'gate_id_taken');
    await page.keyboard.press('Escape');
    await expect(createDrawer).toBeHidden();
    return { justCreated: false };
  }

  await page.keyboard.press('Escape');
  await expect(detailDrawer).toBeHidden();
  return { justCreated: true };
}

test.describe('P-B2a acceptance: a generic mcp gate-host instance, end to end', () => {
  // Serial: see the file doc comment for the real dependency each test after the first has on the
  // one before it, not just narrative convention.
  test.describe.configure({ mode: 'serial' });

  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_BASE_URL, WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD to run this suite (see README.md)',
  );

  test('admin: create the hosted mcp instance; the gate host takes it over', async ({ page }) => {
    // The 90s bound in `waitForGateTakeover` alone eats most of `test.slow()`'s tripled 90s budget
    // — give this one test room on top of that for login/navigation.
    test.setTimeout(150_000);
    await signInAsAdmin(page);

    await page.getByTestId('nav-platformIntegrations').click();
    await expect(page.getByTestId('platform-integrations-page')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('integrations-tab-instances').click();
    await expect(
      page.getByTestId('gate-instances-table').or(page.getByTestId('gate-instances-empty')),
    ).toBeVisible({ timeout: 15_000 });

    const { justCreated } = await ensureHostedInstanceExists(page);

    const row = page.getByTestId(`gate-instance-row-${GATE_ID}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('gate-hosted-badge')).toBeVisible();
    if (justCreated) {
      // The one moment this transient chip is guaranteed to still be showing: right after
      // creation, before the host's next scheduled pull. A retry that finds the row already there
      // skips this — by then the host may already have taken over.
      await expect(row.getByTestId('gate-instance-status')).toHaveText(/等待宿主接管/);
    }

    await waitForGateTakeover(page, GATE_ID);

    // The row itself reflects the same end state once refreshed — not just the direct API call.
    await page.reload();
    await page.getByTestId('integrations-tab-instances').click();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('gate-instance-status')).not.toHaveText(/等待宿主接管/, {
      timeout: 15_000,
    });

    await signOut(page);
  });

  test('admin: enter the shared credential, then test the connection', async ({ page }) => {
    test.slow();
    await signInAsAdmin(page);

    await page.getByTestId('nav-platformIntegrations').click();
    await expect(page.getByTestId('platform-integrations-page')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('integrations-tab-instances').click();
    const row = page.getByTestId(`gate-instance-row-${GATE_ID}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    const drawer = page.getByTestId('gate-instance-drawer');
    await expect(drawer.getByTestId('gate-instance-detail')).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByTestId('gate-instance-hosted-tag')).toBeVisible();

    // --- 录入共享凭证: the fixture ignores whatever credential it receives (`server.mjs` takes no
    //     auth) — this proves the browser -> caddy `/gate-host/*` -> gate host -> its own signed
    //     JWT path, not that the fixture validates the token. ---
    const hostedDefinition = drawer.getByTestId('gate-instance-hosted-definition');
    await hostedDefinition.getByTestId('gate-credential-token-button').click();
    const tokenInput = hostedDefinition.getByTestId('gate-credential-token-input');
    await expect(tokenInput).toBeVisible({ timeout: 15_000 });
    await tokenInput.fill(SHARED_TOKEN);
    await hostedDefinition.getByTestId('gate-credential-submit').click();
    await expect(hostedDefinition.getByTestId('gate-credential-stored')).toBeVisible({
      timeout: 15_000,
    });

    // --- 测试连接: the gate host's own health probe against the fixture, through the take-over
    //     from the previous test — never `unreachable` once taken over. ---
    await drawer.getByTestId('gate-instance-test').click();
    await expect(drawer.getByTestId('gate-instance-test-result')).toContainText('ok', {
      timeout: 15_000,
    });

    // --- 启用: a hosted instance lands `discovered` (review decision — the administrator reviews the
    //     host's endpoint and Operations before workspaces may enable it, same as a packaged gate).
    const statusToggle = drawer.getByTestId('gate-instance-status-toggle');
    if ((await statusToggle.textContent())?.trim() !== '禁用 Disable') {
      await statusToggle.click();
    }
    await expect(statusToggle).toHaveText('禁用 Disable', { timeout: 15_000 });

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await signOut(page);
  });

  test('admin: platform-preset the mcp connector, then enable it as workspace owner', async ({
    page,
  }) => {
    test.slow();
    await signInAsAdmin(page);
    await ensureOwnedWorkspaceSelected(page);

    // --- 接入包 Connectors: the generic `mcp` connector (`self_serve` from the start, per
    //     0023_gate_instances.sql) has to be `platform_preset` before an owner can see this
    //     instance in the workspace catalog at all (`listAvailableGateInstances`'s own `where`). ---
    await page.getByTestId('nav-platformIntegrations').click();
    await expect(page.getByTestId('platform-integrations-page')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('integrations-tab-connectors').click();
    await expect(page.getByTestId(`connector-row-${CONNECTOR}`)).toBeVisible({ timeout: 15_000 });
    const modeSelect = page.getByTestId(`connector-mode-${CONNECTOR}`);
    if ((await modeSelect.inputValue()) !== 'platform_preset') {
      await modeSelect.selectOption('platform_preset');
    }
    await expect(modeSelect).toHaveValue('platform_preset', { timeout: 15_000 });

    // --- 系统接入 Systems: enable it from the platform catalog (idempotent — a retry that already
    //     enabled it just finds the "已启用 Enabled" link with no button left to click). ---
    await page.getByTestId('nav-systems').click();
    await expect(page.getByRole('heading', { name: '系统接入 Systems' })).toBeVisible({
      timeout: 15_000,
    });
    const availableRow = page.getByTestId(`available-gate-${GATE_ID}`);
    await expect(availableRow).toBeVisible({ timeout: 15_000 });
    const enableButton = availableRow.getByTestId(`enable-gate-${GATE_ID}`);
    if (await enableButton.isVisible().catch(() => false)) {
      await enableButton.click();
      await expect(availableRow).toContainText('已发布 2 个 Operation Published 2 operations', {
        timeout: 15_000,
      });
    }
    await expect(availableRow.getByRole('link', { name: /已启用 Enabled/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('gatekeeper-card').filter({ hasText: DISPLAY_NAME })).toHaveCount(
      1,
      { timeout: 15_000 },
    );

    // --- 能力目录 Catalog: both fixture tools are published, end state either way. ---
    await page.getByTestId('nav-catalog').click();
    await expect(page.getByRole('heading', { name: '能力目录 Catalog' })).toBeVisible({
      timeout: 15_000,
    });
    const catalogList = page.getByTestId('catalog-list');
    await expect(catalogList.or(page.getByTestId('catalog-empty'))).toBeVisible({
      timeout: 15_000,
    });
    await expect(catalogList.getByText(OBSERVE_OP, { exact: true })).toHaveCount(1);
    await expect(catalogList.getByText(EXECUTE_OP, { exact: true })).toHaveCount(1);

    await signOut(page);
  });

  test('admin: mark the instance vetted, then disable one Operation on connector mcp', async ({
    page,
  }) => {
    test.slow();
    await signInAsAdmin(page);
    await ensureOwnedWorkspaceSelected(page);

    // --- 门实例: mark it `vetted` (mcp-only control — see `GateInstanceDetailPanel`'s own doc
    //     comment) so its idempotent tools become auto-approvable; not itself asserted here (that
    //     is an approvals-flow concern, not this catalog-visibility one), just set. ---
    await page.getByTestId('nav-platformIntegrations').click();
    await expect(page.getByTestId('platform-integrations-page')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('integrations-tab-instances').click();
    const row = page.getByTestId(`gate-instance-row-${GATE_ID}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    const drawer = page.getByTestId('gate-instance-drawer');
    await expect(drawer.getByTestId('gate-instance-detail')).toBeVisible({ timeout: 15_000 });
    const trustToggle = drawer.getByTestId('gate-instance-trust-toggle');
    const trustLabel = (await trustToggle.textContent())?.trim();
    if (trustLabel !== '撤销 vetted Revoke vetted') {
      await trustToggle.click();
    }
    await expect(trustToggle).toHaveText('撤销 vetted Revoke vetted', { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    async function expandMcpDenyList(): Promise<void> {
      await page.getByTestId('nav-platformIntegrations').click();
      await expect(page.getByTestId('platform-integrations-page')).toBeVisible({
        timeout: 15_000,
      });
      await page.getByTestId('integrations-tab-connectors').click();
      const connectorRow = page.getByTestId(`connector-row-${CONNECTOR}`);
      await expect(connectorRow).toBeVisible({ timeout: 15_000 });
      // Fresh mount ⇒ always collapsed (`ConnectorsTab` unmounts on every tab switch) — expand it.
      await connectorRow.getByRole('button', { name: /展开 Expand/ }).click();
    }

    async function catalogHasOperation(name: string): Promise<boolean> {
      await page.getByTestId('nav-catalog').click();
      await expect(page.getByRole('heading', { name: '能力目录 Catalog' })).toBeVisible({
        timeout: 15_000,
      });
      const list = page.getByTestId('catalog-list');
      await expect(list.or(page.getByTestId('catalog-empty'))).toBeVisible({ timeout: 15_000 });
      return (await list.getByText(name, { exact: true }).count()) > 0;
    }

    // --- disable accept_s2_mcp_note, and it drops out of the catalog while the observe tool
    //     stays — same assertion shape `integrations.spec.ts` uses for its own fixture. ---
    await expandMcpDenyList();
    await setOperationDisabled(page, CONNECTOR, EXECUTE_OP, true);

    expect(await catalogHasOperation(EXECUTE_OP)).toBe(false);
    expect(await catalogHasOperation(OBSERVE_OP)).toBe(true);

    // --- restore: re-enable it so a later retry (or a human) finds a clean deny list on the
    //     shared `mcp` connector. ---
    await expandMcpDenyList();
    await setOperationDisabled(page, CONNECTOR, EXECUTE_OP, false);
    expect(await catalogHasOperation(EXECUTE_OP)).toBe(true);

    await signOut(page);
  });
});
