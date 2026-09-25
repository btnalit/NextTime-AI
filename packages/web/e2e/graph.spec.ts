import { expect, test } from '@playwright/test';
import { loginWithApiKey, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/graph.spec.ts: CI smoke coverage for the native 图谱 Graph page (S6-D, docs/console-
 * completion-plan.md §5.7; `packages/web/src/components/graph/`). Same shape as
 * governance.spec.ts: one owner API key against a freshly bootstrapped workspace, each test
 * asserting the page reaches a ready (or explicitly acceptable empty) state without a
 * 403 / 404 / 500. The fake stack has no collector run, so a bare workspace holds only the
 * platform meta-ontology Objects (the bootstrap Gatekeeper / Operations, if any) — every
 * assertion below accepts the empty state as well as rows. NOTE (lane report): this spec was
 * written against the fake-stack conventions but has NOT been run — it needs the S6-D route to
 * be wired into `lib/router.ts` / `routes.tsx` by the integrator first.
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_API_KEY` (any role — `search` / `list_types` /
 * `state_at` / `explain` are `minRole: 'member'`), a kernel started `AGENT_RUNTIME=fake`.
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

async function login(page: import('@playwright/test').Page, apiKey: string): Promise<void> {
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithApiKey(page, apiKey);
}

test.describe('CI smoke: 图谱 Graph page', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite against a running kernel (see README.md)',
  );

  test('lands on the browse list with the type filter and legend (empty state is fine)', async ({
    page,
  }) => {
    const apiKey = API_KEY as string; // guarded by test.skip above
    await login(page, apiKey);

    await page.goto('/#/work/graph');
    await expect(page.getByRole('heading', { name: '图谱' })).toBeVisible();
    await expect(
      page.getByTestId('graph-results').or(page.getByTestId('graph-results-empty')),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-results-error')).toHaveCount(0);
    // `list_types` populated the selector (or, only if it failed, the text fallback is present).
    await expect(
      page.getByTestId('graph-type-select').or(page.getByTestId('graph-type-input')),
    ).toBeVisible();
    // S8 W4 (audit G3, i18n correctness fix): the legend summary used to glue both languages
    // together ("2 小时 2 h") regardless of the selected language — `formatWindow` now returns
    // one language via `t()`, same as every other label on this page, so the default zh-CN
    // session shows only the Chinese half.
    await expect(page.getByTestId('graph-legend')).toContainText('2 小时');
    await expect(page.getByTestId('graph-no-object')).toBeVisible();
  });

  test('a submitted search lands in the hash; a missing object shows the not-found state', async ({
    page,
  }) => {
    const apiKey = API_KEY as string;
    await login(page, apiKey);

    await page.goto('/#/work/graph');
    await page.getByTestId('graph-q').fill('zzz-no-such-object');
    await page.getByTestId('graph-search-submit').click();
    await expect(page).toHaveURL(/#\/work\/graph\?q=zzz-no-such-object$/);
    await expect(page.getByTestId('graph-results-empty')).toBeVisible({ timeout: 15_000 });

    // A deep link to an unknown Object id is a rendered state, not an error.
    await page.goto('/#/work/graph?objectId=00000000-0000-4000-8000-000000000000');
    await expect(page.getByTestId('graph-object-missing')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('graph-back').click();
    await expect(page.getByTestId('graph-no-object')).toBeVisible();
  });

  test('opening the first Object (when any) shows its card and Fact list or the empty Facts state', async ({
    page,
  }) => {
    const apiKey = API_KEY as string;
    await login(page, apiKey);

    await page.goto('/#/work/graph');
    await expect(
      page.getByTestId('graph-results').or(page.getByTestId('graph-results-empty')),
    ).toBeVisible({ timeout: 15_000 });
    const rows = page.getByTestId('graph-result-row');
    test.skip((await rows.count()) === 0, 'workspace has no Objects — nothing to open');

    await rows.first().click();
    await expect(page).toHaveURL(/#\/work\/graph\?objectId=/);
    await expect(page.getByTestId('graph-object-card')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-object-freshness')).toBeVisible();
    await expect(
      page.getByTestId('graph-neighbour-list').or(page.getByTestId('graph-facts-empty')),
    ).toBeVisible();

    // When a Fact exists, its provenance drawer opens on `explain` and links to the audit page.
    const facts = page.getByTestId('graph-fact-row');
    if ((await facts.count()) > 0) {
      await facts.first().getByTestId('graph-fact-provenance').click();
      const drawer = page.getByTestId('graph-provenance-drawer');
      await expect(drawer).toBeVisible();
      await expect(
        drawer
          .getByTestId('graph-provenance-chain')
          .or(drawer.getByTestId('graph-provenance-error')),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('graph-open-in-audit')).toHaveAttribute('href', /nodeId=/);
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
    }
  });
});
