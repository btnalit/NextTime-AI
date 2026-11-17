import { describe, expect, it } from 'vitest';
import { ParamsSchemaInvalidError, ParamsValidationError } from './errors.js';
import { assertParamsValid } from './params-validation.js';

describe('assertParamsValid', () => {
  it('accepts anything against an empty schema', () => {
    expect(() => assertParamsValid('op', {}, { anything: 'goes' })).not.toThrow();
    expect(() => assertParamsValid('op', {}, undefined)).not.toThrow();
  });

  it('accepts params matching the schema', () => {
    const schema = { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] };
    expect(() => assertParamsValid('op', schema, { sku: 'X1' })).not.toThrow();
  });

  it('throws ParamsValidationError for params that fail the schema', () => {
    const schema = { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] };
    expect(() => assertParamsValid('op', schema, {})).toThrow(ParamsValidationError);
    expect(() => assertParamsValid('op', schema, { sku: 5 })).toThrow(ParamsValidationError);
  });

  it('defaults additionalProperties:false when properties are declared but the flag is omitted (review lane 5, P2-5)', () => {
    const schema = { type: 'object', properties: { sku: { type: 'string' } } };
    expect(() => assertParamsValid('op', schema, { sku: 'X1' })).not.toThrow();
    expect(() => assertParamsValid('op', schema, { sku: 'X1', evil: 'x' })).toThrow(
      ParamsValidationError,
    );
  });

  it('honours an explicit additionalProperties:true override', () => {
    const schema = {
      type: 'object',
      properties: { sku: { type: 'string' } },
      additionalProperties: true,
    };
    expect(() => assertParamsValid('op', schema, { sku: 'X1', extra: 1 })).not.toThrow();
  });

  describe('legacy 803: a schema written for 2019-09 / 2020-12 is checked in that dialect', () => {
    const ok = (schema: Record<string, unknown>, params: unknown) =>
      expect(() => assertParamsValid('op', schema, params)).not.toThrow();
    const refused = (schema: Record<string, unknown>, params: unknown) =>
      expect(() => assertParamsValid('op', schema, params)).toThrow(ParamsValidationError);

    it('a $schema naming 2020-12 or 2019-09 is checked in it, not refused as an unknown meta-schema', () => {
      for (const dialect of [
        'https://json-schema.org/draft/2020-12/schema',
        'https://json-schema.org/draft/2019-09/schema',
        'http://json-schema.org/draft/2020-12/schema#',
      ]) {
        const schema = {
          $schema: dialect,
          type: 'object',
          properties: { sku: { type: 'string' } },
          required: ['sku'],
        };
        ok(schema, { sku: 'X1' });
        refused(schema, {});
        refused(schema, { sku: 'X1', evil: 'x' });
      }
      // 2019-09 still has the array form of `items`, which 2020-12 dropped.
      const tuple2019 = {
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        type: 'array',
        items: [{ type: 'string' }],
        additionalItems: false,
      };
      ok(tuple2019, ['a']);
      refused(tuple2019, ['a', 'b']);
    });

    it('a $schema naming draft-07 is checked as before, and an unknown one is still refused', () => {
      const draft07 = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'array',
        items: [{ type: 'string' }],
        additionalItems: false,
      };
      ok(draft07, ['a']);
      refused(draft07, ['a', 'b']);
      expect(() =>
        assertParamsValid('op', { $schema: 'https://example.test/my-dialect', type: 'object' }, {}),
      ).toThrow(ParamsSchemaInvalidError);
    });

    it('prefixItems beside items:false takes the tuple it describes', () => {
      const schema = {
        type: 'object',
        properties: {
          pair: {
            type: 'array',
            prefixItems: [{ type: 'string' }, { type: 'integer' }],
            items: false,
          },
        },
      };
      ok(schema, { pair: ['a', 1] });
      ok(schema, { pair: ['a'] });
      refused(schema, { pair: ['a', 'b'] });
      refused(schema, { pair: ['a', 1, 2] });
    });

    it('unevaluatedProperties:false lets through what an allOf declares, and nothing else', () => {
      const schema = {
        type: 'object',
        allOf: [{ properties: { id: { type: 'string' } } }],
        properties: { note: { type: 'string' } },
        unevaluatedProperties: false,
      };
      ok(schema, { id: 'a', note: 'b' });
      refused(schema, { id: 'a', evil: 'x' });
    });

    it('dependentRequired, dependentSchemas and maxContains are checked', () => {
      ok({ type: 'object', dependentRequired: { card: ['cvc'] } }, { card: '1', cvc: '2' });
      refused({ type: 'object', dependentRequired: { card: ['cvc'] } }, { card: '1' });
      const dependent = {
        type: 'object',
        dependentSchemas: { card: { properties: { cvc: { type: 'string' } }, required: ['cvc'] } },
      };
      refused(dependent, { card: '1' });
      const contains = {
        type: 'object',
        properties: { tags: { type: 'array', contains: { const: 'x' }, maxContains: 1 } },
      };
      ok(contains, { tags: ['x', 'y'] });
      refused(contains, { tags: ['x', 'x'] });
    });

    it('a property called prefixItems does not switch the dialect: draft-07 array items still work', () => {
      const schema = {
        type: 'object',
        properties: {
          prefixItems: { type: 'string' },
          pair: { type: 'array', items: [{ type: 'string' }], additionalItems: false },
        },
      };
      ok(schema, { prefixItems: 'a', pair: ['a'] });
      refused(schema, { pair: ['a', 'b'] });
    });

    it('a later-dialect word inside enum, a default or an x- extension is data, not a keyword', () => {
      const schema = {
        type: 'object',
        'x-examples': { sample: { prefixItems: [] } },
        properties: {
          mode: { enum: [{ prefixItems: 1 }], default: { unevaluatedProperties: false } },
          pair: { type: 'array', items: [{ type: 'string' }], additionalItems: false },
        },
      };
      ok(schema, { mode: { prefixItems: 1 }, pair: ['a'] });
      refused(schema, { pair: ['a', 'b'] });
    });
  });

  it('surfaces an unresolvable $ref as ParamsSchemaInvalidError, not a bare/opaque throw', () => {
    const schema = { type: 'object', properties: { x: { $ref: '#/definitions/Missing' } } };
    expect(() => assertParamsValid('broken-op', schema, { x: 1 })).toThrow(
      ParamsSchemaInvalidError,
    );
    expect(() => assertParamsValid('broken-op', schema, { x: 1 })).toThrow(/broken-op/);
  });
});
