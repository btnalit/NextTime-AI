import { getCapability } from '@nexttime/shared';
import { type Page, expect, test } from '@playwright/test';
import { OWNER_API_KEY, loginAsOwner } from './lib/auth.js';

/**
 * e2e/gate-absence.spec.ts (S11 「门确认不存在」 A): an observe Operation that declares which of the
 * target's answers mean "the thing looked up does not exist" says so in the catalog's detail, at
 * the widths UX checks (1440, 390) — an http Operation's statuses, a cli Operation's exit
 * statuses on a draft, and nothing for one that declares none. No gate on the CI stack declares
 * one, so `list_operations` and the gate it names are stand-ins answered in the browser
 * (`page.route`, as procedure-template.spec.ts does), each checked against the capability's own
 * result contract; everything else is the real stack. Full-page captures land in `test-results/`
 * for the UX acceptance to read; they are not a screenshot gate.
 */

const GATE = '68000000-0000-4000-8000-0000000000d1';
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
      id === GATE ? [{ id, kind: 'gatekeeper', name: 'records-gate' }] : [],
    );
    await route.fulfill(answer('resolve_refs', { items }));
  });
}

test.describe('S11 「门确认不存在」 A: the catalog says which answers mean “not there” (stand-in reads)', () => {
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
      await page.screenshot({
        path: testInfo.outputPath(`gate-absence-${width}.png`),
        fullPage: true,
      });

      await page.goto(`/#/govern/catalog/operations/${encodeURIComponent(`${GATE}::unit.show`)}`);
      await expect(
        page.getByTestId('operation-detail').getByTestId('catalog-detail-absent-answers'),
      ).toContainText('命令以退出码 4 结束时，表示要查的东西不存在', { timeout: 15_000 });
      await page.screenshot({
        path: testInfo.outputPath(`gate-absence-draft-${width}.png`),
        fullPage: true,
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
