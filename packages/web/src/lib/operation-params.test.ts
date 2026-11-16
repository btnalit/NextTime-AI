import type { OperationParamSummaryWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { fillableParams, paramTextsOf, paramsTextFrom } from './operation-params.js';

const PARAMS: readonly OperationParamSummaryWire[] = [
  { name: 'auth', in: 'header', required: true, type: 'string', gateOwned: true },
  { name: 'count', required: false, type: 'number' },
  { name: 'id', in: 'path', required: true, type: 'integer' },
  { name: 'labels', required: false, type: 'array' },
  { name: 'name', required: false, type: 'string' },
  { name: 'on', required: false, type: 'boolean' },
  { name: 'spec', required: false, type: 'object' },
  { name: 'value', required: false },
];

describe('fillableParams (legacy 775)', () => {
  it('leaves out the params only the gate sets, required ones first, then by name', () => {
    expect(fillableParams(PARAMS).map((param) => param.name)).toEqual([
      'id',
      'count',
      'labels',
      'name',
      'on',
      'spec',
      'value',
    ]);
  });
});

describe('paramTextsOf (legacy 775)', () => {
  const fillable = fillableParams(PARAMS);
  it('shows each value in its param’s field', () => {
    expect(
      paramTextsOf(
        JSON.stringify({
          id: 7,
          count: 1.5,
          labels: ['a'],
          name: 'web 1',
          on: false,
          spec: { a: 1 },
          value: 'x',
        }),
        fillable,
      ),
    ).toEqual({
      id: '7',
      count: '1.5',
      labels: '["a"]',
      name: 'web 1',
      on: 'false',
      spec: '{"a":1}',
      // A word with no single type shows without quotes; anything JSON reads shows as JSON.
      value: 'x',
    });
    expect(paramTextsOf('{"value": "12"}', fillable)).toEqual({ value: '"12"' });
    expect(paramTextsOf('{"value": "  "}', fillable)).toEqual({ value: '"  "' });
    expect(paramTextsOf('  ', fillable)).toEqual({});
  });

  it('is null for JSON the fields cannot hold without changing it', () => {
    for (const text of [
      'not json',
      '[1]',
      '"x"',
      '{"unknown": 1}',
      '{"auth": "k"}',
      '{"id": "7"}',
      '{"id": 7.5}',
      '{"name": 1}',
      '{"on": "true"}',
      '{"spec": [1]}',
      '{"labels": {}}',
    ]) {
      expect(paramTextsOf(text, fillable), text).toBeNull();
    }
  });
});

describe('paramsTextFrom (legacy 775)', () => {
  const fillable = fillableParams(PARAMS);
  it('makes the JSON from the fields, by type, in the fields’ order, leaving empty ones out', () => {
    const { text, problems } = paramsTextFrom(
      {
        value: '[1]',
        spec: '{"a": 1}',
        on: 'true',
        name: ' web ',
        labels: '["x"]',
        count: ' -2.5e1 ',
        id: '3',
      },
      fillable,
    );
    expect(problems).toEqual({});
    expect(text).toBe(
      JSON.stringify(
        { id: 3, count: -25, labels: ['x'], name: ' web ', on: true, spec: { a: 1 }, value: [1] },
        null,
        2,
      ),
    );
    expect(paramsTextFrom({ id: ' ', name: '', on: '' }, fillable).text).toBe('');
  });

  it('keeps what does not fit as typed, and says which field', () => {
    const { text, problems } = paramsTextFrom(
      { id: '1.5', count: '1,5', spec: '[1]', labels: '{', value: 'abc' },
      fillable,
    );
    // #1296 UX P3: a param with no single type takes a word as that text, no quotes needed.
    expect(problems).toEqual({
      id: 'integer',
      count: 'number',
      spec: 'object',
      labels: 'array',
    });
    expect(JSON.parse(text)).toEqual({
      id: '1.5',
      count: '1,5',
      labels: '{',
      spec: '[1]',
      value: 'abc',
    });
  });

  it('keeps a whole number JSON cannot carry exactly as typed, and says so (review #501 P3-1)', () => {
    const { text, problems } = paramsTextFrom({ id: '9007199254740993' }, fillable);
    expect(problems).toEqual({ id: 'integer' });
    expect(JSON.parse(text)).toEqual({ id: '9007199254740993' });
    expect(paramsTextFrom({ id: '9007199254740991' }, fillable).problems).toEqual({});
  });

  it('says a required param left empty (#1296 UX P2-1)', () => {
    expect(paramsTextFrom({ id: ' ', name: 'x' }, fillable)).toEqual({
      text: JSON.stringify({ name: 'x' }, null, 2),
      problems: { id: 'required' },
    });
  });

  it('keeps a text param that is only spaces; any other such field is left out', () => {
    expect(JSON.parse(paramsTextFrom({ name: '  ', count: '  ' }, fillable).text)).toEqual({
      name: '  ',
    });
  });

  it('round-trips what paramTextsOf shows', () => {
    const sent = { id: 9, labels: [1, 'b'], name: '', on: false, value: 'a word' };
    const texts = paramTextsOf(JSON.stringify(sent), fillable);
    expect(texts).not.toBeNull();
    // An empty text param is left out; everything else comes back as it was.
    const { name: _empty, ...rest } = sent;
    expect(JSON.parse(paramsTextFrom(texts ?? {}, fillable).text)).toEqual(rest);
  });
});
