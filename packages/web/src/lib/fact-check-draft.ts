import type { OntologyLinkTypeWire } from '@nexttime/shared';
import type { Translate } from './i18n.js';
import {
  type PredicateDraft,
  type PredicateValueKind,
  predicateDraftFrom,
  predicateDraftProblems,
  predicateFromDraft,
  predicateValueDraft,
  predicateValueOf,
  predicateValueProblem,
} from './predicate-draft.js';

/**
 * lib/fact-check-draft (legacy 464, PR-B): a Fact check (`@nexttime/shared` `predicate.ts`
 * `FactCheck`, a `fact_predicate` acceptance check) as the Procedure editor edits it — the Link
 * type, each end named by its ObjectType and identity (field by field, each value of a chosen
 * kind) or by an Object's id, and what the Fact's own properties must satisfy (a predicate,
 * `lib/predicate-draft`). What the form cannot read stays JSON as it came.
 *
 * Why identity is field by field: the kernel finds the Object whose stored identity is equal, as
 * JSON, to the one written here (`application/goal/fact-check.ts`) — a field missing, one too
 * many or `"3"` for `3` never matches, and the check then waits for evidence that cannot come.
 * The editor offers the ObjectType's own identity fields, and fills them from a picked Object
 * with the values as stored.
 */

export interface FactIdentityRow {
  /** React key; never sent. */
  readonly uid: string;
  readonly key: string;
  readonly valueKind: PredicateValueKind;
  readonly valueText: string;
}

export type FactRefDraft =
  | {
      readonly by: 'identity';
      readonly objectType: string;
      readonly rows: readonly FactIdentityRow[];
    }
  | { readonly by: 'id'; readonly objectId: string };

export type FactCheckDraft =
  | {
      readonly mode: 'form';
      readonly linkType: string;
      readonly source: FactRefDraft;
      readonly target: FactRefDraft;
      /** `null`: the Fact being there is the check. */
      readonly expect: PredicateDraft | null;
    }
  | { readonly mode: 'json'; readonly text: string };

let rowCounter = 0;
export function newFactIdentityRow(key = ''): FactIdentityRow {
  rowCounter += 1;
  return { uid: `identity-${rowCounter}`, key, valueKind: 'string', valueText: '' };
}

export function emptyFactRef(): FactRefDraft {
  return { by: 'identity', objectType: '', rows: [] };
}

