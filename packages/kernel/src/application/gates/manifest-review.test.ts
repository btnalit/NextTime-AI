import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  operationGovernanceChangeDirection,
  operationGovernanceFieldsOf,
} from '../../governance/gatekeepers/index.js';
import {
  canonicalJson,
  diffAnnouncedManifest,
  isReviewedManifestChange,
  manifestDigest,
  toWireGateOperation,
} from './manifest-review.js';

function op(overrides: Partial<Operation> = {}): Operation {
  return {
    name: 'container.restart',
    description: 'Restart a container.',
    binding: { kind: 'http', method: 'POST', path: '/containers/{id}/restart' },
    params_schema: { type: 'object', properties: { id: { type: 'string' } } },
    mode: 'execute',
    blast_radius: 'high',
    reversibility: false,
    auto_approvable: false,
    await_decision: false,
    reads: [],
    writes: [],
    ...overrides,
  };
}

function direction(before: Partial<Operation>, after: Partial<Operation>) {
  return operationGovernanceChangeDirection(
    operationGovernanceFieldsOf(op(before)),
    operationGovernanceFieldsOf(op(after)),
  );
}

/** The governance fields `op()` leaves at their defaults. */
const UNDECLARED = {
  awaitDecision: false,
  reads: [],
  writes: [],
  readOnlyHint: null,
  destructiveHint: null,
  idempotentHint: null,
  target: null,
} as const;

describe('operationGovernanceChangeDirection (R-19, D-17)', () => {
  it('counts a lower blast radius as loosening on its own (high → medium, medium → low)', () => {
    expect(direction({ blast_radius: 'high' }, { blast_radius: 'medium' })).toBe('loosened');
    expect(direction({ blast_radius: 'medium' }, { blast_radius: 'low' })).toBe('loosened');
  });

  it('counts execute → observe as loosening on its own', () => {
    expect(direction({ mode: 'execute' }, { mode: 'observe' })).toBe('loosened');
  });

  it('counts auto-approvable false → true as loosening', () => {
    expect(direction({ auto_approvable: false }, { auto_approvable: true })).toBe('loosened');
  });

  it('counts the opposite moves as tightening', () => {
    expect(direction({ blast_radius: 'low' }, { blast_radius: 'high' })).toBe('tightened');
    expect(direction({ mode: 'observe' }, { mode: 'execute' })).toBe('tightened');
    expect(direction({ auto_approvable: true }, { auto_approvable: false })).toBe('tightened');
  });

  it('a change that loosens one field and tightens another is mixed', () => {
    expect(
      direction(
        { mode: 'execute', blast_radius: 'low' },
        { mode: 'observe', blast_radius: 'high' },
      ),
    ).toBe('mixed');
  });

  it('is neutral when none of the three governance fields changed', () => {
    expect(direction({}, {})).toBe('neutral');
    expect(direction({}, { binding: { kind: 'http', method: 'GET', path: '/other' } })).toBe(
      'neutral',
    );
  });
});

describe('isReviewedManifestChange (R-18, D-18)', () => {
  const list = op({ name: 'container.list', mode: 'observe', blast_radius: 'low' });
  const restart = op();

  it('a re-announce of the same manifest is no change, whatever the order of Operations or keys', () => {
    const reordered = [{ ...restart }, Object.fromEntries(Object.entries(list).reverse())];
    expect(isReviewedManifestChange([list, restart], reordered as Operation[])).toBe(false);
  });

  it('a description-only change needs no review', () => {
    expect(
      isReviewedManifestChange([list, restart], [list, { ...restart, description: 'Reworded.' }]),
    ).toBe(false);
  });

  it('a changed governance field, binding, added or removed Operation is a change', () => {
    expect(isReviewedManifestChange([restart], [{ ...restart, blast_radius: 'medium' }])).toBe(
      true,
    );
    expect(
      isReviewedManifestChange(
        [restart],
        [{ ...restart, binding: { kind: 'http', method: 'POST', path: '/admin/wipe' } }],
      ),
    ).toBe(true);
    expect(isReviewedManifestChange([restart], [restart, list])).toBe(true);
    expect(isReviewedManifestChange([restart, list], [restart])).toBe(true);
  });
});

