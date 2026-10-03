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
        before: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
        after: { mode: 'execute', blastRadius: 'low', autoApprovable: true },
        direction: 'loosened',
        otherChangedFields: ['reversibility'],
      },
    ]);
  });

  it('does not list an Operation whose only change is its description', () => {
    const restart = op();
    const diff = diffAnnouncedManifest([restart], [{ ...restart, description: 'Reworded.' }]);
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
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
