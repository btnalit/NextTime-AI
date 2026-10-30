import { describe, expect, it } from 'vitest';
import { presenceShown } from './absence-baseline.js';

/** application/goal/absence-baseline (legacy 507): what a baseline counts as the gate showing the
 *  thing there. The rest of the runner is `advancer.integration.test.ts`'s. */

describe('presenceShown (legacy 507)', () => {
  const unmapped = {};

  it('without a result mapping, takes a result that is not empty as the thing there', () => {
    for (const data of [
      { name: 'web', state: 'running' },
      { name: 'web', enabled: false },
      [{ id: 1 }],
      'web',
      7,
      true,
      { items: [{ name: 'web' }], total: 1 },
    ]) {
      expect(presenceShown(unmapped, data), JSON.stringify(data)).toBe(true);
    }
  });

  it('without a result mapping, does not take an empty answer — a 200 for "nothing matched"', () => {
    for (const data of [
      null,
      undefined,
      '',
      '   ',
      false,
      0,
      [],
      {},
      [[], {}],
      { items: [], total: 0 },
      { found: false },
      { data: null, next: null },
      { results: { items: [] } },
    ]) {
      expect(presenceShown(unmapped, data), JSON.stringify(data)).toBe(false);
    }
  });

  it('with a result mapping, takes only an item of the declared shape with its identity', () => {
    const mapping = {
      result_mapping: { jmes_path: 'items', object_type: 'Service', identity_keys: ['name'] },
    };
    expect(presenceShown(mapping, { items: [{ name: 'web', state: 'up' }] })).toBe(true);
    expect(presenceShown(mapping, { items: [{ name: 0 }] })).toBe(true);
    expect(presenceShown(mapping, { items: [{ state: 'up' }, { name: 'web' }] })).toBe(true);
    for (const data of [
      { items: [] },
      { items: null },
      {},
      { items: [{ state: 'up' }] },
      { items: [{ name: null }] },
      { items: [{ name: '' }] },
      { items: ['web'] },
      { name: 'web' },
    ]) {
      expect(presenceShown(mapping, data), JSON.stringify(data)).toBe(false);
    }
    // A single object matched, and a mapping with no identity keys: any object it matches.
    const single = {
      result_mapping: { jmes_path: '@', object_type: 'Service', identity_keys: ['name'] },
    };
    expect(presenceShown(single, { name: 'web' })).toBe(true);
    expect(presenceShown(single, { state: 'up' })).toBe(false);
    const anyObject = {
      result_mapping: { jmes_path: 'service', object_type: 'Service', identity_keys: [] },
    };
    expect(presenceShown(anyObject, { service: {} })).toBe(true);
    expect(presenceShown(anyObject, { service: null })).toBe(false);
  });

  it('takes an expression the result cannot be read with as not shown', () => {
    const broken = {
      result_mapping: { jmes_path: 'items[', object_type: 'Service', identity_keys: ['name'] },
    };
    expect(presenceShown(broken, { items: [{ name: 'web' }] })).toBe(false);
  });
});
