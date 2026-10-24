import type { EntryTemplateStatusWire, WorkerDefinitionWire } from '@nexttime/shared';
import { type Page, expect, test } from '@playwright/test';
import { OWNER_API_KEY, loginAsOwner } from './lib/auth.js';

/**
 * e2e/entry-template.spec.ts (legacy 145): a workspace whose entry definition predates what the
 * platform's entry template says now, brought up to it from the catalog — against the real stack,
 * no stand-ins. The CI workspace is created from today's template, so the test first publishes
 * the entry version such a workspace would have: the template without its goals section and
 * without `propose_goal` (what workspaces created before S11 GO5 run with), plus one line of the
 * workspace's own. Then, at the widths UX checks (1440, 390): the Worker tab says the template
 * differs, the entry version in use lists the capability the template adds by what it does (UX
 * acceptance of #747, P2-1) ahead of the prompt's line-by-line difference, 「按平台模板生成新版本草稿」
 * proposes a draft that opens focused and says what publishing it changes against the version in
 * use, and once the owner publishes it the version in use matches the template again — which also
 * leaves the shared workspace's entry where it started. Full-page captures land in `test-results/` for the UX
 * acceptance to read; they are not a screenshot gate.
 */

const OWN_LINE = '本工作区的约定：回答前先说出你查了哪些来源。';

interface CapResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** A capability called as the owner, outside the page (the console keeps an apiKey session in
 *  the tab, not in a cookie the request context would share). */
