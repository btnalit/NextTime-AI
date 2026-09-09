// scripts/guards/vocabulary.test.mjs — a small test of the vocabulary guard's own detectors
// (docs/development-tasks.md S3.7 deliverable 4: "Add a small test for the guard's detectors").
// Exercises the pure predicate functions vocabulary.mjs exports directly, not a full repo scan —
// `node scripts/guards/vocabulary.mjs` (or `pnpm ci:guards`) is the end-to-end run against the
// real repository; this is the fast, isolated unit layer under it. No test framework dependency:
// Node's own built-in test runner.
//
// Usage: node --test scripts/guards/vocabulary.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectPropertyKeys,
  evaluateProposeModeCapability,
  isBareStringActionKindLine,
  isCommentLine,
  isIdempotencyKeyZodFieldLine,
  isListEnvelopeShape,
  isListShapedName,
  isSnakeCaseViolation,
} from './vocabulary.mjs';

test('isCommentLine', async (t) => {
  await t.test('recognizes // line comments', () => {
    assert.equal(isCommentLine('  // some prose'), true);
  });
  await t.test('recognizes /** and * JSDoc continuation lines', () => {
    assert.equal(isCommentLine('/**'), true);
    assert.equal(isCommentLine(' * continuation'), true);
  });
  await t.test('does not flag real code', () => {
    assert.equal(isCommentLine('  actionKindTag: z.string(),'), false);
  });
});

test('(a) isBareStringActionKindLine', async (t) => {
  await t.test('flags a bare-string actionKind zod field', () => {
    assert.equal(isBareStringActionKindLine('    actionKind: z.string().min(1),'), true);
  });
  await t.test('does not flag the {tag,label} object reuse', () => {
    assert.equal(isBareStringActionKindLine('  actionKind: ActionKindSchema,'), false);
  });
  await t.test('does not flag the distinct actionKindTag field', () => {
    assert.equal(isBareStringActionKindLine('  actionKindTag: z.string(),'), false);
  });
});

test('(b) isIdempotencyKeyZodFieldLine', async (t) => {
  await t.test('flags a zod idempotencyKey field declaration', () => {
    assert.equal(isIdempotencyKeyZodFieldLine('  idempotencyKey: z.string().optional(),'), true);
  });
  await t.test('does not flag actionRequestId (the correct field)', () => {
    assert.equal(isIdempotencyKeyZodFieldLine('  actionRequestId: z.string().min(1),'), false);
  });
  await t.test('does not flag a non-zod value (e.g. a plain object literal in a test)', () => {
    assert.equal(isIdempotencyKeyZodFieldLine("  idempotencyKey: 'abc',"), false);
  });
});

test('(c) evaluateProposeModeCapability', async (t) => {
  await t.test('propose_* name with mode propose is fine', () => {
    assert.equal(evaluateProposeModeCapability({ name: 'propose_skill', mode: 'propose' }), null);
  });
  await t.test('request_* name with mode propose is fine', () => {
    assert.equal(
      evaluateProposeModeCapability({ name: 'request_connection', mode: 'propose' }),
      null,
    );
  });
  await t.test('mode propose without a propose_/request_ prefix is a violation', () => {
    const message = evaluateProposeModeCapability({ name: 'assert_fact', mode: 'propose' });
    assert.match(message, /does not start with/);
  });
  await t.test('a propose_*/request_* name with a non-propose mode is a violation', () => {
    const message = evaluateProposeModeCapability({ name: 'propose_skill', mode: 'write' });
    assert.match(message, /not "propose"/);
  });
  await t.test('request_action is the one documented exemption', () => {
    assert.equal(
      evaluateProposeModeCapability({ name: 'request_action', mode: 'execute' }),
      null,
    );
  });
});

test('(d) isSnakeCaseViolation', async (t) => {
  await t.test('flags a snake_case key', () => {
    assert.equal(isSnakeCaseViolation('owner_principal_id'), true);
  });
  await t.test('does not flag a camelCase key', () => {
    assert.equal(isSnakeCaseViolation('ownerPrincipalId'), false);
  });
  await t.test('does not flag a single-word key (no underscore to judge)', () => {
    assert.equal(isSnakeCaseViolation('id'), false);
  });
  await t.test('exempts the known Operation-manifest fields', () => {
    assert.equal(isSnakeCaseViolation('params_schema'), false);
    assert.equal(isSnakeCaseViolation('blast_radius'), false);
    assert.equal(isSnakeCaseViolation('tool_name'), false);
  });
});

test('collectPropertyKeys', async (t) => {
  await t.test('collects nested object/array/union keys', () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        child: {
          type: 'object',
          properties: { owner_id: { type: 'string' } },
        },
        items: {
          type: 'array',
          items: { type: 'object', properties: { nested_key: { type: 'string' } } },
        },
        variant: {
          anyOf: [
            { type: 'object', properties: { branch_a: { type: 'string' } } },
            { type: 'object', properties: { branch_b: { type: 'string' } } },
          ],
        },
      },
    };
    const keys = collectPropertyKeys(jsonSchema);
    assert.deepEqual(
      keys.sort(),
      ['branch_a', 'branch_b', 'child', 'id', 'items', 'nested_key', 'owner_id', 'variant'].sort(),
    );
  });
});

test('(e) isListEnvelopeShape / isListShapedName', async (t) => {
  await t.test('recognizes a listEnvelope-shaped JSON schema', () => {
    assert.equal(
      isListEnvelopeShape({
        type: 'object',
        properties: { items: { type: 'array', items: {} }, nextCursor: { type: 'string' } },
      }),
      true,
    );
  });
  await t.test('rejects a bare array', () => {
    assert.equal(isListEnvelopeShape({ type: 'array', items: {} }), false);
  });
  await t.test('rejects an object with no items property', () => {
    assert.equal(
      isListEnvelopeShape({ type: 'object', properties: { objects: { type: 'array' } } }),
      false,
    );
  });
  await t.test('matches every required name prefix', () => {
    assert.equal(isListShapedName('list_chats'), true);
    assert.equal(isListShapedName('find_workers'), true);
    assert.equal(isListShapedName('query_decisions'), true);
    assert.equal(isListShapedName('get_chat_history'), true);
    assert.equal(isListShapedName('search'), false);
    assert.equal(isListShapedName('get_task'), false);
  });
});
