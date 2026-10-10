import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { operationDefinitionChange } from './definition.js';

/**
 * definition.test (legacy K, UX acceptance of #538): `operationDefinitionChange` — what the catalog
 * shows of a revision draft before it is published.
 */

const STOCK: Operation = {
  name: 'stock.get',
  binding: { kind: 'http', method: 'GET', path: '/stock' },
  params_schema: {
    type: 'object',
    properties: {
      sku: { type: 'string', 'x-in': 'query' },
      unit: { type: 'string', 'x-in': 'Query' },
    },
    required: ['sku'],
  },
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

describe('operationDefinitionChange', () => {
  it('names added, removed and changed params, and the definition fields that differ', () => {
    const revised: Operation = {
      ...STOCK,
      binding: { kind: 'http', method: 'GET', path: '/v2/stock' },
      params_schema: {
        type: 'object',
        properties: {
          sku: { type: 'string', 'x-in': 'query' },
          warehouse: { type: 'string', 'x-in': 'query' },
          limit: { type: 'number' },
        },
        required: ['sku', 'limit'],
      },
      // Governance fields are `governanceChange`'s, never listed here.
      auto_approvable: false,
      description: 'Reads stock.',
    };
    expect(operationDefinitionChange(STOCK, revised)).toEqual({
      changedFields: ['binding', 'params_schema'],
      paramsAdded: [
        { name: 'limit', required: true },
        { name: 'warehouse', in: 'query', required: false },
      ],
      paramsRemoved: [{ name: 'unit', in: 'query', required: false }],
      paramsChanged: [],
    });
  });

  it('a param that becomes required, or moves, is changed', () => {
    const revised: Operation = {
      ...STOCK,
      params_schema: {
        type: 'object',
        properties: {
          sku: { type: 'string', 'x-in': 'header' },
          unit: { type: 'string', 'x-in': 'Query' },
        },
        required: ['sku', 'unit'],
      },
    };
    expect(operationDefinitionChange(STOCK, revised)).toEqual({
      changedFields: ['params_schema'],
      paramsAdded: [],
      paramsRemoved: [],
      paramsChanged: [
        { name: 'sku', in: 'header', required: true },
        { name: 'unit', in: 'query', required: true },
      ],
    });
  });

  it('an identical definition changes nothing; one that does not parse has no diff', () => {
    expect(operationDefinitionChange(STOCK, { ...STOCK, description: 'x' })).toEqual({
      changedFields: [],
      paramsAdded: [],
      paramsRemoved: [],
      paramsChanged: [],
    });
    expect(operationDefinitionChange(STOCK, { name: 'stock.get' })).toBeUndefined();
  });
});
