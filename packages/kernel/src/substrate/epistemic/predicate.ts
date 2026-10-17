import { type Predicate, type PredicateLeaf, predicateLeaves } from '@nexttime/shared';
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
 *   3. **Probes.** The predicate must not hold on a result that says nothing about the target:
 *      {@link PREDICATE_EMPTY_PROBES} (nothing, empty, an unrelated field) and refusals built from
 *      fields the predicate does not read (several keys, long strings, a list of them). And for
 *      each field it reads, it must not hold on every value of {@link PREDICATE_FIELD_PROBE_VALUES}
 *      it can judge (at least two) — `length(items) >= 0` does, whatever `items` is; `exists
 *      status`, `enabled == false` and `length(items) == 0` do not, and stay the plan author's to
 *      weigh (the confirmation card shows them).
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

/** Keys a refusal probe may carry — those the predicate does not read become its fields. */
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

function judge(predicate: Predicate, data: unknown, undetermined: string[]): Truth {
  if ('all' in predicate) {
    const values = predicate.all.map((child) => judge(child, data, undetermined));
    if (values.includes(false)) return false;
    return values.includes(null) ? null : true;
  }
  if ('any' in predicate) {
    const values = predicate.any.map((child) => judge(child, data, undetermined));
    if (values.includes(true)) return true;
    return values.includes(null) ? null : false;
  }
  if ('not' in predicate) {
    const value = judge(predicate.not, data, undetermined);
    return value === null ? null : !value;
  }
  return judgeLeaf(predicate, data, undetermined);
}

/** Judges `predicate` against `data` (an observation's result) — see the module comment. Never
 *  throws on any result: what cannot be judged is `undetermined`. */
export function evaluatePredicate(predicate: Predicate, data: unknown): PredicateEvaluation {
  const undetermined: string[] = [];
  const value = judge(predicate, data, undetermined);
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
  return probe === null ? 'no result' : JSON.stringify(probe);
}

/** Refusals made of fields `read` does not name: several keys, long strings, a list of them —
 *  `[]` when it names nearly all of {@link REFUSAL_PROBE_KEYS}. */
export function predicateRefusalProbes(read: ReadonlySet<string>): readonly unknown[] {
  const [a, b, c, d] = REFUSAL_PROBE_KEYS.filter((key) => !read.has(key));
  if (!a || !b || !c || !d) return [];
  const refusal = { [a]: PROBE_LONG_STRING, [b]: 1, [c]: false };
  const other = { [a]: 'refused', [b]: 2, [c]: { [d]: PROBE_LONG_STRING } };
  return [refusal, other, { [a]: PROBE_LONG_STRING, [b]: PROBE_LONG_STRING }, [refusal, other]];
}

/** Whether `predicate` holds on every value of `field` it can judge — at least two of them. */
function holdsWhateverValue(predicate: Predicate, field: string): boolean {
  let judged = 0;
  for (const value of PREDICATE_FIELD_PROBE_VALUES) {
    const { outcome } = evaluatePredicate(predicate, { [field]: value });
    if (outcome === 'undetermined') continue;
    if (outcome === 'unsatisfied') return false;
    judged += 1;
  }
  return judged >= 2;
}

/** The problems that make `predicate` unfit to prove anything — `[]` when there are none. See
 *  the module comment. */
export function lintPredicate(predicate: Predicate): readonly string[] {
  const problems: string[] = [];
  const read = new Set<string>();
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
        break;
    }
  }
  if (problems.length > 0) return problems;
  for (const probe of [...PREDICATE_EMPTY_PROBES, ...predicateRefusalProbes(read)]) {
    if (evaluatePredicate(predicate, probe).outcome === 'satisfied') {
      return [
        `the predicate holds on ${describeProbe(probe)} — it would pass without the observation showing the target`,
      ];
    }
  }
  for (const field of read) {
    if (holdsWhateverValue(predicate, field)) {
      return [
        `the predicate holds whatever "${field}" is (empty, false, zero or unrelated) — it does not test its value`,
      ];
    }
  }
  return problems;
}
