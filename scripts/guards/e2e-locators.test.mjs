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

test('L2: page-level selector actions are reported; keyboard presses are not', () => {
  assert.deepEqual(
    rules(`
      await page.selectOption('#audit-resource-type', 'workspace');
      await page.click('text=OK');
      await page.keyboard.press('Escape');
    `),
    ["L2 page.selectOption('#audit-resource-type', 'workspace')", "L2 page.click('text=OK')"],
  );
});

test('a target that cannot be traced (a parameter, an ambiguous name) is left alone', () => {
  assert.deepEqual(
    rules(`
      async function pick(select) { await select.selectOption('a'); }
      let x = page.getByTestId('a'); let x = page.getByRole('button');
      await x.click();
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
