import {
  PREDICATE_COMPARE_OPS,
  PREDICATE_MAX_CHILDREN,
  PREDICATE_MAX_LEAVES,
  PREDICATE_MAX_NESTING,
  PREDICATE_ORDER_OPS,
  type PredicateCompareOp,
} from '@nexttime/shared';
import type { Translate } from './i18n.js';

/**
 * lib/predicate-draft (legacy 464): a predicate (`@nexttime/shared` `predicate.ts`) as the
 * Procedure editor edits it — conditions one per row (a path, a comparison, a value of a chosen
 * kind) in groups that all or any must hold, each one negatable — or the predicate as JSON when
 * the form cannot say it (a `not` of a `not`, a key the shape does not know).
 *
 * The form is a projection, not a second model: what it writes is the predicate, what it cannot
 * read stays JSON as it came. A predicate read into the form and not touched comes back the same
 * — a lone condition stays a lone condition, an `all` of one stays an `all` of one.
 *
 * The console never evaluates a predicate (the kernel does); it only knows its shape and limits.
 */

export type PredicateOp = 'exists' | PredicateCompareOp;
export const PREDICATE_OPS: readonly PredicateOp[] = ['exists', ...PREDICATE_COMPARE_OPS];

/** The kind of a condition's value, as the form asks for it. */
export type PredicateValueKind = 'string' | 'number' | 'boolean' | 'null' | 'json';
export const PREDICATE_VALUE_KINDS: readonly PredicateValueKind[] = [
  'string',
  'number',
  'boolean',
  'null',
  'json',
];

const VALUE_KIND_LABEL: Readonly<Record<PredicateValueKind, readonly [string, string]>> = {
  string: ['文本', 'Text'],
  number: ['数字', 'Number'],
  boolean: ['是 / 否', 'Yes / no'],
  null: ['空值', 'Null'],
  json: ['JSON', 'JSON'],
};

export function predicateValueKindLabel(kind: PredicateValueKind, t: Translate): string {
  const [zh, en] = VALUE_KIND_LABEL[kind];
  return t(zh, en);
}

/** The value kinds a comparison takes: an ordering one numbers or text only, `exists` none. */
export function predicateValueKinds(op: PredicateOp): readonly PredicateValueKind[] {
  if (op === 'exists') return [];
  if (PREDICATE_ORDER_OPS.includes(op)) return ['number', 'string'];
  return PREDICATE_VALUE_KINDS;
}

export interface PredicateConditionDraft {
  readonly kind: 'condition';
  /** React key; never sent. */
  readonly uid: string;
  readonly path: string;
  readonly op: PredicateOp;
  readonly valueKind: PredicateValueKind;
  /** The value as typed: text, a number's digits, `true` / `false`, or JSON. */
  readonly valueText: string;
  /** Written as `{not: …}`. */
  readonly negated: boolean;
}

export interface PredicateGroupDraft {
  readonly kind: 'group';
  readonly uid: string;
  readonly mode: 'all' | 'any';
  readonly negated: boolean;
  readonly children: readonly PredicateNodeDraft[];
}

export type PredicateNodeDraft = PredicateConditionDraft | PredicateGroupDraft;

export type PredicateDraft =
  | {
      readonly mode: 'form';
      readonly root: PredicateGroupDraft;
      /** The predicate came as (or starts as) one condition, not a group: while the root holds
       *  one un-negated thing under 全部满足, it is written as that thing alone. */
      readonly bare: boolean;
    }
  | { readonly mode: 'json'; readonly text: string };

let uidCounter = 0;
function nextUid(): string {
  uidCounter += 1;
  return `pred-${uidCounter}`;
}

export function newPredicateCondition(): PredicateConditionDraft {
  return {
    kind: 'condition',
    uid: nextUid(),
    path: '',
    op: 'eq',
    valueKind: 'string',
    valueText: '',
    negated: false,
  };
}

export function newPredicateGroup(): PredicateGroupDraft {
  return {
    kind: 'group',
    uid: nextUid(),
    mode: 'any',
    negated: false,
    children: [newPredicateCondition()],
  };
}

