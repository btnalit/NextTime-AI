import { PREDICATE_MAX_LEAVES, PredicateSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import {
  type PredicateDraft,
  emptyPredicateDraft,
  newPredicateCondition,
  newPredicateGroup,
  predicateAddLimit,
  predicateComparesText,
  predicateDraftAsForm,
  predicateDraftAsJson,
  predicateDraftFrom,
  predicateDraftProblems,
  predicateFormBlocker,
  predicateFormBlockerText,
  predicateFromDraft,
  predicateValueKinds,
  predicateWithPaths,
  withChildAdded,
  withConditionChanged,
  withNodeRemoved,
} from './predicate-draft.js';

const t: Translate = (zh) => zh;
type Form = Extract<PredicateDraft, { mode: 'form' }>;
const form = (draft: PredicateDraft): Form => {
  if (draft.mode !== 'form') throw new Error('expected the form');
  return draft;
};

describe('lib/predicate-draft (legacy 464)', () => {
  it('reads every predicate the form can say and writes it back the same', () => {
    const cases: unknown[] = [
      { path: 'status', op: 'eq', value: 'ok' },
      { path: 'status', op: 'exists' },
      { not: { path: 'error', op: 'exists' } },
      { all: [{ path: 'n', op: 'gt', value: 3 }] },
      {
        any: [
          { path: 'ready', op: 'eq', value: true },
          {
            not: {
              all: [
                { path: 'tags', op: 'contains', value: 'x' },
                { path: 'v', op: 'eq', value: null },
              ],
            },
          },
          { path: 'meta', op: 'eq', value: { a: [1, 2] } },
        ],
      },
      { not: { any: [{ path: 'a', op: 'lt', value: '2026-01-01' }] } },
    ];
    for (const value of cases) {
      const draft = predicateDraftFrom(value);
      expect(draft.mode).toBe('form');
      expect(predicateFromDraft(draft)).toEqual(value);
      expect(PredicateSchema.safeParse(predicateFromDraft(draft)).success).toBe(true);
    }
  });

  it('keeps as JSON what the form cannot say, and says where', () => {
    const doubleNot = { all: [{ not: { not: { path: 'a', op: 'exists' } } }] };
    const draft = predicateDraftFrom(doubleNot);
    expect(draft.mode).toBe('json');
    expect(predicateFromDraft(draft)).toEqual(doubleNot);
    expect(predicateFormBlocker(draft)).toEqual({ kind: 'double_not', at: 'all.0.not' });
    expect(predicateDraftAsForm(draft)).toBeNull();
    // Where, in the form's words rather than the JSON path.
    expect(predicateFormBlockerText({ kind: 'double_not', at: 'all.0.not' }, t)).toMatch(
      /^第 1 项是/,
    );
    expect(predicateFormBlockerText({ kind: 'double_not', at: 'all.1.not.any.0.not' }, t)).toMatch(
      /^第 2 项里的第 1 项是/,
    );
    expect(predicateFormBlockerText({ kind: 'double_not', at: 'not' }, t)).toMatch(/^整个条件是/);
    expect(
      predicateFormBlocker(predicateDraftFrom({ path: 'a', op: 'eq', value: 1, x: 1 })),
    ).toEqual({ kind: 'shape', at: '' });
    expect(predicateFormBlocker({ mode: 'json', text: '{' })).toEqual({ kind: 'not_json' });
    // Back and forth through JSON loses nothing.
    const value = {
      any: [
        { path: 'a', op: 'eq', value: 1 },
        { path: 'b', op: 'exists' },
      ],
    };
    const json = predicateDraftAsJson(predicateDraftFrom(value));
    expect(predicateFromDraft(form(predicateDraftAsForm(json) as PredicateDraft))).toEqual(value);
  });

  it('writes a new one as a lone condition, and as all of them once there are more', () => {
    const draft = form(emptyPredicateDraft());
    const [first] = draft.root.children as unknown as [{ uid: string }];
    const one = withConditionChanged(draft, first.uid, { path: 'status', valueText: 'ok' });
    expect(predicateFromDraft(one)).toEqual({ path: 'status', op: 'eq', value: 'ok' });
    const second = newPredicateCondition();
    const two = withConditionChanged(withChildAdded(one, one.root.uid, second), second.uid, {
      path: 'n',
      op: 'gte',
      valueKind: 'number',
      valueText: '2',
    });
    expect(predicateFromDraft(two)).toEqual({
      all: [
        { path: 'status', op: 'eq', value: 'ok' },
        { path: 'n', op: 'gte', value: 2 },
      ],
    });
    // Back to one: a lone condition again.
    expect(predicateFromDraft(withNodeRemoved(two, second.uid))).toEqual({
      path: 'status',
      op: 'eq',
      value: 'ok',
    });
  });

  it('offers a comparison only the value kinds it takes, and moves the value to one it does', () => {
    expect(predicateValueKinds('exists')).toEqual([]);
    expect(predicateValueKinds('gt')).toEqual(['number', 'string']);
    expect(predicateValueKinds('contains')).toContain('json');
    const draft = form(predicateDraftFrom({ path: 'on', op: 'eq', value: true }));
    const [only] = draft.root.children as unknown as [{ uid: string }];
    const ordered = withConditionChanged(draft, only.uid, { op: 'lt' });
    const [node] = ordered.root.children as unknown as [{ valueKind: string }];
    expect(node.valueKind).toBe('number');

    // Turning to an ordering comparison: empty or numeric text is compared as a number (UX #743
    // P2-1); other text stays text and says it is compared as text.
    const text = form(predicateDraftFrom({ path: 'count', op: 'eq', value: '5' }));
    const [count] = text.root.children as unknown as [{ uid: string }];
    const [asNumber] = withConditionChanged(text, count.uid, { op: 'gt' }).root
      .children as unknown as [Parameters<typeof predicateComparesText>[0]];
    expect(asNumber.valueKind).toBe('number');
    expect(predicateComparesText(asNumber)).toBe(false);
    const date = form(predicateDraftFrom({ path: 'until', op: 'eq', value: '2026-01-01' }));
    const [until] = date.root.children as unknown as [{ uid: string }];
    const [asText] = withConditionChanged(date, until.uid, { op: 'lt' }).root
      .children as unknown as [Parameters<typeof predicateComparesText>[0]];
    expect(asText.valueKind).toBe('string');
    expect(predicateComparesText(asText)).toBe(true);
    // Choosing text by hand afterwards is kept.
    const chosen = withConditionChanged(
      withConditionChanged(text, count.uid, { op: 'gt' }),
      count.uid,
      { valueKind: 'string' },
    );
    expect((chosen.root.children[0] as { valueKind: string }).valueKind).toBe('string');
  });

  it('says at its place a number or JSON that does not parse', () => {
    const draft = form(
      predicateDraftFrom({
        all: [{ path: 'n', op: 'eq', value: 1 }, { not: { path: 'm', op: 'eq', value: { a: 1 } } }],
      }),
    );
    const [n, m] = draft.root.children as unknown as [{ uid: string }, { uid: string }];
    const broken = withConditionChanged(
      withConditionChanged(draft, n.uid, { valueText: '1.2.3' }),
      m.uid,
      { valueText: '{a' },
    );
    expect([...predicateDraftProblems(broken, t)]).toEqual([
      ['all.0.value', '要填一个数字'],
      ['all.1.not.value', expect.stringMatching(/^不是合法的/)],
    ]);
    expect(predicateWithPaths(broken)?.paths.get(m.uid)).toBe('all.1.not');
  });

  it('removing the last of a group takes the group too', () => {
    const draft = form(emptyPredicateDraft());
    const group = newPredicateGroup();
    const added = withChildAdded(draft, draft.root.uid, group);
    const [inner] = group.children as unknown as [{ uid: string }];
    const removed = withNodeRemoved(added, inner.uid);
    expect(removed.root.children).toHaveLength(1);
  });

  it('says why a group cannot take more: conditions, items, nesting', () => {
    let draft = form(emptyPredicateDraft());
    for (let i = 1; i < PREDICATE_MAX_LEAVES; i += 1) {
      draft = withChildAdded(
        draft,
        draft.root.uid,
        i < 16 ? newPredicateCondition() : newPredicateGroup(),
      );
    }
    expect(predicateAddLimit(draft, draft.root.uid, 'condition', t)).toMatch(/最多 32 个条件/);

    let deep = form(emptyPredicateDraft());
    let parent = deep.root.uid;
    for (let level = 0; level < 3; level += 1) {
      const group = newPredicateGroup();
      deep = withChildAdded(deep, parent, group);
      parent = group.uid;
    }
    expect(predicateAddLimit(deep, parent, 'condition', t)).toBeNull();
    expect(predicateAddLimit(deep, parent, 'group', t)).toMatch(/最多套 4 层/);
  });
});
