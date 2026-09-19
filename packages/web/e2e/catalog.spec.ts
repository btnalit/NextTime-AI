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
    await expect(proposed.getByTestId('draft-private-notice')).toContainText('private');
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
    // The checklist only lists the published, policy-allowed Skills once "继承 Inherit" is
    // unchecked (S3.13: an inheriting profile has nothing to pick); a fresh publication is
    // *available* there, not auto-enabled.
    await skillsField.getByRole('checkbox', { name: /Inherit workspace default/ }).uncheck();
    await expect(skillsField.getByText(name)).toBeVisible();
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
    await page.keyboard.press('Escape');
    await expect(procedure).toBeHidden();

    await page.goto('/#/govern/catalog/workers');
    await page.getByTestId('workers-new-draft').click();
    const worker = page.getByTestId('worker-editor-drawer');
    await expect(worker).toBeVisible({ timeout: 15_000 });
    await expect(worker.getByTestId('wd-kind')).toHaveValue('worker');
    await worker.getByTestId('worker-view-json').click();
    await expect(worker.getByTestId('worker-json')).toBeVisible();
  });
});