/** A new predicate: one empty condition. */
export function emptyPredicateDraft(): PredicateDraft {
  return {
    mode: 'form',
    root: {
      kind: 'group',
      uid: nextUid(),
      mode: 'all',
      negated: false,
      children: [newPredicateCondition()],
    },
    bare: true,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Why the form cannot say a predicate — the first place it stops at. `at` is the JSON path of
 *  that place (`all.1.not`), `''` for the whole predicate. */
export type PredicateFormBlocker =
  | { readonly kind: 'not_json' }
  | { readonly kind: 'shape'; readonly at: string }
  | { readonly kind: 'double_not'; readonly at: string }
  | { readonly kind: 'empty_group'; readonly at: string };

function valueDraft(value: unknown): Pick<PredicateConditionDraft, 'valueKind' | 'valueText'> {
  if (typeof value === 'string') return { valueKind: 'string', valueText: value };
  if (typeof value === 'number') return { valueKind: 'number', valueText: String(value) };
  if (typeof value === 'boolean') return { valueKind: 'boolean', valueText: String(value) };
  if (value === null) return { valueKind: 'null', valueText: '' };
  return { valueKind: 'json', valueText: JSON.stringify(value, null, 2) };
}

const LEAF_KEYS: ReadonlySet<string> = new Set(['path', 'op', 'value']);

function nodeOf(
  value: unknown,
  at: string,
  negated: boolean,
): PredicateNodeDraft | PredicateFormBlocker {
  const join = (key: string | number) => (at === '' ? String(key) : `${at}.${key}`);
  if (!isRecord(value)) return { kind: 'shape', at };
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'not') {
    if (negated) return { kind: 'double_not', at };
    return nodeOf(value.not, join('not'), true);
  }
  if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
    const mode = keys[0];
    const list = value[mode];
    if (!Array.isArray(list)) return { kind: 'shape', at: join(mode) };
    if (list.length === 0) return { kind: 'empty_group', at: join(mode) };
    const children: PredicateNodeDraft[] = [];
    for (const [index, child] of list.entries()) {
      const read = nodeOf(child, join(`${mode}.${index}`), false);
      if (!isNode(read)) return read;
      children.push(read);
    }
    return { kind: 'group', uid: nextUid(), mode, negated, children };
  }
  if (!keys.every((key) => LEAF_KEYS.has(key))) return { kind: 'shape', at };
  const { path, op } = value;
  if (typeof path !== 'string' || !PREDICATE_OPS.includes(op as PredicateOp)) {
    return { kind: 'shape', at };
  }
  if (op === 'exists') {
    if ('value' in value) return { kind: 'shape', at };
    return {
      kind: 'condition',
      uid: nextUid(),
      path,
      op,
      valueKind: 'string',
      valueText: '',
      negated,
    };
  }
  if (!('value' in value)) return { kind: 'shape', at };
  return {
    kind: 'condition',
    uid: nextUid(),
    path,
    op: op as PredicateOp,
    ...valueDraft(value.value),
    negated,
  };
}

const isNode = (value: PredicateNodeDraft | PredicateFormBlocker): value is PredicateNodeDraft =>
  'uid' in value;

/** The form for a predicate, or where the form cannot say it. */
function formOf(value: unknown): PredicateDraft | PredicateFormBlocker {
  const read = nodeOf(value, '', false);
  if (!isNode(read)) return read;
  if (read.kind === 'group' && !read.negated) return { mode: 'form', root: read, bare: false };
  return {
    mode: 'form',
    root: { kind: 'group', uid: nextUid(), mode: 'all', negated: false, children: [read] },
    bare: true,
  };
}

const isDraft = (value: PredicateDraft | PredicateFormBlocker): value is PredicateDraft =>
  'mode' in value;

/** The draft for a predicate as it came (`undefined`: a new one): its form, or its JSON. */
export function predicateDraftFrom(value: unknown): PredicateDraft {
  if (value === undefined) return emptyPredicateDraft();
  const read = formOf(value);
  return isDraft(read) ? read : { mode: 'json', text: JSON.stringify(value, null, 2) };
}

