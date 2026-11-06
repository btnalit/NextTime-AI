// Unit tests for scripts/guards/ratchet-shrinks.mjs; CI (`quality`) runs the guard itself against
// the pull request's base branch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locatorRaises, matrixRaises } from './ratchet-shrinks.mjs';

test('matrix: a ratchet that stays or goes down passes; one that goes up is reported', () => {
  const base = { ratchet: { console_unexplained: 10, kernel_test_missing: 6 } };
  assert.deepEqual(
    matrixRaises(base, { ratchet: { console_unexplained: 9, kernel_test_missing: 6 } }),
    [],
  );
  assert.deepEqual(
    matrixRaises(base, { ratchet: { console_unexplained: 10, kernel_test_missing: 7 } }),
    [{ key: 'kernel_test_missing', base: 6, head: 7 }],
  );
  assert.deepEqual(matrixRaises(base, { ratchet: { new_key: 1 } }), [
    { key: 'new_key', base: 0, head: 1 },
  ]);
});

test('locators: fewer violations pass; a new call text or a higher count is reported', () => {
  const base = { 'a.spec.ts': { 'row.click()': 2, 'x.fill(v)': 1 } };
  assert.deepEqual(locatorRaises(base, { 'a.spec.ts': { 'row.click()': 1 } }), []);
  assert.deepEqual(locatorRaises(base, { 'a.spec.ts': { 'row.click()': 3, 'x.fill(v)': 1 } }), [
    { key: 'row.click()', base: 2, head: 3 },
    { key: '(total)', base: 3, head: 4 },
  ]);
  assert.deepEqual(
    locatorRaises(base, { 'a.spec.ts': { 'row.click()': 2 }, 'b.spec.ts': { 'y.check()': 1 } }),
    [{ key: 'y.check()', base: 0, head: 1 }],
  );
});

test('locators: moving a spec file to a new name is not a raise', () => {
  const base = { 'old.spec.ts': { 'row.click()': 2 } };
  assert.deepEqual(locatorRaises(base, { 'journeys/new.spec.ts': { 'row.click()': 2 } }), []);
});
