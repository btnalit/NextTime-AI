// Unit tests for scripts/guards/capability-matrix.mjs; the guard itself runs against the real
// registry and console in CI (`quality`) and `pnpm ci:guards`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  bootstrapMatrix,
  checkMatrix,
  parseToolArray,
  scanConsoleCalls,
  scanQuoted,
} from './capability-matrix.mjs';

test('scanConsoleCalls: direct calls count, labels, permission probes and comments do not', () => {
  const src = `
    await http.call('list_tasks', {});
    const r = await http.call<{ valid: boolean; errors?: readonly string[] }>('validate', {});
    const x = useCapabilityList<ObjectWire>(http, 'search', params);
    const y = useCapability(http, 'explain', { nodeId });
    const canIt = can('deprecate_skill');
    // the old http.call path is gone; see 'traverse'
    const labels = { approve: 'x', 'reject': 'y' };
  `;
  const found = scanConsoleCalls(src, [
    'list_tasks',
    'validate',
    'search',
    'explain',
    'deprecate_skill',
    'traverse',
    'reject',
  ]);
  assert.deepEqual([...found].sort(), ['explain', 'list_tasks', 'search', 'validate']);
});

test('scanConsoleCalls: a name is not matched inside a longer name', () => {
  assert.equal(scanConsoleCalls("http.call('list_tasks_extra')", ['list_tasks']).size, 0);
});

test('parseToolArray reads the list and ignores comments', () => {
  const src = `export const ADMIN_TOOL_CAPABILITY_NAMES = [
    // graph: 'not_a_tool' [see below]
    'get_object',
    /* 'also_not' */ 'search', // trailing 'nope'
    'step2_read',
  ] as const;`;
  assert.deepEqual([...parseToolArray(src, 'ADMIN_TOOL_CAPABILITY_NAMES')].sort(), [
    'get_object',
    'search',
    'step2_read',
  ]);
});

test('parseToolArray fails loudly on an entry it cannot read instead of dropping it', () => {
  const spread = "export const ENTRY_TOOL_CAPABILITY_NAMES = ['get_object', ...MORE] as const;";
  assert.throws(
    () => parseToolArray(spread, 'ENTRY_TOOL_CAPABILITY_NAMES'),
    /cannot read: \.\.\.MORE/,
  );
  assert.throws(() => parseToolArray('const X = [];', 'ENTRY_TOOL_CAPABILITY_NAMES'), /not found/);
});

function facts(overrides = {}) {
  return {
    names: ['a_cap', 'b_cap', 'c_cap'],
    consoleCalls: new Set(['a_cap']),
    entry: new Set(['b_cap']),
    admin: new Set(['b_cap']),
    kernelTested: new Set(['a_cap', 'b_cap', 'c_cap']),
    fileHasName: (file, name) => file === 'web/x.tsx' && name === 'c_cap',
    ...overrides,
  };
}

function matrix(rows, ratchet = { console_unexplained: 0, kernel_test_missing: 0 }) {
  return { ratchet, capabilities: rows };
}

const GOOD = {
  a_cap: { console: 'required', agents: [] },
  b_cap: { console: 'none: agent 回调', agents: ['entry', 'admin'] },
  c_cap: { console: 'indirect: web/x.tsx', agents: [] },
};

test('a matrix that matches the code passes', () => {
  assert.deepEqual(checkMatrix(matrix(GOOD), facts()), []);
});

test('M1: a new capability without a row fails; a stale row fails', () => {
  const { c_cap: _c, ...rest } = GOOD;
  const out = checkMatrix(matrix({ ...rest, z_cap: { console: 'required', agents: [] } }), facts());
  assert.ok(out.some((v) => v.startsWith('M1 c_cap')));
  assert.ok(out.some((v) => v.startsWith('M1 z_cap')));
});

test('M2: required without a call, and none with a call, both fail', () => {
  const out = checkMatrix(
    matrix({ ...GOOD, a_cap: { console: 'none: later', agents: [] } }),
    facts(),
  );
  assert.ok(out.some((v) => v.startsWith('M2 a_cap') && v.includes('calls it')));
  const out2 = checkMatrix(
    matrix({ ...GOOD, c_cap: { console: 'required', agents: [] } }),
    facts(),
  );
  assert.ok(out2.some((v) => v.startsWith('M2 c_cap') && v.includes('never calls')));
});

