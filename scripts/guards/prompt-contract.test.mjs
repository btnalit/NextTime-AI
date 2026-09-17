// scripts/guards/prompt-contract.test.mjs — a small test of the prompt-contract guard's own
// detectors (docs/development-tasks.md S5.4 deliverable 2: "要有自检... 并证明它能抓住一个故意写错的
// 工具名"). Exercises the pure functions `prompt-contract.mjs` exports directly, not a full repo
// scan — `node scripts/guards/prompt-contract.mjs` (or `pnpm ci:guards`) is the end-to-end run
// against the real `ontology/*.yaml`; this is the fast, isolated unit layer under it, same split
// `vocabulary.test.mjs`/`vocabulary.mjs` already establish.
//
// Usage: node --test scripts/guards/prompt-contract.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALLOWED_NON_TOOL_WORDS,
  GATE_PLACEHOLDER,
  candidateIdentifier,
  checkPromptFile,
  extractBacktickSpans,
  extractCandidateIdentifiers,
  extractStringArrayLiteral,
} from './prompt-contract.mjs';

test('candidateIdentifier', async (t) => {
  await t.test('accepts a bare identifier', () => {
    assert.equal(candidateIdentifier('factsToAssert'), 'factsToAssert');
  });
  await t.test('accepts the structural gate placeholder', () => {
    assert.equal(candidateIdentifier(GATE_PLACEHOLDER), GATE_PLACEHOLDER);
  });
  await t.test('extracts the leading name from a call-signature example', () => {
    assert.equal(
      candidateIdentifier('invoke_worker(definition@version, input, gates=[...])'),
      'invoke_worker',
    );
    assert.equal(candidateIdentifier('request_connection(kind, target)'), 'request_connection');
  });
  await t.test('rejects a hyphenated word (not an identifier shape)', () => {
    assert.equal(candidateIdentifier('ops-runner'), null);
  });
  await t.test('rejects prose spans (spaces, braces, colons)', () => {
    assert.equal(candidateIdentifier('{status: pending_approval, simulated}'), null);
    assert.equal(candidateIdentifier('await_decision=false'), null);
    assert.equal(candidateIdentifier('two words'), null);
  });
});

test('extractBacktickSpans', async (t) => {
  await t.test('extracts every span, in order, duplicates kept', () => {
    assert.deepEqual(extractBacktickSpans('call `foo` then `bar`, or `foo` again'), [
      'foo',
      'bar',
      'foo',
    ]);
  });
  await t.test('returns an empty array when there are no backticks', () => {
    assert.deepEqual(extractBacktickSpans('plain prose, no code spans'), []);
  });
});

test('extractCandidateIdentifiers', async (t) => {
  await t.test('drops prose spans and de-duplicates candidates', () => {
    assert.deepEqual(
      extractCandidateIdentifiers(
        'Call `report_result` once. `report_result` again. Not `{a, b}` and not `ops-runner`.',
      ),
      ['report_result'],
    );
  });
});

test('extractStringArrayLiteral', async (t) => {
  await t.test(
    'extracts string entries, ignoring comment lines even with a stray apostrophe',
    () => {
      const fixture = [
        'const ENTRY_TOOL_CAPABILITY_NAMES = [',
        "  // a comment with an apostrophe's stray quote and a 'quoted word' inside a comment",
        "  'get_object',",
        "  'traverse',",
        '] as const;',
      ].join('\n');
      assert.deepEqual(extractStringArrayLiteral(fixture, 'ENTRY_TOOL_CAPABILITY_NAMES'), [
        'get_object',
        'traverse',
      ]);
    },
  );
  await t.test('throws a clear error when the constant is not found', () => {
    assert.throws(
      () => extractStringArrayLiteral('const OTHER = [];', 'MISSING_NAME'),
      /could not find/,
    );
  });
});

test('checkPromptFile', async (t) => {
  const toolSet = new Set(['report_result', GATE_PLACEHOLDER]);
  const allowed = new Set(['context']);

  await t.test(
    'a clean prompt (every backtick word is a tool, a placeholder, or allow-listed) has no violations',
    () => {
      const prompt =
        'Each `<gate>.<op>` tool is observe- or execute-class. When done, call `report_result`. ' +
        'The result arrives via `context` on a later turn.';
      assert.deepEqual(checkPromptFile('fixture.yaml', prompt, toolSet, allowed), []);
    },
  );

  await t.test(
    'catches a deliberately wrong/fabricated tool name (the H2 regression shape) — proves this guard bites',
    () => {
      // Deliberately bad sample built in-memory, per the task's own instruction — never by editing
      // a real ontology/*.yaml file for this test.
      const badPrompt = 'Read first — `describe_operations` shows which is which.';
      const violations = checkPromptFile('fixture.yaml', badPrompt, toolSet, allowed);
      assert.equal(violations.length, 1);
      assert.match(violations[0], /describe_operations/);
      assert.match(violations[0], /neither a tool this mode registers nor an allow-listed word/);
    },
  );

  await t.test('catches a stale result-contract key (the H1 regression shape)', () => {
    const contractKeys = new Set(['summary', 'factsToAssert']);
    const combined = new Set([...toolSet, ...contractKeys]);
    const badPrompt = 'Report `facts_to_assert` as part of the result.';
    const violations = checkPromptFile('fixture.yaml', badPrompt, combined, allowed);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /facts_to_assert/);
  });

  await t.test('a call-signature example resolves to its leading tool name', () => {
    const withInvoke = new Set([...toolSet, 'invoke_worker']);
    const prompt =
      'Then `invoke_worker(definition@version, input, gates=[...])` — this issues a Handle.';
    assert.deepEqual(checkPromptFile('fixture.yaml', prompt, withInvoke, allowed), []);
  });
});

test('ALLOWED_NON_TOOL_WORDS', async (t) => {
  await t.test('only covers the two known prompt files, each a Set', () => {
    assert.deepEqual(Object.keys(ALLOWED_NON_TOOL_WORDS).sort(), [
      'ontology/entry-agent.yaml',
      'ontology/ops-runner.yaml',
    ]);
    for (const value of Object.values(ALLOWED_NON_TOOL_WORDS)) {
      assert.ok(value instanceof Set);
    }
  });
});
