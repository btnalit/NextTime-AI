import {
  type OutputSchema,
  type Predicate,
  type PredicateLeaf,
  predicateLeaves,
} from '@nexttime/shared';
import jmespath from 'jmespath';

/**
 * substrate/epistemic/predicate (S11 GO3d; plan §4.6, §4.7): judging a predicate
 * (`@nexttime/shared` `Predicate`) against the result of an observation — what turns "the gate
 * returned this" into "the effect is there" without a model. The reconcile check of an
 * outcome-unknown action uses it (`application/goal/reconcile-check.ts`), and so will the
 * acceptance checks (GO4, `observe_predicate`).
 *
 * **Why here.** Deriving a claim from an Observation is epistemic work, and this layer depends on
 * the domain package alone (`.dependency-cruiser.cjs`): whoever judges a predicate — the goal
 * advancer now, acceptance and the gates' own tooling later — reaches the same code, and this code
 * reaches nothing above it. It does not reuse `@nexttime/gatekeeper-base`'s result mapping: that
 * runs on the gate side, maps a response into graph facts, and a change there must not change what
 * the kernel accepts as proof. The kernel depends on `jmespath` directly, at the same version.
 *
 * **Three values.** A leaf whose path fails on this result (a function given the wrong type) or
 * whose comparison has no answer (ordering a string against a number, ordering or `contains` on
 * nothing) is `undetermined`, not false: `not` of it stays undetermined, `all` is undetermined
 * unless a child is false, `any` unless a child is true. Only `satisfied` proves anything; a caller
 * reads the other two the same way — the effect was not shown.
 *
 * **The lint** ({@link lintPredicate}) refuses a predicate that would prove something without the
 * observation showing it. An agent drafts these predicates (plan §4.3, F2); the lint is what keeps
 * "always true" from reaching a person's confirmation, not the prompt. In order:
 *
 *   1. **Paths.** One that does not compile, one through `__proto__` / `constructor` /
 *      `prototype`, one that reads nothing from the result (literals only).
 *   2. **Anchoring** (review #493 on #649). Every read of the result at its root must go through a
 *      named field: not the result itself (`@`), its keys or values (`keys(@)`, `values(@)`, `*`)
 *      or a position (`[0]`, `[*]`) unless a named field follows. Such a path measures the
 *      answer's shape — `length(keys(@)) > 1` holds on a refusal like `{error, code}` as well as on
 *      the effect. Each branch of `||` / `&&` is anchored on its own, so a literal or shape branch
 *      cannot carry the rest. Below the root — right of a field, a projection, a filter or a pipe —
 *      anything goes (`items[?name=='web'] | length(@)` reads `items`).
 *   3. **Probes** (review #493 on #649, twice). The predicate must not hold on an answer that
 *      says no:
 *      - at the root: {@link PREDICATE_EMPTY_PROBES} (nothing, empty, an unrelated field),
 *        refusals built from fields the predicate does not read (several keys, long strings, a
 *        list of them) and {@link PREDICATE_REFUSAL_ANSWERS} (`{error, code, message}`,
 *        `{found: false, reason}`, `{ok: false, error}`) — so `exists error` is refused;
 *      - at every place it reads, however deep (`result` in `length(result) > 0`; `data`,
 *        `data.items`, `data.items[]` and `data.items[].id` in `data.items[?id=='x']`): that place
 *        holding nothing (missing, `{}`, `[]`) or a "no" — objects of unrelated fields, lists of
 *        them, unrelated texts, the refusal answers. A gate's answer usually comes in a wrapper,
 *        so a shape test one level down (`length(result) > 0`, `length(keys(data)) > 1`,
 *        `merge(data, {}) != {}`, `type(result) == 'object'`) holds on `{result: {found: false}}`
 *        as well as on the effect. A predicate made only of `exists` on plain field paths is
 *        not probed here: `exists status` and `exists data.id` hold on `{status: {…}}`, and that
 *        is all they say. Any other path keeps the probes — `exists keys(data)[0]` measures
 *        `data`, `exists items[0]` is `length(items) >= 1` (review #493);
 *      - and at each place, not on every value of {@link PREDICATE_FIELD_PROBE_VALUES} it can judge
 *        (at least two) — `length(items) >= 0` does.
 *      Refused on purpose, then: an absence (`length(items) == 0`, `found == false`,
 *      `items[?id=='x'] | length(@) == 0`) — "nothing there" is also what an answer that found
 *      nothing says, so an outcome-unknown removal goes to a person; a count of unfiltered items or
 *      keys a short answer reaches (`length(items) >= 1`); an order comparison on text with nothing
 *      else (`version >= '1.2'` — `'unknown'` sorts above it). A test of a value lets the rest
 *      through: `all` with `state == 'running'`, or a filter's literal
 *      (`items[?name=='web'] | length(@) == 1` — no probe holds an item named `web`). What stays
 *      the plan author's to weigh (the confirmation card shows it): `exists status`,
 *      `enabled == false`, `revision >= 7`, and a predicate that tests the wrong field.
 *
 * The lint runs in the kernel's event loop, so its probing is bounded: at most
 * {@link MAX_PROBED_PLACES} places, at most {@link MAX_PROBE_WORK} of work per predicate and
 * {@link PREDICATE_LINT_PLAN_WORK} per plan, past which a predicate is refused rather than
 * half-checked; and a probe at a place re-judges only the leaves that read under its root field
 * ({@link placeProber}).
 */