test('M2: none needs a reason; indirect needs a file that names it', () => {
  const out = checkMatrix(
    matrix({
      ...GOOD,
      b_cap: { console: 'none:', agents: ['entry', 'admin'] },
      c_cap: { console: 'indirect: web/y.tsx', agents: [] },
    }),
    facts(),
  );
  assert.ok(out.some((v) => v.startsWith('M2 b_cap') && v.includes('reason')));
  assert.ok(out.some((v) => v.startsWith('M2 c_cap') && v.includes('does not name')));
});

test('M3: the agents list must equal the tools the code registers (the capability-pack case)', () => {
  // the admin agent registers b_cap, the row forgets it
  const out = checkMatrix(
    matrix({ ...GOOD, b_cap: { console: 'none: x', agents: ['entry'] } }),
    facts(),
  );
  assert.ok(out.some((v) => v.startsWith('M3 b_cap') && v.includes('admin agent registers')));
  // the row claims the admin agent has a tool it does not register
  const out2 = checkMatrix(
    matrix({ ...GOOD, a_cap: { console: 'required', agents: ['admin'] } }),
    facts(),
  );
  assert.ok(out2.some((v) => v.startsWith('M3 a_cap') && v.includes('does not register')));
  const out3 = checkMatrix(
    matrix({ ...GOOD, a_cap: { console: 'required', agents: ['worker'] } }),
    facts(),
  );
  assert.ok(out3.some((v) => v.includes("unknown agent surface 'worker'")));
});

test('M5: an untested capability fails unless waived; a stale waiver fails', () => {
  const untested = facts({ kernelTested: new Set(['a_cap', 'b_cap']) });
  assert.ok(checkMatrix(matrix(GOOD), untested).some((v) => v.startsWith('M5 c_cap')));
  const waived = { ...GOOD, c_cap: { ...GOOD.c_cap, kernel_test: 'missing' } };
  assert.deepEqual(
    checkMatrix(matrix(waived, { console_unexplained: 0, kernel_test_missing: 1 }), untested),
    [],
  );
  assert.ok(
    checkMatrix(matrix(waived, { console_unexplained: 0, kernel_test_missing: 1 }), facts()).some(
      (v) => v.startsWith('M5 c_cap'),
    ),
  );
});

test('R: the ratchet must equal the counts, in both directions', () => {
  const rows = { ...GOOD, b_cap: { console: 'none: 待说明（x）', agents: ['entry', 'admin'] } };
  assert.deepEqual(
    checkMatrix(matrix(rows, { console_unexplained: 1, kernel_test_missing: 0 }), facts()),
    [],
  );
  const up = checkMatrix(matrix(rows), facts());
  assert.ok(up.some((v) => v.startsWith('R ratchet.console_unexplained') && v.includes('raises')));
  const down = checkMatrix(
    matrix(GOOD, { console_unexplained: 2, kernel_test_missing: 0 }),
    facts(),
  );
  assert.ok(down.some((v) => v.startsWith('R ratchet.console_unexplained') && v.includes('lower')));
});

test('bootstrap output passes its own check and keeps earlier reasons', () => {
  const f = facts({ kernelTested: new Set(['a_cap', 'b_cap']) });
  const text = bootstrapMatrix(f, { capabilities: { b_cap: { console: 'none: agent 回调' } } });
  const parsed = parse(text);
  assert.equal(parsed.capabilities.b_cap.console, 'none: agent 回调');
  assert.equal(parsed.capabilities.c_cap.kernel_test, 'missing');
  // c_cap has no call and no earlier reason: it is left undecided, and the ratchet counts it
  assert.match(parsed.capabilities.c_cap.console, /^none: 待说明/);
  assert.deepEqual(checkMatrix(parsed, f), []);
});

test('scanQuoted finds quoted names only', () => {
  assert.deepEqual([...scanQuoted("call('a_cap'); b_cap", ['a_cap', 'b_cap'])], ['a_cap']);
});