/** Where a JSON draft keeps the form from saying it — `null` when it can (or is the form). */
export function predicateFormBlocker(draft: PredicateDraft): PredicateFormBlocker | null {
  if (draft.mode === 'form') return null;
  if (draft.text.trim() === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(draft.text);
  } catch {
    return { kind: 'not_json' };
  }
  const read = formOf(value);
  return isDraft(read) ? null : read;
}

/** An ordering comparison against text: compared as text (dates read fine, numbers do not). */
export function predicateComparesText(node: PredicateConditionDraft): boolean {
  return (
    node.op !== 'exists' && PREDICATE_ORDER_OPS.includes(node.op) && node.valueKind === 'string'
  );
}

/**
 * Where in the predicate, in the words the form uses — 第 2 项里的第 1 项 — never its JSON path
 * (`all.1.not.any.0`).
 */
function predicatePlaceText(at: string, t: Translate): string {
  const items = at
    .split('.')
    .filter((segment) => /^\d+$/.test(segment))
    .map((segment) => Number(segment) + 1);
  if (items.length === 0) return t('整个条件', 'The whole predicate');
  return t(
    items.map((n) => `第 ${n} 项`).join('里的'),
    items.map((n, i) => `${i === 0 ? 'Item' : 'item'} ${n}`).join(' › '),
  );
}

export function predicateFormBlockerText(blocker: PredicateFormBlocker, t: Translate): string {
  const where = (at: string) => predicatePlaceText(at, t);
  switch (blocker.kind) {
    case 'not_json':
      return t('还不是合法的 JSON。', 'It is not valid JSON yet.');
    case 'shape':
      return t(
        `${where(blocker.at)}不是条件（path / op / value）也不是 all / any / not。`,
        `${where(blocker.at)} is neither a condition (path / op / value) nor all / any / not.`,
      );
    case 'double_not':
      return t(
        `${where(blocker.at)}是「不满足」套「不满足」，表单只能取反一次。`,
        `${where(blocker.at)} negates a negation; the form negates once.`,
      );
    case 'empty_group':
      return t(
        `${where(blocker.at)}是空的一组，至少要有一个条件。`,
        `${where(blocker.at)} is an empty group; a group holds at least one condition.`,
      );
  }
}

/** The draft as JSON — what「用 JSON 编辑」starts from. */
export function predicateDraftAsJson(draft: PredicateDraft): PredicateDraft {
  if (draft.mode === 'json') return draft;
  const value = predicateFromDraft(draft);
  return { mode: 'json', text: value === undefined ? '' : JSON.stringify(value, null, 2) };
}

/** The JSON draft as the form, or `null` when the form cannot say it. Empty JSON: a new one. */
export function predicateDraftAsForm(draft: PredicateDraft): PredicateDraft | null {
  if (draft.mode === 'form') return draft;
  if (draft.text.trim() === '') return emptyPredicateDraft();
  try {
    const read = formOf(JSON.parse(draft.text));
    return isDraft(read) ? read : null;
  } catch {
    return null;
  }
}

/** A condition's value as sent; what does not parse goes as the text typed (the schema then
 *  refuses it, and {@link predicateDraftProblems} says why at its place). */
function conditionValue(node: PredicateConditionDraft): unknown {
  switch (node.valueKind) {
    case 'string':
      return node.valueText;
    case 'number': {
      const text = node.valueText.trim();
      const number = Number(text);
      return text !== '' && Number.isFinite(number) ? number : node.valueText;
    }
    case 'boolean':
      return node.valueText === 'true';
    case 'null':
      return null;
    case 'json':
      try {
        return JSON.parse(node.valueText);
      } catch {
        return node.valueText;
      }
  }
}

/** Each node's place in the predicate as sent (`all.1`, `all.0.not`), by uid. */
export type PredicatePaths = ReadonlyMap<string, string>;