describe('diffAnnouncedManifest', () => {
  it('lists added, removed and changed Operations, each change with the kernel direction', () => {
    const list = op({ name: 'container.list', mode: 'observe', blast_radius: 'low' });
    const remove = op({ name: 'container.remove' });
    const restart = op();
    const diff = diffAnnouncedManifest(
      [list, remove, restart],
      [
        list,
        { ...restart, blast_radius: 'low', auto_approvable: true, reversibility: true },
        op({ name: 'container.exec' }),
      ],
    );
    expect(diff.added.map((o) => o.name)).toEqual(['container.exec']);
    expect(diff.removed.map((o) => o.name)).toEqual(['container.remove']);
    expect(diff.changed).toEqual([
      {
        name: 'container.restart',
        before: { ...UNDECLARED, mode: 'execute', blastRadius: 'high', autoApprovable: false },
        after: { ...UNDECLARED, mode: 'execute', blastRadius: 'low', autoApprovable: true },
        direction: 'loosened',
        otherChangedFields: ['reversibility'],
      },
    ]);
  });

  it('carries every governance field in before / after, never in otherChangedFields (STATUS leftover 344)', () => {
    const restart = op();
    const diff = diffAnnouncedManifest(
      [restart],
      [
        {
          ...restart,
          await_decision: !restart.await_decision,
          reads: ['Container'],
          writes: ['Container'],
          read_only_hint: true,
          destructive_hint: false,
          idempotent_hint: true,
        },
      ],
    );
    expect(diff.changed).toHaveLength(1);
    const [change] = diff.changed;
    expect(change?.after).toMatchObject({
      awaitDecision: !restart.await_decision,
      reads: ['Container'],
      writes: ['Container'],
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(change?.otherChangedFields).toEqual([]);
    expect(change?.direction).not.toBe('neutral');
  });

  it('does not list an Operation whose only change is its description', () => {
    const restart = op();
    const diff = diffAnnouncedManifest([restart], [{ ...restart, description: 'Reworded.' }]);
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('toWireGateOperation (console G4, UX acceptance of #567 P3)', () => {
  it('carries the gate-owned params publish_operation refuses by, and nothing for a clean entry', () => {
    const held = op({
      name: 'orders.lookup',
      binding: { kind: 'http', method: 'GET', path: '/orders' },
      params_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', 'x-in': 'query' },
          Authorization: { type: 'string', 'x-in': 'header' },
        },
      },
    });
    expect(toWireGateOperation(held).gateOwnedParams).toEqual([
      { param: 'Authorization', location: 'header' },
    ]);
    expect(toWireGateOperation(op())).not.toHaveProperty('gateOwnedParams');
    // The pending-manifest diff lists added entries the same way.
    expect(diffAnnouncedManifest([], [held]).added[0]?.gateOwnedParams).toEqual([
      { param: 'Authorization', location: 'header' },
    ]);
  });
});

describe('diffAnnouncedManifest changed[] (review #501 on #571 ③)', () => {
  it('marks a changed entry whose announced definition now declares a gate-owned param', () => {
    const clean = op({
      name: 'orders.lookup',
      binding: { kind: 'http', method: 'GET', path: '/orders' },
      params_schema: { type: 'object', properties: { id: { type: 'string', 'x-in': 'query' } } },
    });
    const withHeader = op({
      ...clean,
      params_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', 'x-in': 'query' },
          Authorization: { type: 'string', 'x-in': 'header' },
        },
      },
    });
    const diff = diffAnnouncedManifest([clean], [withHeader]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.gateOwnedParams).toEqual([
      { param: 'Authorization', location: 'header' },
    ]);
    // A change that keeps the definition clean carries no mark.
    const relaxed = diffAnnouncedManifest([clean], [op({ ...clean, blast_radius: 'low' })]);
    expect(relaxed.changed[0]).not.toHaveProperty('gateOwnedParams');
  });
});

describe('manifestDigest / canonicalJson', () => {
  it('digests the same stored manifest the same, whatever its key order', () => {
    const a = [{ name: 'x', mode: 'observe', nested: { b: 1, a: 2 } }];
    const b = [{ nested: { a: 2, b: 1 }, mode: 'observe', name: 'x' }];
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(manifestDigest(a)).toBe(manifestDigest(b));
  });

  it('digests a different manifest differently', () => {
    expect(manifestDigest([op()])).not.toBe(manifestDigest([op({ blast_radius: 'low' })]));
    expect(manifestDigest([op()])).toMatch(/^[0-9a-f]{64}$/);
  });
});
