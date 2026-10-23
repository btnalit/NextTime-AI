import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import {
  emptySchemaDraft,
  schemaDraftAsFields,
  schemaDraftAsJson,
  schemaDraftFrom,
  schemaFieldNames,
  schemaFromDraft,
  schemaRowProblems,
} from './schema-fields.js';

const zhT: Translate = (zh) => zh;

describe('schema-fields (legacy 453)', () => {
  it('a flat object schema reads into the list and comes back with the same meaning', () => {
    const schema = {
      type: 'object',
      description: 'What the step hands back',
      properties: {
        hosts: { type: 'array', description: 'The hosts' },
        count: { type: 'integer' },
        anything: {},
      },
      required: ['count'],
      additionalProperties: false,
    };
    const draft = schemaDraftFrom(schema);
    expect(draft.mode).toBe('fields');
    expect(schemaFromDraft(draft)).toEqual({ ok: true, value: schema });
    expect(schemaFieldNames(draft)).toEqual(['hosts', 'count', 'anything']);
  });

  it('a schema that says more than the list can stays JSON, untouched', () => {
    for (const schema of [
      { type: 'object', properties: { host: { type: 'object', properties: {} } } },
      { type: 'object', properties: { size: { type: 'integer', minimum: 1 } } },
      { type: 'object', properties: { kind: { type: ['string', 'null'] } } },
      { type: 'object', required: ['missing'] },
      { type: 'string' },
    ]) {
      const draft = schemaDraftFrom(schema);
      expect(draft.mode).toBe('json');
      expect(schemaFromDraft(draft)).toEqual({ ok: true, value: schema });
      expect(schemaDraftAsFields(draft)).toBeNull();
    }
  });

  it('keeps empty properties / required as they came, and adds none of its own', () => {
    const kept = { type: 'object', properties: {}, required: [] };
    expect(schemaFromDraft(schemaDraftFrom(kept))).toEqual({ ok: true, value: kept });
    expect(schemaFromDraft(emptySchemaDraft())).toEqual({ ok: true, value: { type: 'object' } });
  });

  it('goes to JSON and back; JSON that does not parse stands as its text', () => {
    const draft = schemaDraftFrom({ type: 'object', properties: { site: { type: 'string' } } });
    const json = schemaDraftAsJson(draft);
    expect(json.mode).toBe('json');
    expect(schemaDraftAsFields(json)).toMatchObject({ mode: 'fields' });
    const broken = { mode: 'json' as const, text: '{"type":' };
    expect(schemaFromDraft(broken)).toEqual({ ok: false, text: '{"type":' });
    expect(schemaDraftAsFields(broken)).toBeNull();
    expect(schemaFieldNames(broken)).toEqual([]);
  });

  it('names rows without a name, or with one used twice', () => {
    const draft = schemaDraftFrom({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    });
    if (draft.mode !== 'fields') throw new Error('expected fields');
    const rows = draft.rows.map((row, index) => (index === 1 ? { ...row, name: 'a' } : row));
    expect([
      ...schemaRowProblems(
        {
          ...draft,
          rows: [
            ...rows,
            { uid: 'x', name: ' ', kind: 'string' as const, required: false, description: '' },
          ],
        },
        zhT,
      ),
    ]).toEqual([
      [1, '字段名 a 重复了'],
      [2, '字段要有名字'],
    ]);
  });
});
