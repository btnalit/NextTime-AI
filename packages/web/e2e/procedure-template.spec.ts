import { getCapability } from '@nexttime/shared';
import { type Page, expect, test } from '@playwright/test';
import { OWNER_API_KEY, loginAsOwner } from './lib/auth.js';

/**
 * e2e/procedure-template.spec.ts (S11 GO5d-2): a Procedure's catalog page read as the template a
 * goal's plan is made from — each step's place in the plan, what it waits for, where its inputs
 * come from, who checks each verify step, and the parameters — and its editor editing those fields
 * in place (legacy 453), at the widths UX checks (1440, 390). Nothing on the CI stack publishes such a
 * Procedure, so `list_procedures` and the names it points at are stand-ins answered in the browser
 * (`page.route`, as goal-detail.spec.ts does); everything else is the real stack. Full-page
 * captures land in `test-results/` for the UX acceptance to read; they are not a screenshot gate.
 */

const PROCEDURE = '67000000-0000-4000-8000-000000000001';
const WORKER = '67000000-0000-4000-8000-0000000000e1';
const GATE = '67000000-0000-4000-8000-0000000000d1';
const PROPOSER = '67000000-0000-4000-8000-0000000000a1';
const T0 = new Date(Date.now() - 3_600_000).toISOString();

const worker = { kind: 'worker', definitionId: WORKER, version: 2 };

const PROCEDURE_ROW = {
  id: PROCEDURE,
  version: 3,
  status: 'published',
  name: '证书续期',
  description: '列出站点上即将过期的证书，换成新签发的，再确认新证书有效。',
  steps: [
    {
      ...worker,
      description: '列出即将过期的证书所在的主机',
      key: 'fetch',
      input: { mode: 'safe' },
      bindings: [{ to: 'target.site', from: '$params', path: 'site' }],
      outputSchema: {
        type: 'object',
        properties: {
          hosts: { type: 'array', items: { type: 'string' }, description: '要换证书的主机' },
        },
        required: ['hosts'],
      },
      maxAttempts: 2,
    },
    { kind: 'verify', description: '列出的主机和资产表里的一致。' },
    {
      ...worker,
      description: '在这些主机上换证书',
      bindings: [{ to: 'target.hosts', from: 'fetch', path: 'hosts' }],
    },
    {
      kind: 'verify',
      description: '新证书有效。',
      check: {
        kind: 'observe_predicate',
        key: 'valid',
        check: {
          gatekeeperId: GATE,
          operation: 'cert.status',
          params: {},
          expect: { path: 'state', op: 'eq', value: 'valid' },
        },
      },
    },
  ],
  parameters: {
    type: 'object',
    properties: { site: { type: 'string', minLength: 1, description: '要续期的站点' } },
    required: ['site'],
  },
  proposedBy: PROPOSER,
};

const NAMES: Record<string, { kind: string; name: string }> = {
  [WORKER]: { kind: 'workerDefinition', name: 'cert-rotator' },
  [GATE]: { kind: 'gatekeeper', name: 'cert-gate' },
  [PROPOSER]: { kind: 'principal', name: 'alice' },
};

/** A stand-in's answer, checked first against the capability's own result contract. */
function answer(name: string, result: unknown) {
  const contract = getCapability(name)?.resultSchema;
  if (!contract) throw new Error(`no result contract for ${name}`);
  return { json: { ok: true, result: contract.parse(result) } };
}

/** Legacy 455: a draft whose bindings the page can already tell are wrong — one from the step
 *  itself, one from a step the Procedure does not have. */
const DRAFT_ROW = {
  ...PROCEDURE_ROW,
  version: 4,
  status: 'draft',
  steps: [
    {
      ...worker,
      description: '列出即将过期的证书所在的主机',
      key: 'fetch',
      bindings: [{ to: 'target.site', from: 'fetch', path: 'site' }],
      outputSchema: { type: 'object', properties: { site: { type: 'string' } } },
    },
    {
      ...worker,
      description: '在这些主机上换证书',
      key: 'apply',
      bindings: [{ to: 'target.hosts', from: 'scan', path: 'hosts' }],
    },
  ],
};

async function answerProcedureReads(page: Page, row: object = PROCEDURE_ROW): Promise<void> {
  await page.route('**/api/cap/list_procedures', (route) =>
    route.fulfill(answer('list_procedures', { items: [row] })),
  );
  await page.route('**/api/cap/list_gatekeepers', (route) =>
    route.fulfill(
      answer('list_gatekeepers', {
        items: [
          {
            id: GATE,
            name: 'cert-gate',
            kind: 'http',
            status: 'active',
            operationCount: 2,
            createdAt: T0,
          },
        ],
      }),
    ),
  );
  await page.route('**/api/cap/list_operations', (route) =>
    route.fulfill(
      answer('list_operations', {
        items: [
          {
            gatekeeperId: GATE,
            name: 'cert.status',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
            version: 1,
            status: 'published',
          },
        ],
      }),
    ),
  );
  await page.route('**/api/cap/resolve_refs', async (route) => {
    const body = route.request().postDataJSON() as { ids?: string[] } | null;
    const items = (body?.ids ?? []).flatMap((id) => {
      const ref = NAMES[id];
      return ref ? [{ id, ...ref }] : [];
    });
    await route.fulfill(answer('resolve_refs', { items }));
  });
}