async function callCap<T>(page: Page, name: string, data: unknown): Promise<T> {
  const res = await page.request.post(`/api/cap/${name}`, {
    headers: { authorization: `Bearer ${OWNER_API_KEY}` },
    data,
  });
  const body = (await res.json()) as CapResult;
  if (!body.ok) {
    throw new Error(`capability ${name} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result as T;
}

/**
 * Publishes the entry version an older workspace would run with and returns what the notice
 * should show for it: the first line of the section it lacks, and the version number.
 */
async function publishOlderEntry(page: Page): Promise<{ goalsHeading: string; version: number }> {
  const status = await callCap<EntryTemplateStatusWire>(page, 'get_entry_template_status', {});
  if (!status.current) throw new Error('the workspace has no published entry definition');
  const current = status.current;
  const { items } = await callCap<{ items: WorkerDefinitionWire[] }>(
    page,
    'list_worker_definitions',
    { kind: 'entry' },
  );
  const row = items.find(
    (item) => item.id === current.definitionId && item.version === current.version,
  );
  if (!row) throw new Error('the entry version in use is not listed');

  // The template's own prompt without its goals section (up to the next `## ` heading).
  const paragraphs = status.template.systemPrompt.split('\n\n');
  const goals = paragraphs.findIndex((paragraph) => paragraph.startsWith('## Goals'));
  expect(goals, 'the entry template has a "## Goals" section').toBeGreaterThan(0);
  const next = paragraphs.findIndex((paragraph, index) => index > goals && /^## /.test(paragraph));
  const kept = [...paragraphs.slice(0, goals), ...paragraphs.slice(next === -1 ? undefined : next)];
  const older = `${kept.join('\n\n').trimEnd()}\n\n${OWN_LINE}`;
  expect(status.template.capabilities, 'the entry template grants propose_goal').toContain(
    'propose_goal',
  );
  const capabilities = (row.definition.capabilities as string[]).filter(
    (name) => name !== 'propose_goal',
  );

  const draft = await callCap<WorkerDefinitionWire>(page, 'propose_worker_definition', {
    definitionId: row.id,
    kind: 'entry',
    definition: { ...row.definition, systemPrompt: older, capabilities },
  });
  const published = await callCap<WorkerDefinitionWire>(page, 'publish_worker_definition', {
    definitionId: draft.id,
    version: draft.version,
  });
  return {
    goalsHeading: (paragraphs[goals] as string).split('\n')[0] as string,
    version: published.version,
  };
}

/** A full-page capture from the top (taken mid-scroll, Chromium leaves the opened difference out
 *  of a full-page shot at 1440). */
async function capture(page: Page, path: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true });
}

test.describe('legacy 145: bringing the entry definition up to the platform template', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  for (const width of [1440, 390] as const) {
    test(`the template's difference, the draft, and publishing it at ${width}`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 900 });
      await loginAsOwner(page);
      const older = await publishOlderEntry(page);

      await page.goto('/#/govern/catalog/workers');
      const summary = page.getByTestId('entry-template-summary');
      await expect(summary).toContainText(
        `当前生效的入口定义 v${older.version} 的系统提示词、能力与这个平台版本自带的入口模板不同`,
        {
          timeout: 15_000,
        },
      );
      await summary.getByTestId('entry-template-summary-open').click();

      const detail = page.getByTestId('worker-detail');
      await expect(detail).toHaveAttribute('data-worker-key', new RegExp(`@${older.version}$`));
      const notice = page.getByTestId('entry-template-notice');
      await expect(notice).toContainText('与平台自带的入口模板不同');
      await expect(notice).toContainText('新草稿会用平台模板替换这些改动');
      // The capability the template adds, by what it does, before the folded prompt difference.
      const capabilities = page.getByTestId('entry-template-capability-diff');
      await expect(capabilities).toBeVisible();
      await expect(
        capabilities
          .getByTestId('capability-changes-added')
          .locator('[data-capability="propose_goal"]'),
      ).toContainText('+ 提议目标 propose_goal');
      await expect(capabilities.getByTestId('capability-changes-removed')).toHaveCount(0);

      await page.getByTestId('entry-template-diff').locator('summary').click();
      const diff = page.getByTestId('entry-template-prompt-diff');
      await expect(diff).toBeVisible();
      // The workspace's own line is what the template replaces.
      await expect(diff.locator('[data-change="removed"]', { hasText: OWN_LINE })).toHaveText(
        `− ${OWN_LINE}`,
      );
      await expect(diff.locator('[data-change="added"]').first()).toHaveText(
        `+ ${older.goalsHeading}`,
      );
      await expect(diff.locator('[data-change="gap"]').first()).toContainText('行未变');
      await capture(page, testInfo.outputPath(`entry-template-${width}.png`));

      await page.getByTestId('entry-template-propose').click();
      // A retried run finds the first attempt's identical draft and says so.
      await expect(
        page.getByTestId('toast').filter({ hasText: /已生成草稿 v\d+|你已经有这份草稿/ }),
      ).toBeVisible();
      await expect(detail.getByTestId('worker-detail-stepper')).toBeVisible();
      const draftKey = await detail.getAttribute('data-worker-key');
      expect(draftKey).not.toMatch(new RegExp(`@${older.version}$`));
      // UX acceptance of #747: focus on the draft's title (P3-1); what publishing it changes
      // against the version in use, next to Publish (P2-1).
      await expect(detail.locator('.catalog-detail-title')).toBeFocused();
      const changes = detail.getByTestId('entry-draft-changes');
      await expect(changes).toContainText(`与当前生效的 v${older.version} 相比`);
      await expect(
        changes.getByTestId('capability-changes-added').locator('[data-capability="propose_goal"]'),
      ).toContainText('提议目标');
      await expect(changes.getByTestId('entry-draft-prompt-change')).toHaveText(
        '系统提示词有改动，见下面的定义。',
      );
      await capture(page, testInfo.outputPath(`entry-template-draft-${width}.png`));

      await detail.getByTestId('worker-draft-publish').click();
      await expect(page.getByTestId('entry-template-current')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('entry-template-notice')).toHaveCount(0);

      const after = await callCap<EntryTemplateStatusWire>(page, 'get_entry_template_status', {});
      expect(after.differs).toEqual([]);
      expect(`${after.current?.definitionId}@${after.current?.version}`).toBe(draftKey);
    });
  }
});
