import { FactCheckSchema, type OntologyLinkTypeWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  factCheckDraftAsForm,
  factCheckDraftAsJson,
  factCheckDraftFrom,
  factCheckDraftProblems,
  factCheckFromDraft,
  factEndTypes,
  factFormBlocker,
  factIdentityMismatch,
  factIdentityRows,
  factRowsForType,
} from './fact-check-draft.js';
import type { Translate } from './i18n.js';

const t: Translate = (zh) => zh;
const HOST = '5f0c1a52-8a2e-4f3b-9c61-0d2b7e4a9f10';

describe('lib/fact-check-draft (legacy 464)', () => {
  it('reads every Fact check the form can say and writes it back the same', () => {
    const cases: unknown[] = [
      {
        linkType: 'runs_on',
        source: { objectType: 'Service', identity: { name: 'web', env: 'prod' } },
        target: { objectId: HOST },
      },
      {
        linkType: 'runs_on',
        source: { objectType: 'Service', identity: { name: 'web', replicas: 3, canary: false } },
        target: { objectType: 'Host', identity: { hostId: 3, meta: { rack: 'a' }, retired: null } },
        expect: {
          all: [
            { path: 'port', op: 'eq', value: 443 },
            { path: 'tls', op: 'exists' },
          ],
        },
      },
    ];
    for (const value of cases) {
      const draft = factCheckDraftFrom(value);
      expect(draft.mode).toBe('form');
      expect(factCheckFromDraft(draft)).toEqual(value);
      expect(FactCheckSchema.safeParse(factCheckFromDraft(draft)).success).toBe(true);
      // Through JSON and back loses nothing.
      const back = factCheckDraftAsForm(factCheckDraftAsJson(draft));
      expect(back && factCheckFromDraft(back)).toEqual(value);
    }
  });

  it('keeps as JSON what the form cannot say, and says where', () => {
    const odd = { linkType: 'x', source: { objectId: HOST, objectType: 'Host' }, target: {} };
    const draft = factCheckDraftFrom(odd);
    expect(draft.mode).toBe('json');
    expect(factCheckFromDraft(draft)).toEqual(odd);
    expect(factFormBlocker(draft)).toEqual({ kind: 'shape', at: 'source' });
    expect(factFormBlocker({ mode: 'json', text: '{' })).toEqual({ kind: 'not_json' });
    expect(factFormBlocker(factCheckDraftFrom({ linkType: 'x', note: 1 }))).toEqual({
      kind: 'shape',
      at: 'note',
    });
  });

  it('says at its place a field with no name, one used twice, a value that does not parse', () => {
    const draft = factCheckDraftFrom({
      linkType: 'runs_on',
      source: { objectType: 'Service', identity: { name: 'web' } },
      target: { objectType: 'Host', identity: { hostId: 3 } },
      expect: { path: 'port', op: 'eq', value: 443 },
    });
    if (draft.mode !== 'form' || draft.source.by !== 'identity' || draft.target.by !== 'identity') {
      throw new Error('expected the form');
    }
    const [name] = draft.source.rows as unknown as [{ uid: string }];
    const [hostId] = draft.target.rows as unknown as [{ uid: string; valueKind: string }];
    const broken = {
      ...draft,
      source: {
        ...draft.source,
        rows: [
          ...draft.source.rows,
          { ...draft.source.rows[0], uid: 'x', key: 'name' },
          {
            uid: 'y',
            key: '',
            valueKind: 'string' as const,
            valueText: 'a',
          },
        ],
      },
      target: {
        ...draft.target,
        rows: draft.target.rows.map((row) => ({ ...row, valueText: 'three' })),
      },
    };
    expect(name).toBeTruthy();
    expect(hostId.valueKind).toBe('number');
    expect(Object.fromEntries(factCheckDraftProblems(broken as typeof draft, t))).toEqual({
      'source.identity.name': '身份字段 name 重复了',
      'source.identity.#2': '身份字段要有名字',
      'target.identity.hostId': '要填一个数字',
    });
  });

  it('knows the types a Link type allows at each end, and an identity against the type’s fields', () => {
    const link: OntologyLinkTypeWire = {
      kind: 'link',
      name: 'runs_on',
      signatures: [
        { domain: 'Service', range: 'Host', description: '' },
        { domain: 'Container', range: 'Host', description: '' },
      ],
    };
    expect(factEndTypes(link, 'source')).toEqual(['Service', 'Container']);
    expect(factEndTypes(link, 'target')).toEqual(['Host']);
    expect(
      factEndTypes(
        { ...link, signatures: [{ domain: '*', range: 'Host', description: '' }] },
        'source',
      ),
    ).toBeNull();
    expect(factEndTypes(undefined, 'source')).toBeNull();

    const rows = factIdentityRows({ name: 'web', zone: 'a' });
    expect(factIdentityMismatch(rows, ['name', 'env'])).toEqual({
      missing: ['env'],
      extra: ['zone'],
    });
    expect(factIdentityMismatch(rows, undefined)).toEqual({ missing: [], extra: [] });
    expect(factRowsForType(rows, ['env', 'name']).map((row) => [row.key, row.valueText])).toEqual([
      ['env', ''],
      ['name', 'web'],
    ]);
  });
});
