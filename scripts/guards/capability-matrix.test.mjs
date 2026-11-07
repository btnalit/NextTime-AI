// Unit tests for scripts/guards/capability-matrix.mjs; the guard itself runs against the real
// registry and console in CI (`quality`) and `pnpm ci:guards`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  bootstrapMatrix,
  checkMatrix,
  checkObserved,
  parseToolArray,
  readObserved,
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

function matrix(
  rows,
  ratchet = { console_unexplained: 0, kernel_test_missing: 0, e2e_waived: 0, repeat_unclear: 0 },
) {
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
    checkMatrix(
      matrix(waived, {
        console_unexplained: 0,
        kernel_test_missing: 1,
        e2e_waived: 0,
        repeat_unclear: 0,
      }),
      untested,
    ),
    [],
  );
  assert.ok(
    checkMatrix(
      matrix(waived, {
        console_unexplained: 0,
        kernel_test_missing: 1,
        e2e_waived: 0,
        repeat_unclear: 0,
      }),
      facts(),
    ).some((v) => v.startsWith('M5 c_cap')),
  );
});

test('R: the ratchet must equal the counts, in both directions', () => {
  const rows = { ...GOOD, b_cap: { console: 'none: 待说明（x）', agents: ['entry', 'admin'] } };
  assert.deepEqual(
    checkMatrix(
      matrix(rows, {
        console_unexplained: 1,
        kernel_test_missing: 0,
        e2e_waived: 0,
        repeat_unclear: 0,
      }),
      facts(),
    ),
    [],
  );
  const up = checkMatrix(matrix(rows), facts());
  assert.ok(up.some((v) => v.startsWith('R ratchet.console_unexplained') && v.includes('raises')));
  const down = checkMatrix(
    matrix(GOOD, {
      console_unexplained: 2,
      kernel_test_missing: 0,
      e2e_waived: 0,
      repeat_unclear: 0,
    }),
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

// M4: a_cap is a write the console calls, c_cap a write it calls indirectly, b_cap an observe.
const MODES = new Map([
  ['a_cap', 'write'],
  ['b_cap', 'observe'],
  ['c_cap', 'execute'],
]);
const E2E = {
  a_cap: { ...GOOD.a_cap, e2e: 'observed' },
  b_cap: GOOD.b_cap,
  c_cap: { ...GOOD.c_cap, e2e: 'waived: 656' },
};
const E2E_RATCHET = {
  console_unexplained: 0,
  kernel_test_missing: 0,
  e2e_waived: 1,
  repeat_unclear: 0,
};

test('M4: a write with a console entry says observed or waived; nothing else carries e2e', () => {
  const f = facts({ modes: MODES });
  assert.deepEqual(checkMatrix(matrix(E2E, E2E_RATCHET), f), []);
  const missing = { ...E2E, a_cap: GOOD.a_cap };
  assert.ok(checkMatrix(matrix(missing, E2E_RATCHET), f).some((v) => v.startsWith('M4 a_cap')));
  const noNumber = { ...E2E, c_cap: { ...GOOD.c_cap, e2e: 'waived: later' } };
  assert.ok(checkMatrix(matrix(noNumber, E2E_RATCHET), f).some((v) => v.startsWith('M4 c_cap')));
  const onObserve = { ...E2E, b_cap: { ...GOOD.b_cap, e2e: 'observed' } };
  assert.ok(checkMatrix(matrix(onObserve, E2E_RATCHET), f).some((v) => v.startsWith('M4 b_cap')));
  // the waiver is counted: one more without raising the ratchet fails R
  const twoWaived = { ...E2E, a_cap: { ...GOOD.a_cap, e2e: 'waived: 656' } };
  assert.ok(
    checkMatrix(matrix(twoWaived, E2E_RATCHET), f).some((v) =>
      v.startsWith('R ratchet.e2e_waived'),
    ),
  );
});

test('M4 at run time: observed must have been called ok; a waived row that was is reported', () => {
  const m = matrix(E2E, E2E_RATCHET);
  assert.deepEqual(checkObserved(m, new Set(['a_cap'])), []);
  assert.ok(checkObserved(m, new Set()).some((v) => v.startsWith('M4 a_cap: e2e: observed')));
  assert.ok(checkObserved(m, new Set(['a_cap', 'c_cap'])).some((v) => v.startsWith('M4 c_cap')));
});

test('readObserved keeps the calls the kernel answered ok, from every cap-calls.jsonl below the dir', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cap-calls-'));
  mkdirSync(path.join(dir, 'a-test'));
  mkdirSync(path.join(dir, 'b-test-retry1'));
  writeFileSync(
    path.join(dir, 'a-test', 'cap-calls.jsonl'),
    `${JSON.stringify({ name: 'a_cap', via: 'http', ok: true, status: 200 })}\n`,
  );
  writeFileSync(
    path.join(dir, 'b-test-retry1', 'cap-calls.jsonl'),
    `${JSON.stringify({ name: 'c_cap', via: 'ws', ok: false, status: null })}\n\n${JSON.stringify({ name: 'd_cap', via: 'stub', ok: true, status: 200 })}\n`,
  );
  writeFileSync(path.join(dir, 'a-test', 'other.jsonl'), 'not json');
  const { names, files } = readObserved(dir);
  assert.equal(files, 2);
  assert.deepEqual([...names], ['a_cap']);
});

test('bootstrap with an e2e run: observed where called, waived under the given no. elsewhere', () => {
  const f = facts({ modes: MODES });
  const text = bootstrapMatrix(f, matrix(GOOD), { observed: new Set(['a_cap']), waiver: '656' });
  const parsed = parse(text);
  assert.equal(parsed.capabilities.a_cap.e2e, 'observed');
  assert.equal(parsed.capabilities.c_cap.e2e, 'waived: 656');
  assert.equal(parsed.capabilities.b_cap.e2e, undefined);
  assert.equal(parsed.ratchet.e2e_waived, 1);
  assert.deepEqual(checkMatrix(parsed, f), []);
  // without a run, the e2e it had stays; without one and no waiver no., it refuses
  assert.equal(parse(bootstrapMatrix(f, parsed)).capabilities.a_cap.e2e, 'observed');
  assert.throws(() => bootstrapMatrix(f, matrix(GOOD)), /--waive/);
});

// M6: a_cap and c_cap have side effects, b_cap does not.
const SIDE_EFFECTS = new Set(['a_cap', 'c_cap']);
const REPEAT = {
  a_cap: { ...GOOD.a_cap, repeat: 'idempotent' },
  b_cap: GOOD.b_cap,
  c_cap: { ...GOOD.c_cap, repeat: 'unclear: 664' },
};
const REPEAT_RATCHET = {
  console_unexplained: 0,
  kernel_test_missing: 0,
  e2e_waived: 0,
  repeat_unclear: 1,
};

test('M6: a capability with side effects declares repeat; observe rows carry none', () => {
  const f = facts({ sideEffects: SIDE_EFFECTS });
  assert.deepEqual(checkMatrix(matrix(REPEAT, REPEAT_RATCHET), f), []);
  for (const repeat of ['creates', 'repeats', 'conflict: illegal_transition']) {
    const rows = { ...REPEAT, a_cap: { ...GOOD.a_cap, repeat } };
    assert.deepEqual(checkMatrix(matrix(rows, REPEAT_RATCHET), f), [], repeat);
  }
  // missing on a side-effecting row: a hard failure, not a silent debt
  const missing = { ...REPEAT, a_cap: GOOD.a_cap };
  assert.ok(checkMatrix(matrix(missing, REPEAT_RATCHET), f).some((v) => v.startsWith('M6 a_cap')));
  // on an observe row
  const onObserve = { ...REPEAT, b_cap: { ...GOOD.b_cap, repeat: 'idempotent' } };
  assert.ok(
    checkMatrix(matrix(onObserve, REPEAT_RATCHET), f).some((v) => v.startsWith('M6 b_cap')),
  );
  // malformed: an unknown word, unclear without a number, conflict without a code
  for (const repeat of [
    'sometimes',
    'unclear: later',
    'unclear',
    'conflict',
    'conflict: Bad Code',
  ]) {
    const rows = { ...REPEAT, a_cap: { ...GOOD.a_cap, repeat } };
    assert.ok(
      checkMatrix(matrix(rows, REPEAT_RATCHET), f).some((v) => v.startsWith('M6 a_cap')),
      repeat,
    );
  }
});

test('M6 + R: unclear rows are counted by ratchet.repeat_unclear, in both directions', () => {
  const f = facts({ sideEffects: SIDE_EFFECTS });
  const two = { ...REPEAT, a_cap: { ...GOOD.a_cap, repeat: 'unclear: 664' } };
  assert.ok(
    checkMatrix(matrix(two, REPEAT_RATCHET), f).some(
      (v) => v.startsWith('R ratchet.repeat_unclear') && v.includes('raises'),
    ),
  );
  const none = { ...REPEAT, c_cap: { ...GOOD.c_cap, repeat: 'creates' } };
  assert.ok(
    checkMatrix(matrix(none, REPEAT_RATCHET), f).some(
      (v) => v.startsWith('R ratchet.repeat_unclear') && v.includes('lower'),
    ),
  );
});

test('bootstrap keeps declared repeats and marks the rest unclear under the given no.', () => {
  const f = facts({ sideEffects: SIDE_EFFECTS });
  const text = bootstrapMatrix(f, matrix(REPEAT, REPEAT_RATCHET), { repeatUnclear: '664' });
  const parsed = parse(text);
  assert.equal(parsed.capabilities.a_cap.repeat, 'idempotent');
  assert.equal(parsed.capabilities.c_cap.repeat, 'unclear: 664');
  assert.equal(parsed.capabilities.b_cap.repeat, undefined);
  assert.equal(parsed.ratchet.repeat_unclear, 1);
  assert.deepEqual(checkMatrix(parsed, f), []);
  // a side-effecting row with nothing to keep and no legacy no. given: refuse
  assert.throws(() => bootstrapMatrix(f, matrix(GOOD)), /--repeat-unclear/);
});
