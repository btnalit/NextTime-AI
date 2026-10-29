import { getCapability } from '@nexttime/shared';
import { type Page, expect, test } from '@playwright/test';
import { OWNER_API_KEY, loginAsOwner } from './lib/auth.js';

/**
 * e2e/gate-absence.spec.ts (S11 「门确认不存在」 A, B-a): an observe Operation that declares which of
 * the target's answers mean "the thing looked up does not exist" says so in the catalog's detail, at
 * the widths UX checks (1440, 390) — an http Operation's statuses, a cli Operation's exit
 * statuses on a draft, and nothing for one that declares none. B-a: the draft asks its publisher to
 * confirm the gate's credentials can see what it looks up (Publish waits for the tick, the call
 * carries `absentAnswersReviewed`), and a published version says who confirmed it, or that nobody
 * did. No gate on the CI stack declares
 * one, so `list_operations` and the gate it names are stand-ins answered in the browser
 * (`page.route`, as procedure-template.spec.ts does), each checked against the capability's own
 * result contract; everything else is the real stack. Full-page captures land in `test-results/`
 * for the UX acceptance to read; they are not a screenshot gate.
 */

const GATE = '68000000-0000-4000-8000-0000000000d1';
const REVIEWER = '68000000-0000-4000-8000-0000000000e1';
const T0 = new Date(Date.now() - 3_600_000).toISOString();

const OPERATIONS = [
  {
    gatekeeperId: GATE,
    name: 'record.get',
    description: '按编号读取一条记录',
    mode: 'observe',
    blastRadius: 'low',
    autoApprovable: true,
    version: 1,
    status: 'published',
    absentAnswers: { statuses: [404, 410] },
    absentAnswersReview: { reviewedBy: REVIEWER, reviewedAt: T0 },
  },
  {
    gatekeeperId: GATE,
    name: 'record.head',
    description: '确认一条记录是否还在',
    mode: 'observe',
    blastRadius: 'low',
    autoApprovable: true,
    version: 1,
    status: 'published',
    absentAnswers: { statuses: [404] },
  },
  {
    gatekeeperId: GATE,
    name: 'unit.show',
    description: '查看一个服务单元',
    mode: 'observe',
    blastRadius: 'low',
    autoApprovable: true,
    version: 1,
    status: 'draft',
    origin: 'human',
    draftDigest: 'sha256:unit-show-draft',
    absentAnswers: { exitCodes: [4] },
  },
  {
    gatekeeperId: GATE,
    name: 'record.list',
    description: '列出全部记录',
    mode: 'observe',
    blastRadius: 'low',
    autoApprovable: true,
    version: 1,
    status: 'published',
  },
];

/** What `publish_operation` answers for `unit.show` once confirmed (the stand-in's result). */
const PUBLISHED_UNIT_SHOW = {
  gatekeeperId: GATE,
  name: 'unit.show',
  version: 1,
  status: 'published',
  origin: 'human',
  proposedBy: null,
  operation: {
    name: 'unit.show',
    binding: { kind: 'cli', command_template: 'unit-show {unit}', absent_exit_codes: [4] },
    params_schema: { type: 'object', properties: { unit: { type: 'string' } } },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  },
  supersedes: null,
  absentAnswersReview: { reviewedBy: REVIEWER, reviewedAt: T0 },
};

/** A stand-in's answer, checked first against the capability's own result contract. */
function answer(name: string, result: unknown) {
  const contract = getCapability(name)?.resultSchema;
  if (!contract) throw new Error(`no result contract for ${name}`);
  return { json: { ok: true, result: contract.parse(result) } };
}

