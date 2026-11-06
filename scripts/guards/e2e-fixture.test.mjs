// Unit tests for scripts/guards/e2e-fixture.mjs (rules E1, E2).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_FILE, findViolations } from './e2e-fixture.mjs';

const SPEC = 'packages/web/e2e/journeys/x.spec.ts';
const lines = (text) => findViolations(SPEC, text).map((v) => v.line);

test("importing Playwright's test, under any name or shape, is reported", () => {
  assert.deepEqual(lines("import { expect, test } from '@playwright/test';"), [1]);
  assert.deepEqual(lines("import { test as base } from '@playwright/test';"), [1]);
  assert.deepEqual(lines("import * as pw from '@playwright/test';"), [1]);
  assert.deepEqual(lines("import pw from '@playwright/test';"), [1]);
  assert.deepEqual(lines("const pw = require('@playwright/test');"), [1]);
  assert.deepEqual(lines("const pw = await import('@playwright/test');"), [1]);
});

test('types and expect may come from Playwright; the fixture may import its test', () => {
  assert.deepEqual(lines("import type { Page } from '@playwright/test';"), []);
  assert.deepEqual(lines("import { type Page, expect } from '@playwright/test';"), []);
  assert.deepEqual(lines("import type { test } from '@playwright/test';"), []);
  assert.deepEqual(lines("import { type Page, expect, test } from '../lib/test.js';"), []);
  assert.deepEqual(
    findViolations(FIXTURE_FILE, "import { test as base } from '@playwright/test';"),
    [],
  );
});

test('E2: code run in the page may not call /api/cap; Node-side requests and routes may', () => {
  const rules = (text) => findViolations(SPEC, text).map((v) => `${v.line}:${v.rule}`);
  assert.deepEqual(
    rules("await page.evaluate(() => fetch('/api/cap/approve', { method: 'POST' }));"),
    ['1:E2'],
  );
  assert.deepEqual(
    rules(
      'await page.evaluate((n) => fetch(`/api/cap/${n}`), name);\nawait page.addInitScript(() => { void fetch("/api/cap/x"); });',
    ),
    ['1:E2', '2:E2'],
  );
  assert.deepEqual(rules("await page.request.post('/api/cap/approve', { data: {} });"), []);
  assert.deepEqual(rules("await page.route('**/api/cap/get_goal', (r) => r.continue());"), []);
  assert.deepEqual(rules('await page.evaluate(() => document.title);'), []);
});
