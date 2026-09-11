import { describe, expect, it } from 'vitest';
import { gateToolParameters } from './tool-schema.js';

/** W7: every gate tool's `parameters` must be an object schema — an OpenAI-compatible provider
 *  rejects the whole request otherwise (the first real-model S2 run: a parameterless GET's
 *  `params_schema` of `null` took every entry-agent turn down with a 400). */
describe('gateToolParameters', () => {
  it('null / undefined / non-object → empty object schema', () => {
    const empty = { type: 'object', properties: {}, additionalProperties: false };
    expect(gateToolParameters(null)).toEqual(empty);
    expect(gateToolParameters(undefined)).toEqual(empty);
    expect(gateToolParameters('string')).toEqual(empty);
    expect(gateToolParameters([])).toEqual(empty);
  });

  it('{} → empty object schema; properties without type → type added', () => {
    expect(gateToolParameters({})).toEqual({ type: 'object', properties: {} });
    expect(
      gateToolParameters({ properties: { id: { type: 'string' } }, required: ['id'] }),
    ).toEqual({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
  });

  it('a well-formed object schema is returned as is (properties filled in when missing)', () => {
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    };
    expect(gateToolParameters(schema)).toBe(schema);
    expect(gateToolParameters({ type: 'object' })).toEqual({ type: 'object', properties: {} });
  });

  it('a non-object top-level schema is wrapped as a required `value` property', () => {
    expect(gateToolParameters({ type: 'string' })).toEqual({
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    });
  });
});
