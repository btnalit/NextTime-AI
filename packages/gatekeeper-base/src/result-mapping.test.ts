import type { ResultMapping } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { applyResultMapping } from './result-mapping.js';

describe('applyResultMapping', () => {
  it('maps a JMESPath array match into observed fact candidates', () => {
    const mapping: ResultMapping = {
      jmes_path: 'items[]',
      object_type: 'Stock',
      identity_keys: ['sku'],
      attributes: { quantity: 'qty' },
    };
    const response = {
      items: [
        { sku: 'A', qty: 1 },
        { sku: 'B', qty: 2 },
      ],
    };

    expect(applyResultMapping(response, mapping)).toEqual([
      { objectType: 'Stock', identity: { sku: 'A' }, properties: { quantity: 1 } },
      { objectType: 'Stock', identity: { sku: 'B' }, properties: { quantity: 2 } },
    ]);
  });

  it('maps a single-object match without attributes using the item itself as properties', () => {
    const mapping: ResultMapping = {
      jmes_path: 'container',
      object_type: 'Container',
      identity_keys: ['id'],
    };
    const response = { container: { id: 'c1', status: 'running' } };
    expect(applyResultMapping(response, mapping)).toEqual([
      {
        objectType: 'Container',
        identity: { id: 'c1' },
        properties: { id: 'c1', status: 'running' },
      },
    ]);
  });

  it('returns no candidates when the JMESPath expression matches nothing', () => {
    const mapping: ResultMapping = {
      jmes_path: 'items[]',
      object_type: 'Stock',
      identity_keys: ['sku'],
    };
    expect(applyResultMapping({}, mapping)).toEqual([]);
  });
});
