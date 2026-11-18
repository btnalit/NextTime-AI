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

    it('a $schema naming draft-07 is checked as before (https too), and an unknown one is still refused', () => {
      for (const dialect of [
        'http://json-schema.org/draft-07/schema#',
        'https://json-schema.org/draft-07/schema',
      ]) {
        const draft07 = {
          $schema: dialect,
          type: 'array',
          items: [{ type: 'string' }],
          additionalItems: false,
        };
        ok(draft07, ['a']);
        refused(draft07, ['a', 'b']);
        // draft-07 ignores unevaluatedProperties, so the gate's own default still refuses an
        // unexpected key (#493 review of #1387).
        const unevaluated = {
          $schema: dialect,
          type: 'object',
          properties: { a: { type: 'string' } },
          unevaluatedProperties: false,
        };
        ok(unevaluated, { a: 'x' });
        refused(unevaluated, { a: 'x', c: 'y' });
      }
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
      // A 2019-09 keyword beside it does not pull the schema back to 2019-09, which has no prefixItems.
      const withDependent = {
        ...schema,
        properties: { ...schema.properties, label: { type: 'string' } },
        dependentRequired: { pair: ['label'] },
      };
      ok(withDependent, { pair: ['a', 1], label: 'x' });
      refused(withDependent, { pair: ['a', 'b'], label: 'x' });
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
      const atLeast = {
        type: 'object',
        properties: { ids: { type: 'array', contains: { type: 'integer' }, minContains: 2 } },
      };
      ok(atLeast, { ids: [1, 'a', 2] });
      refused(atLeast, { ids: [1, 'a'] });
    });

    it.each(['allOf', 'anyOf', 'oneOf'])(
      'a later-dialect keyword inside an %s list counts',
      (list) => {
        const schema = {
          type: 'object',
          [list]: [{ dependentRequired: { card: ['cvc'] } }],
        };
        ok(schema, { card: '1', cvc: '2' });
        refused(schema, { card: '1' });
      },
    );

    it('a 2020-12 keyword inside a dependentSchemas entry checks in 2020-12, not 2019-09 (legacy 811)', () => {
      // `dependentSchemas` alone would pick 2019-09, where `prefixItems` means nothing and the
      // tuple below would go unchecked; the walk has to reach the keyword inside the entry.
      const schema = {
        type: 'object',
        properties: { card: { type: 'string' }, codes: { type: 'array' } },
        dependentSchemas: {
          card: { properties: { codes: { prefixItems: [{ type: 'string' }] } } },
        },
      };
      ok(schema, { card: '1', codes: ['a'] });
      refused(schema, { card: '1', codes: [5] });
      ok(schema, { codes: [5, 6] });
    });

    it('2019-09 keywords beside draft-07 array-form items are checked in 2019-09, which keeps that form', () => {
      const schema = {
        type: 'object',
        dependentRequired: { pair: ['label'] },
        properties: {
          label: { type: 'string' },
          pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] },
        },
      };
      ok(schema, { label: 'x', pair: ['a', 1] });
      refused(schema, { label: 'x', pair: ['a', 'b'] });
      refused(schema, { pair: ['a', 1] });
    });

    it('a later-dialect keyword inside an array-form items entry counts', () => {
      const schema = {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: [{ type: 'array', contains: { const: 'x' }, maxContains: 1 }],
          },
        },
      };
      ok(schema, { rows: [['x', 'y']] });
      refused(schema, { rows: [['x', 'x']] });
    });

    it('$recursiveRef, $dynamicRef and unevaluatedItems without a $schema are checked', () => {
      const recursive = { type: 'object', properties: { child: { $recursiveRef: '#' } } };
      ok(recursive, { child: { child: {} } });
      refused(recursive, { child: 5 });
      refused(recursive, { child: { evil: 'x' } });
      const dynamic = { type: 'object', properties: { child: { $dynamicRef: '#' } } };
      ok(dynamic, { child: {} });
      refused(dynamic, { child: 5 });
      const items = {
        type: 'object',
        properties: { list: { type: 'array', unevaluatedItems: { type: 'string' } } },
      };
      ok(items, { list: ['a'] });
      refused(items, { list: [1] });
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

    it('the keys of an annotation (discriminator.mapping, externalDocs) are not keywords', () => {
      const schema = {
        type: 'object',
        discriminator: { propertyName: 'kind', mapping: { prefixItems: '#/components/schemas/A' } },
        externalDocs: { url: 'https://docs.example.test', unevaluatedProperties: false },
        properties: {
          kind: { type: 'string' },
          pair: { type: 'array', items: [{ type: 'string' }], additionalItems: false },
        },
      };
      ok(schema, { kind: 'a', pair: ['a'] });
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