async function answerCatalogReads(page: Page): Promise<void> {
  await page.route('**/api/cap/list_operations', (route) =>
    route.fulfill(answer('list_operations', { items: OPERATIONS })),
  );
  await page.route('**/api/cap/get_operation_stats', (route) =>
    route.fulfill(answer('get_operation_stats', { items: [] })),
  );
  await page.route('**/api/cap/list_gatekeepers', (route) =>
    route.fulfill(
      answer('list_gatekeepers', {
        items: [
          {
            id: GATE,
            name: 'records-gate',
            kind: 'http',
            status: 'active',
            operationCount: OPERATIONS.length,
            createdAt: T0,
          },
        ],
      }),
    ),
  );
  await page.route('**/api/cap/resolve_refs', async (route) => {
    const body = route.request().postDataJSON() as { ids?: string[] } | null;
    const items = (body?.ids ?? []).flatMap((id) =>
      id === GATE
        ? [{ id, kind: 'gatekeeper', name: 'records-gate' }]
        : id === REVIEWER
          ? [{ id, kind: 'principal', name: '运维负责人', typeName: 'human' }]
          : [],
    );
    await route.fulfill(answer('resolve_refs', { items }));
  });
}

test.describe('S11 「门确认不存在」 A, B-a: the catalog says which answers mean “not there” and who confirmed them (stand-in reads)', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  for (const width of [1440, 390] as const) {
    test(`an Operation's detail at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await answerCatalogReads(page);
      await loginAsOwner(page);

      await page.goto(`/#/govern/catalog/operations/${encodeURIComponent(`${GATE}::record.get`)}`);
      const detail = page.getByTestId('operation-detail');
      await expect(detail).toBeVisible({ timeout: 15_000 });
      await expect(detail.getByTestId('catalog-detail-absent-answers')).toHaveText(
        '目标回答 404 或 410 时，表示要查的东西不存在：这次观察记为“不存在”，不算调用失败。',
      );
      const reviewed = detail.getByTestId('catalog-detail-absent-reviewed');
      await expect(reviewed).toContainText('运维负责人');
      await expect(reviewed).toContainText('确认于');
      await page.screenshot({
        path: testInfo.outputPath(`gate-absence-${width}.png`),
        fullPage: true,
      });

      await page.goto(`/#/govern/catalog/operations/${encodeURIComponent(`${GATE}::record.head`)}`);
      const older = page.getByTestId('operation-detail');
      await expect(older).toHaveAttribute('data-operation-key', `${GATE}::record.head`, {
        timeout: 15_000,
      });
      await expect(older.getByTestId('catalog-detail-absent-unreviewed')).toContainText(
        '发布于需要确认之前',
      );

      const published: unknown[] = [];
      await page.route('**/api/cap/publish_operation', async (route) => {
        published.push(route.request().postDataJSON());
        await route.fulfill(answer('publish_operation', PUBLISHED_UNIT_SHOW));
      });
      await page.goto(`/#/govern/catalog/operations/${encodeURIComponent(`${GATE}::unit.show`)}`);
      const draft = page.getByTestId('operation-detail');
      await expect(draft.getByTestId('catalog-detail-absent-answers')).toContainText(
        '命令以退出码 4 结束时，表示要查的东西不存在',
        { timeout: 15_000 },
      );
      const review = draft.getByTestId('operation-absent-review');
      await expect(review).toContainText(
        '发布前确认：命令以退出码 4 结束时，记为“要查的东西不存在”。',
      );
      const publish = draft.getByRole('button', { name: '发布', exact: true });
      await expect(publish).toBeDisabled();
      await page.screenshot({
        path: testInfo.outputPath(`gate-absence-draft-${width}.png`),
        fullPage: true,
      });
      await draft.getByTestId('operation-absent-review-confirm').check();
      await expect(publish).toBeEnabled();
      await publish.click();
      await expect.poll(() => published.length).toBe(1);
      expect(published[0]).toEqual({
        gatekeeperId: GATE,
        name: 'unit.show',
        absentAnswersReviewed: true,
        draftDigest: 'sha256:unit-show-draft',
      });

      await page.goto(`/#/govern/catalog/operations/${encodeURIComponent(`${GATE}::record.list`)}`);
      const plain = page.getByTestId('operation-detail');
      await expect(plain).toHaveAttribute('data-operation-key', `${GATE}::record.list`, {
        timeout: 15_000,
      });
      await expect(plain.getByTestId('catalog-detail-absent-answers')).toHaveCount(0);
    });
  }
});
