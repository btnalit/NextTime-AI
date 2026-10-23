import { getCapability } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import { gateToolParameters, toToolParameters } from './tool-schema.js';

/** The part of a JSON Schema these tests walk. */
interface SchemaNode {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly anyOf?: readonly SchemaNode[];
}

function child(node: SchemaNode | undefined, ...path: (string | number)[]): SchemaNode {
  let at: unknown = node;
  for (const segment of path) {
    if (at === null || typeof at !== 'object') throw new Error(`no ${path.join('.')}`);
    at = (at as Record<string | number, unknown>)[segment];
  }
  if (at === null || typeof at !== 'object') throw new Error(`no ${path.join('.')}`);
  return at as SchemaNode;
}

/** S11 GO5e: `propose_goal`'s plan holds schemas that contain themselves (a predicate's `all` /
 *  `any` / `not`, an output schema's `properties`). Their inner occurrence is written as `{}` —
 *  any value, the kernel checks the call — without the library's warning per occurrence. */
describe('toToolParameters', () => {
  it('writes a schema that contains itself as {} the second time, and logs nothing', () => {
    const capability = getCapability('propose_goal');
    if (!capability) throw new Error('propose_goal is not in the registry');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const schema = toToolParameters(capability.paramsSchema) as unknown as SchemaNode;
      expect(warn).not.toHaveBeenCalled();
      expect(schema.type).toBe('object');
      const predicate = child(
        schema,
        'properties',
        'plan',
        'properties',
        'acceptance',
        'items',
        'anyOf',
        0,
        'properties',
        'check',
        'properties',
        'expect',
      );
      const all = predicate.anyOf?.find((option) => option.properties?.all !== undefined);
      expect(all?.properties?.all).toMatchObject({ type: 'array', items: {} });
      expect(all?.properties?.all?.items).toEqual({});
      // The outer predicate is still described in full.
      expect(predicate.anyOf?.length).toBeGreaterThanOrEqual(5);
    } finally {
      warn.mockRestore();
    }
  });
});

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
