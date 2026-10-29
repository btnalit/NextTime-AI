import { expect, test } from '@playwright/test';
import { loginWithApiKey, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/catalog.spec.ts (S6-A A2 acceptance — console-completion-plan §5.3 "在页面新建一个 Skill
 * 草稿并发布，`list_skills` 与「我的智能体」的可选 Skills 立即可见"): the Skill editor end to end
 * against a real kernel — propose a SKILL.md draft, publish it from the editor's success state,
 * see it in the Skills tab and in 我的智能体's Skill checklist. Requires `WEB_E2E_BASE_URL` +
 * `WEB_E2E_API_KEY` (owner — `propose_skill` is builder+, `publish_skill` human-channel).
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

async function login(page: import('@playwright/test').Page, apiKey: string): Promise<void> {
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithApiKey(page, apiKey);
}

test.describe('catalog editors', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite against a running kernel (see README.md)',
  );

  test('skills: new draft → publish → visible in the tab and in my agent', async ({ page }) => {
    await login(page, API_KEY as string);
    const name = `e2e-skill-${Date.now()}`;

    await page.goto('/#/govern/catalog/skills');
    await page.getByTestId('skills-new-draft').click();
    const drawer = page.getByTestId('skill-editor-drawer');
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await drawer.locator('#skill-name').fill(name);
    await drawer.locator('#skill-description').fill('Created by catalog.spec.ts');
    await drawer.locator('#skill-markdown').fill('# Steps\n\n1. Nothing to do.');
    await drawer.getByTestId('skill-submit').click();

    const proposed = drawer.getByTestId('draft-proposed');
    await expect(proposed).toBeVisible({ timeout: 15_000 });
    await expect(proposed.getByTestId('draft-private-notice')).toContainText('只有你');
    await drawer.getByTestId('draft-publish').click();
    await expect(drawer.getByTestId('draft-publish')).toBeHidden({ timeout: 15_000 });
    await drawer.getByTestId('draft-done').click();
    await expect(drawer).toBeHidden();

    const row = page.getByTestId('catalog-row').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('[data-status="published"]')).toBeVisible();

    await page.goto('/#/me/agent');
    const skillsField = page.getByTestId('agent-profile-skills');
    await expect(skillsField).toBeVisible({ timeout: 15_000 });
    // Console redesign D1: the checklist lists every published, policy-allowed Skill, ticked — a
    // fresh publication is in use by default (untick to exclude), never silently left out.
    await expect(skillsField.getByRole('checkbox', { name })).toBeChecked();
  });

  // UX acceptance of #764 (P2-1, P3-1): a published Skill's next version waits as a draft beside
  // the version in use. The list names both; the draft's detail opens the one in use, read-only.
  test('skills: a next-version draft names the version in use, which opens read-only', async ({
    page,
  }) => {
    await login(page, API_KEY as string);
    const name = `e2e-skill-next-${Date.now()}`;

    await page.goto('/#/govern/catalog/skills');
    await page.getByTestId('skills-new-draft').click();
    const drawer = page.getByTestId('skill-editor-drawer');
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await drawer.locator('#skill-name').fill(name);
    await drawer.locator('#skill-description').fill('Created by catalog.spec.ts');
    await drawer.locator('#skill-markdown').fill('# Steps\n\n1. Nothing to do.');
    await drawer.getByTestId('skill-submit').click();
    await expect(drawer.getByTestId('draft-proposed')).toBeVisible({ timeout: 15_000 });
    await drawer.getByTestId('draft-publish').click();
    await expect(drawer.getByTestId('draft-publish')).toBeHidden({ timeout: 15_000 });
    await drawer.getByTestId('draft-done').click();

    const row = page.getByTestId('catalog-row').filter({ hasText: name });
    await expect(row.locator('[data-status="published"]')).toBeVisible({ timeout: 15_000 });
    await row.click();
    const detail = page.getByTestId('skill-detail');
    await detail.getByTestId('catalog-edit-as-draft').click();
    const next = page.getByTestId('skill-editor-drawer');
    const body = next.locator('#skill-markdown');
    await expect(body).toHaveValue('# Steps\n\n1. Nothing to do.', { timeout: 15_000 });
    await body.fill('# Steps\n\n1. Nothing to do.\n2. Still nothing.');
    await next.getByTestId('skill-submit').click();
    await expect(next.getByTestId('draft-proposed')).toBeVisible({ timeout: 15_000 });
    await next.getByTestId('draft-done').click();

    await expect(row.getByTestId('catalog-row-in-use')).toHaveText(
      'v1 已发布（在用）· v2 草稿待发布',
      { timeout: 15_000 },
    );
    await row.click();
    await expect(detail.getByTestId('skill-detail-in-use-note')).toContainText(
      '已发布的 v1 仍在用',
    );
    await expect(detail.getByTestId('skill-detail-body')).toContainText('Still nothing');

    await detail.getByTestId('skill-detail-open-in-use').click();
    await expect(detail.getByTestId('skill-detail-pending-draft-note')).toContainText(
      '这是在用的 v1（只读）',
    );
    await expect(detail.locator('.catalog-detail-title')).toBeFocused();
    await expect(detail.getByTestId('skill-detail-body')).toContainText('Nothing to do');
    await expect(detail.getByTestId('skill-detail-body')).not.toContainText('Still nothing');
    await expect(detail.getByRole('button', { name: '发布', exact: true })).toHaveCount(0);
    await expect(detail.getByTestId('catalog-edit-as-draft')).toHaveCount(0);

    await detail.getByTestId('skill-detail-open-draft').click();
    await expect(detail.getByTestId('skill-detail-in-use-note')).toBeVisible();
    await expect(detail.getByRole('button', { name: '发布', exact: true })).toBeVisible();
  });

  test('procedures / workers: the editors open with their form and JSON views', async ({
    page,
  }) => {
    await login(page, API_KEY as string);

    await page.goto('/#/govern/catalog/procedures');
    await page.getByTestId('procedures-new-draft').click();
    const procedure = page.getByTestId('procedure-editor-drawer');
    await expect(procedure).toBeVisible({ timeout: 15_000 });
    await procedure.getByTestId('procedure-add-step').click();
    await expect(procedure.getByTestId('procedure-step')).toHaveCount(1);
    await procedure.getByTestId('procedure-view-json').click();
    await expect(procedure.getByTestId('procedure-json')).toBeVisible();
    // console redesign P3-5: the editor lives in `kit/master-detail`'s own pane now, not a
    // `ui/Drawer` — at this default (wide, ≥1180px) viewport that pane is always inline, so
    // Escape is a no-op here (same call this lane made for the approvals/tasks journeys in P3-4);
    // the `page.goto` below moves on regardless of whether anything closed.
    await page.keyboard.press('Escape');

    await page.goto('/#/govern/catalog/workers');
    await page.getByTestId('workers-new-draft').click();
    const worker = page.getByTestId('worker-editor-drawer');
    await expect(worker).toBeVisible({ timeout: 15_000 });
    await expect(worker.getByTestId('wd-kind')).toHaveValue('worker');
    await worker.getByTestId('worker-view-json').click();
    await expect(worker.getByTestId('worker-json')).toBeVisible();
  });
});
