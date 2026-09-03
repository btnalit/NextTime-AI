import { describe, expect, it } from 'vitest';
import { ParamsValidationError } from './errors.js';
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
});