export type PredicateOutcome = 'satisfied' | 'unsatisfied' | 'undetermined';

export interface PredicateEvaluation {
  readonly outcome: PredicateOutcome;
  /** Why a leaf was undetermined — its path and what failed — for the evidence a caller records. */
  readonly undetermined: readonly string[];
}

type Truth = true | false | null;

/** A JMESPath AST node as jmespath 0.16 builds it. */
interface PathNode {
  readonly type: string;
  readonly name?: string;
  readonly value?: unknown;
  readonly children?: readonly unknown[];
}

/** Results that say nothing about any target: no result, empty ones, and ones holding only a
 *  field no Operation returns. A predicate satisfied by one of them is refused. */
export const PREDICATE_EMPTY_PROBES: readonly unknown[] = Object.freeze([
  null,
  {},
  [],
  { __nexttime_probe__: 'unrelated' },
  ['__nexttime_probe__'],
]);

/** Keys a refusal probe may carry — those the predicate does not read become its fields, and
 *  made-up ones ({@link unreadKeys}) when it reads nearly all of them. */
const REFUSAL_PROBE_KEYS: readonly string[] = [
  'error',
  'code',
  'reason',
  'message',
  'detail',
  'found',
  'ok',
  'result',
  'data',
  'info',
  'meta',
  'value',
];
const PROBE_LONG_STRING = 'nothing happened here; '.repeat(4);
/** Unrelated texts at a place the predicate reads: one sorting before digits, one after letters,
 *  and a long one. */
const PROBE_TEXTS: readonly string[] = ['(none)', '~ unrelated ~', PROBE_LONG_STRING];

/** Answers that say no, with the fields such answers carry. A predicate one of them satisfies —
 *  as the whole result or at a place it reads — is refused: `exists error` and `found == false`
 *  hold on them, and neither shows an effect. */
export const PREDICATE_REFUSAL_ANSWERS: readonly unknown[] = Object.freeze([
  { error: 'not_found', code: 404, message: 'nothing happened here' },
  { found: false, reason: 'no such thing' },
  { ok: false, error: { code: 'refused', message: 'nothing happened here' } },
]);

/** Values a field the predicate reads takes in its field probes: empty, falsy, unrelated. */
export const PREDICATE_FIELD_PROBE_VALUES: readonly unknown[] = Object.freeze([
  null,
  false,
  0,
  '',
  [],
  {},
  '__nexttime_probe__',
]);

/** Bounds on the lint's own work, which runs in the kernel's event loop: at most this many places
 *  a predicate reads, and this much probing — each leaf judged again counts its path's length
 *  (about 40 ms). A predicate past either is refused rather than half-checked; a plan's predicates
 *  share {@link PredicateLintBudget}. */
const MAX_PROBED_PLACES = 64;
const MAX_PROBE_WORK = 262_144;

/** Probing a whole plan's predicates may take (`application/goal/plan.ts` passes one per plan):
 *  a plan carries up to 400 of them, so each one's bound alone would not bound the plan. */
export const PREDICATE_LINT_PLAN_WORK = 2_097_152;

/** Probing left for the predicates still to lint — {@link lintPredicate} spends from it. */
export interface PredicateLintBudget {
  remaining: number;
}

const RESERVED_FIELDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** jmespath 0.16 exports `compile` (the parser behind `search`); `@types/jmespath` declares only
 *  `search`. */
