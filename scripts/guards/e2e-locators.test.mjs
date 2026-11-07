// Unit tests for scripts/guards/e2e-locators.mjs; the guard itself runs over packages/web/e2e in
// CI (`quality`) and `pnpm ci:guards`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareWithBaseline, findViolations, toBaseline } from './e2e-locators.mjs';

const rules = (src) => findViolations('x.spec.ts', src).map((v) => `${v.rule} ${v.text}`);

test('acting on a role or a label passes, scoped by a test id or not', () => {
  assert.deepEqual(
    rules(`
      await page.getByRole('button', { name: '授权' }).click();
      await drawer.getByTestId('grant-form').getByRole('combobox', { name: '成员' }).fill('al');
      await page.getByLabel('成员').selectOption('u1');
      await page.getByText('全部').first().click();
      await page.getByPlaceholder('搜索').fill('x');
    `),
    [],
  );
});

test('L1: the 646 shape — a test id picked straight into selectOption — is reported', () => {
  assert.deepEqual(
    rules(`
      const memberSelect = grantForm.getByTestId('ggf-member-select');
      await memberSelect.selectOption(memberId);
    `),
    ['L1 memberSelect.selectOption(memberId)'],
  );
});

test('L1: CSS locators and test ids are reported through narrowing and variables', () => {
  assert.deepEqual(
    rules(`
      await page.locator('#login-name').fill(login);
      const rows = table.getByTestId('row');
      const first = rows.filter({ hasText: 'a' }).first();
      await first.click();
      await option.locator('input[type="checkbox"]').check();
    `),
    [
      "L1 page.locator('#login-name').fill(login)",
      'L1 first.click()',
      `L1 option.locator('input[type="checkbox"]').check()`,
    ],
  );
});

test('assertions on test ids are fine; only actions count', () => {
  assert.deepEqual(rules("await expect(page.getByTestId('summary')).toBeVisible();"), []);
});

test('L2: page-level selector actions are reported, page.press(sel, key) too; keyboard presses are not', () => {
  assert.deepEqual(
    rules(`
      await page.selectOption('#audit-resource-type', 'workspace');
      await page.click('text=OK');
      await page.press('#q', 'Enter');
      await page.keyboard.press('Escape');
    `),
    [
      "L2 page.selectOption('#audit-resource-type', 'workspace')",
      "L2 page.click('text=OK')",
      "L2 page.press('#q', 'Enter')",
    ],
  );
});

test('hover, tap, dragTo and dispatchEvent are interactions too', () => {
  assert.deepEqual(
    rules(`
      await page.getByTestId('a').hover();
      await page.locator('.b').dragTo(page.getByRole('row', { name: 'x' }));
      await page.getByRole('button', { name: '保存' }).dispatchEvent('click');
    `),
    [
      "L1 page.getByTestId('a').hover()",
      "L1 page.locator('.b').dragTo(page.getByRole('row', { name: 'x' }))",
    ],
  );
});

test("the same name declared in two tests resolves to each test's own declaration", () => {
  assert.deepEqual(
    rules(`
      test('a', async () => {
        const row = page.getByTestId('row-a');
        await row.click();
      });
      test('b', async () => {
        const row = page.getByRole('row', { name: 'b' });
        await row.click();
      });
      const lines = page.getByTestId('lines');
      test('c', async () => {
        await lines.nth(2).click();
      });
    `),
    ['L1 row.click()', 'L1 lines.nth(2).click()'],
  );
});

test('a target that cannot be traced (a parameter, a shadowing parameter, a name declared twice in one scope) is left alone', () => {
  assert.deepEqual(
    rules(`
      async function pick(select) { await select.selectOption('a'); }
      const row = page.getByTestId('row');
      async function open(row) { await row.click(); }
      let x = page.getByTestId('a'); let x = page.getByRole('button');
      await x.click();
    `),
    [],
  );
});

test('L3 (655): clicking, submitting or setting a control from page-side JavaScript is reported', () => {
  assert.deepEqual(
    rules(`
      const row = page.getByRole('row');
      await row.evaluate((el) => (el as HTMLElement).click());
      await page.locator('form').evaluateAll((els) => els.forEach((f) => f.requestSubmit()));
      await page.evaluate(() => document.querySelector('#go')?.dispatchEvent(new MouseEvent('click')));
      await page.$eval('#agree', (el) => { el.checked = true; });
      await page.evaluate("document.querySelector('#go').click()");
      await page.getByLabel('名称').evaluate((el, v) => { el.value = v; }, 'x');
    `),
    [
      'L3 row.evaluate((el) => (el as HTMLElement).click())',
      'L3 page.locator(\'form\').evaluateAll((els) => els.forEach((f) => f.requestSubmit()))',
      "L3 page.evaluate(() => document.querySelector('#go')?.dispatchEvent(new MouseEvent('click')))",
      "L3 page.$eval('#agree', (el) => { el.checked = true; })",
      'L3 page.evaluate("document.querySelector(\'#go\').click()")',
      "L3 page.getByLabel('名称').evaluate((el, v) => { el.value = v; }, 'x')",
    ],
  );
});

test('L3: reading the page from evaluate is fine', () => {
  assert.deepEqual(
    rules(`
      const text = await page.getByRole('row').evaluate((el) => el.textContent);
      const ok = await page.evaluate(() => (document.querySelector('input') as HTMLInputElement).value === 'x');
      const n = await page.$$eval('li', (els) => els.length);
      await page.evaluate(() => window.scrollTo(0, 0));
    `),
    [],
  );
});

test('baseline: new violations fail, listed ones pass, gone ones are stale', () => {
  const found = {
    'a.ts': [
      { rule: 'L1', text: 'b.click()', line: 1 },
      { rule: 'L1', text: 'b.click()', line: 2 },
      { rule: 'L1', text: 'c.fill(x)', line: 3 },
    ],
  };
  const baseline = { 'a.ts': { 'b.click()': 1, 'gone.click()': 1 } };
  const { fresh, stale } = compareWithBaseline(found, baseline);
  assert.deepEqual(
    fresh.map((v) => `${v.text}@${v.line}`),
    ['b.click()@2', 'c.fill(x)@3'],
  );
  assert.deepEqual(
    stale.map((s) => s.text),
    ['gone.click()'],
  );
  const exact = compareWithBaseline(found, toBaseline(found));
  assert.deepEqual([exact.fresh, exact.stale], [[], []]);
});