test.describe('S11 GO5d-2: a Procedure as a goal plan template (stand-in reads)', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  for (const width of [1440, 390] as const) {
    test(`the Procedure page and its editor at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await answerProcedureReads(page);
      await loginAsOwner(page);

      await page.goto(`/#/govern/catalog/procedures/${PROCEDURE}`);
      const detail = page.getByTestId('procedure-detail');
      await expect(detail).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('procedure-template-summary')).toContainText(
        '可以用这个流程生成目标',
      );
      const steps = page.getByTestId('procedure-template-step');
      await expect(steps).toHaveCount(4);
      await expect(page.getByTestId('procedure-template-binding')).toHaveText([
        '输入 target.site 来自启动参数的 site',
        '输入 target.hosts 来自步骤 fetch 输出的 hosts',
      ]);
      await expect(steps.nth(2)).toContainText('等上一个 Worker 步骤 fetch 完成后开始');
      await expect(page.getByTestId('procedure-template-confirm')).toHaveCount(1);
      await expect(page.getByTestId('procedure-template-check')).toContainText('cert-gate');
      await expect(page.getByTestId('procedure-template-parameters')).toContainText('site');
      await page
        .getByTestId('procedure-template-output-contract')
        .locator(':scope > summary')
        .click();
      await page.screenshot({
        path: testInfo.outputPath(`procedure-template-${width}.png`),
        fullPage: true,
      });

      // Legacy 453: the editor edits them in place — what a list cannot say stays JSON.
      await page.getByTestId('catalog-edit-as-draft').click();
      const editor = page.getByTestId('procedure-editor');
      await expect(editor).toBeVisible({ timeout: 15_000 });
      const editing = editor.getByTestId('procedure-step');
      await expect(editing.nth(0).getByTestId('procedure-step-plan-key')).toHaveValue('fetch');
      await expect(editing.nth(0).getByTestId('procedure-step-binding-from')).toHaveValue(
        '$params',
      );
      await expect(editing.nth(2).getByTestId('procedure-step-binding-from')).toHaveValue('fetch');
      await expect(editing.nth(3).getByTestId('procedure-step-check-kind')).toHaveValue(
        'observe_predicate',
      );
      await expect(editing.nth(3).getByTestId('procedure-step-check-sentence')).toContainText(
        'cert-gate',
      );
      await expect(editor.getByTestId('procedure-parameters-json-only')).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`procedure-template-editor-${width}.png`),
        fullPage: true,
      });

      // Legacy 464: what the observed result must satisfy, as conditions in the form.
      const expectBox = editing.nth(3).getByTestId('procedure-step-check-expect');
      await expect(expectBox.getByTestId('procedure-step-check-expect-path')).toHaveValue('state');
      await expectBox.getByTestId('procedure-step-check-expect-add-condition').first().click();
      const second = expectBox.getByTestId('procedure-step-check-expect-condition').nth(1);
      await expect(second.getByTestId('procedure-step-check-expect-path')).toBeFocused();
      await second.getByTestId('procedure-step-check-expect-path').fill('daysLeft');
      await second.getByTestId('procedure-step-check-expect-op').selectOption('gt');
      await expect(second.getByTestId('procedure-step-check-expect-value-kind')).toHaveValue(
        'number',
      );
      await second.getByTestId('procedure-step-check-expect-value').fill('7');
      await expectBox.getByTestId('procedure-step-check-expect-add-group').first().click();
      const group = expectBox.getByTestId('procedure-step-check-expect-group');
      await group.getByTestId('procedure-step-check-expect-path').fill('issuer');
      await group.getByTestId('procedure-step-check-expect-value').fill('self');
      await group.getByTestId('procedure-step-check-expect-group-negate').check();
      await expect(editing.nth(3).getByTestId('procedure-step-check-sentence')).toContainText(
        'daysLeft 大于 7',
      );
      await editing.nth(3).scrollIntoViewIfNeeded();
      await editing.nth(3).screenshot({
        path: testInfo.outputPath(`procedure-template-check-${width}.png`),
      });
    });

    test(`a draft's bindings the page can tell are wrong at ${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await answerProcedureReads(page, DRAFT_ROW);
      await loginAsOwner(page);

      await page.goto(`/#/govern/catalog/procedures/${PROCEDURE}`);
      await expect(page.getByTestId('procedure-detail')).toBeVisible({ timeout: 15_000 });
      const issues = page.getByTestId('procedure-template-binding-issue');
      await expect(issues).toHaveCount(2);
      // From the step itself is said as that, not as "add it to dependsOn" (legacy 455).
      await expect(issues.nth(0)).toContainText('这一步取自它自己');
      await expect(issues.nth(0)).not.toContainText('dependsOn');
      await expect(issues.nth(1)).toContainText('这个流程没有叫 scan 的 Worker 步骤');
      await page.screenshot({
        path: testInfo.outputPath(`procedure-template-issues-${width}.png`),
        fullPage: true,
      });
    });
  }
});