const compilePath = (jmespath as unknown as { compile(expression: string): unknown }).compile;

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(b)) return false;
    const left = Object.keys(a as object);
    const right = Object.keys(b as object);
    return (
      left.length === right.length &&
      left.every(
        (key) =>
          Object.hasOwn(b as object, key) &&
          jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

function compare(found: unknown, value: unknown): number | null {
  if (typeof found === 'number' && typeof value === 'number') return found - value;
  if (typeof found === 'string' && typeof value === 'string') {
    return found < value ? -1 : found > value ? 1 : 0;
  }
  return null;
}

function judgeLeaf(leaf: PredicateLeaf, data: unknown, undetermined: string[]): Truth {
  let found: unknown;
  try {
    found = jmespath.search(data as never, leaf.path);
  } catch (err) {
    undetermined.push(`${leaf.path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const missing = found === null || found === undefined;
  if (leaf.op === 'exists') return !missing;
  if (leaf.op === 'eq') return jsonEqual(missing ? null : found, leaf.value);
  if (leaf.op === 'ne') return !jsonEqual(missing ? null : found, leaf.value);
  if (leaf.op === 'contains') {
    if (Array.isArray(found)) return found.some((item) => jsonEqual(item, leaf.value));
    if (typeof found === 'string' && typeof leaf.value === 'string') {
      return found.includes(leaf.value);
    }
    undetermined.push(`${leaf.path}: contains needs a list, or a string and a string value`);
    return null;
  }
  const order = compare(found, leaf.value);
  if (order === null) {
    undetermined.push(`${leaf.path}: ${leaf.op} needs two numbers or two strings`);
    return null;
  }
  switch (leaf.op) {
    case 'gt':
      return order > 0;
    case 'gte':
      return order >= 0;
    case 'lt':
      return order < 0;
    case 'lte':
      return order <= 0;
  }
}

function judge(predicate: Predicate, leafTruth: (leaf: PredicateLeaf) => Truth): Truth {
  if ('all' in predicate) {
    const values = predicate.all.map((child) => judge(child, leafTruth));
    if (values.includes(false)) return false;
    return values.includes(null) ? null : true;
  }
  if ('any' in predicate) {
    const values = predicate.any.map((child) => judge(child, leafTruth));
    if (values.includes(true)) return true;
    return values.includes(null) ? null : false;
  }
  if ('not' in predicate) {
    const value = judge(predicate.not, leafTruth);
    return value === null ? null : !value;
  }
  return leafTruth(predicate);
}

/** Judges `predicate` against `data` (an observation's result) — see the module comment. Never
 *  throws on any result: what cannot be judged is `undetermined`. */
export function evaluatePredicate(predicate: Predicate, data: unknown): PredicateEvaluation {
  const undetermined: string[] = [];
  const value = judge(predicate, (leaf) => judgeLeaf(leaf, data, undetermined));
  return {
    outcome: value === true ? 'satisfied' : value === false ? 'unsatisfied' : 'undetermined',
    undetermined,
  };
}

function isPathNode(value: unknown): value is PathNode {
  return (
    value !== null && typeof value === 'object' && typeof (value as PathNode).type === 'string'
  );
}

function childNodes(node: PathNode): readonly PathNode[] {
  return (node.children ?? []).filter(isPathNode);
}

/**
 * How `node`, evaluated at the root of the result, reads it (the lint's rules 1–2, module
 * comment):
 *
 *   - `none` — literals only;
 *   - `field` — only through named fields;
 *   - `root` — the result itself or a position or projection of it (`@`, `[0]`, `[*]`, `*`),
 *     which a named field to its right anchors (`@.state`, `[0].status`, `*.state`);
 *   - `whole` — something measured or built from the result (`keys(@)`, `length(@)`,
 *     `[@, state]`, `{a: @}`, `@ == x`), which nothing to its right anchors — `{a: @}.a` and
 *     `merge(@, …).x` name a key the path made, not one of the result's;
 *   - `branch` — a `||` / `&&` with a branch that is not `field`.
 *
 * A chain (`a.b`, `a[0]`, `a[*].b`, `a | b`, `a[?c]`) reads what its left side reads; below a
 * named field anything goes. Arguments, operands and list elements are all at the root. An
 * unknown node type reads `whole` — the lint then refuses the path.
 */
type RootRead = 'none' | 'field' | 'root' | 'whole' | 'branch';

/** What reading `reads` side by side at the root amounts to: the root among them is measured. */
function combined(reads: readonly RootRead[]): RootRead {
  if (reads.includes('whole') || reads.includes('root')) return 'whole';
  if (reads.includes('branch')) return 'branch';
  return reads.includes('field') ? 'field' : 'none';
}

function rootRead(node: PathNode): RootRead {
  const children = childNodes(node);
  switch (node.type) {
    case 'Field':
      return 'field';
    case 'Literal':
    case 'ExpressionReference':
      return 'none';
    case 'Current':
    case 'Identity':
    case 'Index':
    case 'Slice':
      return 'root';
    case 'Subexpression':
    case 'IndexExpression':
    case 'Projection':
    case 'ValueProjection':
    case 'FilterProjection':
    case 'Pipe': {
      const [left, ...rest] = children;
      if (!left) return 'whole';
      const base = rootRead(left);
      if (base !== 'root') return base;
      const right = rest.map(rootRead);
      if (right.includes('field')) return 'field';
      return right.every((read) => read === 'root' || read === 'none') ? 'root' : 'whole';
    }
    case 'Flatten':
      return children[0] ? rootRead(children[0]) : 'whole';
    case 'NotExpression':
    case 'OrExpression':
    case 'AndExpression':
    case 'Comparator':
    case 'Function':
    case 'MultiSelectList': {
      const reads = children.map(rootRead);
      const read = combined(reads);
      const logical = node.type === 'OrExpression' || node.type === 'AndExpression';
      return logical && read === 'field' && reads.some((branch) => branch !== 'field')
        ? 'branch'
        : read;
    }
    case 'MultiSelectHash':
      return combined(
        children.map((pair) => (isPathNode(pair.value) ? rootRead(pair.value) : 'none')),
      );
    default:
      return 'whole';
  }
}

function fieldNames(node: PathNode, names: Set<string>): Set<string> {
  if (node.type === 'Field' && typeof node.name === 'string') names.add(node.name);
  for (const child of childNodes(node)) fieldNames(child, names);
  if (node.type === 'KeyValuePair' && isPathNode(node.value)) fieldNames(node.value, names);
  return names;
}

/** A step into a part of a value: a named field, an element of a list, a value of an object. */
type Step = { readonly field: string } | 'element' | 'value';
/** A place in the result: the steps to it from the root. */
type Place = readonly Step[];

/**
 * Where a path reads, relative to where it is evaluated (the lint's rule 3, module comment):
 * `reads`, the places it looks at on its way, and `out`, the places its value comes from — where a
 * path to its right goes on. `items[?name=='web'].state` reads `items`, `items[]`,
 * `items[].name` and comes from `items[].state`; an operand or argument is read where its value
 * comes from. Over-approximate on purpose (a function's value comes from its arguments): a place
 * too many only adds a probe.
 */
interface Reach {
  readonly reads: readonly Place[];
  readonly out: readonly Place[];
}

const NOWHERE: Reach = { reads: [], out: [] };

/** Thrown when a path reads more places than the lint will probe ({@link MAX_PROBED_PLACES}). */
class TooManyPlaces extends Error {}

function within(places: readonly Place[]): readonly Place[] {
  if (places.length > MAX_PROBED_PLACES * 4) throw new TooManyPlaces();
  return places;
}

/** Each of `heads` followed by each of `tails`. */
function then(heads: readonly Place[], tails: readonly Place[]): readonly Place[] {
  if (heads.length * tails.length > MAX_PROBED_PLACES * 4) throw new TooManyPlaces();
  return heads.flatMap((head) => tails.map((tail) => [...head, ...tail]));
}

/** What reading `parts` as operands or arguments looks at: where they read, and their values. */
function consumed(parts: readonly Reach[]): readonly Place[] {
  return within(parts.flatMap((part) => [...part.reads, ...part.out]));
}

function reach(node: PathNode): Reach {
  const children = childNodes(node);
  switch (node.type) {
    case 'Field':
      return typeof node.name === 'string'
        ? { reads: [[{ field: node.name }]], out: [[{ field: node.name }]] }
        : NOWHERE;
    case 'Current':
    case 'Identity':
    case 'Slice':
      return { reads: [], out: [[]] };
    case 'Index':
      return { reads: [['element']], out: [['element']] };
    case 'Subexpression':
    case 'IndexExpression':
    case 'Pipe': {
      const [left, right] = children.map(reach);
      if (!left || !right) return NOWHERE;
      // A pipe hands its right side the whole value: after a projection (`a[*].b | [0].c`) that is
      // the list of parts, whose elements sit where the parts do — `a[].b.c`, not `a[].b[].c`.
      const tails = (places: readonly Place[]) =>
        node.type === 'Pipe'
          ? [
              ...places,
              ...places.flatMap((place) => (place[0] === 'element' ? [place.slice(1)] : [])),
            ]
          : places;
      return {
        reads: within([...left.reads, ...then(left.out, tails(right.reads))]),
        out: then(left.out, tails(right.out)),
      };
    }
    case 'Projection':
    case 'ValueProjection':
    case 'FilterProjection': {
      // children: the projected value, what each part goes on to, and a filter's condition.
      const [left, ...rest] = children.map(reach);
      if (!left) return NOWHERE;
      const parts = then(left.out, [[node.type === 'ValueProjection' ? 'value' : 'element']]);
      const right = rest[0];
      return {
        reads: within([
          ...left.reads,
          ...parts,
          ...rest.flatMap((part) => then(parts, part.reads)),
        ]),
        out: right ? then(parts, right.out) : parts,
      };
    }
    case 'Flatten': {
      const [inner] = children.map(reach);
      if (!inner) return NOWHERE;
      return { reads: inner.reads, out: within([...inner.out, ...then(inner.out, [['element']])]) };
    }
    case 'Function': {
      const args = children.filter((child) => child.type !== 'ExpressionReference').map(reach);
      const bodies = children
        .filter((child) => child.type === 'ExpressionReference')
        .flatMap((ref) => childNodes(ref).map(reach));
      const values = within(args.flatMap((arg) => arg.out));
      // `sort_by(items, &name)`: an expression argument is evaluated on each element of the others.
      const elements = bodies.length > 0 ? then(values, [['element']]) : [];
      return {
        reads: within([
          ...consumed(args),
          ...elements,
          ...bodies.flatMap((body) => then(elements, [...body.reads, ...body.out])),
        ]),
        out: within([...values, ...elements]),
      };
    }
    case 'Comparator':
    case 'NotExpression':
      return { reads: consumed(children.map(reach)), out: [] };
    case 'OrExpression':
    case 'AndExpression':
    case 'MultiSelectList': {
      const parts = children.map(reach);
      return { reads: consumed(parts), out: within(parts.flatMap((part) => part.out)) };
    }
    case 'MultiSelectHash': {
      const parts = children.flatMap((pair) => (isPathNode(pair.value) ? [reach(pair.value)] : []));
      return { reads: consumed(parts), out: within(parts.flatMap((part) => part.out)) };
    }
    default:
      return NOWHERE;
  }
}

/** Whether `node` is a plain chain of named fields (`status`, `data.id`). */
function isFieldChain(node: PathNode): boolean {
  if (node.type === 'Field') return true;
  if (node.type !== 'Subexpression') return false;
  const children = childNodes(node);
  return children.length === 2 && children.every(isFieldChain);
}

/** Adds to `places` every place `ast` (a leaf's path) reads, and every place on the way to one —
 *  `data` and `data.items` for `data.items`; the root itself is not one (the root probes cover
 *  it). Returns the root fields the leaf reads under — `null` when it reads under every one
 *  (`[0].status`, `*.state`): only a probe under one of them can change what the leaf finds. */
function addPlacesRead(ast: PathNode, places: Map<string, Place>): ReadonlySet<string> | null {
  const { reads, out } = reach(ast);
  const roots = new Set<string>();
  let everywhere = false;
  for (const place of [...reads, ...out]) {
    const [first] = place;
    if (first === undefined) continue;
    if (typeof first === 'string') everywhere = true;
    else roots.add(first.field);
    for (let depth = 1; depth <= place.length; depth += 1) {
      const prefix = place.slice(0, depth);
      places.set(JSON.stringify(prefix), prefix);
      if (places.size > MAX_PROBED_PLACES) throw new TooManyPlaces();
    }
  }
  return everywhere ? null : roots;
}

/** `value` at `place` in an otherwise empty result; `filler` keys an object's value step. */
function placed(place: Place, value: unknown, filler: string): unknown {
  let result = value;
  for (let i = place.length - 1; i >= 0; i -= 1) {
    const step = place[i] as Step;
    result =
      step === 'element'
        ? [result]
        : step === 'value'
          ? { [filler]: result }
          : { [step.field]: result };
  }
  return result;
}

function describePlace(place: Place): string {
  return place
    .map((step, i) =>
      step === 'element'
        ? '[]'
        : step === 'value'
          ? i === 0
            ? '*'
            : '.*'
          : i === 0
            ? step.field
            : `.${step.field}`,
    )
    .join('');
}

function literalValues(node: PathNode, values: unknown[]): unknown[] {
  if (node.type === 'Literal') values.push(node.value);
  for (const child of childNodes(node)) literalValues(child, values);
  if (node.type === 'KeyValuePair' && isPathNode(node.value)) literalValues(node.value, values);
  return values;
}

/** A literal `predicate` compares with, and the path of the comparison it belongs to. */
export interface PredicateLiteral {
  readonly path: string;
  readonly value: unknown;
}

/** Every literal `predicate` compares with: each comparison's `value`, and the literals in its
 *  path (`` `"x"` ``, `'x'`, a filter's operand). For the credential review of a reconcile check
 *  (`application/goal/plan.ts`'s `predicateCredentialProblems`); a path that does not compile
 *  contributes none — the lint refuses it. */
export function predicateLiterals(predicate: Predicate): readonly PredicateLiteral[] {
  const literals: PredicateLiteral[] = [];
  for (const leaf of predicateLeaves(predicate)) {
    if ('value' in leaf && leaf.value !== undefined) {
      literals.push({ path: leaf.path, value: leaf.value });
    }
    let ast: unknown;
    try {
      ast = compilePath(leaf.path);
    } catch {
      continue;
    }
    if (!isPathNode(ast)) continue;
    for (const value of literalValues(ast, [])) literals.push({ path: leaf.path, value });
  }
  return literals;
}

function describeProbe(probe: unknown): string {
  if (probe === null) return 'no result';
  const shown = JSON.stringify(probe);
  return shown.length > 160 ? `${shown.slice(0, 159)}…` : shown;
}

/** `count` keys `read` does not name: {@link REFUSAL_PROBE_KEYS} first, then made-up ones — a
 *  predicate that names every refusal key still gets its refusal probes (review #493). */
function unreadKeys(read: ReadonlySet<string>, count: number): string[] {
  const keys = REFUSAL_PROBE_KEYS.filter((key) => !read.has(key));
  for (let i = 0; keys.length < count; i += 1) {
    const key = `__nexttime_refusal_${i}__`;
    if (!read.has(key)) keys.push(key);
  }
  return keys.slice(0, count);
}

/** Refusals made of fields `read` does not name: several keys, long strings, a list of them. */
export function predicateRefusalProbes(read: ReadonlySet<string>): readonly unknown[] {
  const [a, b, c, d] = unreadKeys(read, 4) as [string, string, string, string];
  const refusal = { [a]: PROBE_LONG_STRING, [b]: 1, [c]: false };
  const other = { [a]: 'refused', [b]: 2, [c]: { [d]: PROBE_LONG_STRING } };
  return [refusal, other, { [a]: PROBE_LONG_STRING, [b]: PROBE_LONG_STRING }, [refusal, other]];
}

/** What a place the predicate reads may hold in an answer that says no: nothing (missing, empty),
 *  objects of fields `read` does not name (one, three, eight), lists of them, unrelated texts and
 *  the refusal answers. */
function placeProbeValues(read: ReadonlySet<string>): readonly unknown[] {
  const keys = unreadKeys(read, 8);
  const [a, b, c, d] = keys as [string, string, string, string];
  const one = { [a]: false };
  const refusal = { [a]: PROBE_LONG_STRING, [b]: 1, [c]: false };
  const other = { [a]: 'refused', [b]: 2, [c]: { [d]: PROBE_LONG_STRING } };
  const many = Object.fromEntries(keys.map((key, i) => [key, i % 2 === 0 ? 'refused' : i]));
  return [
    null,
    {},
    [],
    one,
    refusal,
    other,
    many,
    [refusal],
    [refusal, other, one],
    ...PROBE_TEXTS,
    ...PREDICATE_REFUSAL_ANSWERS,
  ];
}

/**
 * Judges `predicate` on results that differ from `{}` only at one place. A leaf that reads under
 * none of the root fields above that place finds there what it finds in `{}` — field access on a
 * list or a missing field is `null` either way — so only the leaves that may read there are judged
 * again; the rest keep their judgement on `{}`. `roots` is {@link addPlacesRead}'s per leaf.
 */
function placeProber(
  predicate: Predicate,
  roots: ReadonlyMap<PredicateLeaf, ReadonlySet<string> | null>,
): { judge(place: Place, probe: unknown): Truth; work(place: Place): number } {
  const ignored: string[] = [];
  const leaves = predicateLeaves(predicate);
  const onEmpty = new Map(leaves.map((leaf) => [leaf, judgeLeaf(leaf, {}, ignored)]));
  const reads = (leaf: PredicateLeaf, place: Place): boolean => {
    const read = roots.get(leaf);
    const [first] = place;
    return read == null || typeof first !== 'object' || read.has(first.field);
  };
  return {
    judge: (place, probe) =>
      judge(predicate, (leaf) =>
        reads(leaf, place) ? judgeLeaf(leaf, probe, ignored) : (onEmpty.get(leaf) ?? null),
      ),
    work: (place) =>
      leaves.reduce((sum, leaf) => sum + (reads(leaf, place) ? leaf.path.length : 0), 0),
  };
}

/** The problems that make `predicate` unfit to prove anything — `[]` when there are none. See
 *  the module comment. `budget`, when given, is shared with other predicates and spent from. */
export function lintPredicate(
  predicate: Predicate,
  budget?: PredicateLintBudget,
): readonly string[] {
  const problems: string[] = [];
  const read = new Set<string>();
  const places = new Map<string, Place>();
  const roots = new Map<PredicateLeaf, ReadonlySet<string> | null>();
  let tooMany = false;
  // Whether every leaf is `exists` on a plain field chain — the one kind not probed at its places.
  let onlyFieldExists = true;
  for (const leaf of predicateLeaves(predicate)) {
    let ast: unknown;
    try {
      ast = compilePath(leaf.path);
    } catch (err) {
      problems.push(
        `path "${leaf.path}" is not a JMESPath expression: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!isPathNode(ast)) {
      problems.push(`path "${leaf.path}" reads nothing from the observation's result`);
      continue;
    }
    const names = fieldNames(ast, new Set());
    const reserved = [...names].filter((name) => RESERVED_FIELDS.has(name));
    if (reserved.length > 0) {
      problems.push(`path "${leaf.path}" goes through ${reserved.join(', ')}`);
      continue;
    }
    for (const name of names) read.add(name);
    if (leaf.op !== 'exists' || !isFieldChain(ast)) onlyFieldExists = false;
    switch (rootRead(ast)) {
      case 'none':
        problems.push(`path "${leaf.path}" reads nothing from the observation's result`);
        break;
      case 'root':
      case 'whole':
        problems.push(
          `path "${leaf.path}" reads the result as a whole (@, *, keys, values or a position) instead of a named field — it would hold on almost any answer`,
        );
        break;
      case 'branch':
        problems.push(`path "${leaf.path}": every branch of || and && must read a named field`);
        break;
      case 'field':
        if (tooMany) break;
        try {
          roots.set(leaf, addPlacesRead(ast, places));
        } catch (err) {
          if (!(err instanceof TooManyPlaces)) throw err;
          tooMany = true;
        }
        break;
    }
  }
  if (problems.length > 0) return problems;
  const refusedOn = (probe: unknown) =>
    `the predicate holds on ${describeProbe(probe)} — it would pass without the observation showing the target`;
  for (const probe of [
    ...PREDICATE_EMPTY_PROBES,
    ...predicateRefusalProbes(read),
    ...PREDICATE_REFUSAL_ANSWERS,
  ]) {
    if (evaluatePredicate(predicate, probe).outcome === 'satisfied') return [refusedOn(probe)];
  }
  const values = onlyFieldExists ? [] : placeProbeValues(read);
  const prober = placeProber(predicate, roots);
  const perPlace = values.length + PREDICATE_FIELD_PROBE_VALUES.length;
  const work = [...places.values()].reduce((sum, place) => sum + prober.work(place) * perPlace, 0);
  if (tooMany || work > MAX_PROBE_WORK) {
    return [
      'the predicate reads too many places in the result for the lint to check — test fewer fields',
    ];
  }
  if (budget) {
    if (work > budget.remaining) {
      return [
        "the plan's predicates together read too many places for the lint to check — test fewer fields",
      ];
    }
    budget.remaining -= work;
  }
  const [filler] = unreadKeys(read, 1) as [string];
  for (const place of places.values()) {
    let judged = 0;
    for (const value of PREDICATE_FIELD_PROBE_VALUES) {
      const truth = prober.judge(place, placed(place, value, filler));
      if (truth === false) {
        judged = 0;
        break;
      }
      if (truth === true) judged += 1;
    }
    if (judged >= 2) {
      return [
        `the predicate holds whatever "${describePlace(place)}" is (empty, false, zero or unrelated) — it does not test its value`,
      ];
    }
  }
  for (const place of places.values()) {
    for (const value of values) {
      const probe = placed(place, value, filler);
      if (prober.judge(place, probe) === true) return [refusedOn(probe)];
    }
  }
  return problems;
}

// ----- binding paths (S11 GO5d-1) -------------------------------------------------------------

/**
 * S11 GO5d-1 (plan §4.5): a binding's path — what of an upstream step's output a later step's
 * input takes (`application/goal/bindings.ts`). The same JMESPath dialect and parser as a
 * predicate's path, held to the lint's first rule only: it compiles, goes through no `__proto__` /
 * `constructor` / `prototype`, and reads something of the output (not literals only). Anchoring and
 * probes are rules for a proof; a binding proves nothing — it hands a value on, and the whole
 * output (`@`) is a fair thing to hand on. `[]` when there is no problem.
 */
export function bindingPathProblems(path: string): readonly string[] {
  let ast: unknown;
  try {
    ast = compilePath(path);
  } catch (err) {
    return [
      `path "${path}" is not a JMESPath expression: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }
  if (!isPathNode(ast)) return [`path "${path}" reads nothing from the output`];
  const reserved = [...fieldNames(ast, new Set())].filter((name) => RESERVED_FIELDS.has(name));
  if (reserved.length > 0) return [`path "${path}" goes through ${reserved.join(', ')}`];
  if (rootRead(ast) === 'none') return [`path "${path}" reads nothing from the output`];
  return [];
}

/**
 * S10 E3-1b: a path judged on a document whose top-level fields are fixed — an evaluation case's
 * assertion, read on `{result, calls}` (`@nexttime/shared` eval-case.ts). {@link bindingPathProblems}'
 * rules, and every place it reads starts at one of `roots`: not the document itself (`@`,
 * `keys(@)`, `[0]`, `*`), not a field the document never has (a misspelt root makes an assertion
 * that never holds, or always does under `not`). The anchoring and probes of the lint are not
 * applied: an assertion may test an absence ("this Operation was not called"), which is a fair
 * thing for a case to require. `[]` when there is no problem.
 */
export function documentPathProblems(path: string, roots: readonly string[]): readonly string[] {
  const basic = bindingPathProblems(path);
  if (basic.length > 0)
    return basic.map((problem) => problem.replace('the output', 'the document'));
  const ast = compilePath(path) as PathNode;
  const { reads, out } = reach(ast);
  const unknown = new Set<string>();
  for (const place of [...reads, ...out]) {
    const [first] = place;
    if (first === undefined || typeof first === 'string') {
      return [`path "${path}" reads the document itself — start it at ${roots.join(' or ')}`];
    }
    if (!roots.includes(first.field)) unknown.add(first.field);
  }
  if (unknown.size > 0) {
    return [
      `path "${path}" reads ${[...unknown].map((name) => JSON.stringify(name)).join(', ')} — the document has only ${roots.join(' and ')}`,
    ];
  }
  return [];
}

/** A step of a plain path: a named field, or a position in a list. */
type ChainStep = { readonly field: string } | { readonly index: number };

/** `node` as plain steps (`hosts[0].name` → `hosts`, `0`, `name`; `@` → none), or `null` when it
 *  is anything else (a projection, a filter, a function…). */
function plainChain(node: PathNode): readonly ChainStep[] | null {
  const children = childNodes(node);
  switch (node.type) {
    case 'Current':
    case 'Identity':
      return [];
    case 'Field':
      return typeof node.name === 'string' ? [{ field: node.name }] : null;
    case 'Index':
      return typeof node.value === 'number' ? [{ index: node.value }] : null;
    case 'Subexpression':
    case 'IndexExpression': {
      if (children.length !== 2) return null;
      const left = plainChain(children[0] as PathNode);
      const right = plainChain(children[1] as PathNode);
      return left && right ? [...left, ...right] : null;
    }
    default:
      return null;
  }
}

/** A plain path as JMESPath writes it: a name that is not a plain identifier quoted. */
function chainText(steps: readonly ChainStep[]): string {
  return steps
    .map((step, i) => {
      if ('index' in step) return `[${step.index}]`;
      const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(step.field)
        ? step.field
        : JSON.stringify(step.field);
      return `${i === 0 ? '' : '.'}${name}`;
    })
    .join('');
}

/**
 * What `path` (one {@link bindingPathProblems} accepts) certainly cannot select of an output that
 * meets `schema` (`@nexttime/shared` `OutputSchema`): a field the schema closes off
 * (`additionalProperties: false` and not among `properties`), a field of what is not an object, a
 * position in what is not a list. Only a plain path (fields and positions) is followed, and only
 * as far as the schema says: past a part it leaves open, nothing is claimed — the advancer finds a
 * missing value when it binds (`application/goal/bindings.ts`). `[]` when nothing is certain.
 * `subject` names what the schema describes — a step's output (the default), or a Procedure's
 * parameters (S11 GO5d-2: a `$params` binding).
 */
export function bindingSchemaProblems(
  path: string,
  schema: OutputSchema,
  subject: 'output' | 'parameters' = 'output',
): readonly string[] {
  let ast: unknown;
  try {
    ast = compilePath(path);
  } catch {
    return [];
  }
  if (!isPathNode(ast)) return [];
  const steps = plainChain(ast);
  if (!steps) return [];
  let at: OutputSchema | undefined = schema;
  for (const [i, step] of steps.entries()) {
    if (!at) return [];
    const types = at.type === undefined ? null : Array.isArray(at.type) ? at.type : [at.type];
    const where = i === 0 ? `the ${subject}` : chainText(steps.slice(0, i));
    if ('field' in step) {
      if (types && !types.includes('object')) {
        return [`path "${path}": ${where} is not an object in the ${subject} schema`];
      }
      const declared: OutputSchema | undefined = at.properties
        ? Object.hasOwn(at.properties, step.field)
          ? at.properties[step.field]
          : undefined
        : undefined;
      if (!declared && at.additionalProperties === false) {
        return [
          `path "${path}": the ${subject} schema does not declare ${JSON.stringify(step.field)} in ${where}`,
        ];
      }
      at = declared;
    } else {
      if (types && !types.includes('array')) {
        return [`path "${path}": ${where} is not a list in the ${subject} schema`];
      }
      at = at.items;
    }
  }
  return [];
}

/** What `path` selects of `data` — `found: false` when it selects nothing: JMESPath's `null` is
 *  "nothing there", so a `null` in the output reads as no value — or the error a path failing on
 *  this data raised (a function given the wrong type). */
export function selectPath(
  data: unknown,
  path: string,
):
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false; readonly error: string | null } {
  let value: unknown;
  try {
    value = jmespath.search(data as never, path);
  } catch (err) {
    return { found: false, error: err instanceof Error ? err.message : String(err) };
  }
  return value === null || value === undefined
    ? { found: false, error: null }
    : { found: true, value };
}
