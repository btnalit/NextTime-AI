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

  it('surfaces an unresolvable $ref as ParamsSchemaInvalidError, not a bare/opaque throw', () => {
    const schema = { type: 'object', properties: { x: { $ref: '#/definitions/Missing' } } };
    expect(() => assertParamsValid('broken-op', schema, { x: 1 })).toThrow(
      ParamsSchemaInvalidError,
    );
    expect(() => assertParamsValid('broken-op', schema, { x: 1 })).toThrow(/broken-op/);
  });
});