function nodeToWire(node: PredicateNodeDraft, at: string, paths: Map<string, string>): unknown {
  const join = (base: string, key: string | number) =>
    base === '' ? String(key) : `${base}.${key}`;
  const inner = node.negated ? join(at, 'not') : at;
  paths.set(node.uid, inner);
  let value: unknown;
  if (node.kind === 'condition') {
    value =
      node.op === 'exists'
        ? { path: node.path.trim(), op: 'exists' }
        : { path: node.path.trim(), op: node.op, value: conditionValue(node) };
  } else {
    value = {
      [node.mode]: node.children.map((child, index) =>
        nodeToWire(child, join(inner, `${node.mode}.${index}`), paths),
      ),
    };
  }
  return node.negated ? { not: value } : value;
}

/** Whether the root is written as its one child alone. */
function writtenBare(draft: Extract<PredicateDraft, { mode: 'form' }>): boolean {
  const { root, bare } = draft;
  return bare && root.mode === 'all' && !root.negated && root.children.length === 1;
}

/** The predicate a form draft says, with each node's place; `undefined` for one with no
 *  condition yet (the check then has no `expect`, which the schema says is required). */
export function predicateWithPaths(
  draft: Extract<PredicateDraft, { mode: 'form' }>,
): { readonly value: unknown; readonly paths: PredicatePaths } | undefined {
  const paths = new Map<string, string>();
  if (draft.root.children.length === 0) return undefined;
  if (writtenBare(draft)) {
    const [only] = draft.root.children as [PredicateNodeDraft];
    return { value: nodeToWire(only, '', paths), paths };
  }
  return { value: nodeToWire(draft.root, '', paths), paths };
}

/** The predicate the draft says: the form's, the JSON parsed, or the JSON text when it does not
 *  parse; `undefined` when there is none yet. */
export function predicateFromDraft(draft: PredicateDraft): unknown {
  if (draft.mode === 'json') {
    if (draft.text.trim() === '') return undefined;
    try {
      return JSON.parse(draft.text);
    } catch {
      return draft.text;
    }
  }
  return predicateWithPaths(draft)?.value;
}

/** What the form can tell before the schema does, by the place in the predicate it is at
 *  (`all.1.value`; `''`: the JSON as a whole). */
export function predicateDraftProblems(draft: PredicateDraft, t: Translate): Map<string, string> {
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
  const written = predicateWithPaths(draft);
  if (written === undefined) return problems;
  const visit = (node: PredicateNodeDraft) => {
    if (node.kind === 'group') {
      node.children.forEach(visit);
      return;
    }
    const at = written.paths.get(node.uid) ?? '';
    const value = at === '' ? 'value' : `${at}.value`;
    if (node.op === 'exists') return;
    if (node.valueKind === 'number') {
      const text = node.valueText.trim();
      if (text === '' || !Number.isFinite(Number(text))) {
        problems.set(value, t('要填一个数字', 'Needs a number'));
      }
    }
    if (node.valueKind === 'json') {
      try {
        JSON.parse(node.valueText);
      } catch {
        problems.set(value, t('不是合法的 JSON', 'Not valid JSON'));
      }
    }
  };
  draft.root.children.forEach(visit);
  return problems;
}

// --- edits: pure functions over the tree, by uid ---------------------------------------------

function mapNode(
  node: PredicateNodeDraft,
  uid: string,
  edit: (node: PredicateNodeDraft) => PredicateNodeDraft | null,
): PredicateNodeDraft | null {
  if (node.uid === uid) return edit(node);
  if (node.kind === 'condition') return node;
  const children = node.children
    .map((child) => mapNode(child, uid, edit))
    .filter((child): child is PredicateNodeDraft => child !== null);
  return { ...node, children };
}

type FormDraft = Extract<PredicateDraft, { mode: 'form' }>;

function withRoot(
  draft: FormDraft,
  uid: string,
  edit: (node: PredicateNodeDraft) => PredicateNodeDraft | null,
): FormDraft {
  const root = mapNode(draft.root, uid, edit);
  return { ...draft, root: (root ?? draft.root) as PredicateGroupDraft };
}

