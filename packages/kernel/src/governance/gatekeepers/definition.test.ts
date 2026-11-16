import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { operationDefinitionChange, operationParams } from './definition.js';

/**
 * definition.test (legacy K, UX acceptance of #538): `operationDefinitionChange` — what the catalog
 * shows of a revision draft before it is published; legacy 465: `operationParams` — what it shows
 * of every version's params.
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
        { name: 'limit', required: true, type: 'number' },
        { name: 'warehouse', in: 'query', required: false, type: 'string' },
      ],
      paramsRemoved: [{ name: 'unit', in: 'query', required: false, type: 'string' }],
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
        { name: 'sku', in: 'header', required: true, type: 'string' },
        { name: 'unit', in: 'query', required: true, type: 'string' },
      ],
    });
  });

  it('a param whose type alone changes is changed, shown with its new type (legacy 465)', () => {
    const revised: Operation = {
      ...STOCK,
      params_schema: {
        type: 'object',
        properties: {
          sku: { type: 'integer', 'x-in': 'query' },
          unit: { type: 'string', 'x-in': 'Query' },
        },
        required: ['sku'],
      },
    };
    expect(operationDefinitionChange(STOCK, revised)).toEqual({
      changedFields: ['params_schema'],
      paramsAdded: [],
      paramsRemoved: [],
      paramsChanged: [{ name: 'sku', in: 'query', required: true, type: 'integer' }],
    });
  });

  it('a param only the gate sets is marked on its entry (legacy 465)', () => {
    const revised: Operation = {
      ...STOCK,
      params_schema: {
        type: 'object',
        properties: {
          ...(STOCK.params_schema.properties as Record<string, unknown>),
          Authorization: { type: 'string', 'x-in': 'header' },
        },
        required: ['sku'],
      },
    };
    expect(operationDefinitionChange(STOCK, revised)?.paramsAdded).toEqual([
      { name: 'Authorization', in: 'header', required: false, type: 'string', gateOwned: true },
    ]);
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

describe('operationParams (legacy 465)', () => {
  it('lists the top-level params by name, with where they go, whether required and their type', () => {
    expect(operationParams(STOCK)).toEqual([
      { name: 'sku', in: 'query', required: true, type: 'string' },
      { name: 'unit', in: 'query', required: false, type: 'string' },
    ]);
  });

  it('gives a type only where a param has exactly one; nested properties are not listed', () => {
    const operation: Operation = {
      ...STOCK,
      binding: { kind: 'mcp', tool_name: 'stock_get' },
      params_schema: {
        type: 'object',
        properties: {
          zone: { type: ['string', 'null'] },
          count: { type: ['null', 'integer'] },
          flag: { type: 'boolean' },
          options: { type: 'object', properties: { depth: { type: 'integer' } } },
          tags: { type: 'array', items: { type: 'string' } },
          either: { type: ['string', 'integer'] },
          ref: { $ref: '#/definitions/thing' },
          union: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          blank: {},
          nothing: { type: 'null' },
          odd: { type: 'date' },
        },
        required: ['zone'],
      },
    };
    expect(operationParams(operation)).toEqual([
      { name: 'blank', required: false },
      { name: 'count', required: false, type: 'integer' },
      { name: 'either', required: false },
      { name: 'flag', required: false, type: 'boolean' },
      { name: 'nothing', required: false },
      { name: 'odd', required: false },
      { name: 'options', required: false, type: 'object' },
      { name: 'ref', required: false },
      { name: 'tags', required: false, type: 'array' },
      { name: 'union', required: false },
      { name: 'zone', required: true, type: 'string' },
    ]);
  });

  it('marks a param only the gate sets — an http binding only', () => {
    const declares = {
      type: 'object',
      properties: {
        Authorization: { type: 'string', 'x-in': 'header' },
        sku: { type: 'string', 'x-in': 'query' },
      },
    };
    expect(operationParams({ ...STOCK, params_schema: declares })).toEqual([
      { name: 'Authorization', in: 'header', required: false, type: 'string', gateOwned: true },
      { name: 'sku', in: 'query', required: false, type: 'string' },
    ]);
    expect(
      operationParams({
        ...STOCK,
        binding: { kind: 'mcp', tool_name: 'stock_get' },
        params_schema: declares,
      }),
    ).toEqual([
      { name: 'Authorization', in: 'header', required: false, type: 'string' },
      { name: 'sku', in: 'query', required: false, type: 'string' },
    ]);
  });

  it('is empty for a schema with no params, and absent when the stored one is not a schema', () => {
    expect(operationParams({ ...STOCK, params_schema: {} })).toEqual([]);
    expect(operationParams({ ...STOCK, params_schema: { type: 'object' } })).toEqual([]);
    expect(operationParams({ ...STOCK, params_schema: 'nope' })).toBeUndefined();
    expect(operationParams({ ...STOCK, params_schema: { properties: [] } })).toBeUndefined();
    expect(operationParams({ name: 'stock.get' })).toBeUndefined();
    expect(operationParams(null)).toBeUndefined();
  });
});
