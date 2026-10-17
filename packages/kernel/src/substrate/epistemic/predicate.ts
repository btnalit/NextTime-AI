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
 * observation showing it: a path that does not compile, a path that reads nothing from the result
 * (literals only), a path through `__proto__` / `constructor` / `prototype`, and — the rule that
 * catches the rest — a predicate satisfied by a result that says nothing about the target
 * ({@link PREDICATE_EMPTY_PROBES}: nothing, an empty object or list, an unrelated field). An agent
 * drafts these predicates (plan §4.3, F2); the lint is what keeps "always true" from reaching a
 * person's confirmation, not the prompt.
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

/** Whether `node`, evaluated against the result, reads anything from it. The left side of a
 *  chain is what is applied to the result (`a.b`, `a[0]`, `a[*].b`, `a | b`); a literal reads
 *  nothing, and neither does a `&expr` argument on its own (it is applied to what another argument
 *  produced). An unknown node type reads nothing — the lint then refuses the path. */
function readsResult(node: PathNode): boolean {
  switch (node.type) {
    case 'Field':
    case 'Current':
    case 'Identity':
    case 'Index':
    case 'Slice':
      return true;
    case 'Literal':
    case 'ExpressionReference':
      return false;
    case 'Subexpression':
    case 'IndexExpression':
    case 'Projection':
    case 'ValueProjection':
    case 'FilterProjection':
    case 'Pipe':
    case 'Flatten':
    case 'NotExpression': {
      const left = childNodes(node)[0];
      return left !== undefined && readsResult(left);
    }
    case 'MultiSelectList':
    case 'OrExpression':
    case 'AndExpression':
    case 'Comparator':
    case 'Function':
      return childNodes(node).some(readsResult);
    case 'MultiSelectHash':
      return childNodes(node).some((pair) => isPathNode(pair.value) && readsResult(pair.value));
    default:
      return false;
  }
}

function fieldNames(node: PathNode, names: Set<string>): Set<string> {
  if (node.type === 'Field' && typeof node.name === 'string') names.add(node.name);
  for (const child of childNodes(node)) fieldNames(child, names);
  if (node.type === 'KeyValuePair' && isPathNode(node.value)) fieldNames(node.value, names);
  return names;
}

function describeProbe(probe: unknown): string {
  return probe === null ? 'no result' : JSON.stringify(probe);
}

/** The problems that make `predicate` unfit to prove anything — `[]` when there are none. See
 *  the module comment. */
export function lintPredicate(predicate: Predicate): readonly string[] {
  const problems: string[] = [];
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
    if (!isPathNode(ast) || !readsResult(ast)) {
      problems.push(`path "${leaf.path}" reads nothing from the observation's result`);
      continue;
    }
    const reserved = [...fieldNames(ast, new Set())].filter((name) => RESERVED_FIELDS.has(name));
    if (reserved.length > 0) {
      problems.push(`path "${leaf.path}" goes through ${reserved.join(', ')}`);
    }
  }
  if (problems.length > 0) return problems;
  for (const probe of PREDICATE_EMPTY_PROBES) {
    if (evaluatePredicate(predicate, probe).outcome === 'satisfied') {
      problems.push(
        `the predicate holds on ${describeProbe(probe)} — it would pass without the observation showing the target`,
      );
      break;
    }
  }
  return problems;
}