export function withConditionChanged(
  draft: FormDraft,
  uid: string,
  patch: Partial<Omit<PredicateConditionDraft, 'kind' | 'uid'>>,
): FormDraft {
  return withRoot(draft, uid, (node) => {
    if (node.kind !== 'condition') return node;
    const next = { ...node, ...patch };
    // A comparison that takes fewer kinds of value moves the value to one it takes.
    const kinds = predicateValueKinds(next.op);
    if (kinds.length > 0 && !kinds.includes(next.valueKind)) {
      return { ...next, valueKind: kinds[0] as PredicateValueKind };
    }
    // Turning to an ordering comparison: a value that is empty or a number is compared as one —
    // `count 大于 "5"` as text is easy to miss and seldom meant.
    if (
      patch.op !== undefined &&
      patch.op !== 'exists' &&
      PREDICATE_ORDER_OPS.includes(patch.op) &&
      next.valueKind === 'string' &&
      (next.valueText.trim() === '' || Number.isFinite(Number(next.valueText.trim())))
    ) {
      return { ...next, valueKind: 'number' };
    }
    return next;
  });
}

export function withGroupChanged(
  draft: FormDraft,
  uid: string,
  patch: Partial<Pick<PredicateGroupDraft, 'mode' | 'negated'>>,
): FormDraft {
  return withRoot(draft, uid, (node) => (node.kind === 'group' ? { ...node, ...patch } : node));
}

/** The node taken out; a group it leaves empty goes with it (an empty group is never sent). */
export function withNodeRemoved(draft: FormDraft, uid: string): FormDraft {
  const prune = (node: PredicateNodeDraft): PredicateNodeDraft | null => {
    if (node.uid === uid) return null;
    if (node.kind === 'condition') return node;
    const children = node.children
      .map(prune)
      .filter((child): child is PredicateNodeDraft => child !== null);
    return children.length === 0 && node.children.length > 0 && node !== draft.root
      ? null
      : { ...node, children };
  };
  return { ...draft, root: prune(draft.root) as PredicateGroupDraft };
}

export function withChildAdded(
  draft: FormDraft,
  groupUid: string,
  child: PredicateNodeDraft,
): FormDraft {
  return withRoot(draft, groupUid, (node) =>
    node.kind === 'group' ? { ...node, children: [...node.children, child] } : node,
  );
}

// --- limits: what the form offers to add --------------------------------------------------------

function leaves(node: PredicateNodeDraft): number {
  return node.kind === 'condition' ? 1 : node.children.reduce((sum, c) => sum + leaves(c), 0);
}

function nesting(value: unknown): number {
  if (!isRecord(value)) return 0;
  if (Array.isArray(value.all)) return 1 + Math.max(0, ...value.all.map(nesting));
  if (Array.isArray(value.any)) return 1 + Math.max(0, ...value.any.map(nesting));
  if ('not' in value) return 1 + nesting(value.not);
  return 0;
}

/** Why a group cannot take another condition or group — `null` when it can. */
export function predicateAddLimit(
  draft: FormDraft,
  groupUid: string,
  child: 'condition' | 'group',
  t: Translate,
): string | null {
  if (leaves(draft.root) >= PREDICATE_MAX_LEAVES) {
    return t(
      `一个检查最多 ${PREDICATE_MAX_LEAVES} 个条件。`,
      `A check has at most ${PREDICATE_MAX_LEAVES} conditions.`,
    );
  }
  let group: PredicateGroupDraft | undefined;
  const find = (node: PredicateNodeDraft) => {
    if (node.kind !== 'group') return;
    if (node.uid === groupUid) group = node;
    else node.children.forEach(find);
  };
  find(draft.root);
  if (group !== undefined && group.children.length >= PREDICATE_MAX_CHILDREN) {
    return t(
      `一组最多 ${PREDICATE_MAX_CHILDREN} 项。`,
      `A group holds at most ${PREDICATE_MAX_CHILDREN}.`,
    );
  }
  const tried = predicateWithPaths(
    withChildAdded(
      draft,
      groupUid,
      child === 'group' ? newPredicateGroup() : newPredicateCondition(),
    ),
  );
  if (tried !== undefined && nesting(tried.value) > PREDICATE_MAX_NESTING) {
    return t(
      `组最多套 ${PREDICATE_MAX_NESTING} 层（取反也算一层）。`,
      `Groups nest at most ${PREDICATE_MAX_NESTING} deep (a negation counts as one).`,
    );
  }
  return null;
}