export function emptyFactCheckDraft(): FactCheckDraft {
  return {
    mode: 'form',
    linkType: '',
    source: emptyFactRef(),
    target: emptyFactRef(),
    expect: null,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Why the form cannot say a Fact check — `at` is the JSON path of the place it stops at. */
export type FactFormBlocker =
  | { readonly kind: 'not_json' }
  | { readonly kind: 'shape'; readonly at: string };

/** An identity as rows, value kinds as stored. */
export function factIdentityRows(identity: Readonly<Record<string, unknown>>): FactIdentityRow[] {
  return Object.entries(identity).map(([key, value]) => ({
    ...newFactIdentityRow(key),
    ...predicateValueDraft(value),
  }));
}

function refOf(value: unknown, at: string): FactRefDraft | FactFormBlocker {
  if (value === undefined) return emptyFactRef();
  if (!isRecord(value)) return { kind: 'shape', at };
  const keys = Object.keys(value);
  if (keys.length === 1 && typeof value.objectId === 'string') {
    return { by: 'id', objectId: value.objectId };
  }
  if (
    keys.every((key) => key === 'objectType' || key === 'identity') &&
    (value.objectType === undefined || typeof value.objectType === 'string') &&
    (value.identity === undefined || isRecord(value.identity))
  ) {
    return {
      by: 'identity',
      objectType: (value.objectType as string | undefined) ?? '',
      rows: factIdentityRows((value.identity as Record<string, unknown> | undefined) ?? {}),
    };
  }
  return { kind: 'shape', at };
}

const isRef = (value: FactRefDraft | FactFormBlocker): value is FactRefDraft => 'by' in value;

function formOf(value: unknown): FactCheckDraft | FactFormBlocker {
  if (!isRecord(value)) return { kind: 'shape', at: '' };
  const extra = Object.keys(value).find(
    (key) => !['linkType', 'source', 'target', 'expect'].includes(key),
  );
  if (extra !== undefined) return { kind: 'shape', at: extra };
  if (value.linkType !== undefined && typeof value.linkType !== 'string') {
    return { kind: 'shape', at: 'linkType' };
  }
  const source = refOf(value.source, 'source');
  if (!isRef(source)) return source;
  const target = refOf(value.target, 'target');
  if (!isRef(target)) return target;
  return {
    mode: 'form',
    linkType: (value.linkType as string | undefined) ?? '',
    source,
    target,
    expect: value.expect === undefined ? null : predicateDraftFrom(value.expect),
  };
}

const isDraft = (value: FactCheckDraft | FactFormBlocker): value is FactCheckDraft =>
  'mode' in value;

/** The draft for a Fact check as it came (`undefined`: a new one). */
export function factCheckDraftFrom(value: unknown): FactCheckDraft {
  if (value === undefined) return emptyFactCheckDraft();
  const read = formOf(value);
  return isDraft(read) ? read : { mode: 'json', text: JSON.stringify(value, null, 2) };
}

export function factFormBlocker(draft: FactCheckDraft): FactFormBlocker | null {
  if (draft.mode === 'form' || draft.text.trim() === '') return null;
  try {
    const read = formOf(JSON.parse(draft.text));
    return isDraft(read) ? null : read;
  } catch {
    return { kind: 'not_json' };
  }
}

export function factFormBlockerText(blocker: FactFormBlocker, t: Translate): string {
  if (blocker.kind === 'not_json') return t('还不是合法的 JSON。', 'It is not valid JSON yet.');
  return blocker.at === ''
    ? t('它不是一个对象。', 'It is not an object.')
    : t(
        `${blocker.at} 的写法表单说不出（端点只能按 objectId，或按 objectType 加 identity）。`,
        `The form cannot say ${blocker.at} (an end is an objectId, or an objectType with an identity).`,
      );
}

function refToWire(ref: FactRefDraft): unknown {
  if (ref.by === 'id') return { objectId: ref.objectId.trim() };
  return {
    objectType: ref.objectType.trim(),
    identity: Object.fromEntries(
      ref.rows.map((row) => [row.key.trim(), predicateValueOf(row.valueKind, row.valueText)]),
    ),
  };
}

/** The Fact check the draft says; the JSON text when it does not parse; `undefined` for none. */
export function factCheckFromDraft(draft: FactCheckDraft): unknown {
  if (draft.mode === 'json') {
    if (draft.text.trim() === '') return undefined;
    try {
      return JSON.parse(draft.text);
    } catch {
      return draft.text;
    }
  }
  const expect = draft.expect === null ? undefined : predicateFromDraft(draft.expect);
  return {
    linkType: draft.linkType.trim(),
    source: refToWire(draft.source),
    target: refToWire(draft.target),
    ...(expect !== undefined ? { expect } : {}),
  };
}

export function factCheckDraftAsJson(draft: FactCheckDraft): FactCheckDraft {
  if (draft.mode === 'json') return draft;
  return { mode: 'json', text: JSON.stringify(factCheckFromDraft(draft), null, 2) };
}

export function factCheckDraftAsForm(draft: FactCheckDraft): FactCheckDraft | null {
  if (draft.mode === 'form') return draft;
  if (draft.text.trim() === '') return emptyFactCheckDraft();
  try {
    const read = formOf(JSON.parse(draft.text));
    return isDraft(read) ? read : null;
  } catch {
    return null;
  }
}

/** What the form can tell before the schema does, by the place in the check it is at
 *  (`source.identity.name`, `expect.all.0.value`; `''`: the JSON as a whole). */
export function factCheckDraftProblems(draft: FactCheckDraft, t: Translate): Map<string, string> {
  const problems = new Map<string, string>();
  if (draft.mode === 'json') {
    if (draft.text.trim() === '') return problems;
    try {
      JSON.parse(draft.text);
    } catch {
      problems.set('', t('不是合法的 JSON', 'Not valid JSON'));
    }
    return problems;
  }
  for (const end of ['source', 'target'] as const) {
    const ref = draft[end];
    if (ref.by !== 'identity') continue;
    const seen = new Set<string>();
    for (const [index, row] of ref.rows.entries()) {
      const key = row.key.trim();
      const at = `${end}.identity.${key === '' ? `#${index}` : key}`;
      if (key === '') problems.set(at, t('身份字段要有名字', 'The identity field needs a name'));
      else if (seen.has(key)) {
        problems.set(at, t(`身份字段 ${key} 重复了`, `The identity field ${key} is used twice`));
      }
      seen.add(key);
      const problem = predicateValueProblem(row.valueKind, row.valueText, t);
      if (problem !== null && key !== '') problems.set(at, problem);
    }
  }
  if (draft.expect !== null) {
    for (const [path, problem] of predicateDraftProblems(draft.expect, t)) {
      problems.set(path === '' ? 'expect' : `expect.${path}`, problem);
    }
  }
  return problems;
}

/** The ObjectTypes a Link type allows at an end (its signatures' domains or ranges); `null`:
 *  any — the Link type is unknown here, or one of its signatures takes any (`*`). */
export function factEndTypes(
  linkType: OntologyLinkTypeWire | undefined,
  end: 'source' | 'target',
): readonly string[] | null {
  if (linkType === undefined) return null;
  const types = linkType.signatures.map((signature) =>
    end === 'source' ? signature.domain : signature.range,
  );
  return types.includes('*') ? null : [...new Set(types)];
}

/** What an identity says against the ObjectType's own identity fields: those it lacks, and those
 *  the type does not have. Both mean the check never finds the Object. */
export function factIdentityMismatch(
  rows: readonly FactIdentityRow[],
  identityKey: readonly string[] | undefined,
): { readonly missing: readonly string[]; readonly extra: readonly string[] } {
  if (identityKey === undefined) return { missing: [], extra: [] };
  const keys = rows.map((row) => row.key.trim());
  return {
    missing: identityKey.filter((key) => !keys.includes(key)),
    extra: keys.filter((key) => key !== '' && !identityKey.includes(key)),
  };
}

/** The rows for an ObjectType's identity fields, keeping what was already filled in by key. */
export function factRowsForType(
  rows: readonly FactIdentityRow[],
  identityKey: readonly string[],
): FactIdentityRow[] {
  return identityKey.map(
    (key) => rows.find((row) => row.key.trim() === key) ?? newFactIdentityRow(key),
  );
}
