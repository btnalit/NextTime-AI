import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  OPERATION_FIELD_RULES,
  OPERATION_GOVERNANCE_KEYS,
  diffOperationGovernanceFields,
  operationGovernanceChangeDirection,
  operationGovernanceFieldsOf,
  operationGovernanceProperties,
  withOperationGovernance,
} from './governance-fields.js';

/**
 * STATUS leftover 344: every governance field is compared, applied and ranked — by the very rules
 * the change-plan classifier applies to an Operation (`OPERATION_FIELD_RULES`), so a console
 * confirm and a change plan never disagree on which way a change goes.
 */

function op(overrides: Partial<Operation> = {}): Operation {
  return {
    name: 'container.restart',
    binding: { kind: 'http', method: 'POST', path: '/containers/{id}/restart' },
    params_schema: { type: 'object', properties: { id: { type: 'string' } } },
    mode: 'execute',
    blast_radius: 'medium',
    reversibility: false,
    auto_approvable: false,
    await_decision: true,
    reads: ['Container'],
    writes: ['Container'],
    ...overrides,
  };
}

function direction(before: Partial<Operation>, after: Partial<Operation>) {
  return operationGovernanceChangeDirection(
    operationGovernanceFieldsOf(op(before)),
    operationGovernanceFieldsOf(op(after)),
  );
}

/** What the change-plan classifier says of the same one-field change. */
function planSays(key: keyof Operation, before: Partial<Operation>, after: Partial<Operation>) {
  return OPERATION_FIELD_RULES[key](op(before)[key], op(after)[key]) === null
    ? 'tightened'
    : 'loosened';
}

describe('operation governance direction (one classifier, STATUS leftover 344)', () => {
  const cases: readonly {
    readonly key: keyof Operation;
    readonly before: Partial<Operation>;
    readonly after: Partial<Operation>;
    readonly expected: 'loosened' | 'tightened';
  }[] = [
    { key: 'await_decision', before: {}, after: { await_decision: false }, expected: 'loosened' },
    {
      key: 'await_decision',
      before: { await_decision: false },
      after: { await_decision: true },
      expected: 'tightened',
    },
    { key: 'reads', before: {}, after: { reads: ['Container', 'Host'] }, expected: 'loosened' },
    { key: 'reads', before: {}, after: { reads: [] }, expected: 'tightened' },
    { key: 'writes', before: {}, after: { writes: ['Host'] }, expected: 'loosened' },
    { key: 'writes', before: {}, after: { writes: [] }, expected: 'tightened' },
    // Any change of the read-only hint counts as loosening (decision 10-23).
    { key: 'read_only_hint', before: {}, after: { read_only_hint: true }, expected: 'loosened' },
    {
      key: 'read_only_hint',
      before: { read_only_hint: true },
      after: { read_only_hint: false },
      expected: 'loosened',
    },
    {
      key: 'read_only_hint',
      before: { read_only_hint: true },
      after: {},
      expected: 'loosened',
    },
    // An undeclared destructive hint is as strict as `true`: only `false` lets auto-approval apply.
    {
      key: 'destructive_hint',
      before: {},
      after: { destructive_hint: false },
      expected: 'loosened',
    },
    {
      key: 'destructive_hint',
      before: { destructive_hint: false },
      after: {},
      expected: 'tightened',
    },
    {
      key: 'destructive_hint',
      before: { destructive_hint: false },
      after: { destructive_hint: true },
      expected: 'tightened',
    },
    // An undeclared idempotent hint is as strict as `false`: only `true` lets auto-approval apply.
    { key: 'idempotent_hint', before: {}, after: { idempotent_hint: true }, expected: 'loosened' },
    {
      key: 'idempotent_hint',
      before: { idempotent_hint: true },
      after: { idempotent_hint: false },
      expected: 'tightened',
    },
  ];

  for (const { key, before, after, expected } of cases) {
    it(`${key}: ${JSON.stringify(before)} → ${JSON.stringify(after)} is ${expected}, as a change plan ranks it`, () => {
      expect(direction(before, after)).toBe(expected);
      expect(planSays(key, before, after)).toBe(expected);
    });
  }

  it('the existing three fields keep their directions', () => {
    expect(direction({ mode: 'execute' }, { mode: 'observe' })).toBe('loosened');
    expect(direction({ blast_radius: 'medium' }, { blast_radius: 'high' })).toBe('tightened');
    expect(direction({ auto_approvable: false }, { auto_approvable: true })).toBe('loosened');
  });

  it('reads / writes compare as sets: a reorder or a repeated entry is no change', () => {
    expect(
      direction({ reads: ['Container', 'Host'] }, { reads: ['Host', 'Container', 'Host'] }),
    ).toBe('neutral');
  });

  it('a change that loosens one field and tightens another is mixed', () => {
    expect(direction({}, { await_decision: false, blast_radius: 'high' })).toBe('mixed');
  });

  it('every governance field changing reports each of them', () => {
    const before = operationGovernanceFieldsOf(op());
    const after = operationGovernanceFieldsOf(
      op({
        mode: 'observe',
        blast_radius: 'low',
        auto_approvable: true,
        await_decision: false,
        reads: [],
        writes: [],
        read_only_hint: true,
        destructive_hint: false,
        idempotent_hint: true,
      }),
    );
    expect(diffOperationGovernanceFields(before, after).changedFields).toEqual([
      'mode',
      'blastRadius',
      'autoApprovable',
      'awaitDecision',
      'reads',
      'writes',
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
    ]);
  });

  it('every governance key is a field OPERATION_FIELD_RULES ranks', () => {
    for (const key of OPERATION_GOVERNANCE_KEYS) expect(OPERATION_FIELD_RULES).toHaveProperty(key);
  });
});

describe('operationGovernanceProperties / withOperationGovernance', () => {
  it('sets declared fields and removes a hint the announcement no longer declares', () => {
    const fields = operationGovernanceFieldsOf(op({ destructive_hint: false }));
    expect(operationGovernanceProperties(fields)).toEqual({
      set: {
        mode: 'execute',
        blast_radius: 'medium',
        auto_approvable: false,
        await_decision: true,
        reads: ['Container'],
        writes: ['Container'],
        destructive_hint: false,
      },
      removed: ['read_only_hint', 'idempotent_hint'],
    });
    const applied = withOperationGovernance(
      op({ read_only_hint: true, idempotent_hint: true }),
      fields,
    );
    expect(applied).not.toHaveProperty('read_only_hint');
    expect(applied).not.toHaveProperty('idempotent_hint');
    expect(applied.destructive_hint).toBe(false);
  });
});
